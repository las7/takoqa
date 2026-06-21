/**
 * Unit tests for observation coverage — pure, no browser/LLM.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { computeObservationCoverage } from "../src/coverage.js";
import type {
  MissionResult,
  ObservedAffordance,
  StepRecord,
} from "../src/types.js";

function aff(ref: number, over: Partial<ObservedAffordance> = {}): ObservedAffordance {
  return { ref, role: "button", label: `L${ref}`, ...over };
}

function step(
  url: string,
  elements: ObservedAffordance[],
  actedRefs: number[],
  truncated?: number,
): StepRecord {
  return {
    index: 0,
    url,
    actionSummary: "a",
    rationale: "r",
    observed: { url, elements, actedRefs, ...(truncated ? { truncated } : {}) },
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

test("empty run → vacuously full, nothing observed", () => {
  const c = computeObservationCoverage([]);
  assert.equal(c.observed, 0);
  assert.equal(c.exercised, 0);
  assert.equal(c.coverage, 1);
  assert.deepEqual(c.frontier, []);
  assert.equal(c.frontierTotal, 0);
});

test("half the seen affordances exercised → 0.5, frontier lists the rest", () => {
  const c = computeObservationCoverage([
    mission([step("http://h/p", [aff(0, { label: "A" }), aff(1, { label: "B" })], [0])]),
  ]);
  assert.equal(c.observed, 2);
  assert.equal(c.exercised, 1);
  assert.equal(c.coverage, 0.5);
  assert.equal(c.frontierTotal, 1);
  assert.deepEqual(c.frontier, [{ route: "/p", role: "button", label: "B" }]);
});

test("all seen affordances exercised → 1.0, empty frontier", () => {
  const c = computeObservationCoverage([
    mission([step("http://h/p", [aff(0), aff(1)], [0, 1])]),
  ]);
  assert.equal(c.coverage, 1);
  assert.equal(c.exercised, 2);
  assert.deepEqual(c.frontier, []);
});

test("unlabeled affordances are excluded from the ratio but counted", () => {
  const c = computeObservationCoverage([
    mission([step("http://h/p", [aff(0, { label: "A" }), aff(1, { label: "" })], [0])]),
  ]);
  assert.equal(c.observed, 1);
  assert.equal(c.exercised, 1);
  assert.equal(c.coverage, 1);
  assert.equal(c.unlabeled, 1);
});

test("same affordance seen across steps counts once (stable key dedupe)", () => {
  const c = computeObservationCoverage([
    mission([
      step("http://h/p", [aff(0, { label: "Save" })], []),
      step("http://h/p", [aff(0, { label: "Save" })], [0]),
    ]),
  ]);
  assert.equal(c.observed, 1);
  assert.equal(c.exercised, 1);
  assert.equal(c.coverage, 1);
});

test("dynamic url segments normalize so the same control dedupes across ids", () => {
  const c = computeObservationCoverage([
    mission([
      step("http://h/x/123e4567-e89b-12d3-a456-426614174000", [aff(0, { label: "Save" })], []),
      step("http://h/x/00000000-0000-0000-0000-000000000000", [aff(0, { label: "Save" })], []),
    ]),
  ]);
  assert.equal(c.observed, 1);
  assert.equal(c.frontier[0]!.route, "/x/[id]");
});

test("acting on a ref not present (coordinate/stale) exercises nothing", () => {
  const c = computeObservationCoverage([
    mission([step("http://h/p", [aff(0)], [9])]),
  ]);
  assert.equal(c.observed, 1);
  assert.equal(c.exercised, 0);
  assert.equal(c.coverage, 0);
});

test("truncated counts sum across steps", () => {
  const c = computeObservationCoverage([
    mission([
      step("http://h/p", [aff(0)], [0], 5),
      step("http://h/q", [aff(0)], [0], 3),
    ]),
  ]);
  assert.equal(c.truncated, 8);
});
