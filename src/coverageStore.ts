/**
 * Cross-run coverage memory: remember which interactive affordances a profile
 * has EVER exercised across runs, so a later run can be told which controls have
 * never been touched and prioritize them. Without this, every run rediscovers
 * the surface from scratch and tends to re-exercise the same easy controls.
 *
 * Mirrors the known-bugs baseline (baseline.ts): a per-profile JSON store keyed
 * by the stable affordance key (route|role|label|cap, see coverage.affordanceKey),
 * tolerant load, atomic save, bounded by a stalest-first prune.
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
import type { MissionResult } from "./types.js";
import { runAffordances } from "./coverage.js";

const MAX_COVERAGE_BYTES = 8 * 1024 * 1024;
/** Backstop on entry count: prune oldest-seen beyond this on save. */
const MAX_COVERAGE_ENTRIES = 50000;

export interface CoverageEntry {
  route: string;
  role: string;
  label: string;
  firstSeen: string;
  lastSeen: string;
  /** Runs in which this affordance was observed. */
  runCount: number;
  /** Whether it has ever been acted on, in any run. */
  exercised: boolean;
  lastExercised?: string;
}

export type CoverageMemory = Record<string, CoverageEntry>;

function slug(s: string): string {
  const base = s.replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "") || "x";
  return `${base}-${createHash("sha1").update(s).digest("hex").slice(0, 8)}`;
}

function coveragePath(dir: string, profile: string): string {
  return join(dir, `${slug(profile)}.json`);
}

export function loadCoverage(dir: string, profile: string): CoverageMemory {
  const p = coveragePath(dir, profile);
  if (!existsSync(p)) return {};
  try {
    if (statSync(p).size > MAX_COVERAGE_BYTES) {
      process.stderr.write(
        `takoqa: coverage memory ${p} exceeds ${MAX_COVERAGE_BYTES} bytes — ignoring it (history will be rewritten fresh)\n`,
      );
      return {};
    }
    const r = JSON.parse(readFileSync(p, "utf8")) as unknown;
    return r && typeof r === "object" ? (r as CoverageMemory) : {};
  } catch {
    return {};
  }
}

/** Keep the most-recently-seen MAX_COVERAGE_ENTRIES; drop the stalest. */
function prune(mem: CoverageMemory): CoverageMemory {
  const keys = Object.keys(mem);
  if (keys.length <= MAX_COVERAGE_ENTRIES) return mem;
  const kept = keys
    .sort((a, b) => (mem[a]!.lastSeen < mem[b]!.lastSeen ? 1 : -1))
    .slice(0, MAX_COVERAGE_ENTRIES);
  const out: CoverageMemory = {};
  for (const k of kept) out[k] = mem[k]!;
  return out;
}

export function saveCoverage(
  dir: string,
  profile: string,
  mem: CoverageMemory,
): void {
  const p = coveragePath(dir, profile);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(prune(mem), null, 2));
}

/** Fold a run's observed/exercised affordances into the memory (mutates it). */
export function mergeRunCoverage(
  mem: CoverageMemory,
  results: MissionResult[],
  now: string,
): void {
  for (const a of runAffordances(results)) {
    const e = mem[a.key];
    if (e) {
      e.lastSeen = now;
      e.runCount += 1;
      if (a.exercised) {
        e.exercised = true;
        e.lastExercised = now;
      }
    } else {
      mem[a.key] = {
        route: a.route,
        role: a.role,
        label: a.label,
        firstSeen: now,
        lastSeen: now,
        runCount: 1,
        exercised: a.exercised,
        ...(a.exercised ? { lastExercised: now } : {}),
      };
    }
  }
}

/** The keys of affordances exercised at least once in some past run. */
export function historicalExercisedKeys(mem: CoverageMemory): Set<string> {
  const out = new Set<string>();
  for (const [k, e] of Object.entries(mem)) if (e.exercised) out.add(k);
  return out;
}

export interface CoverageStats {
  /** Distinct labeled affordances ever observed across all runs. */
  known: number;
  /** How many have been exercised at least once. */
  exercised: number;
  /** Seen but never exercised in any run. */
  never: number;
  /** exercised / known, or 1 when nothing is known yet. */
  ratio: number;
  /** The most runs any single affordance has been observed in. */
  runs: number;
}

/** Campaign-level coverage rollup across all runs folded into the memory. */
export function coverageStats(mem: CoverageMemory): CoverageStats {
  const entries = Object.values(mem);
  const known = entries.length;
  const exercised = entries.filter((e) => e.exercised).length;
  const runs = entries.reduce((m, e) => Math.max(m, e.runCount), 0);
  return {
    known,
    exercised,
    never: known - exercised,
    ratio: known === 0 ? 1 : exercised / known,
    runs,
  };
}
