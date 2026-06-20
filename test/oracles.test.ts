/**
 * Layer 1: pure unit tests for the oracle logic. No browser, no LLM — just
 * synthetic events fed to checkInvariants. Fast and deterministic.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { checkInvariants, judgeMission } from "../src/oracles.js";
import type { LLMClient } from "../src/agent.js";
import type { CapturedEvents } from "../src/browser.js";
import type { Observation } from "../src/observe.js";
import { InvariantsSchema, MissionSchema } from "../src/types.js";

const inv = (overrides = {}) => InvariantsSchema.parse(overrides);

const obs = (text = ""): Observation => ({
  url: "http://test/page",
  title: "page",
  elements: [],
  visibleText: text,
  screenshotBase64: "",
  viewport: { width: 1280, height: 900 },
});

const base = { missionId: "m1", persona: "p1", repro: [] };

const noEvents = (): CapturedEvents => ({
  console: [],
  pageErrors: [],
  responses: [],
  cookies: [],
});

test("flags a 5xx response as an http_error", () => {
  const events = noEvents();
  events.responses.push({
    status: 500,
    url: "http://test/api/x",
    method: "GET",
  });
  const findings = checkInvariants(events, inv(), obs(), base);
  const http = findings.find((f) => f.kind === "http_error");
  assert.ok(http, "expected an http_error finding");
  assert.equal(http.severity, "high");
});

test("does not flag responses below the configured threshold", () => {
  const events = noEvents();
  events.responses.push({
    status: 404,
    url: "http://test/missing",
    method: "GET",
  });
  const findings = checkInvariants(events, inv(), obs(), base);
  assert.equal(findings.length, 0);
});

test("flags a 404 on the landed page document as a dead_link", () => {
  const events = noEvents();
  // obs() lands on http://test/page; the document GET for it returned 404.
  events.responses.push({
    status: 404,
    url: "http://test/page",
    method: "GET",
  });
  const dl = checkInvariants(events, inv(), obs(), base).find(
    (f) => f.kind === "dead_link",
  );
  assert.ok(dl, "expected a dead_link finding");
  assert.equal(dl.severity, "medium");
});

test("does not flag a 404 SUB-RESOURCE (not the landed document) as dead_link", () => {
  const events = noEvents();
  // A 404 on a different path than the landed page (/page) — an asset/XHR probe.
  events.responses.push({
    status: 404,
    url: "http://test/api/thing",
    method: "GET",
  });
  const findings = checkInvariants(events, inv(), obs(), base);
  assert.equal(
    findings.find((f) => f.kind === "dead_link"),
    undefined,
  );
});

test("flags a 410 Gone page document as a dead_link", () => {
  const events = noEvents();
  events.responses.push({
    status: 410,
    url: "http://test/page",
    method: "GET",
  });
  const dl = checkInvariants(events, inv(), obs(), base).find(
    (f) => f.kind === "dead_link",
  );
  assert.ok(dl);
});

test("does not double-report when a strict profile lowers the threshold below 404", () => {
  // failOnHttpStatusAtLeast <= 404 makes http_error already own the 404; dead_link
  // is strictly sub-threshold, so the landed 404 is reported once (http_error), not twice.
  const events = noEvents();
  events.responses.push({
    status: 404,
    url: "http://test/page",
    method: "GET",
  });
  const findings = checkInvariants(
    events,
    inv({ failOnHttpStatusAtLeast: 400 }),
    obs(),
    base,
  );
  assert.equal(
    findings.find((f) => f.kind === "dead_link"),
    undefined,
    "dead_link must not fire when http_error already covers the status",
  );
  assert.ok(
    findings.find((f) => f.kind === "http_error"),
    "http_error should still report the 404 at the lowered threshold",
  );
});

test("flags a 404 image sub-resource as a broken_image (low)", () => {
  const events = noEvents();
  events.responses.push({
    status: 404,
    url: "http://test/img/logo.png",
    method: "GET",
    resourceType: "image",
  });
  const f = checkInvariants(events, inv(), obs(), base).find(
    (x) => x.kind === "broken_image",
  );
  assert.ok(f, "expected a broken_image finding");
  assert.equal(f.severity, "low");
});

test("does not flag a 404 NON-image resource as broken_image", () => {
  const events = noEvents();
  events.responses.push({
    status: 404,
    url: "http://test/data.json",
    method: "GET",
    resourceType: "fetch",
  });
  const findings = checkInvariants(events, inv(), obs(), base);
  assert.equal(
    findings.find((x) => x.kind === "broken_image"),
    undefined,
  );
});

test("does not flag a successfully-loaded image as broken_image", () => {
  const events = noEvents();
  events.responses.push({
    status: 200,
    url: "http://test/img/ok.png",
    method: "GET",
    resourceType: "image",
  });
  const findings = checkInvariants(events, inv(), obs(), base);
  assert.equal(
    findings.find((x) => x.kind === "broken_image"),
    undefined,
  );
});

test("a 5xx image is owned by http_error, not double-reported as broken_image", () => {
  const events = noEvents();
  events.responses.push({
    status: 500,
    url: "http://test/img/x.png",
    method: "GET",
    resourceType: "image",
  });
  const findings = checkInvariants(events, inv(), obs(), base);
  assert.ok(
    findings.find((x) => x.kind === "http_error"),
    "a 5xx image is an http_error",
  );
  assert.equal(
    findings.find((x) => x.kind === "broken_image"),
    undefined,
    "a 5xx image must not also be broken_image",
  );
});

test("flags a 404 script as a broken_asset (medium)", () => {
  const events = noEvents();
  events.responses.push({
    status: 404,
    url: "http://test/app.js",
    method: "GET",
    resourceType: "script",
  });
  const f = checkInvariants(events, inv(), obs(), base).find(
    (x) => x.kind === "broken_asset",
  );
  assert.ok(f, "expected a broken_asset finding");
  assert.equal(f.severity, "medium");
});

test("flags a 404 stylesheet as a broken_asset", () => {
  const events = noEvents();
  events.responses.push({
    status: 404,
    url: "http://test/site.css",
    method: "GET",
    resourceType: "stylesheet",
  });
  const f = checkInvariants(events, inv(), obs(), base).find(
    (x) => x.kind === "broken_asset",
  );
  assert.ok(f);
});

test("a 404 image is broken_image, NOT broken_asset (severity tiers stay distinct)", () => {
  const events = noEvents();
  events.responses.push({
    status: 404,
    url: "http://test/logo.png",
    method: "GET",
    resourceType: "image",
  });
  const findings = checkInvariants(events, inv(), obs(), base);
  assert.ok(findings.find((x) => x.kind === "broken_image"));
  assert.equal(
    findings.find((x) => x.kind === "broken_asset"),
    undefined,
  );
});

test("a 5xx script is owned by http_error, not double-reported as broken_asset", () => {
  const events = noEvents();
  events.responses.push({
    status: 503,
    url: "http://test/app.js",
    method: "GET",
    resourceType: "script",
  });
  const findings = checkInvariants(events, inv(), obs(), base);
  assert.ok(findings.find((x) => x.kind === "http_error"));
  assert.equal(
    findings.find((x) => x.kind === "broken_asset"),
    undefined,
  );
});

test("reports an accessibility finding (low) when observe found images missing alt", () => {
  const o = {
    ...obs(),
    a11y: { imagesMissingAlt: { total: 3, samples: ["/a.png", "/b.png"] } },
  };
  const f = checkInvariants(noEvents(), inv(), o, base).find(
    (x) => x.kind === "accessibility",
  );
  assert.ok(f, "expected an accessibility finding");
  assert.equal(f.severity, "low");
  // The count lives in detail (not the title), so the cross-run fingerprint is stable.
  assert.equal(f.title, "Accessibility: image missing alt text");
  assert.match(f.detail, /3 rendered image/);
});

test("does not report accessibility when observe found no missing-alt images", () => {
  const noA11y = checkInvariants(noEvents(), inv(), obs(), base);
  assert.equal(
    noA11y.find((x) => x.kind === "accessibility"),
    undefined,
  );
  const zero = {
    ...obs(),
    a11y: { imagesMissingAlt: { total: 0, samples: [] } },
  };
  assert.equal(
    checkInvariants(noEvents(), inv(), zero, base).find(
      (x) => x.kind === "accessibility",
    ),
    undefined,
  );
});

test("reports a control-name accessibility finding, distinct from the image rule", () => {
  const o = {
    ...obs(),
    a11y: {
      controlsMissingName: { total: 2, samples: ["button#x", "a.icon"] },
    },
  };
  const fs = checkInvariants(noEvents(), inv(), o, base).filter(
    (x) => x.kind === "accessibility",
  );
  assert.equal(fs.length, 1);
  assert.equal(fs[0].severity, "low");
  // A distinct title from the image rule, so the two rules don't fingerprint-merge.
  assert.equal(fs[0].title, "Accessibility: control with no accessible name");
});

test("reports BOTH a11y rules as two findings when both are present", () => {
  const o = {
    ...obs(),
    a11y: {
      imagesMissingAlt: { total: 1, samples: ["/a.png"] },
      controlsMissingName: { total: 1, samples: ["button#y"] },
    },
  };
  const titles = checkInvariants(noEvents(), inv(), o, base)
    .filter((x) => x.kind === "accessibility")
    .map((x) => x.title)
    .sort();
  assert.deepEqual(titles, [
    "Accessibility: control with no accessible name",
    "Accessibility: image missing alt text",
  ]);
});

test("reports a form-field accessibility finding, distinct from the other rules", () => {
  const o = {
    ...obs(),
    a11y: {
      fieldsMissingLabel: { total: 2, samples: ["input#email", "select"] },
    },
  };
  const fs = checkInvariants(noEvents(), inv(), o, base).filter(
    (x) => x.kind === "accessibility",
  );
  assert.equal(fs.length, 1);
  assert.equal(fs[0].severity, "low");
  assert.equal(fs[0].title, "Accessibility: form field with no label");
  assert.match(fs[0].detail, /2 form field/);
});

test("reports an orphan-label accessibility finding, distinct from the other rules", () => {
  const o = {
    ...obs(),
    a11y: { orphanLabels: { total: 1, samples: ["nope"] } },
  };
  const fs = checkInvariants(noEvents(), inv(), o, base).filter(
    (x) => x.kind === "accessibility",
  );
  assert.equal(fs.length, 1);
  assert.equal(fs[0].severity, "low");
  assert.equal(fs[0].title, "Accessibility: label points to a missing id");
});

test("reports a duplicate_id finding (low) when observe found duplicate ids", () => {
  const o = {
    ...obs(),
    dom: { duplicateIds: { total: 1, samples: ["x (×2)"] } },
  };
  const f = checkInvariants(noEvents(), inv(), o, base).find(
    (x) => x.kind === "duplicate_id",
  );
  assert.ok(f, "expected a duplicate_id finding");
  assert.equal(f.severity, "low");
  assert.equal(f.title, "Duplicate element id");
});

test("does not report duplicate_id when observe found none", () => {
  assert.equal(
    checkInvariants(noEvents(), inv(), obs(), base).find(
      (x) => x.kind === "duplicate_id",
    ),
    undefined,
  );
});

test("ignores errors from ignored URL substrings", () => {
  const events = noEvents();
  events.responses.push({
    status: 500,
    url: "http://test/_next/data",
    method: "GET",
  });
  const findings = checkInvariants(
    events,
    inv({ ignoreUrlSubstrings: ["/_next/"] }),
    obs(),
    base,
  );
  assert.equal(findings.length, 0);
});

test("flags an uncaught page error as critical", () => {
  const events = noEvents();
  events.pageErrors.push({
    message: "boom",
    stack: "at x",
    url: "http://test/p",
  });
  const findings = checkInvariants(events, inv(), obs(), base);
  const pe = findings.find((f) => f.kind === "page_error");
  assert.ok(pe);
  assert.equal(pe.severity, "critical");
});

test("flags console errors and crash signatures in body text", () => {
  const events = noEvents();
  events.console.push({ type: "error", text: "kaboom", url: "http://test/p" });
  const findings = checkInvariants(
    events,
    inv(),
    obs("Oops! Application error: a client-side exception"),
    base,
  );
  assert.ok(findings.some((f) => f.kind === "console_error"));
  assert.ok(findings.some((f) => f.kind === "body_error_signature"));
});

test("suppresses console errors whose text matches ignoreConsoleSubstrings", () => {
  const events = noEvents();
  events.console.push({
    type: "error",
    text: "Warning: A tree hydrated but some attributes of the server rendered HTML didn't match",
    url: "http://test/p",
  });
  const findings = checkInvariants(
    events,
    inv({ ignoreConsoleSubstrings: ["hydrated but some attributes"] }),
    obs(),
    base,
  );
  assert.ok(
    !findings.some((f) => f.kind === "console_error"),
    "a console error matching an ignore substring should be suppressed",
  );
});

test("produces no findings on a clean step", () => {
  const findings = checkInvariants(
    noEvents(),
    inv(),
    obs("All good here"),
    base,
  );
  assert.equal(findings.length, 0);
});

/** Minimal LLMClient whose judge() returns a fixed verdict JSON. */
const judgeStub = (verdict: unknown): LLMClient => ({
  decide: async () => {
    throw new Error("decide not used by judgeMission");
  },
  judge: async () => JSON.stringify(verdict),
});

