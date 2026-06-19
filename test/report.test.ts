/**
 * Unit tests for report rendering helpers — pure, no browser/LLM. Covers the
 * repro-collapse helper and the occurrences suffix in the findings report.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { collapseRepeats, renderFindings } from "../src/report.js";
import type { Finding, RunReport } from "../src/types.js";

test("collapseRepeats folds consecutive duplicates into (xN)", () => {
  assert.deepEqual(
    collapseRepeats([
      "Opened /playground",
      "Clicked [6] Playground",
      "Clicked [6] Playground",
      "Clicked [6] Playground",
      "Finished",
    ]),
    ["Opened /playground", "Clicked [6] Playground (x3)", "Finished"],
  );
});

test("collapseRepeats leaves singletons and non-consecutive repeats verbatim", () => {
  assert.deepEqual(collapseRepeats([]), []);
  assert.deepEqual(collapseRepeats(["a"]), ["a"]);
  assert.deepEqual(collapseRepeats(["a", "b", "a"]), ["a", "b", "a"]);
});

test("collapseRepeats folds a long run to a single (xN) line", () => {
  assert.deepEqual(collapseRepeats(Array(17).fill("Clicked [6] Playground")), [
    "Clicked [6] Playground (x17)",
  ]);
});

test("renderFindings shows occurrences and collapses repeated repro lines", () => {
  const finding: Finding = {
    kind: "console_error",
    severity: "low",
    missionId: "m1",
    persona: "p1",
    title: "Console error: boom",
    detail: "the page logged a console error",
    repro: ["Clicked [0] Go", "Clicked [0] Go", "Clicked [0] Go"],
    url: "http://test/x",
    timestamp: "2026-01-01T00:00:00.000Z",
    occurrences: 3,
  };
  const report: RunReport = {
    profile: "fixture",
    baseUrl: "http://test",
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:00:01.000Z",
    results: [
      {
        missionId: "m1",
        persona: "p1",
        goal: "g",
        outcome: "stuck",
        steps: [],
        findings: [finding],
        startedAt: "2026-01-01T00:00:00.000Z",
        finishedAt: "2026-01-01T00:00:01.000Z",
      },
    ],
    coverage: {
      routesVisited: ["/agent", "/knowledge/[id]"],
      unvisitedKnownRoutes: ["/settings"],
    },
  };
  const out = renderFindings(report);
  assert.match(out, /\(fired 3 times\)/);
  assert.match(out, /Clicked \[0\] Go \(x3\)/);
  assert.match(out, /Coverage: 2 route\(s\) visited/);
  assert.match(out, /Unvisited known routes: \/settings/);
});
