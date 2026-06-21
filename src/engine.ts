/**
 * The mission runner. Wires the loop together:
 *
 *   reset → auth → for each mission:
 *     goto start → loop(observe → decide → act → checkInvariants) → judge
 *
 * Findings from invariant oracles and the judge are collected per mission.
 */

import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BrowserSession, type ResponseEvent } from "./browser.js";
import type { LLMClient, AgentContext, Decision } from "./agent.js";
import { actionLabel, actionRefs, annotateAction, executeAction } from "./act.js";
import {
  affordanceKey,
  computeObservationCoverage,
  untriedAffordances,
} from "./coverage.js";
import {
  historicalExercisedKeys,
  loadCoverage,
  mergeRunCoverage,
  saveCoverage,
} from "./coverageStore.js";
import { captureScreenshot, observe, type Observation } from "./observe.js";
import { checkInvariants, judgeMission, verifyFindings } from "./oracles.js";
import { recordFinding } from "./findings.js";
import {
  classifyAndUpdate,
  loadBaseline,
  mutedExclusions,
  saveBaseline,
} from "./baseline.js";
import { loadLearned, mergeLearned } from "./learned.js";
import {
  actionSignature,
  diffProgress,
  isGatedRedirect,
  normalizeRoute,
  pathOf,
  progressNote,
  progressSignature,
} from "./progress.js";
import {
  describeTarget,
  loadRecipe,
  resolveStep,
  saveRecipe,
  type Recipe,
  type RecipeStep,
} from "./recipe.js";
import type { LoadedProfile } from "./profile.js";
import { makeFixtureResolver } from "./profile.js";
import { settle } from "./settle.js";
import type {
  Auth,
  Finding,
  Mission,
  MissionResult,
  Persona,
  RunReport,
  StepRecord,
} from "./types.js";

/**
 * How many times the agent may take the SAME action from the SAME page-state
 * before the engine declares the mission stuck. Keying on (action + state)
 * rather than a consecutive-repeat counter catches both a dead control clicked
 * over and over AND a cycle that alternates between a few states/actions
 * (e.g. Playground↔Knowledge, or open-dialog↔Cancel) — neither of which is a
 * run of identical consecutive actions. Form-fills don't trip it: each field is
 * a distinct action signature, so no (action+state) pair recurs.
 */
const MAX_ACTION_REVISITS = 3;

/**
 * How many early steps to watch for a DELAYED gate redirect. Some apps load the
 * target, then client-redirect away a beat later (a tier/auth check that
 * resolves after first paint), which the post-goto check can't see.
 */
const GATE_GRACE_STEPS = 3;

/** Finding kinds that mean the app itself broke (or leaked) during the mission. */
const HARD_FINDING_KINDS = new Set<string>([
  "page_error",
  "http_error",
  "body_error_signature",
  // A critical authz break or a leaked secret must veto a "passed" outcome just
  // like a 5xx — these are real defects, not agent limitations. Both halves of
  // the authz split count (an unauthenticated reach is at least as severe as an
  // authenticated-but-under-privileged one).
  "broken_authz",
  "missing_authn",
  "sensitive_data_exposure",
]);

/**
 * The HTTP status of the document the crawl actually LANDED on: the last GET
 * response whose normalized URL matches the landed URL. Used to populate
 * StepRecord.status so the authz differential can distinguish a route that
 * served a 2xx document from one that returned a gated 3xx/4xx/5xx. Returns
 * undefined when no matching GET was captured (then "reached" is assumed, the
 * conservative default — same as before this signal existed).
 */
function landedDocumentStatus(
  responses: ResponseEvent[],
  landedUrl: string,
): number | undefined {
  const target = normalizeRoute(landedUrl);
  let status: number | undefined;
  for (const r of responses) {
    if (r.method === "GET" && normalizeRoute(r.url) === target) {
      status = r.status; // keep the LAST matching GET
    }
  }
  return status;
}

/** True if the mission hit a hard functional failure (crash / uncaught
 *  exception / 5xx) — such a mission must not be reported as "passed". */
function hasHardFailure(findings: Finding[]): boolean {
  return findings.some(
    (f) =>
      HARD_FINDING_KINDS.has(f.kind) &&
      (f.severity === "critical" || f.severity === "high"),
  );
}

