/**
 * Unit tests for the route/progress helpers — pure, no browser.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeRoute, isGatedRedirect } from "../src/progress.js";

test("normalizeRoute collapses dynamic id segments to [id]", () => {
  assert.equal(
    normalizeRoute("http://x/knowledge/626803c5-c56f-4241-b7be-5fdd1368e097"),
    "/knowledge/[id]",
  );
  assert.equal(normalizeRoute("http://x/agent/42/runs"), "/agent/[id]/runs");
  assert.equal(
    normalizeRoute("http://x/playground/documents"),
    "/playground/documents",
  );
  assert.equal(normalizeRoute("http://x/"), "/");
  // trailing slash + query/hash stripped
  assert.equal(normalizeRoute("http://x/knowledge/?tab=1#a"), "/knowledge");
});

test("isGatedRedirect flags only unrelated redirects", () => {
  assert.equal(
    isGatedRedirect("/playground/documents", "http://x/knowledge"),
    true,
  );
  assert.equal(isGatedRedirect("/knowledge", "http://x/knowledge/abc"), false); // nested = same area
  assert.equal(isGatedRedirect("/", "http://x/agent"), false); // root landing redirect is normal
  assert.equal(isGatedRedirect("/agent", "http://x/agent"), false);
});
