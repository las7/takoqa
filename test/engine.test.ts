/**
 * Layer 2: integration test. Drives the real engine + real Chromium against the
 * planted-bug fixture app, using the MockClient so it's deterministic and needs
 * no API key. Proves the observe -> act -> oracle wiring actually catches a
 * known bug, and does NOT cry wolf on a clean page.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { executeAction, type Action } from "../src/act.js";
import { MockClient } from "../src/agent.js";
import type { AgentContext, Decision, LLMClient } from "../src/agent.js";
import type { Observation } from "../src/observe.js";
import type { Page } from "playwright";
import { runProfile } from "../src/engine.js";
import { observe } from "../src/observe.js";
import { settle } from "../src/settle.js";
import { createRunDir } from "../src/report.js";
import { loadRecipe } from "../src/recipe.js";
import { ProfileSchema } from "../src/types.js";
import type { LoadedProfile } from "../src/profile.js";
import { startFixtureServer, type FixtureServer } from "./fixture-server.js";

function profileFor(
  baseUrl: string,
  startPath: string,
  missionId: string,
  maxSteps = 3,
): LoadedProfile {
  const profile = ProfileSchema.parse({
    name: "fixture",
    baseUrl,
    personas: [{ name: "tester", description: "a test persona" }],
    missions: [
      {
        id: missionId,
        goal: "click the primary button",
        startPath,
        maxSteps,
      },
    ],
  });
  return { profile, baseDir: tmpdir() };
}

async function run(
  server: FixtureServer,
  startPath: string,
  missionId: string,
  script: Action[],
  maxSteps = 3,
) {
  const runDir = createRunDir(tmpdir(), "fixture-test");
  const report = await runProfile(
    profileFor(server.url, startPath, missionId, maxSteps),
    {
      llm: new MockClient(script),
      runDir,
      headless: true,
      record: false,
    },
  );
  return report.results[0]!;
}

/** Drives a single real Chromium page against the fixture server. */
async function withPage<T>(
  fn: (page: Page, baseUrl: string) => Promise<T>,
): Promise<T> {
  const server = await startFixtureServer();
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  try {
    const page = await browser.newPage();
    await page.setViewportSize({ width: 1280, height: 900 });
    return await fn(page, server.url);
  } finally {
    await browser.close();
    await server.close();
  }
}

const ident = (n: string) => n;

/** LLMClient that records what it was handed, then finishes immediately. */
class CapturingClient implements LLMClient {
  lastCtx?: AgentContext;
  lastJudgePrompt?: string;
  async decide(_obs: Observation, ctx: AgentContext): Promise<Decision> {
    this.lastCtx = ctx;
    return {
      action: { type: "finish", success: true, summary: "done" },
      rationale: "capture",
    };
  }
  async judge(prompt: string): Promise<string> {
    this.lastJudgePrompt = prompt;
    return JSON.stringify({ goalMet: true, severity: "low", issues: [] });
  }
}

test("catches a planted page error + console error on the buggy page", async () => {
  const server = await startFixtureServer();
  try {
    // Script: click the Save button (ref 0), which throws + logs an error.
    const result = await run(server, "/settings", "settings-bug", [
      { type: "click", ref: 0 },
    ]);
    const kinds = result.findings.map((f) => f.kind);
    assert.ok(
      kinds.includes("page_error"),
      `expected page_error, got: ${kinds.join(", ")}`,
    );
    assert.ok(
      kinds.includes("console_error"),
      `expected console_error, got: ${kinds.join(", ")}`,
    );
  } finally {
    await server.close();
  }
});

test("catches a planted 5xx triggered by a user action", async () => {
  const server = await startFixtureServer();
  try {
    // Click "Load data" (ref 0), which fetches an endpoint returning HTTP 500.
    const result = await run(server, "/api-fail", "api-bug", [
      { type: "click", ref: 0 },
    ]);
    const http = result.findings.find((f) => f.kind === "http_error");
    assert.ok(http, "expected an http_error finding from the failed fetch");
  } finally {
    await server.close();
  }
});

