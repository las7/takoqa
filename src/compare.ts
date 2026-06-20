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
  /**
   * Same identity in both runs, but the evidence or severity differs — a partial
   * fix or partial regression a pure presence diff misses (e.g. a security-header
   * finding whose evidence goes from "4 missing" to "1 missing", same title).
   */
  changed: { before: Finding; after: Finding }[];
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
  // Evidence signature: what the finding *says*, beyond its identity. A change
  // here on a stable fingerprint means the same bug was partially fixed (or got
  // worse) — which a pure presence diff reports as "unchanged".
  const evid = (f: Finding) => `${f.severity}|${f.evidence ?? f.detail ?? ""}`;

  const fixed: Finding[] = [];
  const unchanged: Finding[] = [];
  const changed: { before: Finding; after: Finding }[] = [];
  for (const [k, fa] of a) {
    const fb = b.get(k);
    if (!fb) fixed.push(fa);
    else if (evid(fa) === evid(fb)) unchanged.push(fa);
    else changed.push({ before: fa, after: fb });
  }

  const added: Finding[] = [];
  for (const [k, f] of b) if (!a.has(k)) added.push(f);

  return { fixed, added, unchanged, changed };
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
    `  fixed: ${diff.fixed.length}   added: ${diff.added.length}   changed: ${diff.changed.length}   unchanged: ${diff.unchanged.length}`,
  ];
  if (diff.added.length) {
    out.push(`\n### ADDED — present in AFTER, absent in BEFORE (regressions)`);
    sorted(diff.added).forEach((f) => out.push(line(f)));
  }
  if (diff.fixed.length) {
    out.push(`\n### FIXED — in BEFORE, gone in AFTER`);
    sorted(diff.fixed).forEach((f) => out.push(line(f)));
  }
  if (diff.changed.length) {
    out.push(
      `\n### CHANGED — same finding, evidence/severity differs (partial fix or regression)`,
    );
    const ev = (f: Finding) =>
      (f.evidence ?? f.detail ?? "").replace(/\s+/g, " ").trim().slice(0, 90);
    [...diff.changed]
      .sort((x, y) => x.after.title.localeCompare(y.after.title))
      .forEach(({ before, after }) => {
        out.push(
          `  [${before.severity}→${after.severity}] ${after.kind} — ${after.title}`,
        );
        if (ev(before) !== ev(after)) {
          out.push(`      − ${ev(before)}`);
          out.push(`      + ${ev(after)}`);
        }
      });
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
  const added = diff.added.filter((f) => rank[f.severity] >= rank[minSeverity]);
  // A finding that survived but ESCALATED severity past the gate is a regression
  // too (e.g. a low UX nit that became a high bug under the same title).
  const escalated = diff.changed.filter(
    ({ before, after }) =>
      rank[after.severity] > rank[before.severity] &&
      rank[after.severity] >= rank[minSeverity],
  );
  return added.length + escalated.length > 0 ? 1 : 0;
}
