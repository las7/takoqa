/**
 * Unit tests for the comparative eval ledger (src/evalLedger.ts). Pure node
 * --test — no browser, no fixture, no LLM.
 *
 * The KEY tests are on compareToBaseline: a per-case SWAP that keeps aggregate
 * recall FLAT must still register as a regression — that is exactly what the
 * absolute recall gate (selfeval.test.ts) cannot see and the whole reason this
 * comparative layer exists.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  compareToBaseline,
  datasetHash,
  loadLedger,
  previousRecord,
  recordRun,
  type EvalRecord,
} from "../src/evalLedger.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "takoqa-ledger-test-"));
}

/** A minimal record builder so each test states only what it cares about. */
function rec(over: Partial<EvalRecord> = {}): EvalRecord {
  return {
    ts: "2026-01-01T00:00:00.000Z",
    task: "self_eval",
    dataset: { hash: "sha256:aaa", files: 2 },
    alg: { harness: "self-eval" },
    config: {},
    git: { gitSha: "abc", dirty: false },
    metrics: {
      recall: 1,
      precision: 1,
      falsePositives: 0,
      caught: [],
      missed: [],
      total: 0,
    },
    perCase: {},
    ...over,
  };
}

// --------------------------------------------------------------------------
// datasetHash
// --------------------------------------------------------------------------

test("datasetHash is deterministic regardless of input order", () => {
  const dir = tmp();
  const a = join(dir, "a.txt");
  const b = join(dir, "b.txt");
  writeFileSync(a, "alpha");
  writeFileSync(b, "beta");

  const h1 = datasetHash([a, b]);
  const h2 = datasetHash([b, a]);
  assert.equal(h1.hash, h2.hash);
  assert.equal(h1.files, 2);
});

test("datasetHash changes when a file's bytes change", () => {
  const dir = tmp();
  const a = join(dir, "a.txt");
  writeFileSync(a, "before");
  const before = datasetHash([a]);
  writeFileSync(a, "after");
  const after = datasetHash([a]);
  assert.notEqual(before.hash, after.hash);
});

test("datasetHash skips missing files (counts only those present)", () => {
  const dir = tmp();
  const a = join(dir, "a.txt");
  writeFileSync(a, "x");
  const h = datasetHash([a, join(dir, "does-not-exist.txt")]);
  assert.equal(h.files, 1);
});

// --------------------------------------------------------------------------
// recordRun + loadLedger
// --------------------------------------------------------------------------

test("recordRun + loadLedger round-trips appended records in order", () => {
  const path = join(tmp(), "nested", "eval_ledger.jsonl");
  const r1 = rec({ ts: "2026-01-01T00:00:00.000Z" });
  const r2 = rec({ ts: "2026-01-02T00:00:00.000Z" });
  recordRun(path, r1);
  recordRun(path, r2);

  const loaded = loadLedger(path);
  assert.equal(loaded.length, 2);
  assert.equal(loaded[0]!.ts, r1.ts);
  assert.equal(loaded[1]!.ts, r2.ts);
});

test("loadLedger returns [] for a missing file", () => {
  assert.deepEqual(loadLedger(join(tmp(), "nope.jsonl")), []);
});

test("loadLedger tolerates blank and corrupt lines (skips them)", () => {
  const path = join(tmp(), "eval_ledger.jsonl");
  recordRun(path, rec({ ts: "2026-01-01T00:00:00.000Z" }));
  appendFileSync(path, "\n", "utf8"); // blank line
  appendFileSync(path, "{not valid json\n", "utf8"); // corrupt line
  recordRun(path, rec({ ts: "2026-01-02T00:00:00.000Z" }));

  const loaded = loadLedger(path);
  assert.equal(loaded.length, 2);
  assert.equal(loaded[0]!.ts, "2026-01-01T00:00:00.000Z");
  assert.equal(loaded[1]!.ts, "2026-01-02T00:00:00.000Z");
});

// --------------------------------------------------------------------------
// previousRecord
// --------------------------------------------------------------------------

test("previousRecord returns the most-recent matching (task, datasetHash)", () => {
  const ledger = [
    rec({ ts: "t1", dataset: { hash: "sha256:aaa", files: 2 } }),
    rec({ ts: "t2", dataset: { hash: "sha256:aaa", files: 2 } }),
  ];
  const got = previousRecord(ledger, {
    task: "self_eval",
    datasetHash: "sha256:aaa",
  });
  assert.equal(got?.ts, "t2"); // last append wins
});