test("does not raise functional findings on a clean page", async () => {
  const server = await startFixtureServer();
  try {
    const result = await run(server, "/clean", "clean", [
      { type: "click", ref: 0 },
    ]);
    const functional = result.findings.filter((f) =>
      [
        "page_error",
        "console_error",
        "http_error",
        "body_error_signature",
      ].includes(f.kind),
    );
    assert.equal(
      functional.length,
      0,
      `clean page should be quiet, got: ${functional.map((f) => f.kind).join(", ")}`,
    );
  } finally {
    await server.close();
  }
});

test("breaks out of a no-op action loop instead of burning the step budget", async () => {
  const server = await startFixtureServer();
  try {
    // /noop's button (ref 0) is inert: every click changes nothing. With a
    // generous step budget, the loop guard must stop well before maxSteps.
    const script: Action[] = Array.from({ length: 10 }, () => ({
      type: "click",
      ref: 0,
    }));
    const result = await run(server, "/noop", "noop-loop", script, 10);

    assert.equal(
      result.outcome,
      "stuck",
      "a dead-control loop should end stuck",
    );
    assert.ok(
      result.findings.some((f) => f.kind === "no_progress"),
      `expected a no_progress finding, got: ${result.findings.map((f) => f.kind).join(", ")}`,
    );
    assert.ok(
      !result.findings.some((f) => f.kind === "agent_stuck"),
      "no_progress should replace the generic agent_stuck finding, not duplicate it",
    );
    assert.ok(
      result.steps.length < 10,
      `loop guard should stop early, but ran ${result.steps.length}/10 steps`,
    );
  } finally {
    await server.close();
  }
});

test("skips a gated mission whose start path redirects away", async () => {
  const server = await startFixtureServer();
  try {
    // /gated 302-redirects to /landing before the page ever loads.
    const result = await run(server, "/gated", "gated", [
      { type: "click", ref: 0 },
    ]);

    assert.equal(
      result.outcome,
      "skipped",
      "a gated start path should skip the mission",
    );
    assert.ok(
      result.findings.some((f) => f.kind === "route_gated"),
      `expected a route_gated finding, got: ${result.findings.map((f) => f.kind).join(", ")}`,
    );
    assert.equal(
      result.steps.length,
      0,
      "a skipped mission should take no agent steps",
    );
  } finally {
    await server.close();
  }
});

test("recovers from a stale/missing element ref instead of hanging or crashing", async () => {
  const server = await startFixtureServer();
  try {
    // Acting on a ref that doesn't resolve (here, a ref that was never stamped)
    // must be detected fast as stale, not time out for seconds and abort.
    const result = await run(server, "/clean", "stale", [
      { type: "click", ref: 99 },
    ]);

    assert.notEqual(
      result.outcome,
      "error",
      "a stale ref must not crash the mission",
    );
    assert.ok(
      result.steps.some((s) => /no longer on the page/i.test(s.actionSummary)),
      `expected a stale-target step, got: ${result.steps.map((s) => s.actionSummary).join(" | ")}`,
    );
  } finally {
    await server.close();
  }
});

test("collapses a console error that recurs every step into one finding", async () => {
  const server = await startFixtureServer();
  try {
    // /relog logs the SAME console.error each click but bumps the title so the
    // loop guard never fires — every step re-fires it. Within-run dedupe must
    // collapse the N copies into ONE finding with occurrences > 1.
    const script: Action[] = Array.from({ length: 4 }, () => ({
      type: "click",
      ref: 0,
    }));
    const result = await run(server, "/relog", "relog", script, 4);

    const consoleErrors = result.findings.filter(
      (f) => f.kind === "console_error",
    );
    assert.equal(
      consoleErrors.length,
      1,
      `expected ONE collapsed console_error, got ${consoleErrors.length}`,
    );
    assert.ok(
      !result.findings.some((f) => f.kind === "no_progress"),
      "title bumps should keep the loop guard from firing",
    );
    assert.equal(
      result.steps.length,
      4,
      "all four click steps should have run",
    );
    assert.equal(
      consoleErrors[0]!.occurrences,
      4,
      "the collapsed finding should count exactly one occurrence per step",
    );
  } finally {
    await server.close();
  }
});

