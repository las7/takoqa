/**
 * Server-log correlation — attach the app's own server-side traceback to a
 * client-observed failure.
 *
 * A 5xx / crash finding tells you the request blew up but not WHY; the cause is
 * in the server log, which a human otherwise greps by hand (the one triage step
 * that stayed manual). This reads a configured log source and, for each
 * server-side failure finding, splices in the log lines around that request — so
 * the finding carries the real stack trace and a triager (or the baseline
 * classifier) can tell a genuine 5xx from an environment/config drift at a glance.
 *
 * Product-AGNOSTIC mechanism, app-SPECIFIC source: the engine correlates by the
 * failing request's path; the profile says where the log lives (a file, or a
 * command like a container `logs` / `tmux capture-pane`). Purely additive and
 * best-effort: no source configured ⇒ behaviour is byte-identical to before, and
 * any read/parse failure leaves findings untouched.
 *
 * correlateServerLog / correlateReport are PURE (log text in, enriched findings
 * out); readServerLog does the IO (injected for tests). Secrets in the spliced
 * excerpt are redacted via the same redactSecrets the oracles use.
 */

import { execSync } from "node:child_process";
import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";

import { redactSecrets, VERBOSE_ERROR_SIGNATURES } from "./oracles.js";
import type {
  Finding,
  FindingKind,
  RunReport,
  Security,
  ServerLogSource,
} from "./types.js";

/**
 * Finding kinds whose `url` is the FAILING SERVER REQUEST (so the server log
 * will have its traceback): a 5xx, a verbose error body, and an SSR crash page.
 * `page_error` is deliberately excluded — it is a CLIENT-side JS exception whose
 * url is the page location, not a request the server logged.
 */
const CORRELATE_KINDS = new Set<FindingKind>([
  "http_error",
  "verbose_error",
  "body_error_signature",
]);

/** Generic crash markers (the body-error signatures) on top of the trace shapes. */
const CRASH_MARKERS =
  /Internal Server Error|Application error|Unhandled Runtime Error/i;

/** Whether a log window actually contains a stack trace / typed exception / crash
 *  marker — the bar for splicing it in. A window with no such signal (e.g. only
 *  benign request lines) adds noise, not signal, so it is rejected. */
function hasErrorSignature(text: string): boolean {
  return (
    VERBOSE_ERROR_SIGNATURES.some((s) => s.re.test(text)) ||
    CRASH_MARKERS.test(text)
  );
}

/** A log line references `path` as a whole URL token (exact route) — not as a
 *  substring, so `/agent` never matches `/agent/personas` or `/agentic`. Query
 *  string + trailing punctuation are stripped from each whitespace-token. */
function lineHasPath(line: string, path: string): boolean {
  for (const tok of line.split(/\s+/)) {
    const t = tok
      .split("?")[0]!
      .split("#")[0]!
      .replace(/[)\]",.;:]+$/, "");
    if (t === path) return true;
  }
  return false;
}

/** Lines of log context to splice around the matched request line. */
const CONTEXT_BEFORE = 3;
const CONTEXT_AFTER = 14;
/** Hard cap on the spliced excerpt, so one finding can't carry a whole log. */
const MAX_EXCERPT_CHARS = 1600;
/** Tail this many bytes of a log file — a run's errors are always at the end. */
const TAIL_BYTES = 256 * 1024;

/** The request path a finding is about (pathname only), or "" if not useful. */
function findingPath(url: string): string {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    path = url.split("?")[0]!.split("#")[0]!;
  }
  // "/" (or empty) matches every log line — too generic to anchor on.
  return path.length > 1 ? path : "";
}

/**
 * The log excerpt for a request path: scanning from the end (most recent first),
 * the window around the latest line that references the path AS A WHOLE URL TOKEN
 * AND whose window actually contains an error signature. Returns null otherwise —
 * so a finding only ever gets an excerpt that genuinely carries a trace, never a
 * benign run of 200-OK lines that merely mention the path. Pure.
 */
export function excerptForPath(
  logLines: string[],
  path: string,
): string | null {
  if (!path) return null;
  for (let i = logLines.length - 1; i >= 0; i--) {
    if (!lineHasPath(logLines[i]!, path)) continue;
    const from = Math.max(0, i - CONTEXT_BEFORE);
    const to = Math.min(logLines.length, i + CONTEXT_AFTER + 1);
    const window = logLines.slice(from, to).join("\n");
    if (hasErrorSignature(window)) return window.slice(0, MAX_EXCERPT_CHARS);
  }
  return null;
}

/**
 * Enrich each server-side failure finding with the correlated server-log excerpt
 * (redacted), appended to its evidence. Pure: same findings out, with evidence
 * extended only where a path match was found. Non-server-side kinds and findings
 * with no log match are returned unchanged.
 */
export function correlateServerLog(
  findings: Finding[],
  logText: string,
  sensitivePatterns: Security["sensitivePatterns"] = [],
): Finding[] {
  const lines = logText.split("\n");
  return findings.map((f) => {
    if (!CORRELATE_KINDS.has(f.kind)) return f;
    const excerpt = excerptForPath(lines, findingPath(f.url));
    if (!excerpt) return f;
    const { redacted } = redactSecrets(excerpt, sensitivePatterns);
    const tag = `--- correlated server log ---\n${redacted}`;
    return { ...f, evidence: f.evidence ? `${f.evidence}\n${tag}` : tag };
  });
}

/** Apply correlateServerLog across every mission's findings in a report. Pure. */
export function correlateReport(
  report: RunReport,
  logText: string,
  sensitivePatterns: Security["sensitivePatterns"] = [],
): RunReport {
  return {
    ...report,
    results: report.results.map((r) => ({
      ...r,
      findings: correlateServerLog(r.findings, logText, sensitivePatterns),
    })),
  };
}

/** Injected IO for testability (default: real fs/exec). */
export interface ServerLogDeps {
  readFileTail?: (path: string, maxBytes: number) => string;
  runCommand?: (command: string) => string;
}

/** Read the tail of a file (last maxBytes), tolerant of a missing/huge file. */
function defaultReadFileTail(path: string, maxBytes: number): string {
  const size = statSync(path).size;
  if (size <= maxBytes) return readFileSync(path, "utf8");
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(maxBytes);
    readSync(fd, buf, 0, maxBytes, size - maxBytes);
    return buf.toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/**
 * Read the configured server-log source to a string. Best-effort: any failure
 * (missing file, command error) returns "" so correlation is simply skipped.
 * The command path runs a shell command from the profile — the same trust model
 * as the existing resetCommand (operator's own local profile).
 */
export function readServerLog(
  source: ServerLogSource,
  deps: ServerLogDeps = {},
): string {
  try {
    if (source.kind === "file") {
      const tail = deps.readFileTail ?? defaultReadFileTail;
      return tail(source.path, TAIL_BYTES);
    }
    const run =
      deps.runCommand ??
      ((command: string) => {
        // A `docker logs` / `tmux capture-pane` may emit far more than the tail
        // we keep — give execSync a generous buffer (so it doesn't ENOBUFS and
        // silently yield nothing) and tail the result ourselves.
        const out = execSync(command, {
          encoding: "utf8",
          maxBuffer: 64 * 1024 * 1024,
          stdio: ["ignore", "pipe", "ignore"],
        });
        return out.length > TAIL_BYTES
          ? out.slice(out.length - TAIL_BYTES)
          : out;
      });
    return run(source.command);
  } catch {
    return ""; // best-effort: no correlation rather than a failed run
  }
}