const mission = MissionSchema.parse({
  id: "m1",
  goal: "upload a document and see it processed",
});

test("consolidates a multi-issue verdict into exactly ONE ux_issue", async () => {
  const llm = judgeStub({
    goalMet: true,
    severity: "low",
    issues: [
      "the upload button is hard to find",
      "no progress indicator while processing",
      "success toast disappears too quickly",
    ],
    rationale: "completed but rough",
  });
  const findings = await judgeMission(llm, mission, obs("done"), [], base);
  const ux = findings.filter((f) => f.kind === "ux_issue");
  assert.equal(ux.length, 1, "a multi-issue verdict should yield one ux_issue");
  // All three issues are listed in the single finding's bulleted detail.
  assert.match(ux[0]!.detail, /upload button/);
  assert.match(ux[0]!.detail, /progress indicator/);
  assert.match(ux[0]!.detail, /toast/);
  // No goal_failed when the goal was met.
  assert.ok(!findings.some((f) => f.kind === "goal_failed"));
});

test("on goal_failed, drops ux_issues that merely restate the failure", async () => {
  const llm = judgeStub({
    goalMet: false,
    severity: "high",
    issues: [
      // Restates the goal failure — should be suppressed.
      "could not upload the document so it was never processed",
      // A distinct UX issue — should survive.
      "the error message used red text with poor contrast",
    ],
    rationale: "the upload never completed; document was not processed",
  });
  const findings = await judgeMission(llm, mission, obs("error"), [], base);
  assert.ok(findings.some((f) => f.kind === "goal_failed"));
  const ux = findings.filter((f) => f.kind === "ux_issue");
  assert.equal(ux.length, 1, "redundant restatements should be dropped");
  assert.match(ux[0]!.detail, /contrast/);
  assert.ok(
    !/never processed/.test(ux[0]!.detail),
    "the goal-restating issue should not appear in the ux_issue",
  );
});