test("breaks an alternating A<->B no-progress cycle, not just identical repeats", async () => {
  const server = await startFixtureServer();
  try {
    // /toggle has two inert buttons (refs 0,1). Alternating clicks never make
    // progress; the guard must catch the cycle (a consecutive-repeat counter
    // would not, since no signature repeats back-to-back).
    const script: Action[] = Array.from({ length: 12 }, (_, i) => ({
      type: "click",
      ref: i % 2,
    }));
    const result = await run(server, "/toggle", "toggle-loop", script, 12);

    assert.equal(result.outcome, "stuck", "an A<->B cycle should end stuck");
    assert.ok(
      result.findings.some((f) => f.kind === "no_progress"),
      `expected a no_progress finding, got: ${result.findings.map((f) => f.kind).join(", ")}`,
    );
    assert.ok(
      result.steps.length < 12,
      `loop guard should stop the cycle early, but ran ${result.steps.length}/12 steps`,
    );
  } finally {
    await server.close();
  }
});

test("skips a mission whose start path redirects away a beat after load (delayed gate)", async () => {
  const server = await startFixtureServer();
  try {
    // /slowgate loads OK then client-redirects to /landing ~800ms later — the
    // post-goto check can miss it, so the in-loop grace check must catch it.
    const script: Action[] = Array.from({ length: 5 }, () => ({
      type: "click",
      ref: 0,
    }));
    const result = await run(server, "/slowgate", "slow-gate", script, 5);

    assert.equal(
      result.outcome,
      "skipped",
      "a delayed gate should skip the mission",
    );
    assert.ok(
      result.findings.some((f) => f.kind === "route_gated"),
      `expected a route_gated finding, got: ${result.findings.map((f) => f.kind).join(", ")}`,
    );
  } finally {
    await server.close();
  }
});

test("settle waits for content rendered shortly after load", async () => {
  const server = await startFixtureServer();
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  try {
    const page = await browser.newPage();
    // /late appends its button ~300ms after load; observing immediately misses
    // it, observing after settle() must see it.
    await page.goto(`${server.url}/late`, { waitUntil: "domcontentloaded" });
    await settle(page);
    const obs = await observe(page);
    assert.ok(
      obs.elements.some((e) => /late button/i.test(e.label)),
      `settle should let the late-rendered button appear, saw: ${obs.elements
        .map((e) => e.label)
        .join(", ")}`,
    );
  } finally {
    await browser.close();
    await server.close();
  }
});

test("drag sweeps a box on a canvas (drag gesture reaches non-DOM content)", async () => {
  await withPage(async (page, baseUrl) => {
    await page.goto(`${baseUrl}/canvas`, { waitUntil: "domcontentloaded" });
    const box = (await page.locator("#c").boundingBox())!;
    const r = await executeAction(
      page,
      {
        type: "drag",
        x: box.x + 40,
        y: box.y + 40,
        x2: box.x + 220,
        y2: box.y + 180,
      },
      ident,
    );
    assert.ok(r.ok, `drag should succeed: ${r.error ?? ""}`);
    assert.equal(
      (await page.locator("#status").textContent())?.trim(),
      "drew-box",
      "the drag should register mousedown->mouseup on the canvas",
    );
  });
});

test("click_at hits an element that has no DOM ref (coordinate click)", async () => {
  await withPage(async (page, baseUrl) => {
    await page.goto(`${baseUrl}/coord`, { waitUntil: "domcontentloaded" });
    const box = (await page.locator("#t").boundingBox())!;
    await executeAction(
      page,
      { type: "click_at", x: box.x + box.width / 2, y: box.y + box.height / 2 },
      ident,
    );
    assert.equal(
      (await page.locator("#status").textContent())?.trim(),
      "clicked",
      "click_at should land on the untagged div",
    );
  });
});

