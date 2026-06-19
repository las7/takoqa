/**
 * The autonomous exploration loop.
 *
 * Each round the planner proposes fresh missions (creative, novelty-pressured),
 * the engine runs them, findings are classified against the persisted baseline,
 * and a journal accumulates so the next round knows what's been done. The loop
 * stops when it goes "dry" (K consecutive rounds with no NEW findings — the
 * baseline is what makes "new" meaningful), hits the round cap, or exhausts an
 * optional step budget.
 *
 * Reuses runProfile per round: classification against the persistent baseline
 * gives the new-vs-known signal for free. The round executor + proposer are
 * injectable so the loop control is unit-testable without a browser or LLM.
 */

import type { LLMClient } from "./agent.js";
import type { LoadedProfile } from "./profile.js";
import type { Finding, Mission, RunReport } from "./types.js";
import { MissionSchema } from "./types.js";
import { runProfile, type EngineOptions } from "./engine.js";
import { normalizeRoute } from "./progress.js";
import {
  distillFromLoop,
  emptyStore,
  loadLearned,
  mergeLearned,
  recentAttempted,
  type LearnedStore,
  type LoopJournal,
} from "./learned.js";
import {
  ALL_LEVERS,
  actionFrontier,
  buildProposePrompt,
  parseProposedMissions,
  type Levers,
  type ProposeContext,
} from "./planner.js";

export interface LoopConfig {
  /** Hard cap on proposing rounds (round 0 is the crawl, not counted here). */
  maxRounds: number;
  /** Stop after this many consecutive rounds with no NEW findings (K). */
  dryRounds: number;
  missionsPerRound: number;
  /** Optional: stop once total agent steps exceed this. */
  budgetSteps?: number;
  levers: Levers;
}

export const DEFAULT_LOOP: LoopConfig = {
  maxRounds: 8,
  dryRounds: 2,
  missionsPerRound: 3,
  levers: ALL_LEVERS,
};

export interface RoundResult {
  round: number;
  goals: string[];
  newFindings: number;
  report: RunReport;
}

export interface LoopResult {
  rounds: RoundResult[];
  stopped: "dry" | "max-rounds" | "budget";
  allFindings: Finding[];
  coverage: string[];
  /**
   * Learnings distilled from this loop's journal (route gates, dead controls,
   * route offerings, attempted goals). The caller merges this delta into the
   * persisted learned store so the next session is smarter — the journal is no
   * longer thrown away. See learned.ts.
   */
  learnings: LearnedStore;
}

export interface LoopDeps {
  propose: (prompt: string) => Promise<string>;
  runRound: (missions: Mission[], round: number) => Promise<RunReport>;
}

/** Hard-failure kinds always count as significant new signal, at any severity. */
const HARD_KINDS = new Set([
  "page_error",
  "http_error",
  "body_error_signature",
  // A newly-found authz break or leaked secret is real signal — it must keep the
  // loop alive (dig deeper) rather than letting the round count as dry. Both
  // halves of the authz split (broken_authz + missing_authn) count.
  "broken_authz",
  "missing_authn",
  "sensitive_data_exposure",
]);

/**
 * New findings that count as real signal for dry-detection: a hard failure (any
 * severity) or anything critical/high. Low/medium soft findings (a downgraded
 * agent-limited goal_failed, a ux nit, an expected route_gate) do NOT keep the
 * loop alive — otherwise it never converges on a stream of over-reports.
 */
function countNew(report: RunReport): number {
  return report.results
    .flatMap((r) => r.findings)
    .filter(
      (f) =>
        f.status === "new" &&
        (HARD_KINDS.has(f.kind) ||
          f.severity === "critical" ||
          f.severity === "high"),
    ).length;
}

function countSteps(report: RunReport): number {
  return report.results.reduce((n, r) => n + r.steps.length, 0);
}

