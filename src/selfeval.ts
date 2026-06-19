/**
 * Scored self-eval — regression-tests the harness against the planted-bug
 * fixture by running the REAL engine (no new oracle surface) and scoring its
 * findings against a ground-truth manifest (recall/precision, functional AND
 * security).
 *
 * Two SEPARATE passes are run and their findings merged:
 *   (a) FUNCTIONAL — agent/crawl missions over the functional routes, with NO
 *       security block (so the functional routes' missing headers are NOT
 *       counted as security false-positives).
 *   (b) SECURITY   — a crawl over ONLY the sec-* routes WITH a security block.
 * Keeping them separate is required: a functional route legitimately lacks
 * security headers, and a security crawl must not see the functional pages.
 *
 * scoreFixture is pure; runFixtureEval is the live orchestration. Both reuse
 * ProfileSchema / runProfile / MockClient / createRunDir — no invented engine
 * API. The fixture server + manifest live in test/, so they are INJECTED through
 * deps (rather than imported) to keep src/ free of test/ dependencies.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Action } from "./act.js";
import { MockClient } from "./agent.js";
import type { LLMClient } from "./agent.js";
import { runProfile } from "./engine.js";
import { runMatrix } from "./matrix.js";
import { normalizeRoute } from "./progress.js";
import { createRunDir } from "./report.js";
import type { ResolvedRouteSource } from "./routeSource.js";
import type { LoadedProfile } from "./profile.js";
import { ProfileSchema } from "./types.js";
import type {
  Finding,
  FindingKind,
  MissionResult,
  RunReport,
  Variant,
} from "./types.js";

/**
 * One ground-truth case in the self-eval manifest. The manifest itself lives in
 * test/ (co-located with the fixture); this is the shared shape.
 */
export interface PlantedCase {
  /** Stable id used in the score report (missed/caught lists name this). */
  id: string;
  /** The route the bug lives on (matched by normalizeRoute against findings). */
  route: string;
  /** Which oracle family is expected to catch it. */
  group: "functional" | "security";
  /** Finding kinds, ANY of which on a matching route counts the case CAUGHT. */
  expectedKinds: FindingKind[];
  /** True for a deliberately-clean route: it must produce ZERO findings of its group. */
  clean?: boolean;
}

export interface PerCaseScore {
  id: string;
  group: PlantedCase["group"];
  clean: boolean;
  /** True once a finding matched the case (or, for a clean case, no FP fired). */
  ok: boolean;
  /** Expected kinds the case actually caught on its route. */
  matchedKinds: FindingKind[];
}

export interface FalsePositive {
  id: string;
  route: string;
  kind: FindingKind;
  title: string;
}

export interface SelfEvalScore {
  /** caught / (caught + missed), over the non-clean cases. */
  recall: number;
  /** caught / (caught + falsePositives) — share of "real" findings that were expected. */
  precision: number;
  /** Non-clean case ids that fired their expected finding. */
  caught: string[];
  /** Non-clean case ids that did NOT fire any expected finding. */
  missed: string[];
  /** Findings of a case's group that landed on a clean route. */
  falsePositives: FalsePositive[];
  perCase: PerCaseScore[];
}

/** Finding kinds owned by the security oracles (used to scope clean FP checks). */
const SECURITY_KINDS = new Set<FindingKind>([
  "broken_authz",
  "missing_authn",
  "sensitive_data_exposure",
  "injection_reflection",
  "insecure_headers",
  "insecure_cookie",
  "verbose_error",
]);

/** Whether a finding kind belongs to the case's oracle family. */
function isGroupKind(kind: FindingKind, group: PlantedCase["group"]): boolean {
  const isSec = SECURITY_KINDS.has(kind);
  return group === "security" ? isSec : !isSec;
}

/**
 * Mission-id prefix used by the dedicated single-case functional missions, so a
 * finding can be attributed to its case even when it lands on a DIFFERENT url
 * than the case route (e.g. api-fail's http_error is on /api/boom; gated's
 * route_gated is on the /landing it bounced to). Kept in sync with
 * functionalProfile below.
 */
const FN_MISSION_PREFIX = "fn-";

