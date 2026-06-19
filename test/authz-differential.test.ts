/**
 * Pure unit tests for the authz differential (checkExpectedAccess) — no browser,
 * no LLM. A disallowed reach is a critical finding whose KIND depends on auth: an
 * AUTHENTICATED-but-under-privileged reach (no `unauthenticated` flag) is a
 * broken_authz; an UNAUTHENTICATED reach (`unauthenticated: true`) is a
 * missing_authn. Reaching an allowed route is fine; an undeclared route asserts
 * nothing (no default-deny).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { checkExpectedAccess, reachedRoutes } from "../src/matrix.js";

test("a lower-priv variant reaching an op-only route is a critical broken_authz", () => {
  const findings = checkExpectedAccess(
    [
      { variant: "anon", reachedRoutes: ["/admin", "/"] },
      { variant: "op", reachedRoutes: ["/admin", "/"] },
    ],
    { "/admin": ["op"] },
  );
  const breaks = findings.filter((f) => f.kind === "broken_authz");
  assert.equal(breaks.length, 1, "only anon reaching /admin is a break");
  assert.equal(breaks[0]!.severity, "critical");
  assert.equal(breaks[0]!.persona, "anon");
  assert.match(breaks[0]!.title, /anon/);
  assert.match(breaks[0]!.title, /\/admin/);
});

test("an UNAUTHENTICATED variant reaching a gated route is a critical missing_authn", () => {
  const findings = checkExpectedAccess(
    [
      { variant: "anon", reachedRoutes: ["/admin"], unauthenticated: true },
      { variant: "op", reachedRoutes: ["/admin"] },
    ],
    { "/admin": ["op"] },
  );
  // anon is unauthenticated → missing_authn (not broken_authz); op is allowed.
  assert.equal(findings.length, 1);
  assert.equal(findings[0]!.kind, "missing_authn");
  assert.equal(findings[0]!.severity, "critical");
  assert.equal(findings[0]!.persona, "anon");
  assert.match(findings[0]!.title, /Missing authn/);
});

test("a variant reaching a route it IS allowed to reach yields nothing", () => {
  const findings = checkExpectedAccess(
    [{ variant: "op", reachedRoutes: ["/admin"] }],
    { "/admin": ["op"] },
  );
  assert.equal(findings.length, 0, "an allowed reach is not a finding");
});

test("an undeclared route asserts nothing (no default-deny)", () => {
  const findings = checkExpectedAccess(
    [{ variant: "anon", reachedRoutes: ["/public", "/profile"] }],
    { "/admin": ["op"] }, // neither reached route is declared
  );
  assert.equal(findings.length, 0, "undeclared routes never produce a finding");
});

test("routes with dynamic ids are normalized before comparison", () => {
  const findings = checkExpectedAccess(
    [{ variant: "anon", reachedRoutes: ["/orders/12345"] }],
    { "/orders/[id]": ["op"] },
  );
  assert.equal(findings.length, 1, "a normalized id route matches the rule");
  assert.equal(findings[0]!.kind, "broken_authz");
});

// --- FIX 2: reached is judged by the LANDED document's GET status ------------

test("reachedRoutes: a 403/302 document is NOT reached; 200/undefined IS", () => {
  const reached = reachedRoutes([
    { url: "http://x/forbidden", status: 403 }, // gated body → not reached
    { url: "http://x/redirected", status: 302 }, // redirect → not reached
    { url: "http://x/server-error", status: 500 }, // error → not reached
    { url: "http://x/ok", status: 200 }, // served → reached
    { url: "http://x/unknown" }, // no status captured → reached (default)
  ]);
  assert.ok(!reached.includes("/forbidden"), "403 doc is not reached");
  assert.ok(!reached.includes("/redirected"), "302 doc is not reached");
  assert.ok(!reached.includes("/server-error"), "500 doc is not reached");
  assert.ok(reached.includes("/ok"), "200 doc IS reached");
  assert.ok(
    reached.includes("/unknown"),
    "an undefined status defaults to reached (conservative)",
  );
});

test("a correctly-gated 403 route yields no broken_authz", () => {
  // The variant 'landed' on /admin but the document came back 403, so the route
  // was NOT reached — there must be no broken_authz despite the expectedAccess
  // rule restricting /admin to "op".
  const reached = reachedRoutes([{ url: "http://x/admin", status: 403 }]);
  const findings = checkExpectedAccess(
    [{ variant: "anon", reachedRoutes: reached }],
    {
      "/admin": ["op"],
    },
  );
  assert.equal(findings.length, 0, "a 403-gated route is not a broken_authz");
});

test("checkExpectedAccess normalizes CONFIG keys (trailing slash / concrete id)", () => {
  // Config keys with a trailing slash and a concrete id still match the
  // normalized reached route (/admin and /users/[id]).
  const trailing = checkExpectedAccess(
    [{ variant: "anon", reachedRoutes: ["/admin"] }],
    { "/admin/": ["op"] }, // trailing slash in config
  );
  assert.equal(trailing.length, 1, "a trailing-slash config key still matches");
  assert.equal(trailing[0]!.kind, "broken_authz");

  const concreteId = checkExpectedAccess(
    [{ variant: "anon", reachedRoutes: ["/users/999"] }],
    { "/users/123": ["op"] }, // concrete id in config
  );
  assert.equal(
    concreteId.length,
    1,
    "a concrete-id config key normalizes to /users/[id] and matches",
  );
  assert.equal(concreteId[0]!.kind, "broken_authz");
});
