/**
 * Core type contracts for the QA agent.
 *
 * The engine is product-agnostic. Everything a product needs to describe itself
 * lives in a Profile (loaded from a YAML file). The engine consumes a Profile,
 * runs each Mission, and emits Findings.
 */

import { z } from "zod";

/** A simulated user. Drives how the LLM is told to behave. */
export const PersonaSchema = z.object({
  name: z.string(),
  /** Free-text description injected into the agent system prompt. */
  description: z.string(),
  /** Optional traits that bias behavior, e.g. "impatient", "non-technical". */
  traits: z.array(z.string()).default([]),
  /**
   * The security lever attributes active probes (crafted/abusive inputs, id
   * tampering) to personas with this flag — so an attacker probe is run as a
   * persona explicitly marked adversarial, not as a benign user.
   */
  attacker: z.boolean().default(false),
});
export type Persona = z.infer<typeof PersonaSchema>;

/** A single test objective the agent attempts, like a user story. */
export const MissionSchema = z.object({
  id: z.string(),
  /** What the user is trying to accomplish, in plain language. */
  goal: z.string(),
  /** Which persona attempts it. Defaults to the profile's first persona. */
  persona: z.string().optional(),
  /** URL path the mission starts from, relative to baseUrl. Defaults to "/". */
  startPath: z.string().default("/"),
  /**
   * "agent" (default): the LLM drives toward the goal. "crawl": a deterministic
   * route sweep — navigate each route in `routes` (or the knowledge block's
   * routes) and run the invariant oracles on it, no LLM, no judge.
   */
  mode: z.enum(["agent", "crawl"]).default("agent"),
  /** Routes to visit in crawl mode (falls back to the knowledge block's routes). */
  routes: z.array(z.string()).default([]),
  /** Max agent steps before the mission is abandoned. */
  maxSteps: z.number().int().positive().default(20),
  /**
   * Plain-language success criteria handed to the LLM judge. The judge decides
   * whether the goal was met; this sharpens that decision.
   */
  successCriteria: z.array(z.string()).default([]),
  /**
   * Optional ordered playbook for hard/unfamiliar flows (e.g. a canvas editor):
   * concrete steps the agent should follow but may adapt to what it sees. Use
   * for expert tools where pure intent makes the agent flail; leave empty to
   * test discoverability (intent only).
   */
  hints: z.array(z.string()).default([]),
  /** Files the mission may need to upload, as absolute or profile-relative paths. */
  fixtures: z.array(z.string()).default([]),
  /** Tags for filtering runs, e.g. ["smoke", "knowledge-base"]. */
  tags: z.array(z.string()).default([]),
});
export type Mission = z.infer<typeof MissionSchema>;

/** How the agent gets past auth before missions run. */
export const AuthSchema = z.discriminatedUnion("strategy", [
  /** Auth is disabled server-side (e.g. an auth-bypass test mode). No-op. */
  z.object({ strategy: z.literal("none") }),
  /** Set cookies/localStorage before navigating. */
  z.object({
    strategy: z.literal("storageState"),
    /** Path to a Playwright storageState JSON file. */
    path: z.string(),
  }),
  /** Drive a login form. Credentials pulled from env vars, never inlined. */
  z.object({
    strategy: z.literal("loginForm"),
    loginPath: z.string(),
    usernameEnv: z.string(),
    passwordEnv: z.string(),
    /** Selectors are a hint; the agent falls back to its own reasoning. */
    usernameSelector: z.string().optional(),
    passwordSelector: z.string().optional(),
    submitSelector: z.string().optional(),
  }),
]);
export type Auth = z.infer<typeof AuthSchema>;