/**
 * The findings attributable to a case. A finding belongs to a case when it is
 * connected to the case by EITHER axis:
 *   - the dedicated `fn-<id>` mission that exercised it (the functional agent
 *     missions — each case is its own single-mission run), OR
 *   - its own url matching the case route (the routes a crawl swept — loaderror,
 *     sec-*; each crawl finding carries the visited route as its url).
 * The dual axis is required because several planted findings land on a url other
 * than the route the mission started on (api-fail's http_error on /api/boom;
 * gated's route_gated on the /landing it bounced to) — those are caught by the
 * mission axis. The url axis stays EXACT so a multi-route crawl finding is
 * attributed only to the route it actually fired on (never cross-contaminating a
 * clean sibling route in the same crawl).
 */
function findingsForCase(report: RunReport, c: PlantedCase): Finding[] {
  const caseRoute = normalizeRoute(c.route);
  const matched: Finding[] = [];
  for (const result of report.results) {
    const dedicated = result.missionId === `${FN_MISSION_PREFIX}${c.id}`;
    for (const f of result.findings) {
      if (dedicated || normalizeRoute(f.url) === caseRoute) matched.push(f);
    }
  }
  return matched;
}

/**
 * Score a merged report against the manifest. Pure. A non-clean case is CAUGHT
 * iff a finding attributable to the case (by route or by its dedicated mission)
 * has a kind in its expectedKinds. A clean case contributes a FALSE POSITIVE for
 * each finding of its group attributable to its route.
 */
export function scoreFixture(
  report: RunReport,
  cases: PlantedCase[],
): SelfEvalScore {
  const caught: string[] = [];
  const missed: string[] = [];
  const falsePositives: FalsePositive[] = [];
  const perCase: PerCaseScore[] = [];

  for (const c of cases) {
    const route = normalizeRoute(c.route);
    const here = findingsForCase(report, c);
    if (c.clean) {
      const fps = here.filter((f) => isGroupKind(f.kind, c.group));
      for (const f of fps) {
        falsePositives.push({ id: c.id, route, kind: f.kind, title: f.title });
      }
      perCase.push({
        id: c.id,
        group: c.group,
        clean: true,
        ok: fps.length === 0,
        matchedKinds: [],
      });
      continue;
    }
    const matchedKinds = [
      ...new Set(
        here.map((f) => f.kind).filter((k) => c.expectedKinds.includes(k)),
      ),
    ];
    const ok = matchedKinds.length > 0;
    (ok ? caught : missed).push(c.id);
    perCase.push({ id: c.id, group: c.group, clean: false, ok, matchedKinds });
  }

  const recall =
    caught.length + missed.length
      ? caught.length / (caught.length + missed.length)
      : 1;
  const precision =
    caught.length + falsePositives.length
      ? caught.length / (caught.length + falsePositives.length)
      : 1;

  return { recall, precision, caught, missed, falsePositives, perCase };
}

// ---------------------------------------------------------------------------
// Live runner
// ---------------------------------------------------------------------------

/**
 * A scripted functional case: a single-mission profile driven by a fresh
 * MockClient. Kept one-mission-per-runProfile so each case gets its own script
 * cursor (MockClient advances a single index across a runProfile).
 */
interface ScriptedCase {
  id: string;
  startPath: string;
  /** The agent action script (empty → the mock just finishes). */
  script: Action[];
  maxSteps: number;
}

/**
 * Functional cases that need an agent to click to trigger their bug, plus the
 * clean control. (loaderror fires at load time and is swept by the crawl.)
 * Scripts mirror how engine.test.ts drives the same fixture routes.
 */
