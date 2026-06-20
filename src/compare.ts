/**
 * compareRuns — diff two saved runs by finding identity. Deterministic, no LLM.
 *
 * Two uses:
 *   - Regression gate: diff a BEFORE run against an AFTER run (e.g. before/after
 *     a fix) and fail CI if AFTER introduced findings.
 *   - Environment diff: run the same profile against two `--base-url`s (local vs
 *     prod, prod vs preview) and see what differs — "fixed locally but still live
 *     in prod" (deploy lag) shows up as a `fixed` here, "only in prod" as `added`.
 *
 * Findings are keyed by baselineFingerprint (kind + normalized title, with
 * volatile ids/uuids stripped — see findings.ts), so "the same bug" matches
 * across runs even when its title embeds a URL or resource id. We reuse that key
 * rather than inventing a second identity, so compare agrees with the baseline.
 *
 *   fixed     — in BEFORE, absent in AFTER
 *   added     — in AFTER, absent in BEFORE (a regression, or AFTER-env-only)
 *   unchanged — present in both
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Finding } from "./types.js";
import { baselineFingerprint } from "./findings.js";

export interface RunDiff {
  fixed: Finding[];
  added: Finding[];
  unchanged: Finding[];
}

/**
 * Read the flattened findings from a run directory or its run.json directly.
 * Accepts either `runs/<profile>-<ts>` or `runs/<profile>-<ts>/run.json`.
 */
export function loadRunFindings(runPath: string): Finding[] {
  const file = runPath.endsWith(".json") ? runPath : join(runPath, "run.json");
  const parsed = JSON.parse(readFileSync(file, "utf8")) as {
    results?: Array<{ findings?: Finding[] }>;
  };
  return (parsed.results ?? []).flatMap((r) => r.findings ?? []);
}

/**
 * Diff two finding sets by baselineFingerprint. One representative finding per
 * key (the first occurrence) — matching how the baseline collapses duplicates.
 */
export function compareRuns(before: Finding[], after: Finding[]): RunDiff {
  const index = (fs: Finding[]): Map<string, Finding> => {
    const m = new Map<string, Finding>();
    for (const f of fs) {
      const k = baselineFingerprint(f);
      if (!m.has(k)) m.set(k, f);
    }
    return m;
  };
  const a = index(before);
  const b = index(after);

  const fixed: Finding[] = [];
  const unchanged: Finding[] = [];
  for (const [k, f] of a) (b.has(k) ? unchanged : fixed).push(f);

  const added: Finding[] = [];
  for (const [k, f] of b) if (!a.has(k)) added.push(f);

  return { fixed, added, unchanged };
}

/** Human-readable summary; pass labels to name the two sides in the output. */
export function formatDiff(
  diff: RunDiff,
  labels?: { before: string; after: string },
): string {
  const bl = labels?.before ?? "before";
  const al = labels?.after ?? "after";
  const line = (f: Finding) => `  [${f.severity}] ${f.kind} — ${f.title}`;
  const sorted = (fs: Finding[]) =>
    [...fs].sort((x, y) => x.title.localeCompare(y.title));

  const out: string[] = [
    `Compared  ${bl}  →  ${al}`,
    `  fixed: ${diff.fixed.length}   added: ${diff.added.length}   unchanged: ${diff.unchanged.length}`,
  ];
  if (diff.added.length) {
    out.push(`\n### ADDED — present in AFTER, absent in BEFORE (regressions)`);
    sorted(diff.added).forEach((f) => out.push(line(f)));
  }
  if (diff.fixed.length) {
    out.push(`\n### FIXED — in BEFORE, gone in AFTER`);
    sorted(diff.fixed).forEach((f) => out.push(line(f)));
  }
  if (diff.unchanged.length) {
    out.push(`\n### UNCHANGED — ${diff.unchanged.length} (present in both)`);
  }
  return out.join("\n");
}

/**
 * CI gate: nonzero when AFTER introduced new findings. By default any `added`
 * finding is a regression; pass a minimum severity to gate only on, say, high+.
 */
export function diffExitCode(
  diff: RunDiff,
  minSeverity: Finding["severity"] = "low",
): number {
  const rank: Record<Finding["severity"], number> = {
    low: 0,
    medium: 1,
    high: 2,
    critical: 3,
  };
  const gating = diff.added.filter(
    (f) => rank[f.severity] >= rank[minSeverity],
  );
  return gating.length > 0 ? 1 : 0;
}
