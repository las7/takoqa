/**
 * CLI entrypoint.
 *
 *   tsx src/run.ts --profile profiles/example.yaml [--headed] [--tag smoke] [--mock]
 *
 * Auth: profiles using strategy "none" assume the server bypasses auth
 * (e.g. an auth-disabled test/staging mode); "storageState" loads a saved
 * Playwright session from disk. ("loginForm" is declared in the schema but not
 * yet implemented — BrowserSession.start throws on it.)
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { AnthropicClient, MockClient } from "./agent.js";
import type { LLMClient } from "./agent.js";
import { runProfile } from "./engine.js";
import { discoverRoutes, renderRoutesYaml } from "./discover.js";
import { buildExplorePlan } from "./explore.js";
import { runExploreLoop, DEFAULT_LOOP } from "./exploreLoop.js";
import { runMatrix } from "./matrix.js";
import {
  correlateReport,
  correlateServerLog,
  readServerLog,
} from "./serverLog.js";
import { resolveRoutes, routeSourceFrom } from "./routeSource.js";
import { ALL_LEVERS } from "./planner.js";
import { normalizeRoute } from "./progress.js";
import { baselineFingerprint } from "./findings.js";
import { loadBaseline, saveBaseline } from "./baseline.js";
import {
  compareRuns,
  loadRunFindings,
  formatDiff,
  diffExitCode,
} from "./compare.js";
import { loadLearned, mergeIntoStore, saveLearned } from "./learned.js";
import { loadProfile } from "./profile.js";
import type { RunReport, ServerLogSource } from "./types.js";
import {
  createRunDir,
  printSummary,
  writeReplayHtml,
  writeRunReport,
} from "./report.js";

interface Args {
  profile: string;
  headed: boolean;
  tag?: string;
  mock: boolean;
  model: string;
  outDir: string;
  record: boolean;
  baseUrl?: string;
  /** Enable record-and-replay: replay a cached recipe if present, else run with
   *  the LLM and save the recipe on success. */
  replay: boolean;
  recipesDir: string;
  /** Classify findings new/known/muted against a persisted baseline. */
  baseline: boolean;
  baselineDir: string;
  /** Directory for the per-profile learned-knowledge store (self-improvement). */
  learnedDir: string;
  /** Standalone: mute a baseline fingerprint (with an optional --as reason), then exit. */
  mute?: string;
  muteReason?: string;
  /** Print a knowledge-routes block derived from a Next.js app dir, then exit. */
  discover?: string;
  /** Orchestrated full sweep: auto-discover routes → crawl → missions → triage. */
  explore: boolean;
  /** App-router dir for --explore route discovery (overrides profile.explore.source). */
  appDir?: string;
  /** Explicit static route list for --explore/--matrix (app-agnostic; comma-separated). */
  routes?: string[];
  /** Sitemap URL for --explore/--matrix route discovery. */
  sitemap?: string;
  /** Autonomous creative loop: the planner proposes fresh missions each round. */
  loop: boolean;
  rounds?: number;
  dryRounds?: number;
  missionsPerRound?: number;
  budgetSteps?: number;
  /** Tier/auth matrix: crawl per profile.variant and diff (gates vs real bugs). */
  matrix: boolean;
  /** Enable the attacker lever (bounded active security probes) on a normal/loop run. */
  security: boolean;
  /** Path to a server log file to correlate tracebacks onto 5xx/crash findings. */
  serverLog?: string;
  /** Standalone: diff two prior runs (dirs or run.json paths) and exit. */
  compare?: [string, string];
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    profile: "",
    headed: false,
    mock: false,
    model: process.env.QA_AGENT_MODEL ?? "claude-sonnet-4-6",
    outDir: "runs",
    record: true,
    baseUrl: process.env.QA_AGENT_BASE_URL,
    replay: false,
    recipesDir: process.env.QA_AGENT_RECIPES_DIR ?? "recipes",
    baseline: false,
    baselineDir: process.env.QA_AGENT_BASELINE_DIR ?? "baseline",
    learnedDir: process.env.QA_AGENT_LEARNED_DIR ?? "learned",
    explore: false,
    loop: false,
    matrix: false,
    security: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--profile") args.profile = argv[++i] ?? "";
    else if (a === "--headed") args.headed = true;
    else if (a === "--tag") args.tag = argv[++i];
    else if (a === "--mock") args.mock = true;
    else if (a === "--model") args.model = argv[++i] ?? args.model;
    else if (a === "--out") args.outDir = argv[++i] ?? args.outDir;
    else if (a === "--no-record") args.record = false;
    else if (a === "--base-url") args.baseUrl = argv[++i] ?? args.baseUrl;
    else if (a === "--replay") args.replay = true;
    else if (a === "--recipes-dir")
      args.recipesDir = argv[++i] ?? args.recipesDir;
    else if (a === "--baseline") args.baseline = true;
    else if (a === "--baseline-dir")
      args.baselineDir = argv[++i] ?? args.baselineDir;
    else if (a === "--learned-dir")
      args.learnedDir = argv[++i] ?? args.learnedDir;
    else if (a === "--mute") args.mute = argv[++i];
    else if (a === "--as") args.muteReason = argv[++i];
    else if (a === "--discover") args.discover = argv[++i];
    else if (a === "--explore") args.explore = true;
    else if (a === "--app-dir") args.appDir = argv[++i];
    else if (a === "--routes")
      args.routes = (argv[++i] ?? "")
        .split(",")
        .map((r) => r.trim())
        .filter(Boolean);
    else if (a === "--sitemap") args.sitemap = argv[++i];
    else if (a === "--loop") args.loop = true;
    else if (a === "--rounds") args.rounds = Number(argv[++i]);
    else if (a === "--dry-rounds") args.dryRounds = Number(argv[++i]);
    else if (a === "--missions-per-round")
      args.missionsPerRound = Number(argv[++i]);
    else if (a === "--budget-steps") args.budgetSteps = Number(argv[++i]);
    else if (a === "--matrix") args.matrix = true;
    else if (a === "--security") args.security = true;
    else if (a === "--server-log") args.serverLog = argv[++i];
    else if (a === "--compare")
      args.compare = [argv[++i] ?? "", argv[++i] ?? ""];
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // --discover: print a knowledge-routes block derived from a Next.js app dir,
  // then exit. (Paste it into a profile's `knowledge:` block.)
  if (args.discover) {
    process.stdout.write(renderRoutesYaml(discoverRoutes(args.discover)));
    process.exit(0);
  }

  // --compare <before> <after>: diff two saved runs (dirs or run.json) by finding
  // identity and exit. Deterministic, no profile/LLM needed. Use it to verify a
  // fix removed a finding, or to env-diff the same profile across two --base-urls
  // (e.g. local vs prod). Exits 1 if AFTER introduced any finding (regression).
  if (args.compare) {
    const [before, after] = args.compare;
    const diff = compareRuns(loadRunFindings(before), loadRunFindings(after));
    console.log(formatDiff(diff, { before, after }));
    process.exit(diffExitCode(diff));
  }

  if (!args.profile) {
    console.error(
      "Usage: qa-agent --profile <path.yaml> [--headed] [--tag t] [--mock]",
    );
    process.exit(2);
  }

  let loaded = loadProfile(args.profile);
  // Lets one profile target different environments (local, container, staging).
  if (args.baseUrl) loaded.profile.baseUrl = args.baseUrl;

  // Server-log source (CLI --server-log <file>, or the profile's serverLogs),
  // resolved once: both the standard/explore/loop run AND the --matrix sweep
  // correlate the server's traceback onto their 5xx/crash findings with it.
  const logSource: ServerLogSource | undefined = args.serverLog
    ? { kind: "file", path: args.serverLog }
    : loaded.profile.serverLogs;
  const logSensitive = loaded.profile.security?.sensitivePatterns ?? [];

  // --mute "<fingerprint>" [--as "<reason>"]: mark a known non-bug in the
  // baseline, then exit. It is suppressed from the report + CI gate, and — when
  // a reason is given — fed to the judge as a "do NOT flag" exclusion on the
  // next run (closing the mute→judge loop). A CLI alternative to hand-editing
  // the baseline JSON. The fingerprint is the `kind|title` key shown in the
  // baseline file / findings.
  if (args.mute) {
    const baseline = loadBaseline(args.baselineDir, loaded.profile.name);
    const now = new Date().toISOString();
    const existing = baseline[args.mute];
    baseline[args.mute] = {
      firstSeen: existing?.firstSeen ?? now,
      lastSeen: existing?.lastSeen ?? now,
      runCount: existing?.runCount ?? 0,
      muted: true,
      ...(args.muteReason ? { mutedAs: args.muteReason } : {}),
    };
    saveBaseline(args.baselineDir, loaded.profile.name, baseline);
    console.log(
      `Muted "${args.mute}" for profile "${loaded.profile.name}"` +
        (args.muteReason
          ? ` — judge will be told: "${args.muteReason}"`
          : ' (report-only suppression; pass --as "<reason>" to also teach the judge)') +
        (existing
          ? ""
          : " [fingerprint not yet in baseline — it will match on its next occurrence]"),
    );
    process.exit(0);
  }

  // --matrix: crawl once per auth/tier variant and diff. A finding in only some
  // variants is access-dependent (a gate working as designed); one in every
  // variant is universal (a real candidate). Crawl is deterministic — no LLM.
  if (args.matrix) {
    const routeSource = routeSourceFrom(loaded.profile.explore, {
      appDir: args.appDir,
      routes: args.routes,
      sitemap: args.sitemap,
    });
    if (!routeSource) {
      console.error(
        "--matrix requires a route source: --app-dir <path> (Next.js), " +
          "--routes a,b,c (static list), --sitemap <url>, or a profile.explore.source/appDir.",
      );
      process.exit(2);
    }
    const resolved = await resolveRoutes(routeSource);
    const variants = loaded.profile.variants;
    if (variants.length < 2) {
      console.error(
        `--matrix needs >=2 profile.variants (each {name, auth}) to diff; got ${variants.length}`,
      );
      process.exit(2);
    }
    const unsupported = variants.find((v) => v.auth.strategy === "loginForm");
    if (unsupported) {
      console.error(
        `--matrix: variant "${unsupported.name}" uses loginForm auth, which is not implemented — use storageState (a saved Playwright session).`,
      );
      process.exit(2);
    }
    const runDir = createRunDir(args.outDir, loaded.profile.name);
    console.log(
      `Matrix: "${loaded.profile.name}" across [${variants.map((v) => v.name).join(", ")}] → ${runDir}`,
    );
    const { entries } = await runMatrix(loaded, resolved, variants, {
      llm: new MockClient(), // crawl is deterministic; no model needed
      runDir,
      headless: !args.headed,
      record: false, // per-variant crawls don't need video/trace
    });
    // Splice the server's traceback onto any 5xx/crash among the matrix findings
    // (authz kinds aren't correlate-kinds, so they pass through untouched).
    if (logSource) {
      const logText = readServerLog(logSource);
      if (logText.trim()) {
        for (const e of entries) {
          e.finding = correlateServerLog(
            [e.finding],
            logText,
            logSensitive,
          )[0]!;
        }
        console.log("Correlated server log into matrix findings.");
      }
    }
    const universal = entries.filter((e) => e.universal);
    const specific = entries.filter((e) => !e.universal);
    writeFileSync(
      join(runDir, "matrix.json"),
      JSON.stringify(
        entries.map((e) => ({
          kind: e.finding.kind,
          severity: e.finding.severity,
          title: e.finding.title,
          variants: e.variants,
          universal: e.universal,
        })),
        null,
        2,
      ),
    );
    console.log(
      `Matrix: ${entries.length} distinct findings — ${universal.length} universal (candidate bugs), ${specific.length} access-dependent (likely gates)`,
    );
    // Access-control breaks are variant-scoped (not universal) but are real
    // defects, not gates — surface them prominently and always block, regardless
    // of universality. Both kinds count: broken_authz (an authenticated variant
    // reached a route it shouldn't / IDOR) and missing_authn (an unauthenticated
    // variant reached a gated route — no auth challenge at all).
    const authzBreaks = entries.filter(
      (e) =>
        e.finding.kind === "broken_authz" || e.finding.kind === "missing_authn",
    );
    if (authzBreaks.length) {
      console.log(
        `\n  !! ${authzBreaks.length} ACCESS-CONTROL BREAK (blocking):`,
      );
      for (const e of authzBreaks)
        console.log(
          `  [${e.finding.kind === "missing_authn" ? "MISSING AUTHN" : "BROKEN AUTHZ"}] ${e.finding.title}`,
        );
    }
    for (const e of universal)
      console.log(`  [universal] [${e.finding.kind}] ${e.finding.title}`);
    for (const e of specific) {
      // already shown above
      if (
        e.finding.kind === "broken_authz" ||
        e.finding.kind === "missing_authn"
      )
        continue;
      console.log(
        `  [only ${e.variants.join("+")}] [${e.finding.kind}] ${e.finding.title}`,
      );
    }
    const blocking =
      authzBreaks.length > 0 ||
      universal.some(
        (e) =>
          e.finding.severity === "critical" || e.finding.severity === "high",
      );
    process.exit(blocking ? 1 : 0);
  }

  // The loop builds on explore's crawl + app map, so --loop implies --explore.
  if (args.loop) args.explore = true;

  // --explore: orchestrated full sweep. Auto-discover routes from the app tree,
  // synthesize a crawl over them + run the agent missions, always classifying
  // against the baseline so the report is triaged. Ignores --tag (full sweep).
  if (args.explore) {
    const routeSource = routeSourceFrom(loaded.profile.explore, {
      appDir: args.appDir,
      routes: args.routes,
      sitemap: args.sitemap,
    });
    if (!routeSource) {
      console.error(
        "--explore requires a route source: --app-dir <path> (Next.js), " +
          "--routes a,b,c (static list), --sitemap <url>, or a profile.explore.source/appDir.",
      );
      process.exit(2);
    }
    const resolved = await resolveRoutes(routeSource);
    const plan = buildExplorePlan(loaded, resolved);
    if (plan.crawled.length === 0) {
      // Explore's premise is that routes stay in sync with the app, so a
      // zero-route discovery is almost always a wrong source (bad --app-dir,
      // empty --routes, unreachable --sitemap) — fail loudly rather than emit a
      // green run that crawled nothing.
      console.error(
        `--explore: no static routes from the ${resolved.kind} route source — check the source ` +
          `(--app-dir expects a Next.js app-router dir; --routes/--sitemap must yield routes)`,
      );
      process.exit(2);
    }
    loaded = plan.loaded;
    args.baseline = true; // explore always classifies findings
    args.tag = undefined; // explore is a full sweep, not a tag-scoped run
    console.log(
      `Explore: discovered ${plan.discovered.length} route(s) via ${resolved.kind} source; ` +
        `crawling ${plan.crawled.length} static, then ${loaded.profile.missions.length - 1} agent mission(s)`,
    );
  }

  let llm: LLMClient;
  if (args.mock) {
    llm = new MockClient();
  } else {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    // No hard key requirement anymore: with neither var set, a bare client still
    // authenticates if an `ant auth login` profile is configured on disk (OAuth,
    // auto-refreshed like Claude Code). Warn — don't exit — since that path is
    // only valid when a profile exists; the SDK raises a clear auth error at
    // request time otherwise.
    if (!apiKey && !process.env.ANTHROPIC_AUTH_TOKEN) {
      console.error(
        "No ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN set — relying on an " +
          "`ant auth login` profile. Configure one, set a key, or pass --mock.",
      );
    }
    llm = new AnthropicClient(apiKey, args.model);
  }

  const runDir = createRunDir(args.outDir, loaded.profile.name);
  console.log(`Running profile "${loaded.profile.name}" → ${runDir}`);

  let report = args.loop
    ? await runLoop()
    : await runProfile(loaded, {
        llm,
        runDir,
        headless: !args.headed,
        record: args.record,
        onlyTag: args.tag,
        recipesDir: args.replay ? args.recipesDir : undefined,
        baselineDir: args.baseline ? args.baselineDir : undefined,
        // The learned ratchet rides along with --baseline (both are the run's
        // "memory"): with neither, this path is byte-identical to before. On a
        // non-loop --explore run the store is consumed read-only (there's no
        // loop journal to distill back); only --loop persists new learnings.
        learnedDir: args.baseline ? args.learnedDir : undefined,
      });

  // Autonomous creative loop: the planner proposes fresh missions each round
  // until it goes dry (or hits the round/step cap). Returns one aggregate
  // report (all rounds' missions flattened) so the rest of the pipeline is
  // unchanged.
  async function runLoop(): Promise<RunReport> {
    const loop = await runExploreLoop(
      loaded,
      {
        llm,
        runDir,
        headless: !args.headed,
        record: args.record,
        baselineDir: args.baselineDir,
        // --loop is the self-improvement path by definition, so it always
        // engages the learned ratchet (read at start, distilled + persisted at
        // end) — consistent with it always classifying against the baseline.
        learnedDir: args.learnedDir,
      },
      llm,
      {
        maxRounds: args.rounds ?? DEFAULT_LOOP.maxRounds,
        dryRounds: args.dryRounds ?? DEFAULT_LOOP.dryRounds,
        missionsPerRound:
          args.missionsPerRound ?? DEFAULT_LOOP.missionsPerRound,
        budgetSteps: args.budgetSteps,
        // --security turns on the attacker lever (bounded active probes); off it
        // stays false, so the loop behaves exactly as before.
        levers: args.security ? { ...ALL_LEVERS, attacker: true } : ALL_LEVERS,
      },
    );
    console.log(
      `Loop: ${loop.rounds.length} round(s), stopped=${loop.stopped} — ` +
        loop.rounds.map((r) => `r${r.round}:${r.newFindings}new`).join(" "),
    );
    // Persist what the loop learned so the next session is smarter — the journal
    // is no longer thrown away. Best-effort, like the baseline.
    try {
      const merged = mergeIntoStore(
        loadLearned(args.learnedDir, loaded.profile.name),
        loop.learnings,
      );
      saveLearned(args.learnedDir, loaded.profile.name, merged);
      const g = Object.keys(loop.learnings.routeGates).length;
      const d = Object.keys(loop.learnings.deadControls).length;
      const o = Object.keys(loop.learnings.routeOfferings).length;
      console.log(
        `Learned: ${g} route gate(s), ${d} dead control(s), ${o} route-offering map(s) → ${args.learnedDir}/`,
      );
    } catch {
      /* learned-store persistence is best-effort */
    }
    // Normalize both sides (matches engine.ts coverage), else raw "[id]"/trailing
    // -slash knowledge paths never match normalized visited routes.
    const visited = new Set(loop.coverage);
    const knownRoutes = new Set(
      (loaded.profile.knowledge?.routes ?? []).map((r) =>
        normalizeRoute(r.path),
      ),
    );
    // A standing bug re-found each round appears as a separate finding object per
    // round; dedupe across rounds by cross-run fingerprint (keeping the earliest
    // = "new" copy) so the aggregate histogram counts each bug once.
    const results = loop.rounds.flatMap((r) => r.report.results);
    const seenFp = new Set<string>();
    for (const res of results) {
      res.findings = res.findings.filter((f) => {
        const fp = baselineFingerprint(f);
        if (seenFp.has(fp)) return false;
        seenFp.add(fp);
        return true;
      });
    }
    return {
      profile: loaded.profile.name,
      baseUrl: loaded.profile.baseUrl,
      startedAt: loop.rounds[0]?.report.startedAt ?? new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      results,
      coverage: {
        routesVisited: loop.coverage,
        unvisitedKnownRoutes: [...knownRoutes].filter((r) => !visited.has(r)),
      },
    };
  }

  // Correlate the server's own traceback onto 5xx/crash findings, if a log source
  // is configured (see logSource above). Best-effort + additive: no source ⇒
  // unchanged; a read failure ⇒ skipped. (The --matrix sweep correlates earlier,
  // in its own branch.)
  if (logSource) {
    const logText = readServerLog(logSource);
    if (logText.trim()) {
      report = correlateReport(report, logText, logSensitive);
      console.log("Correlated server log into 5xx/crash findings.");
    }
  }

  writeRunReport(runDir, report);
  writeReplayHtml(runDir, report);
  printSummary(report);
  console.log(`Findings: ${runDir}/findings.txt`);
  console.log(`Replay:   ${runDir}/index.html`);

  // A muted finding is an operator-acknowledged known non-bug — it silences the
  // report AND the CI gate (otherwise muting would be pointless for CI).
  const hasBlocking = report.results
    .flatMap((r) => r.findings)
    .some(
      (f) =>
        (f.severity === "critical" || f.severity === "high") &&
        f.status !== "muted",
    );
  process.exit(hasBlocking ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