const FUNCTIONAL_CASES: ScriptedCase[] = [
  // Click Save → throws + console.error.
  {
    id: "settings",
    startPath: "/settings",
    script: [{ type: "click", ref: 0 }],
    maxSteps: 3,
  },
  // Click "Load data" → fetch returns 500.
  {
    id: "api-fail",
    startPath: "/api-fail",
    script: [{ type: "click", ref: 0 }],
    maxSteps: 3,
  },
  // Clean page: click the working button, no findings expected.
  {
    id: "clean",
    startPath: "/clean",
    script: [{ type: "click", ref: 0 }],
    maxSteps: 3,
  },
  // Inert button hammered → no_progress loop guard.
  {
    id: "noop",
    startPath: "/noop",
    script: Array.from({ length: 10 }, () => ({ type: "click", ref: 0 })),
    maxSteps: 10,
  },
  // Surfaced button whose centre is covered by a foreign overlay → occluded_control.
  {
    id: "occluded",
    startPath: "/occluded",
    script: [{ type: "click", ref: 0 }],
    maxSteps: 3,
  },
  // Alternating inert buttons → no_progress (A↔B cycle).
  {
    id: "toggle",
    startPath: "/toggle",
    script: Array.from({ length: 12 }, (_, i) => ({
      type: "click",
      ref: i % 2,
    })),
    maxSteps: 12,
  },
  // Recurring console.error each click → console_error (deduped to one).
  {
    id: "relog",
    startPath: "/relog",
    script: Array.from({ length: 4 }, () => ({ type: "click", ref: 0 })),
    maxSteps: 4,
  },
  // Start path 302-redirects before load → route_gated (skipped).
  {
    id: "gated",
    startPath: "/gated",
    script: [{ type: "click", ref: 0 }],
    maxSteps: 3,
  },
  // Loads then client-redirects a beat later → delayed route_gated.
  {
    id: "slowgate",
    startPath: "/slowgate",
    script: Array.from({ length: 5 }, () => ({ type: "click", ref: 0 })),
    maxSteps: 5,
  },
  // STARTS on a page that throws during load — the page_error is in the start-page
  // load batch, caught only because agent mode now runs the oracles on it.
  {
    id: "agent-load-error",
    startPath: "/agent-loaderror",
    script: [{ type: "click", ref: 0 }],
    maxSteps: 2,
  },
  // Start page has unlabeled controls/field/img that are all non-perceivable
  // (visibility:hidden / aria-hidden): the a11y hidden() gate must exclude them →
  // ZERO findings (CLEAN). A dedicated mission, not a crawl route, so its findings
  // can't fingerprint-merge into the dirty a11y routes. Click the visible OK button.
  {
    id: "a11y-hidden",
    startPath: "/a11y-hidden",
    script: [{ type: "click", ref: 0 }],
    maxSteps: 2,
  },
];

/** Routes swept by the functional crawl (load-time bugs, no click needed). */
const FUNCTIONAL_CRAWL_ROUTES = [
  "/loaderror",
  "/body-error",
  "/gone",
  "/broken-image",
  "/broken-asset",
  "/a11y-img",
  "/a11y-button",
  "/a11y-input",
  "/a11y-orphan",
  "/dup-id",
];

/** The sec-* routes the security pass crawls (with a security block on). */
const SECURITY_CRAWL_ROUTES = [
  "/sec-clean",
  "/sec-headers",
  "/sec-cookie",
  "/sec-leak",
  "/sec-verbose",
];

function functionalProfile(c: ScriptedCase, baseUrl: string): LoadedProfile {
  const profile = ProfileSchema.parse({
    name: "selfeval-functional",
    baseUrl,
    personas: [{ name: "tester", description: "a test persona" }],
    missions: [
      {
        id: `${FN_MISSION_PREFIX}${c.id}`,
        goal: "exercise the planted route",
        startPath: c.startPath,
        maxSteps: c.maxSteps,
      },
    ],
  });
  return { profile, baseDir: tmpdir() };
}

function crawlProfile(
  name: string,
  routes: string[],
  baseUrl: string,
  security: boolean,
): LoadedProfile {
  const profile = ProfileSchema.parse({
    name,
    baseUrl,
    personas: [{ name: "tester", description: "a test persona" }],
    missions: [
      { id: `${name}-crawl`, goal: "sweep routes", mode: "crawl", routes },
    ],
    ...(security
      ? {
          // Defaults for requiredHeaders; declare the session cookie name so the
          // insecure_cookie oracle checks the planted /sec-cookie cookie.
          security: { sessionCookieNames: ["session"] },
        }
      : {}),
  });
  return { profile, baseDir: tmpdir() };
}

// ---------------------------------------------------------------------------
// Active-probe (injection) + authz-matrix passes
// ---------------------------------------------------------------------------

/**
 * A metacharacter marker the injection mission types then reflects. Bears `<`/`>`
 * (so hasMetacharacter accepts it) but is otherwise inert. The fixture's
 * /sec-reflect echoes ?q= verbatim, so navigating to ?q=<marker> reflects it.
 */
const INJECTION_MARKER = "<xss-marker-9f2>";

