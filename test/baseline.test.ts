/**
 * Unit tests for the known-bugs baseline — pure, no browser/LLM.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyAndUpdate,
  loadBaseline,
  mutedExclusions,
  saveBaseline,
  type Baseline,
} from "../src/baseline.js";
import type { Finding } from "../src/types.js";

function finding(over: Partial<Finding> = {}): Finding {
  return {
    kind: "console_error",
    severity: "low",
    missionId: "m",
    persona: "p",
    title: "boom",
    detail: "d",
    repro: [],
    url: "http://x",
    timestamp: "t",
    ...over,
  };
}

test("a finding is new on first sight and known on the next run", () => {
  const baseline: Baseline = {};
  const first = finding();
  const t1 = classifyAndUpdate([first], baseline, "2026-01-01T00:00:00.000Z");
  assert.equal(t1.new, 1);
  assert.equal(first.status, "new");

  const second = finding();
  const t2 = classifyAndUpdate([second], baseline, "2026-01-02T00:00:00.000Z");
  assert.equal(t2.known, 1);
  assert.equal(t2.new, 0);
  assert.equal(second.status, "known");
});

test("muted baseline entries classify as muted, not known/new", () => {
  const baseline: Baseline = {};
  classifyAndUpdate([finding()], baseline, "t1");
  for (const k of Object.keys(baseline)) baseline[k]!.muted = true;
  const f = finding();
  const t = classifyAndUpdate([f], baseline, "t2");
  assert.deepEqual(t, { new: 0, known: 0, muted: 1 });
  assert.equal(f.status, "muted");
});

test("distinct findings are tracked separately and bumped once per run", () => {
  const baseline: Baseline = {};
  classifyAndUpdate(
    [
      finding({ title: "boom" }),
      finding({ title: "boom" }),
      finding({ kind: "page_error", title: "kaboom" }),
    ],
    baseline,
    "t1",
  );
  assert.equal(Object.keys(baseline).length, 2, "two distinct fingerprints");
});

test("the same bug on a dynamic URL is known across runs despite a new id", () => {
  const baseline: Baseline = {};
  const r1 = finding({
    kind: "http_error",
    title:
      "HTTP 500 on GET /api/documents/3f2504e0-4f89-41d3-9a0c-0305e82c3301",
  });
  const t1 = classifyAndUpdate([r1], baseline, "t1");
  assert.equal(t1.new, 1);

  // Next run: same endpoint+status, different resource id in the title.
  const r2 = finding({
    kind: "http_error",
    title:
      "HTTP 500 on GET /api/documents/9c858901-8a57-4791-81fe-4c455b099bc9",
  });
  const t2 = classifyAndUpdate([r2], baseline, "t2");
  assert.equal(t2.known, 1, "the recurring 500 should be recognized as known");
  assert.equal(Object.keys(baseline).length, 1, "ids collapse to one entry");
});

test("a different HTTP status is a distinct baseline entry, not collapsed", () => {
  const baseline: Baseline = {};
  classifyAndUpdate(
    [
      finding({
        kind: "http_error",
        title: "HTTP 500 on GET /api/x/123456789",
      }),
    ],
    baseline,
    "t1",
  );
  classifyAndUpdate(
    [
      finding({
        kind: "http_error",
        title: "HTTP 404 on GET /api/x/987654321",
      }),
    ],
    baseline,
    "t1",
  );
  assert.equal(
    Object.keys(baseline).length,
    2,
    "500 and 404 must stay distinct (status codes are not collapsed)",
  );
});

test("mutedExclusions returns annotated mutes only — the mute→judge bridge", () => {
  const baseline: Baseline = {
    "ux_issue|dev badge": {
      firstSeen: "t",
      lastSeen: "t",
      runCount: 3,
      muted: true,
      mutedAs: "the N-Issues badge is the dev toolbar, not a product bug",
    },
    "ux_issue|bare mute": {
      firstSeen: "t",
      lastSeen: "t",
      runCount: 1,
      muted: true,
      // no mutedAs — report-only suppression, must NOT reach the judge
    },
    "http_error|real bug": {
      firstSeen: "t",
      lastSeen: "t",
      runCount: 1,
      // not muted at all
    },
  };
  assert.deepEqual(mutedExclusions(baseline), [
    "the N-Issues badge is the dev toolbar, not a product bug",
  ]);
});

test("baseline round-trips through save/load", () => {
  const dir = join(
    tmpdir(),
    "takoqa-baseline-" + Math.random().toString(36).slice(2),
  );
  const b: Baseline = {};
  classifyAndUpdate([finding()], b, "t");
  saveBaseline(dir, "fixture", b);
  assert.equal(Object.keys(loadBaseline(dir, "fixture")).length, 1);
});