test("double_click hits an element that has no DOM ref (coordinate double-click)", async () => {
  await withPage(async (page, baseUrl) => {
    await page.goto(`${baseUrl}/coord`, { waitUntil: "domcontentloaded" });
    const box = (await page.locator("#t").boundingBox())!;
    await executeAction(
      page,
      {
        type: "double_click",
        x: box.x + box.width / 2,
        y: box.y + box.height / 2,
      },
      ident,
    );
    assert.equal(
      (await page.locator("#status").textContent())?.trim(),
      "dblclicked",
      "double_click should fire dblclick on the untagged div",
    );
  });
});

test("threads profile.knowledge into the agent ctx and the judge prompt", async () => {
  const server = await startFixtureServer();
  try {
    const client = new CapturingClient();
    const profile = ProfileSchema.parse({
      name: "fixture",
      baseUrl: server.url,
      personas: [{ name: "tester", description: "a test persona" }],
      missions: [{ id: "k", goal: "g", startPath: "/clean", maxSteps: 2 }],
      knowledge: {
        overview: "A test app.",
        routes: [{ path: "/clean", description: "the clean page" }],
        gotchas: ["The widget spinner is cosmetic, not a bug."],
      },
    });
    await runProfile(
      { profile, baseDir: tmpdir() },
      {
        llm: client,
        runDir: createRunDir(tmpdir(), "knowledge-test"),
        headless: true,
        record: false,
      },
    );

    assert.ok(
      client.lastCtx?.knowledge,
      "decide() should receive ctx.knowledge",
    );
    assert.match(
      client.lastJudgePrompt ?? "",
      /do NOT flag the following/i,
      "judge prompt should carry the gotchas-as-exclusions block",
    );
    assert.match(
      client.lastJudgePrompt ?? "",
      /widget spinner is cosmetic/,
      "judge prompt should include the gotcha text",
    );
  } finally {
    await server.close();
  }
});

test("a knowledge-less profile injects no knowledge into ctx or judge", async () => {
  const server = await startFixtureServer();
  try {
    const client = new CapturingClient();
    const profile = ProfileSchema.parse({
      name: "fixture",
      baseUrl: server.url,
      personas: [{ name: "tester", description: "a test persona" }],
      missions: [{ id: "nok", goal: "g", startPath: "/clean", maxSteps: 2 }],
    });
    await runProfile(
      { profile, baseDir: tmpdir() },
      {
        llm: client,
        runDir: createRunDir(tmpdir(), "no-knowledge-test"),
        headless: true,
        record: false,
      },
    );

    assert.equal(client.lastCtx?.knowledge, undefined);
    assert.ok(
      !/do NOT flag the following/i.test(client.lastJudgePrompt ?? ""),
      "judge prompt must not carry an exclusions block when no knowledge is set",
    );
  } finally {
    await server.close();
  }
});

test("feeds the agent a frontier of known routes not yet visited", async () => {
  const server = await startFixtureServer();
  try {
    const client = new CapturingClient();
    const profile = ProfileSchema.parse({
      name: "fixture",
      baseUrl: server.url,
      personas: [{ name: "tester", description: "a test persona" }],
      missions: [{ id: "fr", goal: "g", startPath: "/clean", maxSteps: 2 }],
      knowledge: {
        routes: [
          { path: "/clean" }, // the start page — visited, so NOT in the frontier
          { path: "/noop" }, // unvisited -> in the frontier
          { path: "/settings" }, // unvisited -> in the frontier
          { path: "/thing/[id]" }, // dynamic -> never suggested literally
        ],
      },
    });
    await runProfile(
      { profile, baseDir: tmpdir() },
      {
        llm: client,
        runDir: createRunDir(tmpdir(), "frontier-test"),
        headless: true,
        record: false,
      },
    );

    const frontier = client.lastCtx?.frontier ?? [];
    assert.ok(
      frontier.includes("/noop") && frontier.includes("/settings"),
      `frontier should list unvisited known routes, got: ${frontier.join(", ")}`,
    );
    assert.ok(
      !frontier.includes("/clean"),
      "the already-visited start page must not be in the frontier",
    );
    assert.ok(
      !frontier.some((r) => r.includes("[")),
      "dynamic [id] routes must not be suggested literally",
    );
  } finally {
    await server.close();
  }
});

