/**
 * Pure unit tests for the deterministic security oracles (checkSecurity, and its
 * appendage to checkInvariants). No browser, no LLM — synthetic CapturedEvents.
 * Each oracle must fire on the bad case and stay silent on the clean case, and
 * secrets must always be redacted (the full value never appears in a finding).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { checkInvariants, checkSecurity } from "../src/oracles.js";
import { parseSetCookie } from "../src/browser.js";
import type { CapturedEvents, ResponseEvent } from "../src/browser.js";
import type { Observation } from "../src/observe.js";
import { InvariantsSchema, SecuritySchema } from "../src/types.js";

const inv = (overrides = {}) => InvariantsSchema.parse(overrides);
const sec = (overrides = {}) => SecuritySchema.parse(overrides);

const obs = (text = ""): Observation => ({
  url: "http://test/page",
  title: "page",
  elements: [],
  visibleText: text,
  screenshotBase64: "",
  viewport: { width: 1280, height: 900 },
});

const base = { missionId: "m1", persona: "p1", repro: [] as string[] };

const noEvents = (): CapturedEvents => ({
  console: [],
  pageErrors: [],
  responses: [],
  cookies: [],
});

/** A same-origin HTML document GET response with the given headers/body. */
function doc(
  over: Partial<ResponseEvent> = {},
  headers: Record<string, string> = {},
): ResponseEvent {
  return {
    status: 200,
    url: "http://test/page",
    method: "GET",
    headers: { "content-type": "text/html; charset=utf-8", ...headers },
    ...over,
  };
}

const ALL_HEADERS = {
  "content-security-policy": "default-src 'self'",
  "strict-transport-security": "max-age=31536000",
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
};

// --- insecure_headers --------------------------------------------------------

test("insecure_headers fires when a document is missing required headers", () => {
  const events = noEvents();
  events.responses.push(doc()); // html doc with NO security headers
  const findings = checkSecurity(events, sec(), obs(), base);
  const f = findings.find((x) => x.kind === "insecure_headers");
  assert.ok(f, "expected insecure_headers");
  assert.equal(f.severity, "medium");
  // Lists the missing set.
  assert.match(f.evidence ?? "", /content-security-policy/);
  assert.match(f.evidence ?? "", /x-frame-options/);
});

test("insecure_headers stays silent when all required headers are present", () => {
  const events = noEvents();
  events.responses.push(doc({}, ALL_HEADERS));
  const findings = checkSecurity(events, sec(), obs(), base);
  assert.ok(!findings.some((x) => x.kind === "insecure_headers"));
});

test("insecure_headers ignores non-document (json) responses", () => {
  const events = noEvents();
  events.responses.push(
    doc({ url: "http://test/api/x" }, { "content-type": "application/json" }),
  );
  const findings = checkSecurity(events, sec(), obs(), base);
  assert.ok(!findings.some((x) => x.kind === "insecure_headers"));
});

// --- insecure_cookie ---------------------------------------------------------

test("insecure_cookie fires for a session cookie missing attributes", () => {
  const events = noEvents();
  events.cookies.push(parseSetCookie("session=abc; Path=/", "http://test/"));
  const findings = checkSecurity(
    events,
    sec({ sessionCookieNames: ["session"] }),
    obs(),
    base,
  );
  const f = findings.find((x) => x.kind === "insecure_cookie");
  assert.ok(f, "expected insecure_cookie");
  assert.match(f.title, /HttpOnly/);
  assert.match(f.title, /Secure/);
  assert.match(f.title, /SameSite/);
});

test("insecure_cookie stays silent when the cookie has all three attributes", () => {
  const events = noEvents();
  events.cookies.push(
    parseSetCookie(
      "session=abc; HttpOnly; Secure; SameSite=Lax",
      "http://test/",
    ),
  );
  const findings = checkSecurity(
    events,
    sec({ sessionCookieNames: ["session"] }),
    obs(),
    base,
  );
  assert.ok(!findings.some((x) => x.kind === "insecure_cookie"));
});