/** Invariants checked after every step. Any violation is a Finding. */
export const InvariantsSchema = z.object({
  /** Fail on uncaught JS exceptions on the page. */
  noPageErrors: z.boolean().default(true),
  /** Fail on console.error output. */
  noConsoleErrors: z.boolean().default(true),
  /** Fail on HTTP responses with status >= this value. Default 500. */
  failOnHttpStatusAtLeast: z.number().int().default(500),
  /** Substrings that, if found in visible page text, indicate a crash. */
  bodyErrorSignatures: z
    .array(z.string())
    .default([
      "Application error",
      "Internal Server Error",
      "Unhandled Runtime Error",
    ]),
  /** URL substrings whose network errors are ignored (analytics, etc.). */
  ignoreUrlSubstrings: z.array(z.string()).default([]),
  /**
   * Substrings that, if found in a console error's TEXT, suppress it. Use to
   * silence framework dev-mode noise that isn't a product defect — e.g. React
   * hydration warnings ("A tree hydrated but some attributes...") in dev builds.
   * Complements ignoreUrlSubstrings, which only matches by URL.
   */
  ignoreConsoleSubstrings: z.array(z.string()).default([]),
});
export type Invariants = z.infer<typeof InvariantsSchema>;

/**
 * Optional structural context about the app under test. Purely additive: a
 * profile without `knowledge` behaves exactly as before. The agent sees a
 * compact "ABOUT THIS APP" block built from this; the judge sees the gotchas as
 * exclusions (things not to flag as defects).
 */
export const KnowledgeSchema = z.object({
  /** One-paragraph description of what the app is and does. */
  overview: z.string().default(""),
  /** Notable routes the agent should know exist. */
  routes: z
    .array(
      z.object({
        path: z.string(),
        description: z.string().default(""),
        /** Precondition to reach it, e.g. "OP tier", "signed in". */
        requires: z.string().optional(),
        /** True if the route needs a background worker/service running. */
        needsWorker: z.boolean().optional(),
      }),
    )
    .default([]),
  /** Domain terms the agent (and judge) should understand. */
  glossary: z
    .array(z.object({ term: z.string(), meaning: z.string().default("") }))
    .default([]),
  /** Known quirks that are NOT bugs — fed to the judge as exclusions. */
  gotchas: z.array(z.string()).default([]),
});
export type Knowledge = z.infer<typeof KnowledgeSchema>;

/**
 * A pluggable route source for `--explore`/`--matrix` discovery. Discriminated
 * by `kind` so takoqa generalizes beyond Next.js:
 *   - `next`    — discover routes from a Next.js app-router directory.
 *   - `static`  — an explicit, app-agnostic route list (no discovery).
 *   - `sitemap` — fetch a sitemap.xml and extract same-origin paths.
 * Resolved to a flat route list by routeSource.ts `resolveRoutes`.
 */
export const RouteSourceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("next"),
    /** Path to the app-router directory (e.g. a Next.js `src/app`). */
    appDir: z.string(),
  }),
  z.object({
    kind: z.literal("static"),
    /** The route list, used verbatim — the truly app-agnostic baseline. */
    routes: z.array(z.string()).min(1),
  }),
  z.object({
    kind: z.literal("sitemap"),
    /** URL of the sitemap.xml to fetch. */
    url: z.string().url(),
    /** Cap on how many discovered routes to keep (default 200). */
    cap: z.number().int().positive().optional(),
  }),
]);
export type RouteSource = z.infer<typeof RouteSourceSchema>;

/**
 * Config for `--explore` mode (the orchestrated full sweep): where to
 * auto-discover routes from, so the crawl + coverage stay in sync with the app
 * instead of a hand-maintained route list.
 */
export const ExploreSchema = z.object({
  /**
   * Shorthand for `{ kind: "next", appDir }` — kept so existing profiles that
   * set `explore.appDir` behave identically. Mutually complementary with
   * `source`; if both are given, `source` wins.
   */
  appDir: z.string().optional(),
  /** Pluggable route source (next/static/sitemap). Overrides the `appDir` shorthand. */
  source: RouteSourceSchema.optional(),
  /** Things the exploration loop's proposer must never do (mutation guardrail). */
  denylist: z.array(z.string()).default([]),
});
export type Explore = z.infer<typeof ExploreSchema>;

/**
 * A named auth/tier variant for the `--matrix` sweep. The matrix runs the crawl
 * once per variant and diffs: a finding present in only some variants is
 * access/tier-dependent (a gate working as designed), not a universal defect.
 */
export const VariantSchema = z.object({ name: z.string(), auth: AuthSchema });
export type Variant = z.infer<typeof VariantSchema>;

