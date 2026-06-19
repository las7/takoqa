/**
 * Unit tests for the exploration planner — pure prompt-building + parsing.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ALL_LEVERS,
  actionFrontier,
  buildProposePrompt,
  parseProposedMissions,
  type ProposeContext,
} from "../src/planner.js";

function ctx(over: Partial<ProposeContext> = {}): ProposeContext {
  return {
    appName: "fixture",
    appMap: [
      { path: "/", description: "home" },
      { path: "/agent", affordances: ["Send message", "New chat"] },
    ],
    visited: ["/"],
    unvisited: ["/agent"],
    attempted: ["open the chat"],
    findings: [
      { title: "save gives no feedback", kind: "ux_issue", severity: "low" },
    ],
    actionsMissing: ["upload", "drag"],
    personas: [
      { name: "power-user", description: "d", traits: [] },
      { name: "chaos", description: "d", traits: [] },
    ],
    levers: ALL_LEVERS,
    denylist: ["delete the org"],
    count: 3,
    ...over,
  };
}

test("the proposer prompt encodes every lever + novelty + guardrail", () => {
  const p = buildProposePrompt(ctx());
  assert.match(p, /ALREADY ATTEMPTED/);
  assert.match(p, /open the chat/, "novelty: prior goal listed");
  assert.match(
    p,
    /Routes not yet visited: \/agent/,
    "coverage gap: unvisited route",
  );
  assert.match(p, /not yet exercised: upload, drag/, "action-space frontier");
  assert.match(p, /DIGS DEEPER/, "deepen-on-findings");
  assert.match(p, /save gives no feedback/, "finding surfaced for deepening");
  assert.match(p, /ADVERSARIAL/, "adversarial lever");
  assert.match(p, /power-user, chaos/, "persona diversity");
  assert.match(p, /Never do: delete the org/, "denylist guardrail");
  assert.match(
    p,
    /JSON array of 3 mission objects/,
    "asks for the right count",
  );
  assert.match(
    p,
    /offers: Send message, New chat/,
    "grounds in real affordances",
  );
  assert.match(
    p,
    /GROUND every goal/,
    "tells the proposer not to invent features",
  );
});

test("disabled levers drop their sections", () => {
  const p = buildProposePrompt(
    ctx({
      levers: {
        coverageGaps: false,
        adversarial: false,
        deepenOnFindings: false,
        personaDiversity: false,
        attacker: false,
      },
    }),
  );
  assert.doesNotMatch(p, /ADVERSARIAL/);
  assert.doesNotMatch(p, /COVERAGE GAPS/);
  assert.doesNotMatch(p, /DIGS DEEPER/);
});

test("the attacker lever is OFF by default — no probe/guardrail block", () => {
  const p = buildProposePrompt(ctx()); // ALL_LEVERS has attacker:false
  assert.doesNotMatch(p, /SECURITY PROBES/);
  assert.doesNotMatch(p, /GUARDRAILS \(mandatory\)/);
});

test("the attacker lever adds the bounded-probe + guardrail block, attributing to attacker personas", () => {
  const p = buildProposePrompt(
    ctx({
      levers: { ...ALL_LEVERS, attacker: true },
      attackerPersonas: [
        { name: "prober", description: "d", traits: [], attacker: true },
      ],
    }),
  );
  assert.match(p, /SECURITY PROBES/, "probe section present");
  assert.match(p, /reflected back UN-ESCAPED/i, "reflection probe described");
  assert.match(p, /IDOR|access control/i, "id-tampering probe described");
  assert.match(p, /GUARDRAILS \(mandatory\)/, "guardrails restated");
  assert.match(p, /REFLECTION\/OBSERVATION ONLY/i, "observation-only restated");
  assert.match(p, /never destructive/i, "non-destructive restated");
  assert.match(p, /prober/, "probes attributed to the attacker persona");
});

test("actionFrontier reports exercised vs missing interaction primitives", () => {
  const f = actionFrontier([
    "Clicked [1] Save",
    'Typed "x" into [2]',
    "Visited /agent",
  ]);
  assert.ok(
    f.seen.includes("click") &&
      f.seen.includes("type") &&
      f.seen.includes("navigate"),
  );
  assert.ok(f.missing.includes("upload") && f.missing.includes("drag"));
});

test("parseProposedMissions validates, clamps unknown personas, and caps count", () => {
  const raw = `Sure! Here you go:
  [
    {"goal": "good one", "startPath": "/agent", "persona": "chaos"},
    {"goal": "bad persona", "persona": "nobody"},
    {"nope": "missing goal"},
    {"goal": "third"},
    {"goal": "fourth — over cap"}
  ]`;
  const out = parseProposedMissions(raw, {
    personas: ["power-user", "chaos"],
    max: 3,
  });
  assert.equal(out.length, 3, "capped to max, malformed entry skipped");
  assert.equal(out[0]!.persona, "chaos", "valid persona kept");
  assert.equal(
    out[1]!.persona,
    undefined,
    "unknown persona cleared (engine falls back)",
  );
  assert.equal(out[2]!.startPath, "/", "startPath defaults");
});

test("parseProposedMissions returns [] on junk, not a throw", () => {
  assert.deepEqual(
    parseProposedMissions("the model refused", { personas: [], max: 3 }),
    [],
  );
  assert.deepEqual(
    parseProposedMissions("{not an array}", { personas: [], max: 3 }),
    [],
  );
});