test("insecure_cookie only checks declared session cookie names", () => {
  const events = noEvents();
  events.cookies.push(parseSetCookie("_ga=xyz", "http://test/")); // not a session cookie
  const findings = checkSecurity(
    events,
    sec({ sessionCookieNames: ["session"] }),
    obs(),
    base,
  );
  assert.ok(!findings.some((x) => x.kind === "insecure_cookie"));
});

// --- sensitive_data_exposure -------------------------------------------------

test("sensitive_data_exposure fires on a JWT and REDACTS it", () => {
  const jwt =
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c";
  const events = noEvents();
  events.responses.push(
    doc({ url: "http://test/api/me", body: `{"token":"${jwt}"}` }),
  );
  const findings = checkSecurity(events, sec(), obs(), base);
  const f = findings.find((x) => x.kind === "sensitive_data_exposure");
  assert.ok(f, "expected sensitive_data_exposure for the JWT");
  assert.equal(f.severity, "high");
  assert.match(f.evidence ?? "", /redacted/);
  // The full secret must NEVER appear anywhere in the finding.
  const blob = JSON.stringify(f);
  assert.ok(!blob.includes(jwt), "the full JWT must not appear in the finding");
});

test("sensitive_data_exposure fires on a configured pattern (AWS key) and redacts it", () => {
  const key = "AKIAIOSFODNN7EXAMPLE";
  const events = noEvents();
  events.responses.push(doc({ body: `leaked ${key} here` }));
  const findings = checkSecurity(
    events,
    sec({
      sensitivePatterns: [{ name: "aws-key", pattern: "AKIA[0-9A-Z]{16}" }],
    }),
    obs(),
    base,
  );
  const f = findings.find(
    (x) =>
      x.kind === "sensitive_data_exposure" && /aws-key/.test(x.evidence ?? ""),
  );
  assert.ok(f, "expected sensitive_data_exposure for the AWS key");
  assert.ok(!JSON.stringify(f).includes(key), "the full key must not leak");
});

test("sensitive_data_exposure stays silent on a clean body and skips invalid regexes", () => {
  const events = noEvents();
  events.responses.push(doc({ body: "<html>all clean here</html>" }));
  const findings = checkSecurity(
    events,
    sec({ sensitivePatterns: [{ name: "broken", pattern: "(" }] }), // invalid regex → skipped
    obs(),
    base,
  );
  assert.ok(!findings.some((x) => x.kind === "sensitive_data_exposure"));
});

// --- injection_reflection ----------------------------------------------------

test("injection_reflection fires when a metachar marker is reflected verbatim", () => {
  const marker = '<xss-7f3a-probe>"';
  const events = noEvents();
  events.responses.push(doc({ body: `<div>echo: ${marker}</div>` }));
  const findings = checkSecurity(events, sec(), obs(), base, [marker]);
  const f = findings.find((x) => x.kind === "injection_reflection");
  assert.ok(f, "expected injection_reflection for an unescaped reflection");
  assert.equal(f.severity, "high");
});

test("injection_reflection does NOT fire when the marker is HTML-escaped", () => {
  const marker = "<xss-7f3a-probe>";
  const escaped = "&lt;xss-7f3a-probe&gt;";
  const events = noEvents();
  events.responses.push(doc({ body: `<div>echo: ${escaped}</div>` }));
  const findings = checkSecurity(events, sec(), obs(), base, [marker]);
  assert.ok(
    !findings.some((x) => x.kind === "injection_reflection"),
    "an escaped reflection is safe and must not fire",
  );
});

test("injection_reflection ignores benign (metacharacter-free) markers", () => {
  const marker = "hello world"; // no metacharacters
  const events = noEvents();
  events.responses.push(doc({ body: `<div>hello world</div>` }));
  const findings = checkSecurity(events, sec(), obs(), base, [marker]);
  assert.ok(!findings.some((x) => x.kind === "injection_reflection"));
});

