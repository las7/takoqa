/**
 * Unit tests for cross-run coverage memory — pure + a tmpdir round-trip.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { runAffordances } from "../src/coverage.js";
import {
  loadCoverage,
  saveCoverage,
  mergeRunCoverage,
  historicalExercisedKeys,
  type CoverageMemory,
} from "../src/coverageStore.js";
import type {
  MissionResult,
  ObservedAffordance,
  StepRecord,
} from "../src/types.js";

function aff(ref: number, over: Partial<ObservedAffordance> = {}): ObservedAffordance {
  return { ref, role: "button", label: `L${ref}`, ...over };
}

function step(url: string, elements: ObservedAffordance[], actedRefs: number[]): StepRecord {
  return {
    index: 0,
    url,
    actionSummary: "a",
    rationale: "r",
    observed: { url, elements, actedRefs },
  };
}

function mission(steps: StepRecord[]): MissionResult {
  return {
    missionId: "m",
    persona: "p",
    goal: "g",
    outcome: "passed",
    steps,
    findings: [],
    startedAt: "t",
    finishedAt: "t",
  };
}

test("runAffordances flags which distinct affordances were exercised", () => {
  const out = runAffordances([
    mission([step("http://h/p", [aff(0, { label: "A" }), aff(1, { label: "B" })], [0])]),
  ]);
  const byLabel = Object.fromEntries(out.map((a) => [a.label, a.exercised]));
  assert.deepEqual(byLabel, { A: true, B: false });
});

test("mergeRunCoverage records observed/exercised; historical = exercised-ever", () => {
  const mem: CoverageMemory = {};
  mergeRunCoverage(
    mem,
    [mission([step("http://h/p", [aff(0, { label: "A" }), aff(1, { label: "B" })], [0])])],
    "2026-06-20T00:00:00Z",
  );
  assert.equal(Object.keys(mem).length, 2);
  const ex = historicalExercisedKeys(mem);
  assert.equal(ex.size, 1);
  assert.ok([...ex][0]!.endsWith("|button|A|"));
});

test("a later run that exercises a previously-unexercised control flips it", () => {
  const mem: CoverageMemory = {};
  const m = (acted: number[]) =>
    mission([step("http://h/p", [aff(1, { label: "B" })], acted)]);
  mergeRunCoverage(mem, [m([])], "2026-06-20T00:00:00Z"); // seen, not exercised
  assert.equal(historicalExercisedKeys(mem).size, 0);
  mergeRunCoverage(mem, [m([1])], "2026-06-21T00:00:00Z"); // now exercised
  const key = Object.keys(mem)[0]!;
  assert.equal(mem[key]!.exercised, true);
  assert.equal(mem[key]!.runCount, 2);
  assert.equal(historicalExercisedKeys(mem).size, 1);
});

test("load/save round-trips through disk, keyed per profile", () => {
  const dir = mkdtempSync(join(tmpdir(), "takoqa-cov-"));
  const mem: CoverageMemory = {};
  mergeRunCoverage(mem, [mission([step("http://h/p", [aff(0)], [0])])], "2026-06-20T00:00:00Z");
  saveCoverage(dir, "intencion", mem);
  const back = loadCoverage(dir, "intencion");
  assert.deepEqual(back, mem);
  assert.deepEqual(loadCoverage(dir, "other-profile"), {}); // isolated per profile
});

test("loading a missing store is empty, not an error", () => {
  assert.deepEqual(loadCoverage(join(tmpdir(), "nope-does-not-exist"), "x"), {});
});
