/**
 * Unit tests for explore-mode orchestration — pure profile transform, builds a
 * temp app tree on disk for route discovery (no browser/LLM).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ProfileSchema } from "../src/types.js";
import type { LoadedProfile } from "../src/profile.js";
import { buildExplorePlan, EXPLORE_CRAWL_ID } from "../src/explore.js";
import { discoverRoutes } from "../src/discover.js";
import type { ResolvedRouteSource } from "../src/routeSource.js";

/** A "next" route source resolved from an app tree — the behavior-preserving
 *  equivalent of the old `buildExplorePlan(loaded, appDir)` call. */
function nextSource(appDir: string): ResolvedRouteSource {
  return { kind: "next", routes: discoverRoutes(appDir) };
}

function tempApp(): string {
  const app = join(
    tmpdir(),
    "takoqa-explore-" + Math.random().toString(36).slice(2),
  );
  const page = (rel: string) => {
    const dir = join(app, rel);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "page.tsx"), "export default function P() {}");
  };
  page(""); // -> /
  page("agent"); // -> /agent
  page("settings"); // -> /settings
  page("knowledge/[id]"); // dynamic -> discovered but NOT crawled
  return app;
}

function loadedWith(missions: object[], knowledge?: object): LoadedProfile {
  const profile = ProfileSchema.parse({
    name: "fixture",
    baseUrl: "http://localhost:3000",
    personas: [{ name: "tester", description: "a test persona" }],
    missions,
    ...(knowledge ? { knowledge } : {}),
  });
  return { profile, baseDir: tmpdir() };
}

test("synthesizes a crawl over discovered static routes, dropping dynamics", () => {
  const app = tempApp();
  const plan = buildExplorePlan(
    loadedWith([{ id: "ask", goal: "g", startPath: "/agent" }]),
    nextSource(app),
  );

  const crawl = plan.loaded.profile.missions[0]!;
  assert.equal(crawl.id, EXPLORE_CRAWL_ID, "crawl mission runs first");
  assert.equal(crawl.mode, "crawl");
  assert.ok(crawl.routes.includes("/") && crawl.routes.includes("/agent"));
  assert.ok(
    !crawl.routes.some((r) => r.includes("[")),
    "dynamic [id] routes are not crawled literally",
  );
  assert.ok(
    plan.discovered.includes("/knowledge/[id]"),
    "dynamic routes are still discovered",
  );
});

test("keeps agent missions after the crawl and drops hand-authored crawl missions", () => {
  const app = tempApp();
  const plan = buildExplorePlan(
    loadedWith([
      { id: "ask", goal: "g", startPath: "/agent" },
      { id: "old-crawl", goal: "sweep", mode: "crawl", routes: ["/stale"] },
    ]),
    nextSource(app),
  );

  const ids = plan.loaded.profile.missions.map((m) => m.id);
  assert.deepEqual(
    ids,
    [EXPLORE_CRAWL_ID, "ask"],
    "one synthesized crawl + agent missions only",
  );
  assert.ok(
    !plan.loaded.profile.missions.some((m) => m.id === "old-crawl"),
    "the hand-authored crawl mission is replaced",
  );
});

test("merges discovered routes into knowledge (union by path), keeping existing entries", () => {
  const app = tempApp();
  const plan = buildExplorePlan(
    loadedWith([{ id: "ask", goal: "g" }], {
      routes: [{ path: "/agent", description: "the chat page" }],
    }),
    nextSource(app),
  );

  const routes = plan.loaded.profile.knowledge!.routes;
  const agent = routes.find((r) => r.path === "/agent");
  assert.equal(agent?.description, "the chat page", "existing entry preserved");
  assert.ok(
    routes.some((r) => r.path === "/settings"),
    "newly discovered route added to knowledge (drives coverage/frontier)",
  );
  assert.ok(
    routes.some((r) => r.path === "/knowledge/[id]"),
    "dynamic routes still tracked in knowledge for coverage",
  );
});

test("a bad app dir yields an empty crawl (caller warns), not a throw", () => {
  const plan = buildExplorePlan(
    loadedWith([{ id: "ask", goal: "g" }]),
    nextSource(join(tmpdir(), "does-not-exist-" + Math.random())),
  );
  assert.deepEqual(plan.crawled, []);
  assert.equal(plan.loaded.profile.missions[0]!.id, EXPLORE_CRAWL_ID);
});