test("emits ONE consolidated `inconsistency` finding, distinct from ux_issue", async () => {
  const llm = judgeStub({
    goalMet: true,
    severity: "low",
    issues: [],
    inconsistencies: [
      'header says "12 runs" but only 8 rows are shown',
      'the run is "success" in the list but "failed" on its detail page',
      'dates appear as both "2026-06-20" and "Jun 20, 2026"',
    ],
    rationale: "the app contradicts its own data",
  });
  const findings = await judgeMission(llm, mission, obs("dashboard"), [], base);
  const inc = findings.filter((f) => f.kind === "inconsistency");
  assert.equal(inc.length, 1, "multiple inconsistencies → one finding");
  assert.match(inc[0]!.title, /3 data\/UI inconsistencies/);
  assert.match(inc[0]!.detail, /12 runs/);
  assert.match(inc[0]!.evidence ?? "", /Jun 20, 2026/);
  assert.ok(
    !findings.some((f) => f.kind === "ux_issue"),
    "consistency defects are NOT folded into ux_issue",
  );
});

test("no `inconsistency` finding when the judge reports none / omits the field", async () => {
  const none = judgeStub({
    goalMet: true,
    severity: "low",
    issues: [],
    inconsistencies: [],
    rationale: "ok",
  });
  assert.equal(
    (await judgeMission(none, mission, obs("ok"), [], base)).filter(
      (f) => f.kind === "inconsistency",
    ).length,
    0,
  );
  // Back-compat: a verdict that omits the field entirely defaults to none.
  const legacy = judgeStub({
    goalMet: true,
    severity: "low",
    issues: [],
    rationale: "ok",
  });
  assert.equal(
    (await judgeMission(legacy, mission, obs("ok"), [], base)).filter(
      (f) => f.kind === "inconsistency",
    ).length,
    0,
  );
});

