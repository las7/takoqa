/**
 * Unit tests for the exploration loop control flow — injected proposer + round
 * runner, so termination logic is tested without a browser or LLM.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { ProfileSchema } from "../src/types.js";
import type { Finding, RunReport } from "../src/types.js";
import type { LoadedProfile } from "../src/profile.js";
import type { LLMClient } from "../src/agent.js";
import { runExploreLoop } from "../src/exploreLoop.js";
import { ALL_LEVERS } from "../src/planner.js";
import { join } from "node:path";
import {
  distillFromLoop,
  emptyStore,
  mergeIntoStore,
  saveLearned,
} from "../src/learned.js";

function loaded(): LoadedProfile {
  const profile = ProfileSchema.parse({
    name: "fx",
    baseUrl: "http://localhost:3000",
    personas: [{ name: "tester", description: "d" }],
    missions: [
      { id: "explore-crawl", goal: "crawl", mode: "crawl", routes: ["/"] },
    ],
    knowledge: { routes: [{ path: "/" }, { path: "/agent" }] },
  });
  return { profile, baseDir: tmpdir() };
}

function finding(
  status: Finding["status"],
  severity: Finding["severity"] = "high",
  kind: Finding["kind"] = "http_error",
): Finding {
  return {
    kind,
    severity,
    missionId: "m",
    persona: "p",
    title: "t",
    detail: "d",
    repro: [],
    url: "http://x/agent",
    timestamp: "t",
    status,
  };
}

function report(findings: Finding[] = []): RunReport {
  return {
    profile: "fx",
    baseUrl: "x",
    startedAt: "t",
    finishedAt: "t",
    results: [
      {
        missionId: "m",
        persona: "p",
        goal: "g",
        outcome: "passed",
        steps: [
          {
            index: 0,
            url: "http://x/agent",
            actionSummary: "Clicked [1]",
            rationale: "",
          },
        ],
        findings,
        startedAt: "t",
        finishedAt: "t",
      },
    ],
    coverage: { routesVisited: ["/agent"], unvisitedKnownRoutes: [] },
  };
}

const llm = {
  decide: async () => ({
    action: { type: "finish", success: true, summary: "" },
    rationale: "",
  }),
  judge: async () => "{}",
  propose: async () => "[]",
} as unknown as LLMClient;

const opts = {
  llm,
  runDir: tmpdir(),
  headless: true,
  record: false,
} as Parameters<typeof runExploreLoop>[1];

const oneMission = async () =>
  JSON.stringify([
    { goal: "do a thing", startPath: "/agent", persona: "tester" },
  ]);

test("stops after K consecutive dry rounds (no new findings)", async () => {
  let calls = 0;
  const res = await runExploreLoop(
    loaded(),
    opts,
    llm,
    { maxRounds: 10, dryRounds: 2, missionsPerRound: 1, levers: ALL_LEVERS },
    {
      propose: oneMission,
      runRound: async () => {
        calls++;
        return report([finding("known")]); // 0 new every round
      },
    },
  );
  assert.equal(res.stopped, "dry");
  assert.equal(calls, 3, "crawl (round 0) + 2 dry rounds");
});

test("a new finding resets the dry streak; maxRounds caps an always-productive loop", async () => {
  let calls = 0;
  const res = await runExploreLoop(
    loaded(),
    opts,
    llm,
    { maxRounds: 3, dryRounds: 2, missionsPerRound: 1, levers: ALL_LEVERS },
    {
      propose: oneMission,
      runRound: async () => {
        calls++;
        return report([finding("new")]); // always productive → never goes dry
      },
    },
  );
  assert.equal(res.stopped, "max-rounds");
  assert.equal(calls, 4, "crawl + 3 productive rounds");
  assert.equal(res.rounds.filter((r) => r.round > 0).length, 3);
});

test("a stream of only soft (low, non-hard) new findings converges to dry", async () => {
  let calls = 0;
  const res = await runExploreLoop(
    loaded(),
    opts,
    llm,
    { maxRounds: 10, dryRounds: 2, missionsPerRound: 1, levers: ALL_LEVERS },
    {
      propose: oneMission,
      runRound: async () => {
        calls++;
        // a downgraded agent-limited goal_failed: new, but low + non-hard kind
        return report([finding("new", "low", "goal_failed")]);
      },
    },
  );
  assert.equal(res.stopped, "dry", "soft findings are not significant signal");
  assert.equal(calls, 3, "crawl + 2 insignificant rounds → dry");
});

test("an empty proposal counts as a dry round and never calls the runner", async () => {
  let calls = 0;
  const res = await runExploreLoop(
    loaded(),
    opts,
    llm,
    { maxRounds: 10, dryRounds: 2, missionsPerRound: 2, levers: ALL_LEVERS },
    {
      propose: async () => "the model declined", // parses to []
      runRound: async () => {
        calls++;
        return report([]);
      },
    },
  );
  assert.equal(res.stopped, "dry");
  assert.equal(calls, 1, "only the crawl ran; empty proposals skip the runner");
});

test("distills route gates + dead controls from the loop journal (memory survives the loop)", async () => {
  const gated: Finding = {
    kind: "route_gated",
    severity: "medium",
    missionId: "m",
    persona: "p",
    title: "Route gated: /playground/documents → /knowledge",
    detail: "d",
    repro: [],
    url: "http://x/knowledge",
    timestamp: "t",
    status: "new",
  };
  const dead: Finding = {
    kind: "no_progress",
    severity: "medium",
    missionId: "m",
    persona: "p",
    title: 'No progress: "click" repeated from the same state (×3)',
    detail: "d",
    repro: [],
    url: "http://x/agent",
    timestamp: "t",
    status: "new",
  };
  const res = await runExploreLoop(
    loaded(),
    opts,
    llm,
    { maxRounds: 1, dryRounds: 5, missionsPerRound: 1, levers: ALL_LEVERS },
    {
      propose: oneMission,
      runRound: async () => report([gated, dead]),
    },
  );
  assert.equal(
    res.learnings.routeGates["/playground/documents"]?.gate,
    "redirects to /knowledge",
    "the route gate is distilled into learnings instead of being thrown away",
  );
  assert.ok(
    res.learnings.deadControls["/agent|click"],
    "the dead control is distilled",
  );
  assert.ok(
    res.learnings.attempted["do a thing"],
    "the attempted goal is recorded",
  );
});

test("seeds attempted goals from the persisted store but does not re-distill them (they can age out)", async () => {
  const dir = join(
    tmpdir(),
    "takoqa-loop-learned-" + Math.random().toString(36).slice(2),
  );
  // A prior session left "prior goal" in the store.
  saveLearned(
    dir,
    "fx",
    mergeIntoStore(
      emptyStore(),
      distillFromLoop(
        { routeOfferings: [], findings: [], attempted: ["prior goal"] },
        "2026-01-01T00:00:00.000Z",
      ),
    ),
  );
  const seedingPrompts: string[] = [];
  const res = await runExploreLoop(
    loaded(),
    { ...opts, learnedDir: dir } as Parameters<typeof runExploreLoop>[1],
    llm,
    { maxRounds: 1, dryRounds: 5, missionsPerRound: 1, levers: ALL_LEVERS },
    {
      propose: async (p) => {
        seedingPrompts.push(p);
        return JSON.stringify([
          { goal: "do a thing", startPath: "/agent", persona: "tester" },
        ]);
      },
      runRound: async () => report([]),
    },
  );
  // The prior goal IS used as novelty pressure (seeded into the proposer)...
  assert.match(
    seedingPrompts[0]!,
    /prior goal/,
    "prior goal seeds the proposer's novelty pressure",
  );
  // ...but is NOT re-stamped into this session's learnings (so it can prune out).
  assert.ok(
    !res.learnings.attempted["prior goal"],
    "a re-seeded prior goal is not re-distilled",
  );
  assert.ok(
    res.learnings.attempted["do a thing"],
    "this session's new goal is distilled",
  );
});

test("accumulates attempted goals across rounds (novelty memory grows)", async () => {
  const prompts: string[] = [];
  await runExploreLoop(
    loaded(),
    opts,
    llm,
    { maxRounds: 2, dryRounds: 5, missionsPerRound: 1, levers: ALL_LEVERS },
    {
      propose: async (prompt) => {
        prompts.push(prompt);
        return JSON.stringify([
          {
            goal: `goal-${prompts.length}`,
            startPath: "/agent",
            persona: "tester",
          },
        ]);
      },
      runRound: async () => report([finding("new")]),
    },
  );
  assert.equal(prompts.length, 2, "proposer called once per round");
  assert.doesNotMatch(
    prompts[0]!,
    /ALREADY ATTEMPTED/,
    "round 1: nothing attempted yet",
  );
  assert.match(prompts[1]!, /ALREADY ATTEMPTED/, "round 2 lists prior goals");
  assert.match(
    prompts[1]!,
    /goal-1/,
    "round 1's goal is remembered in round 2",
  );
});
