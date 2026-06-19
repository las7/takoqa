/**
 * Unit tests for finding identity + within-run collapse. The key guarantee is
 * BOTH directions: identical recurrences collapse, and genuinely-distinct
 * findings stay separate (a regression here would silently merge real bugs).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { findingFingerprint, recordFinding } from "../src/findings.js";
import type { Finding } from "../src/types.js";

function finding(over: Partial<Finding>): Finding {
  return {
    kind: "console_error",
    severity: "low",
    missionId: "m1",
    persona: "p1",
    title: "Console error: boom",
    detail: "d",
    repro: [],
    url: "http://test/x",
    timestamp: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

test("collapses identical recurrences and counts occurrences", () => {
  const findings: Finding[] = [];
  const seen = new Map<string, Finding>();
  for (let i = 0; i < 4; i++) recordFinding(findings, seen, finding({}));
  assert.equal(findings.length, 1);
  assert.equal(findings[0]!.occurrences, 4);
});

test("keeps genuinely-distinct findings separate (no over-collapse)", () => {
  const findings: Finding[] = [];
  const seen = new Map<string, Finding>();
  // Different kinds, different messages — must NOT merge.
  recordFinding(findings, seen, finding({ title: "Console error: boom" }));
  recordFinding(
    findings,
    seen,
    finding({ kind: "page_error", title: "Uncaught: kaboom" }),
  );
  assert.equal(findings.length, 2);
  assert.ok(findings.every((f) => f.occurrences === undefined));
});

test("does NOT merge http errors that differ only by status code or id", () => {
  const findings: Finding[] = [];
  const seen = new Map<string, Finding>();
  recordFinding(
    findings,
    seen,
    finding({
      kind: "http_error",
      severity: "medium",
      title: "HTTP 404 on GET /api/users/1",
    }),
  );
  recordFinding(
    findings,
    seen,
    finding({
      kind: "http_error",
      severity: "high",
      title: "HTTP 500 on GET /api/users/2",
    }),
  );
  assert.equal(
    findings.length,
    2,
    "distinct status/ids must stay separate so a 5xx isn't hidden behind a 4xx",
  );
});

test("only the (×N) loop badge is normalized away", () => {
  const a = findingFingerprint(
    finding({
      kind: "no_progress",
      title: 'No progress: "click" repeated (×3)',
    }),
  );
  const b = findingFingerprint(
    finding({
      kind: "no_progress",
      title: 'No progress: "click" repeated (×7)',
    }),
  );
  assert.equal(
    a,
    b,
    "a moving loop-count badge should not fork the fingerprint",
  );
});