export async function runExploreLoop(
  loaded: LoadedProfile,
  opts: EngineOptions,
  llm: LLMClient,
  config: LoopConfig,
  deps?: Partial<LoopDeps>,
): Promise<LoopResult> {
  const { profile } = loaded;
  const propose = deps?.propose ?? ((p: string) => llm.propose(p));
  const runRound: LoopDeps["runRound"] =
    deps?.runRound ??
    ((missions) =>
      runProfile(
        { ...loaded, profile: { ...profile, missions } },
        { ...opts, onlyTag: undefined },
      ));

  // Cross-session memory: load the persisted learned store so this session's
  // novelty pressure includes missions PRIOR sessions already tried (otherwise a
  // fresh --loop re-proposes the same goals every invocation), and so the
  // proposer's app map carries learned routes/offerings.
  const learned = opts.learnedDir
    ? loadLearned(opts.learnedDir, profile.name)
    : emptyStore();

  const rounds: RoundResult[] = [];
  const visited = new Set<string>();
  // Seed from prior sessions (bounded) so attempted-goal novelty is cumulative,
  // not intra-session only. New goals are appended below as rounds run. Only the
  // NEW goals (past `seedCount`) are distilled back, so a re-seeded prior goal
  // isn't perpetually re-stamped to `now` and can age out of the store via prune.
  const attempted: string[] = recentAttempted(learned, 50);
  const seedCount = attempted.length;
  const allFindings: Finding[] = [];
  const allSummaries: string[] = [];
  // route -> what that page actually offers (from the crawl), for grounding.
  const routeAffordances = new Map<string, string[]>();
  let totalSteps = 0;

  const accumulate = (report: RunReport) => {
    for (const r of report.results) {
      for (const s of r.steps) {
        visited.add(normalizeRoute(s.url));
        allSummaries.push(s.actionSummary);
        if (s.affordances && s.affordances.length) {
          routeAffordances.set(normalizeRoute(s.url), s.affordances);
        }
      }
      allFindings.push(...r.findings);
    }
    for (const v of report.coverage.routesVisited) visited.add(v);
    totalSteps += countSteps(report);
  };

  // Round 0: the crawl seeds coverage + the baseline (so round 1's findings can
  // already be classified new-vs-known).
  const crawl = profile.missions.find((m) => m.mode === "crawl");
  if (crawl) {
    const report0 = await runRound([crawl], 0);
    accumulate(report0);
    rounds.push({
      round: 0,
      goals: ["(crawl)"],
      newFindings: countNew(report0),
      report: report0,
    });
  }

  // Merge learned facts into the app map the proposer grounds on (agent-side
  // knowledge, never the judge) — a learned route gate or offering surfaces here
  // so proposed missions account for it instead of rediscovering it.
  const mergedKnowledge = mergeLearned(
    profile.knowledge,
    learned,
    new Date().toISOString(),
  );
  const appMap = (mergedKnowledge?.routes ?? []).map((r) => ({
    path: r.path,
    description: r.description,
    requires: r.requires,
  }));
  const knownPaths = new Set(appMap.map((r) => normalizeRoute(r.path)));
  const groundedAppMap = () =>
    appMap.map((r) => ({
      ...r,
      affordances: routeAffordances.get(normalizeRoute(r.path)),
    }));

  let dry = 0;
  let stopped: LoopResult["stopped"] = "max-rounds";

  for (let round = 1; round <= config.maxRounds; round++) {
    const af = actionFrontier(allSummaries);
    const ctx: ProposeContext = {
      appName: profile.name,
      appMap: groundedAppMap(),
      visited: [...visited].sort(),
      unvisited: [...knownPaths].filter(
        (p) => !visited.has(p) && !p.includes("["),
      ),
      attempted: [...attempted],
      findings: allFindings.map((f) => ({
        title: f.title,
        kind: f.kind,
        severity: f.severity,
        status: f.status,
      })),
      actionsMissing: af.missing,
      personas: profile.personas,
      // The attacker lever attributes probes to personas marked adversarial.
      attackerPersonas: profile.personas.filter((p) => p.attacker),
      levers: config.levers,
      denylist: profile.explore?.denylist ?? [],
      count: config.missionsPerRound,
    };

    const proposed = parseProposedMissions(
      await propose(buildProposePrompt(ctx)),
      {
        personas: profile.personas.map((p) => p.name),
        max: config.missionsPerRound,
      },
    );

    // An empty proposal contributes no new signal — treat as a dry round.
    if (!proposed.length) {
      dry++;
      if (dry >= config.dryRounds) {
        stopped = "dry";
        break;
      }
      continue;
    }

    const missions: Mission[] = proposed.map((p, i) =>
      MissionSchema.parse({
        id: `explore-r${round}-${i}`,
        goal: p.goal,
        // Guard against a hallucinated route: only honor a proposed startPath if
        // it's a known route, else start at "/" and let the agent navigate.
        startPath: knownPaths.has(normalizeRoute(p.startPath))
          ? p.startPath
          : "/",
        persona: p.persona,
        hints: p.hints,
        tags: ["explore", "proposed"],
      }),
    );
    for (const p of proposed) attempted.push(p.goal);

    const report = await runRound(missions, round);
    accumulate(report);
    const newCount = countNew(report);
    rounds.push({
      round,
      goals: proposed.map((p) => p.goal),
      newFindings: newCount,
      report,
    });

    dry = newCount > 0 ? 0 : dry + 1;
    if (dry >= config.dryRounds) {
      stopped = "dry";
      break;
    }
    if (config.budgetSteps && totalSteps >= config.budgetSteps) {
      stopped = "budget";
      break;
    }
  }

  // Distill the journal we accumulated (route gates + dead controls from the
  // findings, route offerings from the crawl, attempted goals) into a learnings
  // delta. The caller (run.ts) merges it into the persisted store, so what this
  // loop discovered survives to the next session.
  const learnings = distillFromLoop(
    {
      routeOfferings: [...routeAffordances.entries()],
      findings: allFindings,
      // Only goals attempted THIS session — re-seeded prior goals keep their
      // original lastSeen so they can prune out instead of living forever.
      attempted: attempted.slice(seedCount),
    } satisfies LoopJournal,
    new Date().toISOString(),
  );

  return {
    rounds,
    stopped,
    allFindings,
    coverage: [...visited].sort(),
    learnings,
  };
}