test("observe surfaces only relevant on-screen elements (filters junk + caps)", async () => {
  await withPage(async (page, baseUrl) => {
    await page.goto(`${baseUrl}/dense`, { waitUntil: "domcontentloaded" });
    const obs = await observe(page);
    const labels = obs.elements.map((e) => e.label);

    assert.ok(
      labels.includes("Real Button"),
      "a normal in-view button should be listed",
    );
    assert.ok(
      !labels.includes("Disabled Button"),
      "disabled elements should be excluded",
    );
    assert.ok(
      !labels.includes("Offscreen Button"),
      "off-screen elements should be excluded",
    );
    assert.ok(
      obs.elements.every((e) => e.label !== ""),
      "unlabeled clickable divs should be excluded",
    );
    assert.ok(
      obs.elements.length <= 100,
      `the list should be capped, got ${obs.elements.length}`,
    );
    assert.ok(
      (obs.truncated ?? 0) > 0,
      "should report how many on-screen elements were truncated",
    );
    // Refs must be unique (no collision after the filter + stale-ref clear).
    const refs = obs.elements.map((e) => e.ref);
    assert.equal(new Set(refs).size, refs.length, "refs must be unique");
  });
});

test("records a passed mission and replays it without calling the LLM", async () => {
  const server = await startFixtureServer();
  const recipesDir = join(
    tmpdir(),
    "takoqa-recipes-" + Math.random().toString(36).slice(2),
  );
  try {
    const loaded = profileFor(server.url, "/clean", "replayme");

    // Run 1: the (mock) LLM drives and the pass records a recipe.
    const rep1 = await runProfile(loaded, {
      llm: new MockClient([{ type: "click", ref: 0 }]),
      runDir: createRunDir(tmpdir(), "rec1"),
      headless: true,
      record: false,
      recipesDir,
    });
    assert.equal(
      rep1.results[0]!.outcome,
      "passed",
      "run 1 should pass and record a recipe",
    );

    // Run 2: replay from the recipe — the LLM's decide() must NEVER be called
    // (a throwing decide would surface as outcome 'error' if it were).
    let decideCalls = 0;
    const throwing: LLMClient = {
      decide: async () => {
        decideCalls++;
        throw new Error("LLM should not be called during replay");
      },
      judge: async () =>
        JSON.stringify({ goalMet: true, severity: "low", issues: [] }),
    };
    const rep2 = await runProfile(loaded, {
      llm: throwing,
      runDir: createRunDir(tmpdir(), "rec2"),
      headless: true,
      record: false,
      recipesDir,
    });
    assert.equal(
      rep2.results[0]!.outcome,
      "passed",
      "replay should reproduce the pass",
    );
    assert.equal(decideCalls, 0, "replay must not call the LLM decide()");
  } finally {
    await server.close();
  }
});

test("does not bake a failed/stale action into the recorded recipe", async () => {
  const server = await startFixtureServer();
  const recipesDir = join(
    tmpdir(),
    "takoqa-recipes-" + Math.random().toString(36).slice(2),
  );
  try {
    const loaded = profileFor(server.url, "/clean", "recguard", 4);
    // ref 99 doesn't exist (stale → fails); ref 0 (OK) succeeds; then finish.
    await runProfile(loaded, {
      llm: new MockClient([
        { type: "click", ref: 99 },
        { type: "click", ref: 0 },
      ]),
      runDir: createRunDir(tmpdir(), "recg"),
      headless: true,
      record: false,
      recipesDir,
    });
    const recipe = loadRecipe(recipesDir, "fixture", "recguard");
    assert.ok(recipe, "a recipe should be saved on pass");
    assert.ok(
      !recipe!.steps.some(
        (s) => s.action.type === "click" && s.action.ref === 99,
      ),
      "a failed/stale action must not be recorded into the recipe",
    );
    assert.ok(
      recipe!.steps.some((s) => s.action.type === "finish"),
      "the terminal finish should be recorded",
    );
  } finally {
    await server.close();
  }
});

