/**
 * Oracles decide whether what just happened is a bug. Two families:
 *
 *  1. Invariant oracles — cheap, deterministic checks run after every step
 *     (uncaught exceptions, 5xx responses, console errors, crash signatures).
 *     These catch functional bugs without anyone scripting an assertion.
 *
 *  2. The judge oracle — an LLM call run once at mission end that decides
 *     whether the user's goal was actually met and flags UX/quality issues.
 *     This catches the "it technically worked but was broken/confusing" class.
 */

import type { CapturedEvents, ResponseEvent } from "./browser.js";
import type { LLMClient } from "./agent.js";
import type { Observation } from "./observe.js";
import { renderKnowledge } from "./knowledge.js";
import { pathOf } from "./progress.js";
import type {
  Finding,
  FindingKind,
  Invariants,
  Knowledge,
  Mission,
  Security,
  Severity,
} from "./types.js";

function isIgnored(url: string, ignore: string[]): boolean {
  return ignore.some((sub) => url.includes(sub));
}

/** Playwright resourceTypes for a cosmetic vs a behaviour/style-breaking asset. */
const IMAGE_RESOURCE_TYPES: ReadonlySet<string> = new Set(["image"]);
const CRITICAL_ASSET_RESOURCE_TYPES: ReadonlySet<string> = new Set([
  "script",
  "stylesheet",
]);

/**
 * Findings for sub-resources of the given resourceType(s) that failed to load.
 * Shared by the broken_image (cosmetic) and broken_asset (behaviour/style)
 * oracles — same shape, different resourceType set + severity. Strictly below the
 * http_error threshold (a 5xx asset is owned by http_error), deduped per url, and
 * attributed to the embedding PAGE (obs.url) so crawl-finding attribution keys on
 * the visited route. The failing asset url is preserved in the title + evidence.
 */
function brokenResourceFindings(
  responses: ResponseEvent[],
  inv: Invariants,
  obs: Observation,
  base: { missionId: string; persona: string; repro: string[] },
  spec: {
    resourceTypes: ReadonlySet<string>;
    kind: FindingKind;
    severity: Severity;
    noun: string;
  },
): Finding[] {
  const out: Finding[] = [];
  const threshold = inv.failOnHttpStatusAtLeast;
  const seen = new Set<string>();
  for (const r of responses) {
    if (
      r.resourceType !== undefined &&
      spec.resourceTypes.has(r.resourceType) &&
      r.status >= 400 &&
      r.status < threshold &&
      !isIgnored(r.url, inv.ignoreUrlSubstrings) &&
      !seen.has(r.url)
    ) {
      seen.add(r.url);
      out.push({
        kind: spec.kind,
        severity: spec.severity,
        ...base,
        title: `${spec.noun}: HTTP ${r.status} on ${shortUrl(r.url)}`,
        detail: `A required ${r.resourceType} failed to load (HTTP ${r.status}).`,
        url: obs.url,
        evidence: `${r.method} ${r.url} -> ${r.status} (${r.resourceType})`,
        timestamp: new Date().toISOString(),
      });
    }
  }
  return out;
}