/**
 * The injection mission's action script: type the metacharacter marker into the
 * reflect field (so the engine records it as a candidate injection marker), then
 * navigate to the reflect URL carrying the same marker. The marker is echoed
 * un-escaped into the HTML body → the reflection oracle fires.
 */
const INJECTION_SCRIPT: Action[] = [
  { type: "type", ref: 0, text: INJECTION_MARKER },
  { type: "navigate", path: `/sec-reflect?q=${INJECTION_MARKER}` },
];

/**
 * Scripted injection mission profile. Security is ON (body capture + the
 * reflection oracle). Defaults for requiredHeaders are fine — /sec-reflect
 * carries them, so ONLY the reflection fires (kept single-signal for the
 * mutation/ablation analysis).
 */
function injectionProfile(baseUrl: string): LoadedProfile {
  const profile = ProfileSchema.parse({
    name: "selfeval-inject",
    baseUrl,
    personas: [{ name: "attacker", description: "an adversarial tester" }],
    missions: [
      {
        id: "sec-inject",
        goal: "probe the search field for reflected input",
        startPath: "/sec-reflect",
        maxSteps: 4,
      },
    ],
    // A security block turns on body capture + the deterministic security oracles
    // (incl. injection_reflection).
    security: {},
  });
  return { profile, baseDir: tmpdir() };
}

/** The static routes the authz matrix crawls (one per variant). */
const MATRIX_ROUTES = ["/authn-gap", "/authz-gap", "/authz-clean"];

/**
 * The authz-matrix profile: two variants (an UNAUTHENTICATED anon + an
 * authenticated viewer via a throwaway storageState) and an expectedAccess map
 * crafted so each defect is the SOLE signal on its route — anon reaching
 * /authn-gap is missing_authn, viewer reaching /authz-gap is broken_authz, and
 * /authz-clean (allowed for all) stays quiet.
 */
function matrixProfile(
  baseUrl: string,
  viewerStatePath: string,
): { loaded: LoadedProfile; source: ResolvedRouteSource; variants: Variant[] } {
  const variants: Variant[] = [
    { name: "anon", auth: { strategy: "none" } },
    {
      name: "viewer",
      auth: { strategy: "storageState", path: viewerStatePath },
    },
  ];
  const profile = ProfileSchema.parse({
    name: "selfeval-matrix",
    baseUrl,
    personas: [{ name: "tester", description: "a test persona" }],
    // A seed crawl mission satisfies ProfileSchema.min(1); buildExplorePlan (inside
    // runMatrix) drops it and synthesizes its own crawl over `source`.
    missions: [{ id: "seed", goal: "sweep", mode: "crawl", routes: [] }],
    variants,
    expectedAccess: {
      "/authn-gap": ["viewer", "admin"], // anon disallowed + unauth → missing_authn
      "/authz-gap": ["anon", "admin"], // viewer disallowed + authed → broken_authz
      "/authz-clean": ["anon", "viewer", "admin"], // everyone allowed → quiet
    },
  });
  return {
    loaded: { profile, baseDir: tmpdir() },
    source: { kind: "static", routes: MATRIX_ROUTES },
    variants,
  };
}

/** A running fixture server: just the base url + a close hook (injected). */
export interface RunningServer {
  url: string;
  close: () => Promise<void>;
}

export interface FixtureEvalDeps {
  /** Start the fixture server (injected — it lives in test/). */
  startServer: () => Promise<RunningServer>;
  /** The ground-truth manifest to score against. */
  cases: PlantedCase[];
  /** Where run artifacts go. Defaults to a temp run dir. */
  outDir?: string;
}

/**
 * Start the fixture, run the engine over it in two passes (functional +
 * security), merge the findings into one report, and score against the manifest.
 * Owns the server lifecycle (start + close). Reuses runProfile / MockClient /
 * createRunDir — no new engine API.
 */