test("downgrades an uncorroborated goal_failed to low (agent limitation, not an app bug)", async () => {
  const server = await startFixtureServer();
  try {
    // Judge fails the goal at 'critical' on a CLEAN page (no crash/5xx/error sig).
    const client: LLMClient = {
      decide: async () => ({
        action: { type: "finish", success: false, summary: "gave up" },
        rationale: "stuck",
      }),
      judge: async () =>
        JSON.stringify({
          goalMet: false,
          severity: "critical",
          issues: [],
          rationale: "could not complete",
        }),
      propose: async () => "[]",
    };
    const report = await runProfile(profileFor(server.url, "/clean", "softfail"), {
      llm: client,
      runDir: createRunDir(tmpdir(), "softfail"),
      headless: true,
      record: false,
    });
    const gf = report.results[0]!.findings.find((f) => f.kind === "goal_failed");
    assert.ok(gf, "a goal_failed was recorded");
    assert.equal(gf!.severity, "low", "no hard signal → downgraded to low");
    assert.match(gf!.detail, /unverified/, "annotated as unverified");
  } finally {
    await server.close();
  }
});

test("floors a goal_failed at medium (not low) when a no_progress signal corroborates it", async () => {
  const server = await startFixtureServer();
  try {
    // /noop's button is inert → the loop guard fires no_progress (a deterministic
    // "dead control" signal). Judge fails the goal high; no hard crash fired.
    const client: LLMClient = {
      decide: async () => ({ action: { type: "click", ref: 0 }, rationale: "" }),
      judge: async () =>
        JSON.stringify({
          goalMet: false,
          severity: "high",
          issues: [],
          rationale: "could not proceed",
        }),
      propose: async () => "[]",
    };
    const result = (
      await runProfile(profileFor(server.url, "/noop", "deadctrl", 10), {
        llm: client,
        runDir: createRunDir(tmpdir(), "deadctrl"),
        headless: true,
        record: false,
      })
    ).results[0]!;
    assert.ok(
      result.findings.some((f) => f.kind === "no_progress"),
      "precondition: no_progress fired",
    );
    const gf = result.findings.find((f) => f.kind === "goal_failed");
    if (gf) {
      assert.equal(
        gf.severity,
        "medium",
        "a no_progress corroborator floors the downgrade at medium, not low",
      );
    }
  } finally {
    await server.close();
  }
});

test("keeps a goal_failed severe when a hard failure corroborates it", async () => {
  const server = await startFixtureServer();
  try {
    // /settings throws a page_error on click (ref 0); judge fails the goal high.
    const client: LLMClient = {
      decide: async () => ({ action: { type: "click", ref: 0 }, rationale: "" }),
      judge: async () =>
        JSON.stringify({
          goalMet: false,
          severity: "high",
          issues: [],
          rationale: "broke",
        }),
      propose: async () => "[]",
    };
    const report = await runProfile(
      profileFor(server.url, "/settings", "hardfail", 1),
      {
        llm: client,
        runDir: createRunDir(tmpdir(), "hardfail"),
        headless: true,
        record: false,
      },
    );
    const findings = report.results[0]!.findings;
    assert.ok(
      findings.some((f) => f.kind === "page_error"),
      "precondition: a hard failure fired",
    );
    const gf = findings.find((f) => f.kind === "goal_failed");
    assert.ok(gf, "a goal_failed was recorded");
    assert.equal(
      gf!.severity,
      "high",
      "hard failure present → severity preserved",
    );
  } finally {
    await server.close();
  }
});