/**
 * Optional security-oracle config. Purely additive and inert unless present: a
 * profile WITHOUT a `security` block behaves byte-identically to before (no body
 * capture, no security oracles run). When present, it tells the deterministic
 * security oracles what to look for. See oracles.ts `checkSecurity`.
 */
export const SecuritySchema = z.object({
  /** Security response headers a top-level HTML document must carry. */
  requiredHeaders: z
    .array(z.string())
    .default([
      "content-security-policy",
      "strict-transport-security",
      "x-frame-options",
      "x-content-type-options",
    ]),
  /** Named regexes for sensitive data that must never appear in a response body. */
  sensitivePatterns: z
    .array(z.object({ name: z.string(), pattern: z.string() }))
    .default([]),
  /** Names of cookies that hold a session — checked for HttpOnly/Secure/SameSite. */
  sessionCookieNames: z.array(z.string()).default([]),
  /** URL substrings whose bodies are exempt from the reflection oracle. */
  ignoreReflectionPaths: z.array(z.string()).default([]),
});
export type Security = z.infer<typeof SecuritySchema>;

/**
 * Expected access map for the authz differential: a normalized route → the
 * variant names allowed to reach it. A variant that reaches a route NOT in its
 * allow-list is a broken-authz candidate. Undeclared routes assert nothing
 * (no default-deny — silence is not a finding). See matrix.ts checkExpectedAccess.
 */
export const ExpectedAccessSchema = z.record(z.string(), z.array(z.string()));
export type ExpectedAccess = z.infer<typeof ExpectedAccessSchema>;

/**
 * Where to read the app's SERVER log from, to correlate a server-side traceback
 * onto a client-observed failure (a 5xx / crash). Purely additive + best-effort:
 * a profile without it behaves exactly as before. App-specific config (the log's
 * location), product-agnostic mechanism (read + correlate by request path) — the
 * same engine-general / config-per-app split as the rest of the profile.
 *   - `file`    — tail a log file on disk.
 *   - `command` — run a shell command and capture its stdout (e.g. a container
 *                 `logs` command, or `tmux capture-pane -p -t <pane>`).
 */
export const ServerLogSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("file"), path: z.string() }),
  z.object({ kind: z.literal("command"), command: z.string() }),
]);
export type ServerLogSource = z.infer<typeof ServerLogSourceSchema>;

export const ProfileSchema = z
  .object({
    name: z.string(),
    baseUrl: z.string().url(),
    auth: AuthSchema.default({ strategy: "none" }),
    personas: z.array(PersonaSchema).min(1),
    missions: z.array(MissionSchema).min(1),
    invariants: InvariantsSchema.default({}),
    /** Optional shell command to reset state between missions (seed/clear). */
    resetCommand: z.string().optional(),
    /** Optional structural context handed to the agent + judge. */
    knowledge: KnowledgeSchema.optional(),
    /** Optional config for `--explore` mode (route auto-discovery). */
    explore: ExploreSchema.optional(),
    /** Auth/tier variants for the `--matrix` sweep (diff findings across access levels). */
    variants: z.array(VariantSchema).default([]),
    /** Optional deterministic security oracles (inert unless set). */
    security: SecuritySchema.optional(),
    /** Optional route → allowed-variant map for the authz differential (matrix). */
    expectedAccess: ExpectedAccessSchema.optional(),
    /** Optional server-log source, to correlate a server traceback onto a 5xx/crash finding. */
    serverLogs: ServerLogSourceSchema.optional(),
  })
  // Reject unknown top-level keys so a typo'd or vestigial profile key (e.g. a
  // removed report:/fix: block) fails LOUDLY at load instead of being silently
  // dropped — matching run.ts's "fail loudly on a wrong --app-dir" instinct.
  .strict();
export type Profile = z.infer<typeof ProfileSchema>;

// ---------------------------------------------------------------------------
// Runtime records (produced by the engine, not authored by humans)
// ---------------------------------------------------------------------------

export type Severity = "critical" | "high" | "medium" | "low";