export async function runFixtureEval(
  deps: FixtureEvalDeps,
): Promise<{ report: RunReport; score: SelfEvalScore }> {
  // A unique dir per run (not bare tmpdir()) so concurrent self-evals don't share
  // the fixed-name viewer-state file / run artifacts.
  const outDir = deps.outDir ?? mkdtempSync(join(tmpdir(), "takoqa-selfeval-"));
  const server = await deps.startServer();
  const allResults: RunReport["results"] = [];
  let startedAt = new Date().toISOString();
  try {
    // (a) FUNCTIONAL pass — one runProfile per scripted case (fresh MockClient
    // each, so the script cursor never bleeds between cases). No security block.
    for (const c of FUNCTIONAL_CASES) {
      const llm: LLMClient = new MockClient(c.script);
      const rep = await runProfile(functionalProfile(c, server.url), {
        llm,
        runDir: createRunDir(outDir, `selfeval-${c.id}`),
        headless: true,
        record: false,
      });
      if (rep.startedAt < startedAt) startedAt = rep.startedAt;
      allResults.push(...rep.results);
    }
    // Functional crawl for the load-time bug(s).
    const repCrawl = await runProfile(
      crawlProfile(
        "selfeval-fncrawl",
        FUNCTIONAL_CRAWL_ROUTES,
        server.url,
        false,
      ),
      {
        llm: new MockClient(),
        runDir: createRunDir(outDir, "selfeval-fncrawl"),
        headless: true,
        record: false,
      },
    );
    allResults.push(...repCrawl.results);

    // (b) SECURITY pass — crawl ONLY the sec-* routes, WITH a security block, so
    // the deterministic security oracles run (and the functional routes' missing
    // headers never count as security false-positives).
    const repSec = await runProfile(
      crawlProfile(
        "selfeval-seccrawl",
        SECURITY_CRAWL_ROUTES,
        server.url,
        true,
      ),
      {
        llm: new MockClient(),
        runDir: createRunDir(outDir, "selfeval-seccrawl"),
        headless: true,
        record: false,
      },
    );
    allResults.push(...repSec.results);

    // (c) INJECTION pass — a scripted agent mission (security ON) types a
    // metacharacter marker then navigates to the reflecting route, exercising the
    // ACTIVE-probe reflection oracle that a passive crawl cannot reach.
    const repInject = await runProfile(injectionProfile(server.url), {
      llm: new MockClient(INJECTION_SCRIPT),
      runDir: createRunDir(outDir, "selfeval-inject"),
      headless: true,
      record: false,
    });
    if (repInject.startedAt < startedAt) startedAt = repInject.startedAt;
    allResults.push(...repInject.results);

    // (d) AUTHZ-MATRIX pass — crawl the authz routes once per variant and diff,
    // exercising the DIFFERENTIAL detectors (missing_authn for the unauthenticated
    // reach, broken_authz for the authenticated-but-under-privileged reach) that
    // no single-session pass can produce. The viewer variant carries a REAL
    // (non-empty) session cookie so it is genuinely authenticated — its
    // disallowed reach of /authz-gap is a true broken_authz, not a label artifact
    // (the split is keyed on the session payload; see variantCarriesNoSession).
    const viewerStatePath = join(outDir, "selfeval-viewer-state.json");
    writeFileSync(
      viewerStatePath,
      JSON.stringify({
        cookies: [
          {
            name: "session",
            value: "viewer-session-token",
            domain: new URL(server.url).hostname,
            path: "/",
            expires: -1,
            httpOnly: true,
            secure: false,
            sameSite: "Lax",
          },
        ],
        origins: [],
      }),
      "utf8",
    );
    const mp = matrixProfile(server.url, viewerStatePath);
    const { entries } = await runMatrix(mp.loaded, mp.source, mp.variants, {
      llm: new MockClient(),
      runDir: createRunDir(outDir, "selfeval-matrix"),
      headless: true,
      record: false,
    });
    const matrixResult: MissionResult = {
      missionId: "selfeval-matrix",
      persona: "matrix",
      goal: "authz differential across variants",
      outcome: "passed",
      steps: [],
      findings: entries.map((e) => e.finding),
      // Borrows the outer (min-folded) startedAt: runMatrix surfaces no report
      // timestamp and this pass runs last, so folding its own start would be a
      // no-op for the report-level minimum. Display-only; scoring ignores it.
      startedAt,
      finishedAt: new Date().toISOString(),
    };
    allResults.push(matrixResult);
  } finally {
    await server.close();
  }

  const report: RunReport = {
    profile: "selfeval",
    baseUrl: server.url,
    startedAt,
    finishedAt: new Date().toISOString(),
    results: allResults,
    coverage: { routesVisited: [], unvisitedKnownRoutes: [] },
  };
  return { report, score: scoreFixture(report, deps.cases) };
}