test("previousRecord ignores a different dataset.hash, returns null when none match", () => {
  const ledger = [
    rec({ ts: "t1", dataset: { hash: "sha256:OTHER", files: 2 } }),
  ];
  // Same task, different dataset → not comparable → null.
  assert.equal(
    previousRecord(ledger, { task: "self_eval", datasetHash: "sha256:aaa" }),
    null,
  );
  // Different task, same hash → null.
  assert.equal(
    previousRecord(ledger, { task: "OTHER_TASK", datasetHash: "sha256:OTHER" }),
    null,
  );
});

// --------------------------------------------------------------------------
// compareToBaseline — THE KEY TESTS
// --------------------------------------------------------------------------

test("compareToBaseline: no baseline → not comparable, not a regression", () => {
  const current = rec({ perCase: { A: true, B: true } });
  const delta = compareToBaseline(current, null);
  assert.equal(delta.comparable, false);
  assert.equal(delta.isRegression, false);
  assert.equal(delta.baselineTs, null);
  assert.equal(delta.recallDelta, 0);
});

test("compareToBaseline: per-case SWAP at IDENTICAL recall is a REGRESSION", () => {
  // The absolute recall gate (selfeval.test.ts) CANNOT catch this: recall is
  // 0.5 before and after — flat — yet a bug that USED to be caught (A) is now
  // missed. The comparative gate must fail it. This is the whole point of the
  // ledger layer.
  const baseline = rec({
    perCase: { A: true, B: false },
    metrics: {
      recall: 0.5,
      precision: 1,
      falsePositives: 0,
      caught: ["A"],
      missed: ["B"],
      total: 2,
    },
  });
  const current = rec({
    perCase: { A: false, B: true }, // swapped: lost A, gained B
    metrics: {
      recall: 0.5, // IDENTICAL aggregate recall
      precision: 1,
      falsePositives: 0,
      caught: ["B"],
      missed: ["A"],
      total: 2,
    },
  });
  const delta = compareToBaseline(current, baseline);
  assert.equal(delta.comparable, true);
  assert.deepEqual(delta.regressions, ["A"]);
  assert.deepEqual(delta.gains, ["B"]);
  assert.ok(Math.abs(delta.recallDelta) < 1e-9, "recall delta is ~0 (flat)");
  // The assertion the absolute gate cannot make:
  assert.equal(
    delta.isRegression,
    true,
    "a caught→missed swap at flat recall MUST be a regression",
  );
});

test("compareToBaseline: precision drop with same per-case is a regression", () => {
  const baseline = rec({
    perCase: { A: true },
    metrics: {
      recall: 1,
      precision: 1,
      falsePositives: 0,
      caught: ["A"],
      missed: [],
      total: 1,
    },
  });
  const current = rec({
    perCase: { A: true }, // same cases caught
    metrics: {
      recall: 1,
      precision: 0.5, // started crying wolf on a clean route
      falsePositives: 1,
      caught: ["A"],
      missed: [],
      total: 1,
    },
  });
  const delta = compareToBaseline(current, baseline);
  assert.deepEqual(delta.regressions, []);
  assert.ok(delta.precisionDelta < 0);
  assert.equal(delta.fpDelta, 1);
  assert.equal(delta.isRegression, true);
});

test("compareToBaseline: pure gain (new id caught, none lost) is NOT a regression", () => {
  const baseline = rec({
    perCase: { A: true, B: false },
    metrics: {
      recall: 0.5,
      precision: 1,
      falsePositives: 0,
      caught: ["A"],
      missed: ["B"],
      total: 2,
    },
  });
  const current = rec({
    perCase: { A: true, B: true }, // kept A, now also catches B
    metrics: {
      recall: 1,
      precision: 1,
      falsePositives: 0,
      caught: ["A", "B"],
      missed: [],
      total: 2,
    },
  });
  const delta = compareToBaseline(current, baseline);
  assert.deepEqual(delta.regressions, []);
  assert.deepEqual(delta.gains, ["B"]);
  assert.ok(delta.recallDelta > 0);
  assert.equal(delta.isRegression, false);
});