test("caps the bulleted detail at the top 5 but keeps all issues in evidence", async () => {
  const issues = [
    "issue one",
    "issue two",
    "issue three",
    "issue four",
    "issue five",
    "issue six",
    "issue seven",
  ];
  const llm = judgeStub({
    goalMet: true,
    severity: "low",
    issues,
    rationale: "rough",
  });
  const findings = await judgeMission(llm, mission, obs("done"), [], base);
  const ux = findings.filter((f) => f.kind === "ux_issue");
  assert.equal(ux.length, 1);
  assert.match(ux[0]!.title, /7 UX\/quality issues/);
  assert.match(ux[0]!.detail, /and 2 more/);
  assert.match(ux[0]!.detail, /issue five/);
  assert.ok(
    !/issue seven/.test(ux[0]!.detail),
    "detail truncates past the top 5",
  );
  // run.json fidelity: every issue survives in evidence.
  assert.match(ux[0]!.evidence ?? "", /issue seven/);
});

test("issue filtering only runs on failure (goalMet keeps would-be restatements)", async () => {
  const llm = judgeStub({
    goalMet: true,
    severity: "low",
    issues: ["upload document never processed correctly here"],
    rationale: "upload document never processed",
  });
  const findings = await judgeMission(llm, mission, obs("done"), [], base);
  const ux = findings.filter((f) => f.kind === "ux_issue");
  assert.equal(
    ux.length,
    1,
    "goalMet path must not run the restatement filter",
  );
});