/**
 * Inverse of the hard-failure veto. The LLM judge can over-report a `goal_failed`
 * as high/critical when the AGENT failed to drive the flow (looped on a field,
 * clicked a correctly-disabled button, ran out of steps) or the goal was
 * un-gradeable — on a page that never actually broke. Without a deterministic
 * hard-failure signal (page_error / 5xx / crash signature) we can't attribute
 * the failure to the app, so downgrade such findings to low. This keeps agent
 * limitations from masquerading as critical product bugs in the report and the
 * CI gate; the goal is still recorded (and the mission outcome still "failed").
 */
function calibrateGoalFailedSeverity(findings: Finding[]): void {
  if (hasHardFailure(findings)) return;
  // A no_progress finding is a deterministic "the control did nothing" signal —
  // weak evidence the APP (not just the agent) may be at fault — so floor the
  // downgrade at medium rather than low, keeping a possibly-dead control visible.
  // With no such signal, a goal_failed without a hard failure is an agent
  // limitation / un-gradeable goal → low.
  const RANK = ["low", "medium", "high", "critical"];
  const floor = findings.some((f) => f.kind === "no_progress")
    ? "medium"
    : "low";
  for (const f of findings) {
    if (
      f.kind === "goal_failed" &&
      RANK.indexOf(f.severity) > RANK.indexOf(floor)
    ) {
      f.severity = floor as Finding["severity"];
      f.detail =
        (floor === "medium"
          ? `[weakly corroborated — a no-progress signal suggests a possibly-dead ` +
            `control, but no crash/5xx/error signature was observed; medium confidence] `
          : `[unverified — no crash, 5xx, or error signature was observed during this ` +
            `mission, so the goal failure can't be attributed to the app (likely an agent ` +
            `limitation or an un-gradeable goal)] `) + `\n${f.detail}`;
    }
  }
}

/** Next replay decision from a recipe, with the ref re-resolved against the
 *  current page. Returns null when there's no recipe, it's exhausted, or the
 *  recorded target no longer matches (caller then falls back to the LLM). */
function recipeDecision(
  recipe: Recipe | null,
  cursor: number,
  obs: Observation,
): Decision | null {
  if (!recipe || cursor >= recipe.steps.length) return null;
  const step = recipe.steps[cursor];
  if (!step) return null;
  const action = resolveStep(step, obs);
  if (!action) return null;
  // Coordinate gestures are viewport-relative pixels — don't replay them at a
  // different window size; fall back to the LLM instead.
  const coord =
    action.type === "click_at" ||
    action.type === "double_click" ||
    action.type === "drag";
  if (
    coord &&
    recipe.viewport.width > 0 &&
    (recipe.viewport.width !== obs.viewport.width ||
      recipe.viewport.height !== obs.viewport.height)
  ) {
    return null;
  }
  return { action, rationale: "replay (cached recipe)" };
}

export interface EngineOptions {
  llm: LLMClient;
  runDir: string;
  headless: boolean;
  /** Record a video + Playwright trace per mission. */
  record: boolean;
  /** Optional tag filter; only missions with a matching tag run. */
  onlyTag?: string;
  /**
   * Directory for action recipes (record-and-replay). When set, a mission with
   * a cached recipe replays it deterministically (falling back to the LLM on a
   * mismatch), and a mission that passes saves/updates its recipe.
   */
  recipesDir?: string;
  /**
   * Directory for the known-bugs baseline. When set, findings are classified
   * new/known/muted against the profile's baseline, which is then updated.
   */
  baselineDir?: string;
  /**
   * Directory for the per-profile learned-knowledge store. When set, confident
   * learned facts (route gates, dead controls, route offerings) are merged into
   * the Knowledge handed to the acting agent. Absent = no merge (identical to
   * before). See learned.ts.
   */
  learnedDir?: string;
  /**
   * Directory for the per-profile cross-run coverage memory. When set, the run
   * loads which affordances have ever been exercised and tells the agent which
   * visible controls have NEVER been tried (in this or any past run), then folds
   * this run's coverage back in. Absent = no cross-run memory. See coverageStore.ts.
   */
  coverageMemDir?: string;
  /**
   * Auth strategy for the browser session. Defaults to the profile's auth (or
   * "none"). The tier/auth matrix overrides this per variant to diff the app
   * across access levels.
   */
  auth?: Auth;
  /**
   * Adversarial verify: after the LLM judge, run a skeptic over each judgment-tier
   * finding (goal_failed / ux_issue / inconsistency) and drop the ones it can't
   * defend against the page. One extra judge call per such finding, bought only
   * when precision matters. Opt-in via --verify.
   */
  verify?: boolean;
}

