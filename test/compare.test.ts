import { test } from "node:test";
import assert from "node:assert/strict";
import { compareRuns, diffExitCode } from "../src/compare.js";
import type { Finding, FindingKind, Severity } from "../src/types.js";

function f(
  kind: FindingKind,
  title: string,
  severity: Severity = "medium",
): Finding {
  return {
    kind,
    severity,
    missionId: "m",
    persona: "p",
    title,
    detail: "",
    repro: [],
    url: "https://example/",
    timestamp: "2026-01-01T00:00:00.000Z",
  };
}

test("compareRuns classifies fixed / added / unchanged by fingerprint", () => {
  const before = [
    f("insecure_headers", "Missing security headers on /"),
    f("accessibility", "Image missing alt text"),
  ];
  const after = [
    f("insecure_headers", "Missing security headers on /"),
    f("page_error", "Uncaught JS exception"),
  ];
  const d = compareRuns(before, after);

  assert.equal(d.unchanged.length, 1, "headers finding present in both");
  assert.equal(d.unchanged[0].kind, "insecure_headers");
  assert.equal(d.fixed.length, 1, "a11y finding gone in after");
  assert.equal(d.fixed[0].kind, "accessibility");
  assert.equal(d.added.length, 1, "page_error new in after");
  assert.equal(d.added[0].kind, "page_error");
});

test("fingerprint collapses volatile ids so the same bug matches across runs", () => {
  // Titles differ only by an embedded uuid → same baselineFingerprint → the
  // finding is `unchanged`, not a spurious fixed+added pair.
  const before = [
    f("dead_link", "Broken link 3f2a1b0c-1111-2222-3333-444455556666"),
  ];
  const after = [
    f("dead_link", "Broken link 99887766-aaaa-bbbb-cccc-ddddeeeeffff"),
  ];
  const d = compareRuns(before, after);

  assert.equal(d.unchanged.length, 1);
  assert.equal(d.added.length, 0);
  assert.equal(d.fixed.length, 0);
});

test("diffExitCode gates regressions, honoring minimum severity", () => {
  const clean = compareRuns([f("ux_issue", "A")], [f("ux_issue", "A")]);
  assert.equal(diffExitCode(clean), 0, "no new findings → pass");

  const regressed = compareRuns([], [f("page_error", "boom", "high")]);
  assert.equal(diffExitCode(regressed), 1, "a new finding → fail");
  assert.equal(
    diffExitCode(regressed, "critical"),
    0,
    "high < critical gate → pass",
  );
});

test("empty before is all-added; empty after is all-fixed", () => {
  const fs = [f("http_error", "5xx on /api")];
  assert.equal(compareRuns([], fs).added.length, 1);
  assert.equal(compareRuns(fs, []).fixed.length, 1);
});

test("same identity + different evidence is `changed`, not `unchanged`", () => {
  // The dogfood case: a security-header finding partially fixed (4 → 1) keeps the
  // same title, so a presence-only diff calls it unchanged. Evidence diff catches it.
  const before: Finding = {
    ...f("insecure_headers", "Missing security headers on /"),
    evidence: "missing: csp, x-frame-options, x-content-type-options, hsts",
  };
  const after: Finding = {
    ...f("insecure_headers", "Missing security headers on /"),
    evidence: "missing: csp",
  };
  const d = compareRuns([before], [after]);
  assert.equal(d.unchanged.length, 0);
  assert.equal(d.fixed.length, 0);
  assert.equal(d.added.length, 0);
  assert.equal(d.changed.length, 1, "partial fix → changed");
  assert.equal(d.changed[0]!.after.evidence, "missing: csp");
});

test("diffExitCode flags a severity escalation under the same title", () => {
  const lo = f("ux_issue", "Slow page", "low");
  const hi = f("ux_issue", "Slow page", "high");
  const up = compareRuns([lo], [hi]);
  assert.equal(up.changed.length, 1, "severity differs → changed");
  assert.equal(diffExitCode(up), 1, "low→high escalation is a regression");
  const down = compareRuns([hi], [lo]);
  assert.equal(diffExitCode(down), 0, "high→low de-escalation is not");
});