/** A judge stub that captures the prompt it was handed, for prompt-shape asserts. */
const capturingJudge = (): { llm: LLMClient; prompt: () => string } => {
  let captured = "";
  const llm: LLMClient = {
    decide: async () => {
      throw new Error("decide not used by judgeMission");
    },
    judge: async (p: string) => {
      captured = p;
      return JSON.stringify({ goalMet: true, severity: "low", issues: [] });
    },
  };
  return { llm, prompt: () => captured };
};

test("judgeMission injects muted exclusions into the prompt (the mute→judge bridge)", async () => {
  const { llm, prompt } = capturingJudge();
  await judgeMission(llm, mission, obs("done"), [], base, undefined, [
    "the N-Issues badge is the dev toolbar, not a product bug",
  ]);
  assert.match(prompt(), /do NOT flag these/);
  assert.match(prompt(), /N-Issues badge/);
});

test("judgeMission without exclusions omits the exclusion block (byte-compatible)", async () => {
  const { llm, prompt } = capturingJudge();
  await judgeMission(llm, mission, obs("done"), [], base);
  assert.doesNotMatch(prompt(), /triaged as known non-bugs/);
});

test("an empty exclusions array adds nothing to the prompt", async () => {
  const { llm, prompt } = capturingJudge();
  await judgeMission(llm, mission, obs("done"), [], base, undefined, []);
  assert.doesNotMatch(prompt(), /triaged as known non-bugs/);
});

test("a short distinct issue is not suppressed as a restatement", async () => {
  const llm = judgeStub({
    goalMet: false,
    severity: "high",
    issues: ["document upload"], // 2 significant words — too short to judge overlap
    rationale: "the upload of the document never completed",
  });
  const findings = await judgeMission(llm, mission, obs("error"), [], base);
  const ux = findings.filter((f) => f.kind === "ux_issue");
  assert.equal(
    ux.length,
    1,
    "short issues should not be dropped by the heuristic",
  );
});