export async function runProfile(
  loaded: LoadedProfile,
  opts: EngineOptions,
): Promise<RunReport> {
  const { profile, baseDir } = loaded;
  const fixtureResolver = makeFixtureResolver(baseDir);
  const startedAt = new Date().toISOString();
  const results: MissionResult[] = [];

  const missions = opts.onlyTag
    ? profile.missions.filter((m) => m.tags.includes(opts.onlyTag!))
    : profile.missions;

  // Self-improvement inputs — both optional sidecars; an absent one leaves
  // behavior identical to before. The baseline is loaded UP FRONT so that
  // operator-muted findings can be fed to the judge as exclusions DURING the
  // run (the mute→judge bridge), then the same object is reused at the end to
  // classify + persist. The learned store is merged into the Knowledge the
  // acting agent sees (agent-only — the judge variant omits routes).
  const baseline = opts.baselineDir
    ? loadBaseline(opts.baselineDir, profile.name)
    : null;
  const muted = baseline ? mutedExclusions(baseline) : [];
  // Cross-run coverage memory: which affordances were ever exercised before, so
  // the agent can be told what's never been tried. Loaded up front; this run is
  // folded back in (and persisted) at the end.
  const coverageMem = opts.coverageMemDir
    ? loadCoverage(opts.coverageMemDir, profile.name)
    : null;
  const historicalExercised = coverageMem
    ? historicalExercisedKeys(coverageMem)
    : undefined;
  const effectiveKnowledge = opts.learnedDir
    ? mergeLearned(
        profile.knowledge,
        loadLearned(opts.learnedDir, profile.name),
        new Date().toISOString(),
      )
    : profile.knowledge;

  for (const mission of missions) {
    if (profile.resetCommand) {
      try {
        execSync(profile.resetCommand, { stdio: "ignore" });
      } catch {
        /* reset is best-effort; a failed reset shouldn't abort the run */
      }
    }

    const persona =
      profile.personas.find((p) => p.name === mission.persona) ??
      profile.personas[0]!;
    results.push(
      await runMission(
        profile.name,
        profile.baseUrl,
        profile.invariants,
        mission,
        persona,
        effectiveKnowledge,
        profile.security,
        {
          ...opts,
          fixtureResolver,
          auth: opts.auth ?? profile.auth,
          mutedExclusions: muted,
          historicalExercised,
        },
      ),
    );
  }

  // Coverage: the distinct routes the run actually reached (from the step urls),
  // and which routes the knowledge block declares that were never visited.
  const routesVisited = new Set<string>();
  for (const r of results) {
    for (const s of r.steps) routesVisited.add(normalizeRoute(s.url));
  }
  const knownRoutes = new Set(
    (profile.knowledge?.routes ?? []).map((r) => normalizeRoute(r.path)),
  );
  const unvisitedKnownRoutes = [...knownRoutes].filter(
    (k) => !routesVisited.has(k),
  );

  // Known-bugs baseline: stamp each finding new/known/muted against the
  // profile's baseline (loaded up front above) and fold this run into it.
  if (baseline && opts.baselineDir) {
    classifyAndUpdate(
      results.flatMap((r) => r.findings),
      baseline,
      new Date().toISOString(),
    );
    try {
      saveBaseline(opts.baselineDir, profile.name, baseline);
    } catch {
      /* baseline persistence is best-effort */
    }
  }

  // Fold this run's coverage into the cross-run memory so the next run knows
  // what's still never been exercised.
  if (coverageMem && opts.coverageMemDir) {
    mergeRunCoverage(coverageMem, results, new Date().toISOString());
    try {
      saveCoverage(opts.coverageMemDir, profile.name, coverageMem);
    } catch {
      /* coverage memory persistence is best-effort */
    }
  }

  return {
    profile: profile.name,
    baseUrl: profile.baseUrl,
    startedAt,
    finishedAt: new Date().toISOString(),
    results,
    coverage: {
      routesVisited: [...routesVisited].sort(),
      unvisitedKnownRoutes: unvisitedKnownRoutes.sort(),
      observation: computeObservationCoverage(results),
    },
  };
}

