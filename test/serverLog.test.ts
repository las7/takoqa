/**
 * Server-log correlation: a server-side failure finding (5xx / crash) gets the
 * app's own traceback spliced into its evidence, anchored on the request path;
 * secrets in the excerpt are redacted; non-server-side kinds and no-match
 * findings are untouched. Pure — no engine/browser. readServerLog IO is exercised
 * via injected deps.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  correlateServerLog,
  correlateReport,
  excerptForPath,
  readServerLog,
} from "../src/serverLog.js";
import type { Finding, FindingKind, RunReport } from "../src/types.js";

function finding(kind: FindingKind, url: string, evidence?: string): Finding {
  return {
    kind,
    severity: "high",
    missionId: "m",
    persona: "p",
    title: `${kind} on ${url}`,
    detail: "",
    repro: [],
    url,
    evidence,
    timestamp: "2026-01-01T00:00:00.000Z",
  };
}

const LOG = [
  "INFO: 127.0.0.1 - GET /agent 200",
  "INFO: 127.0.0.1 - POST /agent 500",
  "Traceback (most recent call last):",
  '  File "/app/op_core/api/agent.py", line 88, in create_run',
  "    raise UndefinedColumn('agent_runs.model_name')",
  "psycopg2.errors.UndefinedColumn: column agent_runs.model_name does not exist",
  "INFO: 127.0.0.1 - GET /knowledge 200",
].join("\n");

test("correlates a server traceback onto a 5xx finding by request path", () => {
  const out = correlateServerLog(
    [finding("http_error", "http://x/agent")],
    LOG,
  );
  assert.match(out[0]!.evidence ?? "", /correlated server log/);
  assert.match(
    out[0]!.evidence ?? "",
    /UndefinedColumn: column agent_runs\.model_name/,
  );
});

test("appends to existing evidence rather than replacing it", () => {
  const out = correlateServerLog(
    [finding("http_error", "http://x/agent", "POST /agent -> 500")],
    LOG,
  );
  assert.match(out[0]!.evidence ?? "", /POST \/agent -> 500/);
  assert.match(out[0]!.evidence ?? "", /Traceback/);
});

test("redacts secrets in the spliced excerpt", () => {
  const log = [
    "GET /admin 500",
    "Traceback (most recent call last):",
    "  DATABASE_URL = postgres://user:supersecret@db:5432/app",
    "  password=hunter2 in config",
  ].join("\n");
  const out = correlateServerLog(
    [finding("http_error", "http://x/admin")],
    log,
  );
  const ev = out[0]!.evidence ?? "";
  assert.ok(!ev.includes("supersecret"), "connection-url creds redacted");
  assert.ok(!ev.includes("hunter2"), "password redacted");
  assert.match(ev, /\[redacted\]/);
});

test("matches the path as a whole URL token, not a substring", () => {
  const log = [
    "POST /agent/personas 500",
    "Traceback (most recent call last):",
    "  ValueError: boom",
  ].join("\n");
  // A finding on /agent must NOT borrow the /agent/personas traceback.
  const out = correlateServerLog(
    [finding("http_error", "http://x/agent")],
    log,
  );
  assert.equal(out[0]!.evidence, undefined);
  // The /agent/personas finding does correlate.
  const out2 = correlateServerLog(
    [finding("http_error", "http://x/agent/personas")],
    log,
  );
  assert.match(out2[0]!.evidence ?? "", /ValueError: boom/);
});

test("only splices a window that actually contains an error signature", () => {
  // The path matches, but there is no traceback anywhere → no excerpt (a run of
  // benign 200 lines is noise, not signal).
  const benign = ["GET /agent 200", "GET /agent 200", "GET /agent 200"].join(
    "\n",
  );
  assert.equal(
    correlateServerLog([finding("http_error", "http://x/agent")], benign)[0]!
      .evidence,
    undefined,
  );
  // A real error window EARLIER + benign 200s LATER → still finds the error.
  const mixed = [
    "POST /agent 500",
    "Traceback (most recent call last):",
    "  psycopg2.errors.UndefinedColumn: agent_runs.model_name",
    "GET /agent 200",
    "GET /agent 200",
  ].join("\n");
  assert.match(
    correlateServerLog([finding("http_error", "http://x/agent")], mixed)[0]!
      .evidence ?? "",
    /UndefinedColumn/,
  );
});

test("page_error (a client-side exception) is not correlated to the server log", () => {
  const log = [
    "GET /dash 200",
    "Traceback (most recent call last):",
    "  X",
  ].join("\n");
  const out = correlateServerLog([finding("page_error", "http://x/dash")], log);
  assert.equal(out[0]!.evidence, undefined);
});

test("leaves non-server-side kinds and unmatched findings untouched", () => {
  const noisy = finding("console_error", "http://x/agent"); // not a correlate kind
  const unmatched = finding("http_error", "http://x/nowhere"); // path absent from log
  const out = correlateServerLog([noisy, unmatched], LOG);
  assert.equal(out[0]!.evidence, undefined);
  assert.equal(out[1]!.evidence, undefined);
});

test('a generic "/" path never anchors (would match every line)', () => {
  const out = correlateServerLog([finding("http_error", "http://x/")], LOG);
  assert.equal(out[0]!.evidence, undefined);
});

test("excerptForPath returns null on a miss and a bounded window on a hit", () => {
  const lines = LOG.split("\n");
  assert.equal(excerptForPath(lines, "/absent"), null);
  const hit = excerptForPath(lines, "/agent");
  assert.ok(hit && hit.includes("Traceback"));
});

test("correlateReport applies across every mission's findings", () => {
  const report: RunReport = {
    profile: "t",
    baseUrl: "http://x",
    startedAt: "t0",
    finishedAt: "t1",
    results: [
      {
        missionId: "m1",
        persona: "p",
        goal: "g",
        outcome: "failed",
        steps: [],
        findings: [finding("http_error", "http://x/agent")],
        startedAt: "t0",
        finishedAt: "t1",
      },
    ],
    coverage: { routesVisited: [], unvisitedKnownRoutes: [] },
  };
  const out = correlateReport(report, LOG);
  assert.match(out.results[0]!.findings[0]!.evidence ?? "", /Traceback/);
});

test("readServerLog uses injected IO and is best-effort on failure", () => {
  assert.equal(
    readServerLog(
      { kind: "command", command: "whatever" },
      { runCommand: () => "log text" },
    ),
    "log text",
  );
  assert.equal(
    readServerLog(
      { kind: "file", path: "/x" },
      {
        readFileTail: () => {
          throw new Error("nope");
        },
      },
    ),
    "",
    "a read failure yields empty (correlation simply skipped)",
  );
});
