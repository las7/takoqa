/**
 * Known-bugs baseline: remember which findings a profile has seen across runs,
 * so a repeated run can say what's NEW versus already-KNOWN (and let the
 * operator MUTE a fingerprint to silence a known non-bug). Without this, every
 * run re-reports the same standing issues at full volume.
 *
 * Findings are keyed by baselineFingerprint (findings.ts) — like the within-run
 * dedupe key but with volatile ids (UUIDs etc.) collapsed, so "the same bug"
 * recurs under one key across runs even when its title embeds a resource id.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import type { Finding } from "./types.js";
import { baselineFingerprint } from "./findings.js";

const MAX_BASELINE_BYTES = 4 * 1024 * 1024;
/** Backstop on entry count: prune oldest-seen beyond this on save. */
const MAX_BASELINE_ENTRIES = 5000;

export interface BaselineEntry {
  firstSeen: string;
  lastSeen: string;
  runCount: number;
  /** Operator-set: a known non-bug to suppress from the headline report. */
  muted?: boolean;
  /**
   * Operator-supplied one-line reason a muted fingerprint is a known non-bug
   * (e.g. "the N-Issues badge is the dev toolbar, not a product bug"). Set via
   * `--mute <fingerprint> --as "<reason>"` (run.ts) or by hand-editing the JSON
   * alongside `muted`. It is the only carrier of meaning on a muted entry (the
   * entry stores no title), and — fed through mutedExclusions() — the ONLY
   * feedback signal that reaches the judge, closing the mute→judge loop so a
   * triaged non-bug stops being re-flagged every run. See oracles.judgeMission.
   */
  mutedAs?: string;
}

export type Baseline = Record<string, BaselineEntry>;

/**
 * The human-readable notes of every muted+annotated entry, to feed the judge as
 * extra "do NOT flag" exclusions. A bare mute (no note) still silences the
 * report and CI gate but is skipped here, so it never pollutes the judge prompt
 * with an empty line.
 */
export function mutedExclusions(baseline: Baseline): string[] {
  return Object.values(baseline)
    .filter((e) => e.muted && e.mutedAs && e.mutedAs.trim())
    .map((e) => e.mutedAs!.trim());
}

function slug(s: string): string {
  const base = s.replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "") || "x";
  return `${base}-${createHash("sha1").update(s).digest("hex").slice(0, 8)}`;
}

function baselinePath(dir: string, profile: string): string {
  return join(dir, `${slug(profile)}.json`);
}

export function loadBaseline(dir: string, profile: string): Baseline {
  const p = baselinePath(dir, profile);
  if (!existsSync(p)) return {};
  try {
    if (statSync(p).size > MAX_BASELINE_BYTES) {
      process.stderr.write(
        `takoqa: baseline ${p} exceeds ${MAX_BASELINE_BYTES} bytes — ignoring it (history will be rewritten fresh)\n`,
      );
      return {};
    }
    const r = JSON.parse(readFileSync(p, "utf8")) as unknown;
    return r && typeof r === "object" ? (r as Baseline) : {};
  } catch {
    return {};
  }
}

/** Keep the most-recently-seen MAX_BASELINE_ENTRIES; drop the staleset. */
function prune(baseline: Baseline): Baseline {
  const keys = Object.keys(baseline);
  if (keys.length <= MAX_BASELINE_ENTRIES) return baseline;
  const kept = keys
    .sort((a, b) => (baseline[a]!.lastSeen < baseline[b]!.lastSeen ? 1 : -1))
    .slice(0, MAX_BASELINE_ENTRIES);
  const out: Baseline = {};
  for (const k of kept) out[k] = baseline[k]!;
  return out;
}

export function saveBaseline(
  dir: string,
  profile: string,
  baseline: Baseline,
): void {
  const p = baselinePath(dir, profile);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(prune(baseline), null, 2));
}

export interface BaselineTally {
  new: number;
  known: number;
  muted: number;
}

/**
 * Stamp each finding's `status` (new / known / muted) against the baseline and
 * fold this run into it (first/last seen, run count). Mutates both the findings
 * and the baseline; the baseline is bumped once per distinct fingerprint per run.
 */
export function classifyAndUpdate(
  findings: Finding[],
  baseline: Baseline,
  now: string,
): BaselineTally {
  const tally: BaselineTally = { new: 0, known: 0, muted: 0 };
  const bumped = new Set<string>();
  for (const f of findings) {
    const fp = baselineFingerprint(f);
    const existing = baseline[fp];
    if (existing) {
      f.status = existing.muted ? "muted" : "known";
      if (existing.muted) tally.muted++;
      else tally.known++;
      if (!bumped.has(fp)) {
        bumped.add(fp);
        existing.lastSeen = now;
        existing.runCount += 1;
      }
    } else {
      f.status = "new";
      tally.new++;
      if (!bumped.has(fp)) {
        bumped.add(fp);
        baseline[fp] = { firstSeen: now, lastSeen: now, runCount: 1 };
      }
    }
  }
  return tally;
}