async function runMission(
  profileName: string,
  baseUrl: string,
  invariants: LoadedProfile["profile"]["invariants"],
  mission: Mission,
  persona: Persona,
  knowledge: LoadedProfile["profile"]["knowledge"],
  /** Optional deterministic security oracles; absent → identical to before. */
  sec: LoadedProfile["profile"]["security"],
  opts: EngineOptions & {
    fixtureResolver: (n: string) => string;
    /** Operator-vetted muted-finding notes fed to the judge as exclusions. */
    mutedExclusions?: string[];
    /** Affordance keys exercised in some past run (cross-run coverage memory). */
    historicalExercised?: Set<string>;
  },
): Promise<MissionResult> {
  const startedAt = new Date().toISOString();
  // Record-and-replay: a cached recipe (if --replay/recipesDir) drives the
  // mission deterministically; we also record the executed actions to save an
  // updated recipe when the mission passes.
  let recipe = opts.recipesDir
    ? loadRecipe(opts.recipesDir, profileName, mission.id)
    : null;
  // A recipe recorded for a different start path is stale — ignore it (the run
  // then cleanly re-learns with the LLM and re-saves).
  if (recipe && recipe.startPath !== mission.startPath) recipe = null;
  const recordedSteps: RecipeStep[] = [];
  let replayCursor = 0;
  let replaying = recipe !== null;
  let recordedViewport: { width: number; height: number } | undefined;
  const recordDir = opts.record
    ? join(opts.runDir, "missions", mission.id)
    : undefined;
  if (recordDir) mkdirSync(recordDir, { recursive: true });
  // Body capture is on only when the profile opts into security oracles — a
  // profile without a `security` block captures no bodies (identical to before).
  const session = new BrowserSession(
    baseUrl,
    opts.headless,
    recordDir,
    Boolean(sec),
  );
  // Free-text the agent typed this mission, surfaced to the reflection oracle as
  // candidate injection markers (only metacharacter-bearing ones are checked).
  const typedMarkers: string[] = [];
  const steps: StepRecord[] = [];
  const findings: Finding[] = [];
  // Fingerprint -> the Finding already recorded for it, so a multi-step loop on
  // a broken page collapses N identical console_error/page_error/etc. into one
  // Finding with `occurrences` bumped, instead of N copies. Per-mission scope.
  // Declared before the try block so the catch-block crash finding records too.
  const seen = new Map<string, Finding>();
  const record = (f: Finding): void => recordFinding(findings, seen, f);
  const history: string[] = [];
  let outcome: MissionResult["outcome"] = "stuck";

  const base = { missionId: mission.id, persona: persona.name, repro: history };

  // A route-gate finding: opening startPath leads somewhere unrelated without
  // the user getting there on purpose. Shared by the immediate (post-goto) and
  // delayed (in-loop) detectors so they report identically.
  const gatedFinding = (landedUrl: string): Finding => ({
    kind: "route_gated",
    severity: "medium",
    ...base,
    repro: history.length
      ? [...history, `Redirected to ${pathOf(landedUrl)} (route gate)`]
      : [
          `Opened ${mission.startPath}`,
          `Redirected to ${pathOf(landedUrl)} before any action`,
        ],
    title: `Route gated: ${mission.startPath} → ${pathOf(landedUrl)}`,
    detail:
      `Opening "${mission.startPath}" leads to "${pathOf(landedUrl)}" without the user getting there on purpose — ` +
      `typically an auth, tier, or feature-flag gate, or an unmet precondition (the redirect may fire on load or a ` +
      `beat later once the check resolves). The mission was skipped to avoid a misleading failure. If the redirect ` +
      `is itself the defect, investigate the gate; otherwise run with the precondition satisfied (e.g. the right tier).`,
    url: landedUrl,
    timestamp: new Date().toISOString(),
  });

  try {
    await session.start(opts.auth ?? { strategy: "none" });

    if (mission.mode === "crawl") {
      // CRAWL MODE: a deterministic route sweep — navigate each route and run the
      // invariant oracles on it. No LLM, no judge: a fast, broad "does every
      // route load without a crash / 5xx / console error" pass.
      // A dynamic "[id]" segment isn't a literally navigable URL, so never try
      // to goto one — whether it came from the mission or the knowledge fallback.
      const routes = (
        mission.routes.length
          ? mission.routes
          : (knowledge?.routes ?? []).map((r) => r.path)
      ).filter((r) => !r.includes("["));
      for (let i = 0; i < routes.length; i++) {
        const route = routes[i]!;
        try {
          await session.goto(route);
          await settle(session.page);
        } catch (e) {
          record({
            kind: "agent_stuck",
            severity: "high",
            ...base,
            repro: [`Visited ${route}`],
            title: `Failed to open ${route}`,
            detail: e instanceof Error ? (e.stack ?? e.message) : String(e),
            url: route,
            timestamp: new Date().toISOString(),
          });
          continue;
        }
        const obs = await observe(session.page);
        const shotPath = join("screenshots", `${mission.id}-route-${i}.png`);
        writeFileSync(
          join(opts.runDir, shotPath),
          await captureScreenshot(session.page),
        );
        const events = await session.drainEvents();
        const crawlFindings = checkInvariants(
          events,
          invariants,
          obs,
          { ...base, repro: [`Visited ${route}`] },
          sec,
          typedMarkers,
        );
        for (const f of crawlFindings) {
          f.screenshotPath = shotPath;
          record(f);
        }
        steps.push({
          index: steps.length,
          url: session.url(),
          actionSummary: `Visited ${route}`,
          rationale: "crawl",
          screenshotPath: shotPath,
          // The LANDED document's GET status: the last GET response whose URL is
          // the page we ended on. The authz differential treats a non-2xx
          // document as "not reached" (gated/redirected/error), so a correctly
          // gated 403/302 route never becomes a false broken_authz.
          status: landedDocumentStatus(events.responses, session.url()),
          // Grounding for the loop proposer: what this page actually offers.
          affordances: obs.elements
            .map((e) => e.label)
            .filter(Boolean)
            .slice(0, 20),
        });
      }
      outcome = hasHardFailure(findings) ? "failed" : "passed";
    } else {
      await session.goto(mission.startPath);
      // The start-page LOAD batch — NOT discarded as "noise". We run the invariant
      // oracles on it below (once we have the first observation) so a load-time bug
      // on the page the mission STARTS on — a 5xx, a crash, a broken asset / dead
      // link, an a11y violation — is caught in agent mode too, exactly as crawl mode
      // already does, instead of being silently dropped before the first action.
      const loadBatch = await session.drainEvents();

      // Immediate precondition check: if opening the start path already landed
      // somewhere unrelated, the mission is behind an auth/tier/feature gate.
      // Acting from the wrong page produces a misleading "goal_failed" + wasted
      // steps; record one honest finding and skip instead.
      const landedUrl = session.url();
      if (isGatedRedirect(mission.startPath, landedUrl)) {
        outcome = "skipped";
        // A gated start page is skipped without running the load oracle: the page
        // we landed on is the GATE target, so its load findings would be the wrong
        // page's, confusingly attributed to startPath. Crawl mode covers the route
        // unconditionally if it's a known route.
        record(gatedFinding(landedUrl));
      } else {
        // Observe once up front, then carry each step's post-action observation
        // forward as the next step's pre-decision observation — the page doesn't
        // change between them, so this is one observe (DOM scan + screenshot) per
        // step instead of two.
        let carriedObs = await observe(session.page);
        let lastObs = carriedObs;
        // Per-page snapshots accumulated as the agent navigates, so the judge
        // can spot data the app presents inconsistently ACROSS views (a run
        // "success" in the list but "failed" on its detail). Deduped + capped at
        // judge time; text is trimmed per page to bound the prompt.
        const pageTrail: { url: string; text: string }[] = [
          { url: carriedObs.url, text: carriedObs.visibleText.slice(0, 700) },
        ];
        // Run the load-time oracles on the start-page batch (captured above),
        // attributed to the page as "Loaded <startPath>" rather than to any agent
        // action. A clean start page yields nothing (the existing agent cases load
        // clean); a broken one is now reported instead of dropped. Intentional: a
        // hard finding here (a crash/5xx on the start page) vetoes a "passed" — you
        // can't pass a mission whose page is broken on arrival (mirrors crawl). The
        // findings are per-mission scoped, so missions sharing a start route each
        // re-report it; that's real signal, deduped cross-run by the baseline.
        for (const f of checkInvariants(
          loadBatch,
          invariants,
          carriedObs,
          { ...base, repro: [`Loaded ${mission.startPath}`] },
          sec,
          typedMarkers,
        )) {
          record(f);
        }
        // (action+state) -> times taken, to detect dead controls and cycles.
        const actionStateVisits = new Map<string, number>();
        // Set once the agent intentionally navigates somewhere (a successful
        // action that changed the URL). Until then, any drift to an unrelated
        // path is an automatic (gate) redirect, not the agent's doing.
        let intentionalNav = false;
        // Once a page has failed to quiesce a couple of times (live canvas,
        // streaming chat), stop paying settle()'s full caps every step.
        let unsettledStreak = 0;
        let brokeForNoProgress = false;
        // Frontier: known routes not yet visited this mission, to bias the
        // agent toward unexplored areas.
        const knownRouteSet = new Set(
          (knowledge?.routes ?? []).map((r) => normalizeRoute(r.path)),
        );
        const visitedRoutes = new Set<string>();

        for (let i = 0; i < mission.maxSteps; i++) {
          const obs = carriedObs;
          lastObs = obs;
          visitedRoutes.add(normalizeRoute(obs.url));

          // Delayed gate: the target may client-redirect a beat after load (a
          // tier/auth check resolving after first paint), which the post-goto
          // check misses. If we've drifted to an unrelated path in the first few
          // steps without the agent intentionally navigating there, treat it as a
          // gate too.
          if (
            i < GATE_GRACE_STEPS &&
            !intentionalNav &&
            isGatedRedirect(mission.startPath, obs.url)
          ) {
            outcome = "skipped";
            record(gatedFinding(obs.url));
            break;
          }

          // Decide: replay the cached recipe step if it still resolves against the
          // current page; otherwise (no recipe, exhausted, or a descriptor miss)
          // fall back to the LLM and stop replaying from here on.
          // Drop dynamic routes ("/x/[id]") — a literal "[id]" isn't navigable,
          // and a real visit to "/x/<uuid>" already normalizes to it and clears
          // it from the frontier.
          const frontier = knownRouteSet.size
            ? [...knownRouteSet].filter(
                (r) => !visitedRoutes.has(r) && !r.includes("["),
              )
            : undefined;
          // Live affordance frontier: labeled controls visible now that haven't
          // been exercised yet this mission — biases the agent to exhaust the
          // page's surface instead of finishing the instant its goal is met.
          const untried = untriedAffordances(steps, obs);
          // Cross-run memory: of those, the ones never exercised in ANY past run
          // — the standing coverage gaps to prioritize.
          const obsRoute = normalizeRoute(obs.url);
          const neverEver = opts.historicalExercised
            ? untried.filter(
                (a) => !opts.historicalExercised!.has(affordanceKey(obsRoute, a)),
              )
            : [];
          const ctx: AgentContext = {
            persona,
            mission,
            history,
            knowledge,
            frontier,
            affordanceFrontier: untried.length ? untried : undefined,
            neverTriedEver: neverEver.length
              ? neverEver.map((a) => a.label)
              : undefined,
          };
          let decision = replaying
            ? recipeDecision(recipe, replayCursor, obs)
            : null;
          const fromReplay = decision !== null;
          if (decision) {
            replayCursor++;
          } else {
            replaying = false; // recipe exhausted or step no longer matches
            decision = await opts.llm.decide(obs, ctx);
          }
          if (recordedViewport === undefined) recordedViewport = obs.viewport;

          if (decision.action.type === "finish") {
            outcome = decision.action.success ? "passed" : "failed";
            history.push(`Finished: ${decision.action.summary}`);
            recordedSteps.push({ action: decision.action }); // terminal step
            break;
          }

          // Descriptor of the target, captured against the obs the decision was
          // made on; only committed to the recipe if the action actually succeeds.
          const recordTarget = describeTarget(decision.action, obs);

          // Mark the target (element highlight or coordinate marker) BEFORE
          // acting, so the saved screenshot and the video show the agent's intent.
          const annotated = await annotateAction(session.page, decision.action);
          const shotPath = join("screenshots", `${mission.id}-step-${i}.png`);
          writeFileSync(
            join(opts.runDir, shotPath),
            await captureScreenshot(session.page),
          );
          // Brief pause so the highlight is visible in the recorded video.
          if (annotated) await session.page.waitForTimeout(350);

          const result = await executeAction(
            session.page,
            decision.action,
            opts.fixtureResolver,
          );

          // Accumulate typed text as a candidate injection marker for the
          // reflection oracle (only metacharacter-bearing markers are checked).
          if (
            result.ok &&
            !result.stale &&
            decision.action.type === "type" &&
            decision.action.text
          ) {
            typedMarkers.push(decision.action.text);
          }

          // Let any navigation/render settle, then measure what actually changed.
          // Degrade to fast settling once the page has proven it never quiesces,
          // so a live canvas / streaming page doesn't cost full caps every step.
          const settled = await settle(session.page, {
            fast: unsettledStreak >= 2,
          });
          unsettledStreak = settled ? 0 : unsettledStreak + 1;
          const postObs = await observe(session.page);
          lastObs = postObs;
          carriedObs = postObs; // reuse as next step's pre-decision observation
          pageTrail.push({
            url: postObs.url,
            text: postObs.visibleText.slice(0, 700),
          });
          const diff = diffProgress(obs, postObs);

          // Record only a SUCCESSFULLY-executed action, so a stale/failed step
          // never gets baked into the saved recipe.
          if (result.ok && !result.stale) {
            recordedSteps.push({
              action: decision.action,
              target: recordTarget,
            });
          }
          // If a REPLAYED step failed or went stale, the recipe no longer matches
          // reality — stop replaying and let the LLM re-decide from here (so we
          // never march on to a recorded finish and report a false pass).
          if (fromReplay && (!result.ok || result.stale)) {
            replaying = false;
          }

          // DOM actions get a progress note ("no change: still on /knowledge") —
          // the coarse url|title|element-count signal is meaningful for them.
          // Canvas gestures draw pixels the signal can't see, so they get a plain
          // summary (a "no change" note would be misleading there).
          const t = decision.action.type;
          const domAction =
            t === "click" || t === "type" || t === "upload" || t === "navigate";
          const coordAction =
            t === "click_at" || t === "double_click" || t === "drag";
          const interactive = domAction || coordAction;
          const baseSummary = result.ok
            ? result.summary
            : result.error
              ? `${result.summary}: ${result.error}`
              : result.summary;
          const summary =
            result.ok && domAction
              ? `${baseSummary} (${progressNote(diff, postObs)})`
              : baseSummary;
          history.push(summary);
          steps.push({
            index: i,
            url: session.url(),
            actionSummary: summary,
            rationale: decision.rationale,
            screenshotPath: shotPath,
            // The surface the agent saw before deciding (obs, pre-action) plus
            // the refs it touched — feeds observation-coverage measurement.
            observed: {
              url: obs.url,
              elements: obs.elements.map((e) => ({
                ref: e.ref,
                role: e.role,
                label: e.label,
                ...(e.cap ? { cap: e.cap } : {}),
              })),
              ...(obs.truncated ? { truncated: obs.truncated } : {}),
              actedRefs: actionRefs(decision.action),
            },
          });

          const events = await session.drainEvents();
          const stepFindings = checkInvariants(
            events,
            invariants,
            postObs,
            { ...base, repro: [...history] },
            sec,
            [...typedMarkers],
          );
          for (const f of stepFindings) {
            f.screenshotPath = shotPath;
            record(f);
          }

          // A persistently-occluded control is a real "users can't click this"
          // defect — report it as its own finding (deduped across steps) instead
          // of letting the blocked click read as a generic dead control.
          if (result.occluded) {
            record({
              kind: "occluded_control",
              severity: "medium",
              ...base,
              repro: [...history],
              title: `A visible control is covered by another element and can't be clicked`,
              detail: result.summary,
              url: session.url(),
              screenshotPath: shotPath,
              timestamp: new Date().toISOString(),
            });
          }

          // Mark intentional navigation, so the delayed-gate check can tell an
          // automatic (gate) redirect from the agent choosing to move.
          if (result.ok && diff.urlChanged) intentionalNav = true;

          // Loop guard: count how often the agent takes the same action from the
          // same page-state. A dead control clicked repeatedly AND a short cycle
          // that alternates between a few states/actions both revisit the same
          // (action+state) pairs; break with one no_progress finding instead of
          // looping to maxSteps. Form-fills (and distinct-coordinate gestures)
          // don't trip it — each is a distinct action, so no pair recurs.
          if (interactive) {
            const key = `${actionSignature(decision.action)}@${progressSignature(obs)}`;
            const visits = (actionStateVisits.get(key) ?? 0) + 1;
            actionStateVisits.set(key, visits);
            if (visits >= MAX_ACTION_REVISITS) {
              outcome = "stuck";
              brokeForNoProgress = true;
              record({
                kind: "no_progress",
                severity: "medium",
                ...base,
                repro: [...history],
                title: `No progress: "${actionLabel(decision.action)}" repeated from the same state (×${visits})`,
                detail:
                  `The agent took the same action from the same page-state ${visits} times without making progress ` +
                  `(looping — a dead control or an A↔B cycle, last on ${pathOf(session.url())}). ` +
                  `Likely a broken/disabled control or a dead-end flow.`,
                url: session.url(),
                timestamp: new Date().toISOString(),
              });
              break;
            }
          }
        }

        // A delayed gate detected mid-loop skips the rest (no agent_stuck, no
        // judge) — there's nothing to fairly judge on a gated page.
        if (outcome !== "skipped") {
          if (outcome === "stuck" && !brokeForNoProgress) {
            record({
              kind: "agent_stuck",
              severity: "medium",
              ...base,
              repro: [...history],
              title: `Agent ran out of steps on "${mission.goal.slice(0, 60)}"`,
              detail: `Reached the ${mission.maxSteps}-step limit without finishing.`,
              url: session.url(),
              timestamp: new Date().toISOString(),
            });
          }

          const judgeFindings = await judgeMission(
            opts.llm,
            mission,
            lastObs,
            history,
            {
              ...base,
              repro: [...history],
            },
            knowledge,
            opts.mutedExclusions,
            pageTrail,
          );
          let finalJudge = judgeFindings;
          if (opts.verify && judgeFindings.length) {
            const vr = await verifyFindings(opts.llm, judgeFindings, lastObs);
            finalJudge = vr.kept;
            if (vr.dropped.length) {
              console.log(
                `  ↳ verify dropped ${vr.dropped.length} unverified judgment finding(s): ${vr.dropped
                  .map((d) => d.finding.kind)
                  .join(", ")}`,
              );
            }
          }
          for (const f of finalJudge) record(f);
          if (
            finalJudge.some((f) => f.kind === "goal_failed") &&
            outcome === "passed"
          ) {
            outcome = "failed";
          }
          // A hard functional failure during the mission (a crash, an uncaught
          // exception, a 5xx) means the app broke — never report that as "passed",
          // whatever the LLM judge concluded. The deterministic oracles are the
          // reliable backstop against a lenient/nondeterministic judge.
          if (outcome === "passed" && hasHardFailure(findings)) {
            outcome = "failed";
          }
          // ...and the inverse: an uncorroborated goal_failed is downgraded so an
          // agent limitation isn't reported as a critical product defect.
          calibrateGoalFailedSeverity(findings);
        }
      }
    }
  } catch (err) {
    outcome = "error";
    record({
      kind: "agent_stuck",
      severity: "high",
      ...base,
      repro: [...history],
      title: `Mission crashed: ${err instanceof Error ? err.message.slice(0, 60) : "unknown"}`,
      detail: err instanceof Error ? (err.stack ?? err.message) : String(err),
      url: session.url(),
      timestamp: new Date().toISOString(),
    });
  } finally {
    if (recordDir) {
      try {
        await session.stopTracing(join(recordDir, "trace.zip"));
      } catch {
        /* tracing is best-effort */
      }
    }
    await session.close(recordDir ? join(recordDir, "video.webm") : undefined);
  }

  // Cache the action path of a passing mission so a later --replay run can
  // reproduce it without decide() calls (best-effort; a failed save never fails
  // a run). Only successfully-executed steps were recorded above.
  if (opts.recipesDir && outcome === "passed" && recordedSteps.length) {
    try {
      saveRecipe(opts.recipesDir, profileName, {
        missionId: mission.id,
        startPath: mission.startPath,
        recordedAt: new Date().toISOString(),
        viewport: recordedViewport ?? { width: 1280, height: 900 },
        steps: recordedSteps,
      });
    } catch {
      /* recipe caching is best-effort */
    }
  }

  return {
    missionId: mission.id,
    persona: persona.name,
    tracePath: recordDir ? `missions/${mission.id}/trace.zip` : undefined,
    videoPath: recordDir ? `missions/${mission.id}/video.webm` : undefined,
    goal: mission.goal,
    outcome,
    steps,
    findings,
    startedAt,
    finishedAt: new Date().toISOString(),
  };
}
