/**
 * Finding identity + within-run collapse, used by engine.ts to dedupe findings
 * as they accumulate (a console error re-thrown every step on a broken page
 * collapses to one Finding with `occurrences` bumped). Imports only the Finding
 * type — no engine/report/oracles import, so no cycle.
 */

import type { Finding } from "./types.js";

/**
 * Stable identity for a finding: kind + a normalized title. Only a trailing
 * loop-count badge ("(×3)") is stripped, so a finding whose count moves across
 * steps still collapses. Digits that carry meaning (an HTTP status, a resource
 * id, an error line number) are PRESERVED — otherwise "HTTP 500 on GET /x" and
 * "HTTP 404 on GET /x" would wrongly merge and the second (possibly more severe)
 * finding would be lost. Deliberately NOT keyed on url/timestamp/evidence — the
 * title is the canonical one-line identity.
 */
export function findingFingerprint(f: Finding): string {
  const stem = f.title
    .replace(/\(×\s*\d+\)/g, "") // strip the "(×3)" loop-count badge only
    .replace(/\s+/g, " ") // normalize whitespace left by the removal
    .trim();
  return `${f.kind}|${stem}`;
}

/**
 * Cross-run identity for the known-bugs baseline. Like findingFingerprint, but
 * also collapses VOLATILE ids — UUIDs, long hex, and 4+-digit runs — to "[id]",
 * so the same bug recurs under one key across runs even when its title embeds a
 * resource id (e.g. "HTTP 500 on GET /api/documents/<uuid>"). Short numbers like
 * a 3-digit HTTP status are preserved, so a 500 and a 404 stay distinct.
 */
export function baselineFingerprint(f: Finding): string {
  const stem = f.title
    .replace(/\(×\s*\d+\)/g, "")
    .replace(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
      "[id]",
    )
    .replace(/[0-9a-f]{16,}/gi, "[id]")
    .replace(/\d{4,}/g, "[id]")
    .replace(/\s+/g, " ")
    .trim();
  return `${f.kind}|${stem}`;
}

/**
 * Push `f`, or — if a finding with the same fingerprint was already recorded —
 * bump that earlier finding's `occurrences` and drop the duplicate. The kept
 * finding retains its first-occurrence url/screenshot/evidence (the collapsed
 * occurrences are identical by construction of the fingerprint). `seen` maps
 * fingerprint -> the recorded Finding and must be scoped to one mission so
 * counts don't leak across missions.
 */
export function recordFinding(
  findings: Finding[],
  seen: Map<string, Finding>,
  f: Finding,
): void {
  const key = findingFingerprint(f);
  const existing = seen.get(key);
  if (existing) {
    existing.occurrences = (existing.occurrences ?? 1) + 1;
    return;
  }
  seen.set(key, f);
  findings.push(f);
}
