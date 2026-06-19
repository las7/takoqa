/**
 * Harness meta-eval CLI / regression gate — "test the tests".
 *
 * Runs the REAL engine over the planted-bug fixture (via runFixtureEval), then
 * asks whether every DETECTOR the harness ships is EXERCISED (detectorCoverage)
 * and PROTECTED (mutationScore — ablating the oracle makes a caught case miss).
 * A detector that is uncovered or merely shadowed could silently rot while the
 * self-eval + ledger gates stay green; this gate is what catches that.
 *
 *   node --import tsx test/metaeval.ts [--ledger <path>] [--alg <label>]
 *                                      [--record] [--no-gate] [--out <dir>]
 *
 * Lives in test/ (not src/, not a *.test.ts) so it can import the fixture server
 * + manifest, the same boundary the self-eval respects.
 *
 * It re-uses the eval LEDGER unchanged, so a harness change is measured against
 * the previous state exactly like the self-eval. The generic EvalMetrics fields
 * carry the meta measures: metrics.recall := mutationScore, metrics.precision :=
 * detectorCoverage, falsePositives := #uncovered, perCase[kind] := isProtected.
 * compareToBaseline then gives the per-detector gate for free: a detector going
 * protected→unprotected is a per-case regression, and a coverage/mutation drop is
 * a recall/precision drop — either fails the gate.
 *
 * --record appends the new record AFTER comparing, so an accepted improvement
 * becomes the next baseline. --no-gate reports without exiting non-zero.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

import { runFixtureEval } from "../src/selfeval.js";
import { detectorCoverage, mutationScore } from "../src/metaeval.js";
import {
  compareToBaseline,
  datasetHash,
  gitProvenance,
  loadLedger,
  previousRecord,
  recordRun,
  type EvalRecord,
} from "../src/evalLedger.js";
import { startFixtureServer } from "./fixture-server.js";
import { PLANTED } from "./fixture-manifest.js";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(TEST_DIR, "..");

/** The "task" identity — distinct from the self-eval's "self_eval" in the same ledger. */
const TASK = "harness_meta";

/** Float slack matching evalLedger's isRegression, so the printed reason agrees with the gate. */
const EPS = 1e-9;

interface Args {
  ledger: string;
  alg: string;
  record: boolean;
  gate: boolean;
  out?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    ledger: join("eval", "eval_ledger.jsonl"),
    alg: "meta",
    record: false,
    gate: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--ledger") args.ledger = argv[++i] ?? args.ledger;
    else if (a === "--alg") args.alg = argv[++i] ?? args.alg;
    else if (a === "--record") args.record = true;
    else if (a === "--no-gate") args.gate = false;
    else if (a === "--out") args.out = argv[++i];
  }
  return args;
}

/**
 * The dataset whose bytes define "the same harness-coverage question": the
 * fixture server + the ground-truth manifest. Edit either and the hash changes,
 * so a stale baseline stops being comparable (the gate goes silent rather than
 * comparing across a changed fixture). The detector SET (KIND_CLASS in
 * src/metaeval.ts) is intentionally NOT hashed: adding a detector kind without a
 * fixture leaves these two files unchanged, so the prior baseline stays
 * comparable and the coverage DROP correctly trips the gate.
 */
function metaDataset() {
  return datasetHash([
    join(TEST_DIR, "fixture-server.ts"),
    join(TEST_DIR, "fixture-manifest.ts"),
  ]);
}

