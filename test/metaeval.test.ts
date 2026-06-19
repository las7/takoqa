/**
 * Unit tests for the harness meta-eval (pure — no browser, no LLM, no engine).
 *
 * Covers: detector classification (KIND_CLASS exhaustive, DETECTOR_KINDS excludes
 * judgments), coverage from the manifest, ablation, and the mutation/protection
 * analysis (sole-signal ⇒ protected, co-caught ⇒ shadowed, no case ⇒ uncovered).
 * Plus the static ratchet: the REAL manifest must cover every detector kind.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  KIND_CLASS,
  DETECTOR_KINDS,
  detectorCoverage,
  ablateKind,
  mutationScore,
} from "../src/metaeval.js";
import type { PlantedCase } from "../src/selfeval.js";
import type {
  Finding,
  FindingKind,
  MissionResult,
  RunReport,
} from "../src/types.js";
import { PLANTED } from "./fixture-manifest.js";

function finding(kind: FindingKind, url: string): Finding {
  return {
    kind,
    severity: "high",
    missionId: "m",
    persona: "p",
    title: `${kind} on ${url}`,
    detail: "",
    repro: [],
    url,
    timestamp: "2026-01-01T00:00:00.000Z",
  };
}

function reportOf(findings: Finding[]): RunReport {
  const result: MissionResult = {
    missionId: "m",
    persona: "p",
    goal: "g",
    outcome: "passed",
    steps: [],
    findings,
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:00:01.000Z",
  };
  return {
    profile: "t",
    baseUrl: "http://x",
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:00:01.000Z",
    results: [result],
    coverage: { routesVisited: [], unvisitedKnownRoutes: [] },
  };
}

test("KIND_CLASS classifies every FindingKind; judgments are excluded from detectors", () => {
  // The LLM-judge verdicts + the agent step-limit signal are judgments, never detectors.
  for (const k of ["goal_failed", "ux_issue", "agent_stuck"] as FindingKind[]) {
    assert.equal(KIND_CLASS[k], "judgment", `${k} must be a judgment`);
    assert.ok(!DETECTOR_KINDS.includes(k), `${k} must not be a detector`);
  }
  // Everything classified `detector` appears in DETECTOR_KINDS, and vice versa.
  const fromMap = (Object.keys(KIND_CLASS) as FindingKind[]).filter(
    (k) => KIND_CLASS[k] === "detector",
  );
  assert.deepEqual([...DETECTOR_KINDS].sort(), [...fromMap].sort());
});

test("detectorCoverage: a non-clean case exercises a detector; clean cases do not", () => {
  const cases: PlantedCase[] = [
    {
      id: "a",
      route: "/a",
      group: "functional",
      expectedKinds: ["page_error"],
    },
    { id: "c", route: "/c", group: "security", expectedKinds: [], clean: true },
  ];
  const cov = detectorCoverage(cases);
  assert.ok(cov.covered.includes("page_error"));
  // Every OTHER detector is uncovered, and a clean case adds no coverage.
  assert.ok(cov.uncovered.includes("http_error"));
  assert.equal(cov.covered.length, 1);
  assert.equal(cov.coverage, 1 / DETECTOR_KINDS.length);
});

test("ablateKind drops only findings of the given kind", () => {
  const r = reportOf([
    finding("page_error", "http://x/a"),
    finding("http_error", "http://x/a"),
  ]);
  const ablated = ablateKind(r, "page_error");
  const kinds = ablated.results.flatMap((res) =>
    res.findings.map((f) => f.kind),
  );
  assert.deepEqual(kinds, ["http_error"]);
  // Original report is untouched (pure copy).
  assert.equal(r.results[0]!.findings.length, 2);
});

test("mutationScore: sole signal ⇒ protected, co-caught ⇒ shadowed, no case ⇒ uncovered", () => {
  const cases: PlantedCase[] = [
    // page_error is the SOLE expected kind here → ablating it loses the case.
    {
      id: "a",
      route: "/a",
      group: "functional",
      expectedKinds: ["page_error"],
    },
    // console_error only ever appears here, co-caught with page_error → shadowed.
    {
      id: "b",
      route: "/b",
      group: "functional",
      expectedKinds: ["page_error", "console_error"],
    },
  ];
  const report = reportOf([
    finding("page_error", "http://x/a"),
    finding("page_error", "http://x/b"),
    finding("console_error", "http://x/b"),
  ]);
  const mut = mutationScore(report, cases);
  assert.ok(
    mut.protectedKinds.includes("page_error"),
    "page_error is sole on /a",
  );
  assert.ok(mut.shadowed.includes("console_error"), "console_error never sole");
  assert.ok(mut.uncovered.includes("http_error"), "http_error has no case");
  assert.ok(
    mut.unprotected.includes("console_error") &&
      mut.unprotected.includes("http_error"),
    "unprotected = shadowed ∪ uncovered",
  );
});

test("RATCHET: the real planted-bug manifest covers EVERY detector kind", () => {
  const cov = detectorCoverage(PLANTED);
  assert.equal(
    cov.uncovered.length,
    0,
    `detectors with no fixture case (blind spots): [${cov.uncovered.join(", ")}] — ` +
      `add a planted route + manifest case, or reclassify the kind in KIND_CLASS`,
  );
  assert.equal(cov.coverage, 1);
});