export type FindingKind =
  | "page_error" // uncaught JS exception
  | "console_error"
  | "http_error" // 5xx (or configured threshold)
  | "dead_link" // a page navigation landed on 404/410 (broken route / dead link)
  | "broken_image" // an <img> sub-resource failed to load (>= 400, below http_error threshold)
  | "broken_asset" // a <script>/stylesheet failed to load (>= 400, below http_error threshold)
  | "accessibility" // a deterministic WCAG violation (v1: a rendered <img> with no alt)
  | "duplicate_id" // an element id that appears more than once in the document
  | "body_error_signature"
  | "goal_failed" // LLM judge: user could not accomplish the goal
  | "ux_issue" // LLM judge: completed but degraded experience
  | "agent_stuck" // ran out of steps without resolution
  | "no_progress" // same action repeated with no observable effect (dead control / loop)
  | "occluded_control" // a visible, surfaced control is covered by another element and can't be clicked
  | "route_gated" // start path redirected away before any action (auth/tier/feature gate)
  | "broken_authz" // a variant reached a route it should not be allowed to (IDOR / missing access control)
  | "missing_authn" // a protected route served content with no authentication challenge
  | "sensitive_data_exposure" // a secret/credential/PII pattern appeared in a response body
  | "injection_reflection" // a crafted metacharacter payload was reflected un-escaped (XSS/template surface)
  | "insecure_headers" // a document response is missing required security headers (CSP/HSTS/etc.)
  | "insecure_cookie" // a session cookie lacks HttpOnly/Secure/SameSite
  | "verbose_error"; // an error response leaked a stack trace / SQL / framework internals

export interface Finding {
  kind: FindingKind;
  severity: Severity;
  missionId: string;
  persona: string;
  /** One-line summary suitable for a bug title. */
  title: string;
  /** What happened and why it matters. */
  detail: string;
  /** Ordered human-readable steps to reproduce, captured from the action log. */
  repro: string[];
  url: string;
  screenshotPath?: string;
  /** Raw evidence (stack trace, response body snippet, judge rationale). */
  evidence?: string;
  timestamp: string;
  /**
   * How many times this finding fired within the run before being collapsed.
   * Unset (or 1) means once; >1 means the same bug recurred across steps (e.g.
   * a console error re-thrown every step on a broken page) and was deduped to a
   * single Finding. Purely additive — readers may ignore it.
   */
  occurrences?: number;
  /**
   * Cross-run classification against the known-bugs baseline (only set when
   * --baseline is on): "new" (not seen before), "known" (seen in a prior run),
   * or "muted" (a known non-bug the operator suppressed).
   */
  status?: "new" | "known" | "muted";
}

/** One observe→decide→act cycle, retained for repro and debugging. */
export interface StepRecord {
  index: number;
  url: string;
  /** The action the agent chose, rendered for humans. */
  actionSummary: string;
  /** The agent's stated reasoning for the action. */
  rationale: string;
  screenshotPath?: string;
  /**
   * The HTTP status of the LANDED document (the GET response whose URL matches
   * the step's landed URL). Set by crawl mode so the authz differential can tell
   * a route that actually served a 2xx document from one that returned a gated
   * 3xx/4xx/5xx. Optional + additive — only the crawl populates it today.
   */
  status?: number;
  /**
   * Compact list of interactive-element labels observed on this step's page.
   * Populated by the crawl so the exploration loop's proposer can ground its
   * mission goals in what a page actually offers (instead of inventing features).
   */
  affordances?: string[];
}

export interface MissionResult {
  missionId: string;
  persona: string;
  goal: string;
  outcome: "passed" | "failed" | "stuck" | "error" | "skipped";
  steps: StepRecord[];
  findings: Finding[];
  /** Run-dir-relative path to the Playwright trace zip, if recording was on. */
  tracePath?: string;
  /** Run-dir-relative path to the mission video, if recording was on. */
  videoPath?: string;
  startedAt: string;
  finishedAt: string;
}

export interface RunReport {
  profile: string;
  baseUrl: string;
  startedAt: string;
  finishedAt: string;
  results: MissionResult[];
  /**
   * Which routes the run actually reached — so "0 findings" is distinguishable
   * from "barely explored". Routes are normalized (dynamic ids → [id]).
   */
  coverage: {
    routesVisited: string[];
    /** Routes the profile's knowledge block declares but the run never reached. */
    unvisitedKnownRoutes: string[];
  };
}