function fixed(n: number): string {
  return n.toFixed(3);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const outDir = args.out ?? mkdtempSync(join(tmpdir(), "takoqa-meta-"));

  const { report, score } = await runFixtureEval({
    startServer: startFixtureServer,
    cases: PLANTED,
    outDir,
  });

  // The mutation analysis assumes a PASSING report — it asks "would ablating a
  // detector turn a CAUGHT case into a miss?". If the self-eval isn't passing, a
  // genuinely-dead oracle (its case already missed) would masquerade as merely
  // "shadowed". Enforce the premise loudly (exit 2 ≠ the gate's exit 1) rather
  // than report misleading protection numbers.
  if (score.recall !== 1 || score.falsePositives.length > 0) {
    console.error(
      `meta-eval premise violated — the self-eval is not passing ` +
        `(recall ${score.recall.toFixed(3)}, ${score.falsePositives.length} false positive(s)` +
        (score.missed.length ? `, missed: [${score.missed.join(", ")}]` : "") +
        `). Fix it (npm run selfeval) before trusting the meta-eval.`,
    );
    process.exit(2);
  }

  const cov = detectorCoverage(PLANTED);
  const mut = mutationScore(report, PLANTED);

  // perCase: one entry per DETECTOR kind, true iff protected. Going
  // protected→unprotected is the per-detector regression the ledger gate catches.
  const perCase: Record<string, boolean> = {};
  for (const k of cov.detectors) perCase[k] = mut.protectedKinds.includes(k);

  const record: EvalRecord = {
    ts: new Date().toISOString(),
    task: TASK,
    dataset: metaDataset(),
    alg: { harness: args.alg },
    // The semantic measures, kept readable in the ledger alongside the generic
    // recall/precision mapping below.
    config: {
      coverage: cov.coverage,
      mutationScore: mut.mutationScore,
      uncovered: cov.uncovered,
      shadowed: mut.shadowed,
    },
    git: gitProvenance(REPO_ROOT),
    metrics: {
      recall: mut.mutationScore, // mutationScore carried as recall
      precision: cov.coverage, // detectorCoverage carried as precision
      falsePositives: cov.uncovered.length,
      caught: mut.protectedKinds,
      missed: mut.unprotected,
      total: cov.detectors.length,
    },
    perCase,
  };

  const ledgerPath = resolve(REPO_ROOT, args.ledger);
  const ledger = loadLedger(ledgerPath);
  const prev = previousRecord(ledger, {
    task: TASK,
    datasetHash: record.dataset.hash,
  });
  const delta = compareToBaseline(record, prev);

  console.log(
    `meta-eval [${args.alg}] over ${cov.detectors.length} detector kinds`,
  );
  if (delta.comparable) {
    console.log(
      `coverage ${fixed(cov.coverage - delta.precisionDelta)}→${fixed(cov.coverage)}, ` +
        `mutation ${fixed(mut.mutationScore - delta.recallDelta)}→${fixed(mut.mutationScore)}; ` +
        `${delta.regressions.length} now-unprotected${delta.regressions.length ? ` [${delta.regressions.join(", ")}]` : ""}, ` +
        `${delta.gains.length} now-protected${delta.gains.length ? ` [${delta.gains.join(", ")}]` : ""}; ` +
        `comparable to ${delta.baselineTs}`,
    );
  } else {
    console.log(
      `coverage ${fixed(cov.coverage)}, mutation ${fixed(mut.mutationScore)} — ` +
        `no comparable baseline (first run on this dataset)`,
    );
  }
  if (mut.unprotected.length) {
    console.log(
      `unprotected detectors: ${mut.unprotected.join(", ")} ` +
        `(uncovered: ${cov.uncovered.join(", ") || "none"}; shadowed: ${mut.shadowed.join(", ") || "none"})`,
    );
  }

  if (args.record) {
    recordRun(ledgerPath, record);
    console.log(`recorded → ${ledgerPath}`);
  }

  // The gate fails on EITHER a comparative regression (a detector lost protection
  // vs the previous state) OR an absolute floor breach (any unprotected detector
  // right now) — the latter fires even on a first run with no comparable baseline,
  // so a freshly-shipped shadowed/uncovered detector can't slip in silently.
  const unprotectedNow = mut.unprotected.length > 0;
  const blocked = args.gate && (delta.isRegression || unprotectedNow);
  if (blocked) {
    const reasons: string[] = [];
    if (delta.regressions.length)
      reasons.push(
        `${delta.regressions.length} detector(s) lost protection vs baseline [${delta.regressions.join(", ")}]`,
      );
    if (
      delta.comparable &&
      (delta.recallDelta < -EPS || delta.precisionDelta < -EPS)
    )
      reasons.push("coverage/mutation dropped");
    if (unprotectedNow)
      reasons.push(`unprotected now: [${mut.unprotected.join(", ")}]`);
    console.log(`REGRESSION — gate FAILED: ${reasons.join("; ")}`);
  } else {
    console.log(
      delta.comparable
        ? "PASS — no detector lost protection vs previous state"
        : "PASS — first run on this dataset (every detector protected)",
    );
  }
  process.exit(blocked ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