/** Deterministic checks against the events captured during one step. */
export function checkInvariants(
  events: CapturedEvents,
  inv: Invariants,
  obs: Observation,
  base: {
    missionId: string;
    persona: string;
    repro: string[];
  },
  /**
   * Optional security config. When present, the deterministic security oracles
   * (checkSecurity) are appended. Absent → byte-identical to before (existing
   * 4-arg callers and tests are unchanged).
   */
  sec?: Security,
  /**
   * Candidate injection markers (free text the agent typed). Passed THROUGH to
   * checkSecurity for the reflection oracle — never spread into a Finding, so the
   * full typed text can't leak into evidence/run.json (only a redacted snippet
   * may appear). Absent/empty → the reflection oracle has nothing to match.
   */
  markers?: string[],
): Finding[] {
  const findings: Finding[] = [];
  const now = () => new Date().toISOString();

  if (inv.noPageErrors) {
    for (const e of events.pageErrors) {
      findings.push({
        kind: "page_error",
        severity: "critical",
        ...base,
        title: `Uncaught JS exception: ${e.message.slice(0, 80)}`,
        detail: `An unhandled exception fired on the page.`,
        url: e.url,
        evidence: e.stack ?? e.message,
        timestamp: now(),
      });
    }
  }

  const threshold = inv.failOnHttpStatusAtLeast;
  for (const r of events.responses) {
    if (r.status >= threshold && !isIgnored(r.url, inv.ignoreUrlSubstrings)) {
      findings.push({
        kind: "http_error",
        severity: r.status >= 500 ? "high" : "medium",
        ...base,
        title: `HTTP ${r.status} on ${r.method} ${shortUrl(r.url)}`,
        detail: `A network request returned status ${r.status}.`,
        url: r.url,
        evidence: `${r.method} ${r.url} -> ${r.status}`,
        timestamp: now(),
      });
    }
  }

  // dead_link — the page we NAVIGATED to returned 404/410. Strictly ADDITIVE to
  // http_error: only fires BELOW the configured http_error threshold (`r.status <
  // threshold`), so a 404/410 is reported exactly once — by http_error if a strict
  // profile lowered the threshold to <= it, otherwise by dead_link. Scoped to the
  // landed DOCUMENT (a GET whose pathname equals the page's, via the same pathOf
  // the engine uses) so a 404 sub-resource (an optional asset, an XHR probe) never
  // trips. A DELIBERATELY-404 route is silenced via ignoreUrlSubstrings or a
  // baseline fingerprint mute (it would otherwise re-fire every run).
  const landedPath = pathOf(obs.url);
  for (const r of events.responses) {
    if (
      r.method === "GET" &&
      r.status < threshold &&
      (r.status === 404 || r.status === 410) &&
      pathOf(r.url) === landedPath &&
      !isIgnored(r.url, inv.ignoreUrlSubstrings)
    ) {
      findings.push({
        kind: "dead_link",
        severity: "medium",
        ...base,
        title: `Dead link: HTTP ${r.status} on ${shortUrl(r.url)}`,
        detail: `Navigating here returned HTTP ${r.status} (${r.status === 404 ? "Not Found" : "Gone"}) — a broken route or dead link.`,
        url: r.url,
        evidence: `GET ${r.url} -> ${r.status}`,
        timestamp: now(),
      });
      break;
    }
  }

  // broken sub-resources — an asset the page referenced that failed to load
  // (resourceType match, 400 <= status < threshold). dead_link is scoped to the
  // landed DOCUMENT and http_error only fires >= the (500-default) threshold, so a
  // 4xx asset would otherwise be invisible. Kept strictly BELOW the http_error
  // threshold so a 5xx asset is owned once by http_error, never double-reported.
  // A broken IMAGE is cosmetic (low); a broken SCRIPT/STYLESHEET breaks behaviour
  // or styling (medium). Attributed to the embedding PAGE (obs.url) so coverage /
  // baseline / self-eval keys on the visited route; the asset url stays in
  // title+evidence. Fires for CROSS-ORIGIN assets too (a broken third-party/CDN
  // asset is still a defect ON the page); silence a known-noisy one (a tracking
  // pixel/beacon) via ignoreUrlSubstrings.
  findings.push(
    ...brokenResourceFindings(events.responses, inv, obs, base, {
      resourceTypes: IMAGE_RESOURCE_TYPES,
      kind: "broken_image",
      severity: "low",
      noun: "Broken image",
    }),
    ...brokenResourceFindings(events.responses, inv, obs, base, {
      resourceTypes: CRITICAL_ASSET_RESOURCE_TYPES,
      kind: "broken_asset",
      severity: "medium",
      noun: "Broken asset",
    }),
  );

  // accessibility — deterministic WCAG checks from the observe() DOM scan (no
  // page access here; observe collects the signals). v1 rule: a rendered <img>
  // with no alt attribute (WCAG 1.1.1). ONE finding per page (the count + sample
  // srcs live in detail/evidence; the title omits the count so the cross-run
  // fingerprint stays stable). Low severity — an access barrier, not a functional
  // break — so it surfaces in the report without gating. Mute a page of known,
  // accepted a11y debt via the baseline. A future a11y rule keeps this kind but
  // (because rules share `accessibility`) needs its OWN single-signal fixture
  // route, else the meta-eval covers it but can't see it break (shadowed).
  const missingAlt = obs.a11y?.imagesMissingAlt;
  if (missingAlt && missingAlt.total > 0) {
    findings.push({
      kind: "accessibility",
      severity: "low",
      ...base,
      title: `Accessibility: image missing alt text`,
      detail: `${missingAlt.total} rendered image(s) have no alt attribute (WCAG 1.1.1) — a screen reader cannot describe them.`,
      url: obs.url,
      evidence: missingAlt.samples.join(", ").slice(0, 500),
      timestamp: now(),
    });
  }
  // Rule 2: an interactive control (button/link) with no accessible name (WCAG
  // 4.1.2) — the icon-only-button-with-no-aria-label case. Separate title (so it
  // is a distinct finding from the image rule) but the same kind; its own fixture
  // route (/a11y-button) is what lets the per-case self-eval gate it.
  const noName = obs.a11y?.controlsMissingName;
  if (noName && noName.total > 0) {
    findings.push({
      kind: "accessibility",
      severity: "low",
      ...base,
      title: `Accessibility: control with no accessible name`,
      detail: `${noName.total} interactive control(s) (button/link) have no accessible name (WCAG 4.1.2) — a screen reader user cannot tell what they do.`,
      url: obs.url,
      evidence: noName.samples.join(", ").slice(0, 500),
      timestamp: now(),
    });
  }
  // Rule 3: a form field (input/select/textarea) with no label. Distinct title
  // from the other a11y rules; same kind; its own fixture route (/a11y-input).
  const noLabel = obs.a11y?.fieldsMissingLabel;
  if (noLabel && noLabel.total > 0) {
    findings.push({
      kind: "accessibility",
      severity: "low",
      ...base,
      title: `Accessibility: form field with no label`,
      detail: `${noLabel.total} form field(s) have no label (WCAG 4.1.2 / 3.3.2) — no <label>, aria-label, title, or placeholder, so a screen reader user cannot tell what to enter.`,
      url: obs.url,
      evidence: noLabel.samples.join(", ").slice(0, 500),
      timestamp: now(),
    });
  }
  // Rule 4: a <label for="x"> whose target id doesn't exist. Distinct title; own
  // fixture route (/a11y-orphan) so the per-case recall gates it.
  const orphan = obs.a11y?.orphanLabels;
  if (orphan && orphan.total > 0) {
    findings.push({
      kind: "accessibility",
      severity: "low",
      ...base,
      title: `Accessibility: label points to a missing id`,
      detail: `${orphan.total} <label for="…"> point(s) to an id that does not exist (WCAG 1.3.1) — the label is associated with nothing, so clicking it focuses no field and a screen reader announces no name.`,
      url: obs.url,
      evidence: orphan.samples.join(", ").slice(0, 500),
      timestamp: now(),
    });
  }

  // duplicate_id — element ids that appear more than once (from the observe DOM
  // scan). A spec violation that silently breaks <label for> / getElementById /
  // aria-labelledby / fragment links (all resolve to the first match). One finding
  // per page; the count-free title keeps the cross-run fingerprint stable.
  const dupIds = obs.dom?.duplicateIds;
  if (dupIds && dupIds.total > 0) {
    findings.push({
      kind: "duplicate_id",
      severity: "low",
      ...base,
      title: `Duplicate element id`,
      detail: `${dupIds.total} id value(s) appear more than once in the document — <label for>, getElementById, aria-labelledby and #fragment links silently resolve to the first match only.`,
      url: obs.url,
      evidence: dupIds.samples.join(", ").slice(0, 500),
      timestamp: now(),
    });
  }

  if (inv.noConsoleErrors) {
    for (const c of events.console) {
      if (isIgnored(c.url, inv.ignoreUrlSubstrings)) continue;
      if (isIgnored(c.text, inv.ignoreConsoleSubstrings)) continue;
      findings.push({
        kind: "console_error",
        severity: "low",
        ...base,
        title: `Console error: ${c.text.slice(0, 80)}`,
        detail: `The page logged a console error.`,
        url: c.url,
        evidence: c.text,
        timestamp: now(),
      });
    }
  }

  for (const sig of inv.bodyErrorSignatures) {
    if (obs.visibleText.includes(sig)) {
      findings.push({
        kind: "body_error_signature",
        severity: "high",
        ...base,
        title: `Crash signature on page: "${sig}"`,
        detail: `The visible page text contains a known error/crash marker.`,
        url: obs.url,
        evidence: sig,
        timestamp: now(),
      });
      break;
    }
  }

  if (sec) findings.push(...checkSecurity(events, sec, obs, base, markers));

  return findings;
}