// --- verbose_error -----------------------------------------------------------

test("verbose_error fires on a 500 body containing a traceback (and scrubs paths)", () => {
  const events = noEvents();
  events.responses.push(
    doc({
      status: 500,
      url: "http://test/api/boom",
      body: 'Traceback (most recent call last):\n  File "/home/deploy/app/main.py", line 42, in handler\n    raise KeyError("x")',
    }),
  );
  const findings = checkSecurity(events, sec(), obs(), base);
  const f = findings.find((x) => x.kind === "verbose_error");
  assert.ok(f, "expected verbose_error");
  assert.equal(f.severity, "high");
  assert.ok(
    !/\/home\/deploy/.test(f.evidence ?? ""),
    "an absolute path with a username should be scrubbed",
  );
});

test("verbose_error stays silent on a generic error page", () => {
  const events = noEvents();
  events.responses.push(
    doc({
      status: 500,
      body: "<h1>Something went wrong. Please try again.</h1>",
    }),
  );
  const findings = checkSecurity(events, sec(), obs(), base);
  assert.ok(!findings.some((x) => x.kind === "verbose_error"));
});

// --- additivity --------------------------------------------------------------

test("checkInvariants with NO sec arg is byte-identical to today (additive)", () => {
  const events = noEvents();
  events.responses.push({
    status: 500,
    url: "http://test/api/x",
    method: "GET",
  });
  // Even if security signals WOULD exist, none are checked without sec.
  events.cookies.push(parseSetCookie("session=abc", "http://test/"));
  const without = checkInvariants(events, inv(), obs(), base);
  assert.equal(without.length, 1, "only the http_error fires");
  assert.equal(without[0]!.kind, "http_error");
  assert.ok(
    !without.some((f) =>
      [
        "insecure_headers",
        "insecure_cookie",
        "sensitive_data_exposure",
        "injection_reflection",
        "verbose_error",
      ].includes(f.kind),
    ),
    "no security findings without a sec arg",
  );
});

test("checkInvariants WITH sec appends security findings", () => {
  const events = noEvents();
  events.responses.push(doc()); // html doc missing all required headers
  const findings = checkInvariants(events, inv(), obs(), base, sec());
  assert.ok(findings.some((f) => f.kind === "insecure_headers"));
});

// --- FIX 1: markers must NOT ride in base (no leak into Finding/run.json) ----

test("no Finding carries a markers key and the full marker text never leaks", () => {
  const marker = "<script>secret-mission-text-abc123</script>";
  const events = noEvents();
  // Reflect the marker so checkSecurity definitely produces a Finding from it.
  events.responses.push(doc({ body: `<div>echo: ${marker}</div>` }));
  const findings = checkSecurity(events, sec(), obs(), base, [marker]);
  const f = findings.find((x) => x.kind === "injection_reflection");
  assert.ok(f, "expected a reflection finding from the marker");
  // The Finding object must not carry a `markers` key…
  assert.ok(
    !Object.keys(f).includes("markers"),
    "a Finding must not carry a markers key",
  );
  // …and the full marker text must not appear anywhere in the serialized finding
  // (only the length-redacted snippet may appear).
  assert.ok(
    !JSON.stringify(f).includes(marker),
    "the full marker text must not leak into the finding",
  );
  assert.ok(
    !JSON.stringify(f).includes("secret-mission-text-abc123"),
    "the marker payload must not leak into the finding",
  );
});

// --- FIX 3: verbose_error redacts secrets in its body snippet ----------------

test("verbose_error redacts a DB DSN and a JWT in the leaked body", () => {
  const dsn = "postgresql://app:S3cretPw@db:5432/x";
  const jwt =
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhZG1pbiJ9.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c";
  const events = noEvents();
  events.responses.push(
    doc({
      status: 500,
      url: "http://test/api/boom",
      body: `Traceback (most recent call last):\n  connecting to ${dsn}\n  token=${jwt}`,
    }),
  );
  const findings = checkSecurity(events, sec(), obs(), base);
  const f = findings.find((x) => x.kind === "verbose_error");
  assert.ok(f, "expected verbose_error");
  const ev = f.evidence ?? "";
  assert.ok(!ev.includes("S3cretPw"), "DSN password must be redacted");
  assert.ok(!ev.includes(jwt), "JWT must be redacted");
  assert.match(
    ev,
    /matched python-traceback;/,
    "reports which signature fired",
  );
});