test("a mission with a hard functional finding is never reported passed", async () => {
  const server = await startFixtureServer();
  try {
    // /settings throws an uncaught exception on click (page_error). The mock
    // judge would say goalMet, but a crash must veto a 'passed' outcome.
    const result = await run(server, "/settings", "veto", [
      { type: "click", ref: 0 },
    ]);
    assert.ok(
      result.findings.some((f) => f.kind === "page_error"),
      "precondition: the planted page_error fired",
    );
    assert.notEqual(
      result.outcome,
      "passed",
      "a page_error/http_error/crash must veto a 'passed' outcome",
    );
  } finally {
    await server.close();
  }
});

test("settle reports a perpetually-busy page as not quiesced (drives fast settle)", async () => {
  await withPage(async (page, baseUrl) => {
    await page.goto(`${baseUrl}/busy`, { waitUntil: "domcontentloaded" });
    const settled = await settle(page, { fast: true });
    assert.equal(
      settled,
      false,
      "a continuously-mutating page should not settle",
    );
  });
});

test("settle reports a static page as quiesced", async () => {
  await withPage(async (page, baseUrl) => {
    await page.goto(`${baseUrl}/clean`, { waitUntil: "domcontentloaded" });
    const settled = await settle(page);
    assert.equal(settled, true, "a static page should settle");
  });
});

test("crawl mode visits each route and flags one that errors on load", async () => {
  const server = await startFixtureServer();
  try {
    const profile = ProfileSchema.parse({
      name: "fixture",
      baseUrl: server.url,
      personas: [{ name: "t", description: "t" }],
      missions: [
        {
          id: "crawl",
          goal: "sweep routes",
          mode: "crawl",
          routes: ["/clean", "/loaderror", "/noop"],
        },
      ],
    });
    const report = await runProfile(
      { profile, baseDir: tmpdir() },
      {
        llm: new MockClient(),
        runDir: createRunDir(tmpdir(), "crawl"),
        headless: true,
        record: false,
      },
    );
    const r = report.results[0]!;
    assert.equal(r.steps.length, 3, "should visit all three routes");
    assert.ok(
      r.findings.some((f) => f.kind === "page_error"),
      "should flag the route that throws on load",
    );
    assert.equal(r.outcome, "failed", "a hard finding fails the crawl");
    assert.ok(
      report.coverage.routesVisited.includes("/clean") &&
        report.coverage.routesVisited.includes("/loaderror"),
      "coverage should list the crawled routes",
    );
  } finally {
    await server.close();
  }
});

test("crawl skips dynamic [id] routes instead of navigating them literally", async () => {
  const server = await startFixtureServer();
  try {
    const profile = ProfileSchema.parse({
      name: "fixture",
      baseUrl: server.url,
      personas: [{ name: "t", description: "t" }],
      missions: [
        {
          id: "crawl",
          goal: "sweep",
          mode: "crawl",
          routes: ["/clean", "/thing/[id]"],
        },
      ],
    });
    const report = await runProfile(
      { profile, baseDir: tmpdir() },
      {
        llm: new MockClient(),
        runDir: createRunDir(tmpdir(), "crawl-dyn"),
        headless: true,
        record: false,
      },
    );
    const r = report.results[0]!;
    assert.equal(r.steps.length, 1, "only the static route is crawled");
    assert.equal(r.steps[0]!.actionSummary, "Visited /clean");
    assert.ok(
      !r.findings.some((f) => f.url.includes("[")),
      "a literal [id] route must never be navigated",
    );
  } finally {
    await server.close();
  }
});

test("run report includes coverage of the routes actually reached", async () => {
  const server = await startFixtureServer();
  try {
    const report = await runProfile(profileFor(server.url, "/clean", "cov"), {
      llm: new MockClient([{ type: "click", ref: 0 }]),
      runDir: createRunDir(tmpdir(), "cov"),
      headless: true,
      record: false,
    });
    assert.ok(
      report.coverage.routesVisited.includes("/clean"),
      `coverage should list /clean, got: ${report.coverage.routesVisited.join(", ")}`,
    );
  } finally {
    await server.close();
  }
});