/** A JWT in any response body, regardless of profile config — a common leak. */
const JWT_RE = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/;

/**
 * HTML/template metacharacters that make an echoed marker a reflection risk.
 * Lone quotes are NOT a risk on their own — benign text like `search for "x"`
 * reflected into HTML TEXT content is not XSS — so the angle brackets / template
 * delimiters are what we require (an attribute-context quote-break still needs a
 * `<` somewhere in a real payload).
 */
function hasMetacharacter(s: string): boolean {
  return (
    s.includes("<") || s.includes(">") || s.includes("${") || s.includes("{{")
  );
}

/**
 * Error-body signatures that indicate a real leaked stack trace / framework
 * internals. STRUCTURAL only — bare single-word matchers (Exception, KeyError,
 * NoneType, " line N") fire on benign 4xx copy ("An exception occurred", "Invalid
 * value on line 3") and were dropped. Each pattern here requires the shape of an
 * actual trace/typed-exception/DB-error, not just the presence of a scary word.
 */
export const VERBOSE_ERROR_SIGNATURES: { name: string; re: RegExp }[] = [
  { name: "python-traceback", re: /Traceback \(most recent call last\)/ },
  { name: "python-frame", re: /File "\/[^"]*", line \d+/ },
  { name: "js-stack-frame", re: /\bat \S+ \(.*:\d+:\d+\)/ },
  { name: "typed-exception", re: /\b\w*(Error|Exception): / },
  { name: "sqlstate", re: /SQLSTATE/ },
  { name: "sqlalchemy", re: /sqlalchemy/i },
  { name: "psycopg", re: /psycopg/i },
  { name: "python-nonetype", re: /'NoneType' object/ },
  { name: "java-exception", re: /org\.\w+(\.\w+)*\.\w*(Exception|Error)/ },
  { name: "go-goroutine", re: /goroutine \d+ \[/ },
];

/** Report a matched secret by LENGTH only — echo ZERO of its bytes. */
function redactSnippet(secret: string): string {
  return `<${secret.length}-char match redacted>`;
}

/**
 * Built-in secret shapes redacted out of a free-text excerpt (e.g. a verbose
 * error body) before it is stored as evidence. These are independent of the
 * profile's sensitivePatterns and catch the common credential leaks a stack
 * trace / DB error tends to spill: connection URLs with embedded creds, query
 * params / form fields named password/secret, bearer tokens, and PEM keys.
 */
const SECRET_SHAPES: { name: string; re: RegExp }[] = [
  { name: "connection-url-creds", re: /\w+:\/\/[^/\s:@]+:[^/\s@]+@/g },
  { name: "password", re: /password=\S+/gi },
  { name: "secret", re: /secret=\S+/gi },
  { name: "bearer-token", re: /Authorization:\s*Bearer\s+\S+/gi },
  {
    name: "private-key",
    re: /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g,
  },
];

/**
 * Redact secrets out of a free-text excerpt: the profile's configured
 * sensitivePatterns + the built-in JWT regex + the built-in SECRET_SHAPES, each
 * match replaced with "[redacted]". scrubPaths is applied as defense-in-depth.
 * Returns the redacted text plus the names of the signatures that matched (for
 * an "evidence: matched <sig>; …" prefix).
 */
export function redactSecrets(
  text: string,
  sensitivePatterns: Security["sensitivePatterns"],
): { redacted: string; matched: string[] } {
  const matched: string[] = [];
  let out = text;
  const configured = sensitivePatterns
    .map((p) => {
      try {
        return { name: p.name, re: new RegExp(p.pattern, "g") };
      } catch {
        return null; // skip an invalid regex rather than throw
      }
    })
    .filter((x): x is { name: string; re: RegExp } => x !== null);
  const shapes = [
    ...configured,
    { name: "jwt", re: new RegExp(JWT_RE.source, "g") },
    ...SECRET_SHAPES,
  ];
  for (const { name, re } of shapes) {
    if (re.test(out)) {
      matched.push(name);
      out = out.replace(re, "[redacted]");
    }
  }
  return { redacted: scrubPaths(out), matched };
}

/** Strip an absolute path that embeds a username (…/home/<user>/… or /Users/<user>/…). */
function scrubPaths(s: string): string {
  return s
    .replace(/\/(?:home|Users)\/[^/\s"']+/g, "/$1/[user]")
    .replace(/[A-Za-z]:\\Users\\[^\\\s"']+/g, "C:\\Users\\[user]");
}

function isDocumentResponse(r: ResponseEvent): boolean {
  if (r.method !== "GET" || !r.headers) return false;
  const ct = (r.headers["content-type"] ?? "").toLowerCase();
  return ct.includes("text/html");
}

/**
 * Deterministic security oracles. Pure — mirrors checkInvariants. Each oracle
 * has an exact, non-LLM signal; secrets are always redacted in evidence. Does
 * NOT cover missing_authn / broken_authz (those come from the authz differential
 * in matrix.ts, which needs cross-variant reach to assert).
 */
export function checkSecurity(
  events: CapturedEvents,
  sec: Security,
  obs: Observation,
  base: {
    missionId: string;
    persona: string;
    repro: string[];
  },
  /**
   * Candidate injection markers for the reflection oracle. Kept OUT of `base`
   * (and thus out of every Finding) so the raw typed text never leaks — only a
   * redacted snippet may appear in injection_reflection evidence.
   */
  markers?: string[],
): Finding[] {
  const findings: Finding[] = [];
  const now = () => new Date().toISOString();
  const sameOrigin = (url: string): boolean => {
    try {
      return new URL(url).origin === new URL(obs.url).origin;
    } catch {
      return false;
    }
  };

  // insecure_headers — a top-level document missing required security headers.
  const required = sec.requiredHeaders.map((h) => h.toLowerCase());
  for (const r of events.responses) {
    if (!isDocumentResponse(r)) continue;
    if (!sameOrigin(r.url)) continue;
    if (isIgnored(r.url, sec.ignoreReflectionPaths)) continue;
    const present = new Set(
      Object.keys(r.headers ?? {}).map((k) => k.toLowerCase()),
    );
    const missing = required.filter((h) => !present.has(h));
    if (missing.length) {
      findings.push({
        kind: "insecure_headers",
        severity: "medium",
        ...base,
        title: `Missing security headers on ${shortUrl(r.url)}`,
        detail: `The document response is missing required security header(s): ${missing.join(", ")}.`,
        url: r.url,
        evidence: `missing: ${missing.join(", ")}`,
        timestamp: now(),
      });
    }
  }

  // insecure_cookie — a declared session cookie without HttpOnly/Secure/SameSite.
  for (const c of events.cookies) {
    if (!sec.sessionCookieNames.includes(c.name)) continue;
    if (c.httpOnly && c.secure && c.sameSite) continue;
    const missingAttrs: string[] = [];
    if (!c.httpOnly) missingAttrs.push("HttpOnly");
    if (!c.secure) missingAttrs.push("Secure");
    if (!c.sameSite) missingAttrs.push("SameSite");
    findings.push({
      kind: "insecure_cookie",
      severity: "medium",
      ...base,
      title: `Insecure session cookie "${c.name}" (missing ${missingAttrs.join(", ")})`,
      detail: `The session cookie "${c.name}" is missing the attribute(s): ${missingAttrs.join(", ")}.`,
      url: c.url,
      evidence: `missing: ${missingAttrs.join(", ")}`,
      timestamp: now(),
    });
  }

  // sensitive_data_exposure — a secret/JWT in a captured response body.
  const compiled = sec.sensitivePatterns
    .map((p) => {
      try {
        return { name: p.name, re: new RegExp(p.pattern) };
      } catch {
        return null; // skip an invalid regex rather than throw
      }
    })
    .filter((x): x is { name: string; re: RegExp } => x !== null);
  const patterns = [...compiled, { name: "jwt", re: JWT_RE }];
  for (const r of events.responses) {
    if (!r.body) continue;
    for (const p of patterns) {
      const m = r.body.match(p.re);
      if (m) {
        findings.push({
          kind: "sensitive_data_exposure",
          severity: "high",
          ...base,
          title: `Sensitive data in response (${p.name}) on ${shortUrl(r.url)}`,
          detail: `A response body matched the sensitive pattern "${p.name}". The value is redacted below.`,
          url: r.url,
          evidence: `${p.name}: ${redactSnippet(m[0])}`,
          timestamp: now(),
        });
      }
    }
  }

  // injection_reflection — a metacharacter marker echoed un-escaped in HTML.
  const reflectionMarkers = (markers ?? []).filter(hasMetacharacter);
  for (const r of events.responses) {
    if (!r.body) continue;
    if (!sameOrigin(r.url)) continue;
    if (isIgnored(r.url, sec.ignoreReflectionPaths)) continue;
    const ct = (r.headers?.["content-type"] ?? "").toLowerCase();
    if (!ct.includes("text/html")) continue;
    for (const marker of reflectionMarkers) {
      if (r.body.includes(marker)) {
        findings.push({
          kind: "injection_reflection",
          severity: "high",
          ...base,
          title: `Unescaped reflection of injected marker on ${shortUrl(r.url)}`,
          detail:
            `A crafted marker containing HTML/template metacharacters was reflected VERBATIM (un-escaped) ` +
            `into an HTML response — an XSS / template-injection surface.`,
          url: r.url,
          evidence: `reflected marker (redacted): ${redactSnippet(marker)}`,
          timestamp: now(),
        });
      }
    }
  }

  // verbose_error — an error response leaking a stack trace / framework internals.
  for (const r of events.responses) {
    if (r.status < 400 || !r.body) continue;
    const sig = VERBOSE_ERROR_SIGNATURES.find((s) => s.re.test(r.body!));
    if (sig) {
      // Redact any secret (configured patterns, JWT, connection-url creds,
      // password=/secret=, bearer tokens, PEM keys) out of the excerpt BEFORE it
      // is stored, so a DSN or token spilled into the trace can't leak.
      const { redacted } = redactSecrets(r.body.slice(0, 200), [
        ...sec.sensitivePatterns,
      ]);
      findings.push({
        kind: "verbose_error",
        severity: "high",
        ...base,
        title: `Verbose error leaks internals on ${shortUrl(r.url)}`,
        detail: `An error response (HTTP ${r.status}) leaked a stack trace / SQL / framework internals.`,
        url: r.url,
        evidence: `matched ${sig.name}; ${redacted}`,
        timestamp: now(),
      });
    }
  }

  return findings;
}

interface JudgeVerdict {
  goalMet: boolean;
  severity: Severity;
  issues: string[];
  /** Data-model + UI consistency defects (distinct from generic UX issues). */
  inconsistencies: string[];
  rationale: string;
}

/** LLM end-of-mission verdict: did the user accomplish the goal, any UX issues. */
export async function judgeMission(
  llm: LLMClient,
  mission: Mission,
  finalObs: Observation,
  history: string[],
  base: { missionId: string; persona: string; repro: string[] },
  knowledge?: Knowledge,
  /**
   * Extra "do NOT flag" exclusions beyond knowledge.gotchas — operator-vetted
   * muted findings (baseline.mutedExclusions). This is the mute→judge bridge:
   * once a human marks a finding a non-bug, the judge stops re-emitting it every
   * run. Optional + appended, so a profile with no muted notes keeps the prompt
   * byte-identical to before.
   */
  extraExclusions?: string[],
): Promise<Finding[]> {
  const prompt = [
    `You are a QA reviewer judging whether a simulated user accomplished their goal.`,
    ``,
    `GOAL: ${mission.goal}`,
    mission.successCriteria.length
      ? `SUCCESS CRITERIA:\n- ${mission.successCriteria.join("\n- ")}`
      : ``,
    ``,
    `ACTIONS TAKEN:\n${history.map((h, i) => `${i + 1}. ${h}`).join("\n")}`,
    ``,
    `FINAL PAGE TEXT:\n${finalObs.visibleText.slice(0, 1500)}`,
    ``,
    `Judge against the screenshot too. Respond with ONLY a JSON object:`,
    `{"goalMet": boolean, "severity": "critical"|"high"|"medium"|"low", "issues": string[], "inconsistencies": string[], "rationale": string}`,
    `"issues" lists UX or quality problems even if the goal was met (confusing flow, slow, wrong output, broken layout).`,
    `"inconsistencies" lists places the app presents the SAME data or UI inconsistently — report only contradictions you can actually see, with the two conflicting values. Examples: a count/stat that doesn't match the rows or items actually shown ("12 runs" but 8 rows); the same entity showing a different value or status across views (a run "success" in the list but "failed" on its detail); a value attributed differently in two places (a run's model "gpt-4o" here, "claude" there); mixed formatting of the same data type on one page (dates as "2026-06-20" and "Jun 20, 2026"); the same concept labeled with different terms ("Runs" vs "Executions"); inconsistent component styling/state for equivalent controls. Empty array if you see none — do not speculate.`,
    `Do NOT report development-only framework chrome as a product defect: a small "N Issue(s)" error-count badge in a corner is the dev toolbar/overlay, and hydration/console warnings shown only in dev builds are not user-facing bugs. Judge the product, not the dev environment.`,
    knowledge ? renderKnowledge(knowledge, { forJudge: true }) : ``,
    extraExclusions && extraExclusions.length
      ? `ADDITIONALLY, do NOT flag these — they have been triaged as known non-bugs:\n${extraExclusions
          .map((e) => `- ${e}`)
          .join("\n")}`
      : ``,
  ]
    .filter(Boolean)
    .join("\n");

  const raw = await llm.judge(prompt, finalObs.screenshotBase64);
  const verdict = parseVerdict(raw);
  const findings: Finding[] = [];
  const now = new Date().toISOString();

  if (!verdict.goalMet) {
    findings.push({
      kind: "goal_failed",
      severity: verdict.severity === "low" ? "medium" : verdict.severity,
      ...base,
      title: `Goal not accomplished: ${mission.goal.slice(0, 70)}`,
      detail: verdict.rationale,
      url: finalObs.url,
      screenshotPath: undefined,
      evidence: verdict.issues.join("; "),
      timestamp: now,
    });
  }

  // Consolidate the judge's free-text issues into ONE ux_issue instead of
  // fanning out one finding per string (which produced near-identical noise).
  // When the goal already failed, drop issues that merely restate that failure,
  // since the goal_failed finding already carries them.
  const issues = verdict.goalMet
    ? verdict.issues
    : verdict.issues.filter(
        (issue) => !restatesGoalFailure(issue, mission.goal, verdict.rationale),
      );

  if (issues.length) {
    const top = issues.slice(0, MAX_UX_ISSUES);
    const more = issues.length - top.length;
    const detail = [
      ...top.map((issue) => `• ${issue}`),
      ...(more > 0 ? [`• …and ${more} more`] : []),
    ].join("\n");
    findings.push({
      kind: "ux_issue",
      severity: verdict.goalMet ? "low" : "medium",
      ...base,
      title:
        issues.length === 1
          ? `UX/quality issue`
          : `${issues.length} UX/quality issues`,
      detail,
      // Full list kept in evidence so run.json retains every issue even when the
      // human-readable detail truncates to the top few.
      evidence: issues.join("\n"),
      url: finalObs.url,
      timestamp: now,
    });
  }

  // Data-model + UI consistency defects, consolidated like ux_issue. Kept as a
  // distinct kind (not folded into ux_issue) so "the app contradicts its own
  // data" is triaged and baseline-tracked separately from generic UX polish.
  if (verdict.inconsistencies.length) {
    const top = verdict.inconsistencies.slice(0, MAX_UX_ISSUES);
    const more = verdict.inconsistencies.length - top.length;
    const detail = [
      ...top.map((i) => `• ${i}`),
      ...(more > 0 ? [`• …and ${more} more`] : []),
    ].join("\n");
    findings.push({
      kind: "inconsistency",
      severity: "medium",
      ...base,
      title:
        verdict.inconsistencies.length === 1
          ? `Data/UI inconsistency`
          : `${verdict.inconsistencies.length} data/UI inconsistencies`,
      detail,
      evidence: verdict.inconsistencies.join("\n"),
      url: finalObs.url,
      timestamp: now,
    });
  }

  return findings;
}

/** Max issues listed in a consolidated ux_issue before the rest are summarized. */
const MAX_UX_ISSUES = 5;

/**
 * True when a judge issue is just a paraphrase of the goal failure (so the
 * goal_failed finding already conveys it). Deterministic token-overlap check:
 * if most of the issue's significant words also appear in the goal or the
 * judge's rationale, treat it as redundant.
 */
function restatesGoalFailure(
  issue: string,
  goal: string,
  rationale: string,
): boolean {
  const issueWords = significantWords(issue);
  // Too few significant words to judge overlap reliably — keep it rather than
  // risk suppressing a short but genuinely distinct issue whose 2-3 words
  // happen to appear in the goal/rationale.
  if (issueWords.length < 4) return false;
  const haystack = new Set(significantWords(`${goal} ${rationale}`));
  const overlap = issueWords.filter((w) => haystack.has(w)).length;
  return overlap / issueWords.length >= 0.7;
}

function significantWords(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

const STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "was",
  "were",
  "not",
  "but",
  "with",
  "this",
  "that",
  "could",
  "have",
  "has",
  "had",
  "are",
  "did",
  "does",
  "user",
  "able",
  "unable",
  "page",
]);

function parseVerdict(raw: string): JudgeVerdict {
  try {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    const json = JSON.parse(raw.slice(start, end + 1));
    return {
      goalMet: Boolean(json.goalMet),
      severity: ["critical", "high", "medium", "low"].includes(json.severity)
        ? json.severity
        : "medium",
      issues: Array.isArray(json.issues) ? json.issues.map(String) : [],
      inconsistencies: Array.isArray(json.inconsistencies)
        ? json.inconsistencies.map(String)
        : [],
      rationale: String(json.rationale ?? ""),
    };
  } catch {
    return {
      goalMet: false,
      severity: "medium",
      issues: [],
      inconsistencies: [],
      rationale: `Could not parse judge response: ${raw.slice(0, 200)}`,
    };
  }
}

function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname.slice(0, 60);
  } catch {
    return url.slice(0, 60);
  }
}
