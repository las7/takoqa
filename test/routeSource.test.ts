/**
 * Unit tests for pluggable route discovery (routeSource.ts). Pure: the next
 * adapter reads a temp app tree on disk; the sitemap adapter uses an INJECTED
 * fetch so no network is touched.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  resolveRoutes,
  extractSitemapRoutes,
  routeSourceFrom,
} from "../src/routeSource.js";

/** Build a temp Next.js-style app tree (reuses the discover.test pattern). */
function tempApp(): string {
  const app = join(
    tmpdir(),
    "takoqa-rs-" + Math.random().toString(36).slice(2),
  );
  const page = (rel: string) => {
    const dir = join(app, rel);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "page.tsx"), "export default function P() {}");
  };
  page(""); // -> /
  page("agent"); // -> /agent
  page("knowledge/[id]"); // dynamic kept
  return app;
}

// --- next adapter ------------------------------------------------------------

test("next adapter discovers routes from an app-router tree", async () => {
  const app = tempApp();
  const resolved = await resolveRoutes({ kind: "next", appDir: app });
  assert.equal(resolved.kind, "next");
  assert.ok(resolved.routes.includes("/"));
  assert.ok(resolved.routes.includes("/agent"));
  assert.ok(resolved.routes.includes("/knowledge/[id]"));
});

test("next adapter yields [] for a missing app dir (caller decides to fail)", async () => {
  const resolved = await resolveRoutes({
    kind: "next",
    appDir: join(tmpdir(), "nope-" + Math.random()),
  });
  assert.deepEqual(resolved.routes, []);
});

// --- static adapter ----------------------------------------------------------

test("static adapter returns the supplied routes verbatim (identity)", async () => {
  const routes = ["/", "/dashboard", "/settings"];
  const resolved = await resolveRoutes({ kind: "static", routes });
  assert.equal(resolved.kind, "static");
  assert.deepEqual(resolved.routes, routes, "no discovery — used as given");
});

// --- sitemap adapter ---------------------------------------------------------

const SITEMAP = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://app.example.com/</loc></url>
  <url><loc>https://app.example.com/about</loc></url>
  <url><loc>https://app.example.com/docs/intro</loc></url>
  <url><loc>https://app.example.com/users/12345</loc></url>
  <url><loc>https://other-site.com/leak</loc></url>
</urlset>`;

test("sitemap adapter parses same-origin paths from an injected document", async () => {
  const resolved = await resolveRoutes(
    { kind: "sitemap", url: "https://app.example.com/sitemap.xml" },
    { fetchText: async () => SITEMAP },
  );
  assert.equal(resolved.kind, "sitemap");
  assert.ok(resolved.routes.includes("/"));
  assert.ok(resolved.routes.includes("/about"));
  assert.ok(resolved.routes.includes("/docs/intro"));
  // Numeric id normalized to [id].
  assert.ok(
    resolved.routes.includes("/users/[id]"),
    `expected normalized /users/[id], got: ${resolved.routes.join(", ")}`,
  );
  // Off-origin entry dropped.
  assert.ok(
    !resolved.routes.some((r) => r.includes("leak")),
    "off-origin sitemap entries must be dropped",
  );
});

test("sitemap adapter respects the cap", async () => {
  const resolved = await resolveRoutes(
    { kind: "sitemap", url: "https://app.example.com/sitemap.xml", cap: 2 },
    { fetchText: async () => SITEMAP },
  );
  assert.equal(resolved.routes.length, 2, "no more than `cap` routes kept");
});

test("extractSitemapRoutes returns [] for a bad sitemap url (no throw)", () => {
  assert.deepEqual(extractSitemapRoutes(SITEMAP, "not a url", 10), []);
});

// --- routeSourceFrom (profile + CLI override precedence) ---------------------

test("routeSourceFrom: --app-dir override wins over the profile", () => {
  const src = routeSourceFrom(
    { source: { kind: "static", routes: ["/x"] } },
    { appDir: "/some/app" },
  );
  assert.deepEqual(src, { kind: "next", appDir: "/some/app" });
});

test("routeSourceFrom: --routes builds a static source", () => {
  const src = routeSourceFrom(undefined, { routes: ["/a", "/b"] });
  assert.deepEqual(src, { kind: "static", routes: ["/a", "/b"] });
});

test("routeSourceFrom: --sitemap builds a sitemap source", () => {
  const src = routeSourceFrom(undefined, { sitemap: "https://x/sitemap.xml" });
  assert.deepEqual(src, { kind: "sitemap", url: "https://x/sitemap.xml" });
});

test("routeSourceFrom: explore.source is used when no CLI override", () => {
  const src = routeSourceFrom({ source: { kind: "static", routes: ["/y"] } });
  assert.deepEqual(src, { kind: "static", routes: ["/y"] });
});

test("routeSourceFrom: explore.appDir shorthand expands to a next source", () => {
  const src = routeSourceFrom({ appDir: "/legacy/app" });
  assert.deepEqual(src, { kind: "next", appDir: "/legacy/app" });
});

test("routeSourceFrom: nothing declared yields undefined", () => {
  assert.equal(routeSourceFrom(undefined), undefined);
  assert.equal(routeSourceFrom({}), undefined);
});
