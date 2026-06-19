/**
 * Unit tests for renderKnowledge — pure, no browser/LLM. Verifies the agent and
 * judge variants, and that empty knowledge renders to "" (so prompts stay
 * byte-identical for knowledge-less profiles).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { renderKnowledge } from "../src/knowledge.js";
import { KnowledgeSchema } from "../src/types.js";

const knowledge = KnowledgeSchema.parse({
  overview: "A document-intelligence app.",
  routes: [
    {
      path: "/playground/schematic",
      description: "label P&IDs",
      requires: "OP tier",
    },
  ],
  glossary: [{ term: "VC", meaning: "a schematic drawing page" }],
  gotchas: ["The N-Issues dev badge is not a bug."],
});

test("agent variant renders ABOUT THIS APP with routes, glossary, gotchas", () => {
  const out = renderKnowledge(knowledge, { forJudge: false });
  assert.match(out, /ABOUT THIS APP/);
  assert.match(out, /\/playground\/schematic/);
  assert.match(out, /requires: OP tier/);
  assert.match(out, /GLOSSARY:/);
  assert.match(out, /VC: a schematic drawing page/);
  assert.match(out, /dev badge is not a bug/);
});

test("judge variant reframes gotchas as exclusions and omits the route table", () => {
  const out = renderKnowledge(knowledge, { forJudge: true });
  assert.match(out, /do NOT flag the following/i);
  assert.match(out, /dev badge is not a bug/);
  assert.ok(!/ROUTES:/.test(out), "judge variant should not list ROUTES");
});

test("empty knowledge renders to an empty string for both variants", () => {
  const empty = KnowledgeSchema.parse({});
  assert.equal(renderKnowledge(empty, { forJudge: false }), "");
  assert.equal(renderKnowledge(empty, { forJudge: true }), "");
});
