/**
 * Comparative-eval CLI / regression gate.
 *
 * Runs the REAL engine over the planted-bug fixture (via runFixtureEval),
 * records the absolute score AND — the point of this layer — diffs it against
 * the PREVIOUS committed record over the same dataset. A per-case regression (a
 * bug caught before, missed now) fails the gate even when aggregate recall is
 * unchanged; the absolute self-eval gate (selfeval.test.ts) misses that case.
 *
 *   node --import tsx test/eval.ts [--ledger <path>] [--alg <label>]
 *                                  [--record] [--no-gate] [--out <dir>]
 *
 * Lives in test/ (not src/, and NOT a *.test.ts) so it can import the fixture
 * server + manifest — the same src/↔test/ boundary the self-eval respects: src/
 * stays free of test/ deps, the fixture is INJECTED into runFixtureEval.
 *
 * --record appends the new record AFTER comparing, so each accepted improvement
 * becomes the next baseline. --no-gate reports without ever exiting non-zero.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

import { runFixtureEval } from "../src/selfeval.js";
import {
  compareToBaseline,
  datasetHash,
  gitProvenance,
  loadLedger,
  previousRecord,
  recordRun,
  renderDelta,
  type EvalRecord,
} from "../src/evalLedger.js";
import { startFixtureServer } from "./fixture-server.js";
import { PLANTED } from "./fixture-manifest.js";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(TEST_DIR, "..");

/** The "task" identity: this question + metric family. */
const TASK = "self_eval";

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
    alg: "self-eval",
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
 * The dataset whose bytes define "the same data". The planted-bug fixture IS the
 * dataset for the self-eval, so its identity is the byte-hash of the fixture
 * server + its ground-truth manifest. Edit either and the hash changes, so a
 * stale baseline stops being comparable (and the gate goes silent rather than
 * comparing apples to oranges).
 */
function selfEvalDataset() {
  return datasetHash([
    join(TEST_DIR, "fixture-server.ts"),
    join(TEST_DIR, "fixture-manifest.ts"),
  ]);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const outDir = args.out ?? mkdtempSync(join(tmpdir(), "takoqa-eval-"));

  const { score } = await runFixtureEval({
    startServer: startFixtureServer,
    cases: PLANTED,
    outDir,
  });

  // perCase covers only the non-clean (must-catch) cases — a clean route is
  // never "caught", so including it would pollute the per-case regression diff.
  // The manifest's clean cases set perCase[id].clean=true; we exclude those and
  // record caught/missed for the rest.
  const perCase: Record<string, boolean> = {};
  for (const pc of score.perCase) {
    if (pc.clean) continue;
    perCase[pc.id] = pc.ok;
  }

  const record: EvalRecord = {
    ts: new Date().toISOString(),
    task: TASK,
    dataset: selfEvalDataset(),
    alg: { harness: args.alg },
    config: {},
    git: gitProvenance(REPO_ROOT),
    metrics: {
      recall: score.recall,
      precision: score.precision,
      falsePositives: score.falsePositives.length,
      caught: score.caught,
      missed: score.missed,
      total: score.caught.length + score.missed.length,
    },
    perCase,
  };

  // Compare against the PREVIOUS state BEFORE appending the new record.
  const ledgerPath = resolve(REPO_ROOT, args.ledger);
  const ledger = loadLedger(ledgerPath);
  const prev = previousRecord(ledger, {
    task: TASK,
    datasetHash: record.dataset.hash,
  });
  const delta = compareToBaseline(record, prev);

  console.log(
    `self-eval [${args.alg}] over ${record.dataset.files}-file fixture`,
  );
  console.log(renderDelta(delta, record));

  if (args.record) {
    recordRun(ledgerPath, record);
    console.log(`recorded → ${ledgerPath}`);
  }

  const blocked = args.gate && delta.isRegression;
  if (blocked) {
    console.log(
      `REGRESSION — gate FAILED: ${delta.regressions.length} per-case regression(s)` +
        (delta.recallDelta < 0 || delta.precisionDelta < 0
          ? ", recall/precision dropped"
          : "") +
        (delta.regressions.length ? ` [${delta.regressions.join(", ")}]` : ""),
    );
  } else {
    console.log(
      delta.comparable
        ? "PASS — no regression vs previous state"
        : "PASS — first run on this dataset (no gate)",
    );
  }
  process.exit(blocked ? 1 : 0);
}

main().catch((err) => {
  // Always surface the failure; the fixture server is closed inside
  // runFixtureEval's own try/finally, so there is nothing to clean up here.
  console.error(err);
  process.exit(1);
});
