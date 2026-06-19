/**
 * Unit tests for route auto-discovery — pure, builds a temp app tree on disk.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { discoverRoutes, renderRoutesYaml } from "../src/discover.js";

test("discovers routes, dropping route groups/private and keeping dynamic segments", () => {
  const app = join(
    tmpdir(),
    "takoqa-app-" + Math.random().toString(36).slice(2),
  );
  const page = (rel: string) => {
    const dir = join(app, rel);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "page.tsx"), "export default function P() {}");
  };
  page(""); // app/page.tsx -> /
  page("agent"); // -> /agent
  page("(main)/knowledge"); // route group dropped -> /knowledge
  page("knowledge/[id]"); // dynamic kept -> /knowledge/[id]
  page("_private/secret"); // private subtree -> NOT a route
  page("feed/(.)photo"); // intercepting route -> NOT a navigable route

  const routes = discoverRoutes(app);
  assert.ok(routes.includes("/"), "root route");
  assert.ok(routes.includes("/agent"));
  assert.ok(routes.includes("/knowledge"), "route group stripped");
  assert.ok(routes.includes("/knowledge/[id]"), "dynamic segment kept");
  assert.ok(
    !routes.some((r) => r.includes("secret")),
    "private folders are excluded entirely",
  );
  assert.ok(
    !routes.some((r) => r.includes("(.)")),
    "intercepting routes are excluded entirely",
  );
  assert.match(
    renderRoutesYaml(routes),
    /knowledge:\n {2}routes:\n {4}- path: \//,
  );
});

test("discoverRoutes returns [] for a missing directory", () => {
  assert.deepEqual(discoverRoutes(join(tmpdir(), "nope-" + Math.random())), []);
});
