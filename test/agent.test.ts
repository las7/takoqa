/**
 * Unit tests for the agent system prompt — pure, no browser/LLM. Verifies the
 * optional mission hints (playbook) and the knowledge block reach the prompt,
 * and that they vanish cleanly when unset.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { systemPrompt } from "../src/agent.js";
import { KnowledgeSchema, MissionSchema, PersonaSchema } from "../src/types.js";

const persona = PersonaSchema.parse({
  name: "tester",
  description: "a tester",
});

test("injects mission hints as a SUGGESTED STEPS playbook", () => {
  const mission = MissionSchema.parse({
    id: "m",
    goal: "label a symbol",
    hints: [
      "select the bounding-box tool",
      "drag a box around a symbol",
      "pick a class",
    ],
  });
  const p = systemPrompt({ persona, mission, history: [] });
  assert.match(p, /SUGGESTED STEPS/);
  assert.match(p, /drag a box around a symbol/);
});

test("omits the playbook when a mission has no hints", () => {
  const mission = MissionSchema.parse({ id: "m", goal: "do a thing" });
  const p = systemPrompt({ persona, mission, history: [] });
  assert.ok(
    !/SUGGESTED STEPS/.test(p),
    "no hints should mean no playbook block",
  );
});

test("injects the frontier (unvisited routes) as an exploration nudge", () => {
  const mission = MissionSchema.parse({ id: "m", goal: "explore" });
  const p = systemPrompt({
    persona,
    mission,
    history: [],
    frontier: ["/settings", "/playground/schematic"],
  });
  assert.match(p, /NOT YET VISITED/);
  assert.match(p, /\/playground\/schematic/);
});

test("omits the frontier nudge when there are no unvisited routes", () => {
  const mission = MissionSchema.parse({ id: "m", goal: "x" });
  const p = systemPrompt({ persona, mission, history: [], frontier: [] });
  assert.ok(!/NOT YET VISITED/.test(p));
});

test("injects the knowledge block into the agent prompt when present", () => {
  const mission = MissionSchema.parse({ id: "m", goal: "g" });
  const knowledge = KnowledgeSchema.parse({
    overview: "an app",
    gotchas: ["the spinner is cosmetic"],
  });
  const p = systemPrompt({ persona, mission, history: [], knowledge });
  assert.match(p, /ABOUT THIS APP/);
  assert.match(p, /spinner is cosmetic/);
});
