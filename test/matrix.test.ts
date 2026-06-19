/**
 * Unit tests for the tier/auth matrix diff — pure (no browser/LLM).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Finding } from "../src/types.js";
import { ProfileSchema } from "../src/types.js";
import type { LoadedProfile } from "../src/profile.js";
import { MockClient } from "../src/agent.js";
import { createRunDir } from "../src/report.js";
import { classifyAcrossVariants, runMatrix } from "../src/matrix.js";
import { discoverRoutes } from "../src/discover.js";
import type { ResolvedRouteSource } from "../src/routeSource.js";
import { startFixtureServer } from "./fixture-server.js";

/** A "next" route source resolved from an app tree, for runMatrix's 2nd arg. */
function nextSource(appDir: string): ResolvedRouteSource {
  return { kind: "next", routes: discoverRoutes(appDir) };
}

function finding(title: string, kind: Finding["kind"] = "http_error"): Finding {
  return {
    kind,
    severity: "high",
    missionId: "m",
    persona: "p",
    title,
    detail: "d",
    repro: [],
    url: "http://x",
    timestamp: "t",
  };
}

test("a finding in every variant is universal; one in a subset is access-dependent", () => {
  const entries = classifyAcrossVariants([
    {
      variant: "anon",
      findings: [
        finding("HTTP 500 on /api/x"),
        finding("Route gated: /experiments", "route_gated"),
      ],
    },
    { variant: "op", findings: [finding("HTTP 500 on /api/x")] },
  ]);

  const universal = entries.filter((e) => e.universal);
  const specific = entries.filter((e) => !e.universal);

  assert.equal(universal.length, 1, "the 500 seen in both is universal");
  assert.match(universal[0]!.finding.title, /HTTP 500/);
  assert.equal(
    specific.length,
    1,
    "the gate seen only at anon is access-dependent",
  );
  assert.deepEqual(specific[0]!.variants, ["anon"]);
});

test("with a single variant nothing is 'universal' (need >1 to diff)", () => {
  const entries = classifyAcrossVariants([
    { variant: "anon", findings: [finding("HTTP 500 on /api/x")] },
  ]);
  assert.equal(entries.length, 1);
  assert.equal(
    entries[0]!.universal,
    false,
    "one variant can't establish universality",
  );
});

test("the same bug on a dynamic URL collapses across variants (fingerprint)", () => {
  const entries = classifyAcrossVariants([
    {
      variant: "anon",
      findings: [
        finding(
          "HTTP 500 on GET /api/doc/3f2504e0-4f89-41d3-9a0c-0305e82c3301",
        ),
      ],
    },
    {
      variant: "op",
      findings: [
        finding(
          "HTTP 500 on GET /api/doc/9c858901-8a57-4791-81fe-4c455b099bc9",
        ),
      ],
    },
  ]);
  assert.equal(entries.length, 1, "ids collapse to one entry");
  assert.equal(
    entries[0]!.universal,
    true,
    "recognized as the same bug in both variants",
  );
});

/** A temp Next.js-style app tree so buildExplorePlan discovers static routes. */
function tempApp(routes: string[]): string {
  const app = join(
    tmpdir(),
    "takoqa-matrix-" + Math.random().toString(36).slice(2),
  );
  for (const r of routes) {
    const dir = join(app, r === "/" ? "" : r.replace(/^\//, ""));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "page.tsx"), "export default function P() {}");
  }
  return app;
}

function loaded(
  server: string,
  expectedAccess: Record<string, string[]>,
): LoadedProfile {
  const profile = ProfileSchema.parse({
    name: "matrix-fixture",
    baseUrl: server,
    personas: [{ name: "t", description: "t" }],
    missions: [{ id: "placeholder", goal: "g" }],
    expectedAccess,
  });
  return { profile, baseDir: tmpdir() };
}

test("runMatrix surfaces an access-control break from expectedAccess as a variant-scoped entry", async () => {
  const server = await startFixtureServer();
  try {
    // Both variants are UNAUTHENTICATED (auth: none) and reach every route on
    // the fixture server, but expectedAccess restricts /settings to "op" — so
    // "anon" reaching it is a missing_authn (an unauthenticated reach of a gated
    // route). "op" is allowed, so it produces nothing.
    const appDir = tempApp(["/", "/clean", "/settings"]);
    const { entries } = await runMatrix(
      loaded(server.url, { "/settings": ["op"] }),
      nextSource(appDir),
      [
        { name: "anon", auth: { strategy: "none" } },
        { name: "op", auth: { strategy: "none" } },
      ],
      {
        llm: new MockClient(),
        runDir: createRunDir(tmpdir(), "matrix-authz"),
        headless: true,
        record: false,
      },
    );
    const authz = entries.filter((e) => e.finding.kind === "missing_authn");
    assert.equal(
      authz.length,
      1,
      "anon reaching /settings is one missing_authn",
    );
    assert.equal(authz[0]!.universal, false, "authz breaks are variant-scoped");
    assert.deepEqual(authz[0]!.variants, ["anon"]);
    assert.equal(authz[0]!.finding.severity, "critical");
    assert.match(authz[0]!.finding.title, /\/settings/);
  } finally {
    await server.close();
  }
});

test("runMatrix emits no broken_authz when every reached route is allowed", async () => {
  const server = await startFixtureServer();
  try {
    const appDir = tempApp(["/", "/clean"]);
    const { entries } = await runMatrix(
      loaded(server.url, { "/clean": ["anon", "op"] }),
      nextSource(appDir),
      [
        { name: "anon", auth: { strategy: "none" } },
        { name: "op", auth: { strategy: "none" } },
      ],
      {
        llm: new MockClient(),
        runDir: createRunDir(tmpdir(), "matrix-authz-clean"),
        headless: true,
        record: false,
      },
    );
    assert.ok(
      !entries.some((e) => e.finding.kind === "broken_authz"),
      "an allowed reach must not produce a broken_authz",
    );
  } finally {
    await server.close();
  }
});
