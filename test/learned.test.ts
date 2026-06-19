/**
 * Unit tests for the learned-knowledge store (the self-improvement ratchet) —
 * pure, no browser/LLM. Mirrors baseline.test.ts conventions.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  CONFIDENCE_FLOOR,
  distillFromLoop,
  emptyStore,
  loadLearned,
  mergeIntoStore,
  mergeLearned,
  recentAttempted,
  saveLearned,
  type LoopJournal,
} from "../src/learned.js";
import type { Finding, Knowledge } from "../src/types.js";

function fg(kind: Finding["kind"], title: string, url: string): Finding {
  return {
    kind,
    severity: "medium",
    missionId: "m",
    persona: "p",
    title,
    detail: "d",
    repro: [],
    url,
    timestamp: "t",
  };
}

const T1 = "2026-01-01T00:00:00.000Z";
const T2 = "2026-01-02T00:00:00.000Z";

const journal = (over: Partial<LoopJournal> = {}): LoopJournal => ({
  routeOfferings: [["http://h:3000/agent", ["Send", "New chat"]]],
  findings: [
    fg(
      "route_gated",
      "Route gated: /playground/documents → /knowledge",
      "http://h:3000/knowledge",
    ),
    fg(
      "no_progress",
      'No progress: "click" repeated from the same state (×3)',
      "http://h:3000/agent",
    ),
  ],
  attempted: ["explore the agent", "   "],
  ...over,
});

function tmp(): string {
  return join(
    tmpdir(),
    "takoqa-learned-" + Math.random().toString(36).slice(2),
  );
}

test("distillFromLoop maps each loop signal to the right learning, deterministically", () => {
  const s = distillFromLoop(journal(), T1);
  assert.equal(
    s.routeGates["/playground/documents"]?.gate,
    "redirects to /knowledge",
    "route_gated → routeGates with the OBSERVED redirect target",
  );
  assert.ok(
    s.deadControls["/agent|click"],
    "no_progress → deadControls keyed by route|label",
  );
  assert.deepEqual(s.routeOfferings["/agent"]?.affordances, [
    "Send",
    "New chat",
  ]);
  assert.deepEqual(
    Object.keys(s.attempted),
    ["explore the agent"],
    "blank goals are dropped; real goals kept",
  );
  // Pure: same journal + same `now` ⇒ identical output.
  assert.deepEqual(distillFromLoop(journal(), T1), s);
});

test("distillFromLoop handles no_progress labels with colons/spaces/quotes (type:/upload:)", () => {
  const s = distillFromLoop(
    {
      routeOfferings: [],
      attempted: [],
      findings: [
        fg(
          "no_progress",
          'No progress: "type: hello world" repeated from the same state (×3)',
          "http://h:3000/agent",
        ),
        fg(
          "no_progress",
          'No progress: "upload: file.pdf" repeated from the same state (×2)',
          "http://h:3000/docs",
        ),
      ],
    },
    T1,
  );
  assert.ok(
    s.deadControls["/agent|type: hello world"],
    "a type: label (colon + spaces) survives the regex and the route|label key",
  );
  assert.ok(s.deadControls["/docs|upload: file.pdf"]);
});

test("mergeLearned decays stale facts when given `now` (the no-ossification EXIT side)", () => {
  const k: Knowledge = { overview: "", routes: [], glossary: [], gotchas: [] };
  const gateOnly: LoopJournal = {
    routeOfferings: [],
    attempted: [],
    findings: [fg("route_gated", "Route gated: /a → /b", "http://h/b")],
  };
  // Two runs at the same old timestamp → runCount 2 (confident), lastSeen old.
  let store = mergeIntoStore(emptyStore(), distillFromLoop(gateOnly, T1));
  store = mergeIntoStore(store, distillFromLoop(gateOnly, T1));

  assert.equal(
    mergeLearned(k, store, "2026-03-01T00:00:00.000Z"),
    k,
    "a confident fact not re-seen within STALE_AFTER_MS decays out (returns input unchanged)",
  );
  assert.notEqual(
    mergeLearned(k, store, "2026-01-01T06:00:00.000Z"),
    k,
    "the same fact is still merged when recently seen",
  );
  assert.notEqual(
    mergeLearned(k, store),
    k,
    "without `now` there is no decay — pure/back-compat",
  );
});

test("mergeIntoStore bumps runCount + lastSeen on a recurring fact, carrying firstSeen", () => {
  const m1 = mergeIntoStore(emptyStore(), distillFromLoop(journal(), T1));
  assert.equal(m1.routeGates["/playground/documents"]?.runCount, 1);
  const m2 = mergeIntoStore(m1, distillFromLoop(journal(), T2));
  const gate = m2.routeGates["/playground/documents"]!;
  assert.equal(gate.runCount, 2);
  assert.equal(gate.firstSeen, T1, "firstSeen is preserved");
  assert.equal(gate.lastSeen, T2, "lastSeen advances");
  assert.equal(m2.deadControls["/agent|click"]?.runCount, 2);
});

test("mergeIntoStore does not mutate the previous store", () => {
  const prev = mergeIntoStore(emptyStore(), distillFromLoop(journal(), T1));
  const snapshot = JSON.stringify(prev);
  mergeIntoStore(prev, distillFromLoop(journal(), T2));
  assert.equal(JSON.stringify(prev), snapshot, "prev is untouched");
});

test("mergeLearned with an empty store returns the input Knowledge unchanged (back-compat)", () => {
  const k: Knowledge = {
    overview: "o",
    routes: [{ path: "/x", description: "d" }],
    glossary: [],
    gotchas: [],
  };
  assert.equal(
    mergeLearned(k, emptyStore()),
    k,
    "same reference back when nothing to merge",
  );
  assert.equal(mergeLearned(undefined, emptyStore()), undefined);
});

test("mergeLearned honors the confidence floor for gates (runCount must reach CONFIDENCE_FLOOR)", () => {
  const k: Knowledge = { overview: "", routes: [], glossary: [], gotchas: [] };
  const gateOnly = journal({
    routeOfferings: [],
    attempted: [],
    findings: [fg("route_gated", "Route gated: /a → /b", "http://h/b")],
  });

  let store = emptyStore();
  for (let i = 1; i < CONFIDENCE_FLOOR; i++) {
    store = mergeIntoStore(store, distillFromLoop(gateOnly, T1));
  }
  assert.equal(
    mergeLearned(k, store),
    k,
    "below the floor the gate is NOT merged — a one-off flake is not durable knowledge",
  );

  store = mergeIntoStore(store, distillFromLoop(gateOnly, T2)); // now at the floor
  const merged = mergeLearned(k, store)!;
  assert.notEqual(merged, k);
  const route = merged.routes.find((r) => r.path === "/a");
  assert.ok(
    route,
    "a confident learned gate adds the route to the agent's app map",
  );
  assert.match(route!.requires ?? "", /redirects to \/b/);
  assert.match(route!.requires ?? "", /learned/);
});

test("mergeLearned attaches dead-control + offering notes to the route description (agent-only)", () => {
  const k: Knowledge = {
    overview: "",
    routes: [{ path: "/agent", description: "chat" }],
    glossary: [],
    gotchas: [],
  };
  // Two runs so dead controls clear the confidence floor.
  const store = mergeIntoStore(
    mergeIntoStore(emptyStore(), distillFromLoop(journal(), T1)),
    distillFromLoop(journal(), T2),
  );
  const merged = mergeLearned(k, store)!;
  const agentRoute = merged.routes.find((r) => r.path === "/agent")!;
  assert.match(
    agentRoute.description ?? "",
    /dead end/,
    "dead control surfaced in description",
  );
  assert.match(
    agentRoute.description ?? "",
    /offers:/,
    "offerings surfaced in description",
  );
  // The judge must NOT learn these — they live under routes (omitted from the
  // judge variant of renderKnowledge), never under gotchas.
  assert.deepEqual(
    merged.gotchas,
    [],
    "learned facts never become judge exclusions",
  );
});

test("mergeLearned synthesizes Knowledge when none was authored", () => {
  const store = mergeIntoStore(
    mergeIntoStore(emptyStore(), distillFromLoop(journal(), T1)),
    distillFromLoop(journal(), T2),
  );
  const merged = mergeLearned(undefined, store)!;
  assert.ok(merged.routes.some((r) => r.path === "/playground/documents"));
});

test("recentAttempted returns the newest goals first, bounded", () => {
  const store = emptyStore();
  store.attempted = {
    old: { lastSeen: "2026-01-01T00:00:00.000Z" },
    mid: { lastSeen: "2026-01-02T00:00:00.000Z" },
    newest: { lastSeen: "2026-01-03T00:00:00.000Z" },
  };
  assert.deepEqual(recentAttempted(store, 2), ["newest", "mid"]);
});

test("loadLearned returns an empty store for missing / corrupt / non-object files", () => {
  const dir = tmp();
  assert.deepEqual(loadLearned(dir, "fx"), emptyStore(), "missing → empty");

  mkdirSync(dir, { recursive: true });
  // Corrupt (non-JSON) → empty, never throws.
  writeFileSync(join(dir, slugFor("garbage")), "{not json");
  assert.deepEqual(
    loadLearned(dir, "garbage"),
    emptyStore(),
    "corrupt → empty",
  );

  // Non-object JSON (array) → empty.
  writeFileSync(join(dir, slugFor("arr")), "[1,2,3]");
  assert.deepEqual(loadLearned(dir, "arr"), emptyStore(), "array → empty");
});

test("learned store round-trips through save/load and prunes to the entry cap", () => {
  const dir = tmp();
  const store = emptyStore();
  // Exceed the per-map cap so prune kicks in on save.
  for (let i = 0; i < 600; i++) {
    store.attempted[`goal-${i}`] = {
      lastSeen: `2026-01-01T00:00:${String(i % 60).padStart(2, "0")}.${String(i).padStart(3, "0")}Z`,
    };
  }
  saveLearned(dir, "fx", store);
  const back = loadLearned(dir, "fx");
  assert.ok(
    Object.keys(back.attempted).length <= 500,
    "attempted map pruned to the entry cap on save",
  );
});

// Recreate the module's private slug() so a test can write to the exact path
// loadLearned will read (keeps the corruption tests honest without exporting an
// internal). Must stay in sync with learned.ts slug().
function slugFor(profile: string): string {
  const base =
    profile.replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "") || "x";
  return `${base}-${createHash("sha1").update(profile).digest("hex").slice(0, 8)}.json`;
}