// --- FIX 4: VERBOSE_ERROR_SIGNATURES are structural, not bare words ----------

test("verbose_error does NOT fire on benign 4xx error copy", () => {
  for (const body of [
    `{"detail":"Invalid value on line 3"}`,
    `{"error":"An exception occurred, please retry"}`,
    "Field cannot be of type NoneType",
  ]) {
    const events = noEvents();
    events.responses.push(doc({ status: 400, body }));
    const findings = checkSecurity(events, sec(), obs(), base);
    assert.ok(
      !findings.some((x) => x.kind === "verbose_error"),
      `benign copy must not fire verbose_error: ${body}`,
    );
  }
});

test("verbose_error DOES fire on real traces (python / js frame / SQLSTATE)", () => {
  const realTraces = [
    'Traceback (most recent call last):\n  File "/srv/app/x.py", line 9, in f\n    1/0\nZeroDivisionError: division by zero',
    "TypeError: undefined is not a function\n    at handler (/srv/app/server.js:42:13)",
    'ERROR: column "x" does not exist\nSQLSTATE 42703',
  ];
  for (const body of realTraces) {
    const events = noEvents();
    events.responses.push(doc({ status: 500, body }));
    const findings = checkSecurity(events, sec(), obs(), base);
    assert.ok(
      findings.some((x) => x.kind === "verbose_error"),
      `a real trace must fire verbose_error: ${body.slice(0, 30)}…`,
    );
  }
});

// --- FIX 7: sensitive_data_exposure echoes ZERO secret bytes -----------------

test("sensitive_data_exposure reports only the match LENGTH, no secret bytes", () => {
  const key = "AKIAIOSFODNN7EXAMPLE";
  const events = noEvents();
  events.responses.push(doc({ body: `leaked ${key} here` }));
  const findings = checkSecurity(
    events,
    sec({
      sensitivePatterns: [{ name: "aws-key", pattern: "AKIA[0-9A-Z]{16}" }],
    }),
    obs(),
    base,
  );
  const f = findings.find((x) => x.kind === "sensitive_data_exposure");
  assert.ok(f, "expected sensitive_data_exposure");
  const ev = f.evidence ?? "";
  // Neither the full key nor its first 8 chars may appear.
  assert.ok(!ev.includes(key), "the full key must not appear in evidence");
  assert.ok(
    !ev.includes(key.slice(0, 8)),
    "not even the first 8 chars of the key may appear",
  );
  assert.match(ev, /aws-key: <\d+-char match redacted>/, "length-only form");
});

// --- FIX 8: reflection requires angle brackets / template delims, not quotes -

test("injection_reflection does NOT fire on a reflected quoted string", () => {
  const marker = 'search for "annual report"'; // lone quotes only
  const events = noEvents();
  events.responses.push(doc({ body: `<div>${marker}</div>` }));
  const findings = checkSecurity(events, sec(), obs(), base, [marker]);
  assert.ok(
    !findings.some((x) => x.kind === "injection_reflection"),
    "a quoted string reflected into HTML text is not a reflection finding",
  );
});

test("injection_reflection DOES fire on a reflected angle-bracket payload", () => {
  const marker = "<img src=x>";
  const events = noEvents();
  events.responses.push(doc({ body: `<div>${marker}</div>` }));
  const findings = checkSecurity(events, sec(), obs(), base, [marker]);
  assert.ok(
    findings.some((x) => x.kind === "injection_reflection"),
    "an angle-bracket payload reflected verbatim IS a reflection finding",
  );
});
