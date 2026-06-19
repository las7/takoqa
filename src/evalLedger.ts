/**
 * Append-only eval ledger + comparative regression gate.
 *
 * The scored self-eval (selfeval.ts) produces an ABSOLUTE score (recall /
 * precision vs the planted-bug fixture). This module adds the missing layer:
 * every harness change is measured against the PREVIOUS STATE — "report the
 * delta, not just the value". A per-case regression (a bug caught before,
 * missed now) FAILS the gate even when aggregate recall is unchanged, which the
 * absolute gate misses.
 *
 * A *run* is one `(task, dataset@hash, config, alg) -> metrics` result, stamped
 * with git provenance, and appended as one JSON object per line to a `.jsonl`
 * ledger. The ledger is plain text so a human (or an LLM hill-climbing the
 * harness) can read it directly. Mirrors the repo's canonical run-ledger
 * (op-core/src/op_core/eval/ledger.py) in spirit: append-only, byte-hashed
 * dataset identity, repo-level git provenance, an honest manual `alg` label,
 * and compare-by-equality on dataset.hash sorted by append order.
 *
 * The only structured, load-bearing identity fields are:
 *   - dataset.hash — so "is this the same data?" is answerable by equality.
 *   - git.gitSha / git.dirty — so "which tree produced this?" is answerable.
 *
 * Identity weaknesses we knowingly accept (documented per-function):
 *   - gitSha is REPO-level, not algorithm-level: an unrelated commit changes it
 *     while the harness code is byte-identical, and `dirty` only flags THAT
 *     something is uncommitted, not WHAT. Algorithm identity is therefore a
 *     caller-supplied `alg` label (e.g. { harness: "self-eval" }) — an explicit,
 *     honest human/LLM assertion, not a false-precise auto-hash.
 *   - datasetHash hashes BYTES, not semantics: a re-serialized but semantically
 *     identical fixture hashes differently.
 *
 * Pure module: only node:fs/crypto/child_process + types. No fixture or
 * selfeval-runtime import (so it stays free of test/ dependencies and is unit-
 * testable in isolation).
 */

import { execFileSync } from "node:child_process";
import type { ExecFileSyncOptionsWithStringEncoding } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { basename, dirname } from "node:path";

/** Git provenance for the producing tree. Both null on any git failure. */
export interface GitProvenance {
  gitSha: string | null;
  dirty: boolean | null;
}

/**
 * Return `{ gitSha, dirty }` for the repo containing `repoRoot` (or CWD).
 *
 * `gitSha` is the current HEAD; `dirty` is true when the working tree has
 * uncommitted changes. This is REPO-level provenance only — see the module
 * docstring for why it is not a faithful algorithm identity. On any git failure
 * (not a repo, git missing) both values are null. Never throws.
 */
export function gitProvenance(repoRoot?: string): GitProvenance {
  const opts: ExecFileSyncOptionsWithStringEncoding = {
    cwd: repoRoot,
    encoding: "utf8",
    // Pipe stdout (we read it), silence stderr (git's "not a repo" noise).
    stdio: ["ignore", "pipe", "ignore"],
  };
  try {
    const sha = execFileSync("git", ["rev-parse", "HEAD"], opts).trim();
    const status = execFileSync("git", ["status", "--porcelain"], opts);
    return { gitSha: sha, dirty: status.trim().length > 0 };
  } catch {
    return { gitSha: null, dirty: null };
  }
}

/** Content-hash identity of a dataset (a fixed set of files). */
export interface DatasetHash {
  hash: string;
  files: number;
}

/**
 * Content hash of a dataset given as an explicit list of file paths.
 *
 * Builds a sorted manifest of `${basename}\0${sha256(bytes)}\0${size}` for each
 * EXISTING file (missing files are skipped), joins with "\n", and sha256s the
 * manifest. Same bytes -> same hash, independent of the order the paths were
 * passed in. The manifest key is the BASENAME (not the full path) so the hash is
 * CWD-independent — two checkouts at different absolute paths agree.
 *
 * Accepted weakness: hashes BYTES, not semantics — a re-serialized but
 * semantically identical fixture hashes differently (mirrors ledger.py).
 */
export function datasetHash(filePaths: string[]): DatasetHash {
  const entries: string[] = [];
  for (const p of filePaths) {
    if (!existsSync(p)) continue;
    const bytes = readFileSync(p);
    const sha = createHash("sha256").update(bytes).digest("hex");
    entries.push(`${basename(p)}\0${sha}\0${bytes.length}`);
  }
  entries.sort();
  const digest = createHash("sha256").update(entries.join("\n")).digest("hex");
  return { hash: `sha256:${digest}`, files: entries.length };
}

/** The scores for one run. */
export interface EvalMetrics {
  recall: number;
  precision: number;
  /** Count of false positives (findings on a clean route). */
  falsePositives: number;
  /** Non-clean case ids that fired their expected finding. */
  caught: string[];
  /** Non-clean case ids that did NOT fire any expected finding. */
  missed: string[];
  /** Total non-clean cases evaluated (caught + missed). */
  total: number;
}

/**
 * One appended ledger record. `alg` and `config` are free-form dicts the caller
 * shapes however it likes (mirrors ledger.py's deliberately-unmodelled design).
 * `perCase` maps a (non-clean) caseId -> whether it was caught this run; it is
 * the substrate for the per-case comparative gate.
 */
export interface EvalRecord {
  ts: string;
  task: string;
  dataset: DatasetHash;
  alg: Record<string, string>;
  config: Record<string, unknown>;
  git: GitProvenance;
  metrics: EvalMetrics;
  /** caseId -> caught (true) / missed (false). Non-clean cases only. */
  perCase: Record<string, boolean>;
}

/**
 * Append one record to `ledgerPath` (creating the directory if needed).
 * APPENDS exactly one JSON line — it NEVER rewrites or truncates existing lines,
 * so the ledger is a durable, ordered history.
 */
export function recordRun(ledgerPath: string, record: EvalRecord): void {
  mkdirSync(dirname(ledgerPath), { recursive: true });
  appendFileSync(ledgerPath, JSON.stringify(record) + "\n", "utf8");
}

/**
 * Load every record from `ledgerPath` in append (chronological) order.
 *
 * Returns [] if the file is missing. Parses each non-blank line under try/catch
 * and SKIPS corrupt lines rather than failing the whole load (mirrors
 * baseline.ts's load tolerance) — a half-written final line never bricks the
 * gate.
 */
export function loadLedger(ledgerPath: string): EvalRecord[] {
  if (!existsSync(ledgerPath)) return [];
  let text: string;
  try {
    text = readFileSync(ledgerPath, "utf8");
  } catch {
    return [];
  }
  const out: EvalRecord[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line) as EvalRecord;
      if (rec && typeof rec === "object") out.push(rec);
    } catch {
      // Skip a corrupt/partial line — tolerant load, like baseline.ts.
    }
  }
  return out;
}

/** Selector for "the previous state": same question + same data. */
export interface BaselineSelector {
  task: string;
  datasetHash: string;
}

/**
 * The LAST (append-order = chronological) record matching `task` AND
 * `dataset.hash`. This is "the previous state" the current run is compared to.
 * Returns null when nothing matches.
 */
export function previousRecord(
  ledger: EvalRecord[],
  sel: BaselineSelector,
): EvalRecord | null {
  for (let i = ledger.length - 1; i >= 0; i--) {
    const rec = ledger[i]!;
    if (rec.task === sel.task && rec.dataset.hash === sel.datasetHash) {
      return rec;
    }
  }
  return null;
}

/** The delta between the current run and its comparable baseline. */
export interface EvalDelta {
  /** True iff there is a baseline over the SAME dataset.hash to compare to. */
  comparable: boolean;
  baselineTs: string | null;
  recallDelta: number;
  precisionDelta: number;
  /** current.falsePositives - baseline.falsePositives. */
  fpDelta: number;
  /** Case ids caught by the baseline but missed now (caught -> missed). */
  regressions: string[];
  /** Case ids missed by the baseline but caught now (missed -> caught). */
  gains: string[];
  /**
   * True iff a comparable baseline exists AND the harness got worse: a per-case
   * regression OR a drop in recall/precision. A per-case SWAP that keeps
   * aggregate recall flat is STILL a regression — that is the whole point of the
   * comparative gate (the absolute recall gate misses it).
   */
  isRegression: boolean;
}

/** Floating-point slack so "flat" comparisons aren't tripped by rounding. */
const EPS = 1e-9;

/**
 * Compare the current run to its (possibly null) comparable baseline.
 *
 * `comparable` requires a baseline over the SAME dataset.hash — comparing across
 * datasets is meaningless, so deltas are zeroed and isRegression is false when
 * there is no comparable baseline (e.g. the first run on a new fixture).
 *
 * regressions = ids caught by baseline but not caught now; gains = the reverse.
 * isRegression fires on ANY per-case regression OR a recall/precision drop — so
 * a swap that trades catching A for catching B (recall unchanged) still fails.
 */
export function compareToBaseline(
  current: EvalRecord,
  baseline: EvalRecord | null,
): EvalDelta {
  const comparable =
    !!baseline && baseline.dataset.hash === current.dataset.hash;
  if (!comparable || !baseline) {
    return {
      comparable: false,
      baselineTs: null,
      recallDelta: 0,
      precisionDelta: 0,
      fpDelta: 0,
      regressions: [],
      gains: [],
      isRegression: false,
    };
  }

  const regressions: string[] = [];
  const gains: string[] = [];
  const ids = new Set([
    ...Object.keys(baseline.perCase),
    ...Object.keys(current.perCase),
  ]);
  for (const id of ids) {
    const before = baseline.perCase[id] === true;
    const after = current.perCase[id] === true;
    if (before && !after) regressions.push(id);
    else if (!before && after) gains.push(id);
  }
  regressions.sort();
  gains.sort();

  const recallDelta = current.metrics.recall - baseline.metrics.recall;
  const precisionDelta = current.metrics.precision - baseline.metrics.precision;
  const fpDelta =
    current.metrics.falsePositives - baseline.metrics.falsePositives;

  const isRegression =
    regressions.length > 0 || recallDelta < -EPS || precisionDelta < -EPS;

  return {
    comparable: true,
    baselineTs: baseline.ts,
    recallDelta,
    precisionDelta,
    fpDelta,
    regressions,
    gains,
    isRegression,
  };
}

/** Format a number as a signed, fixed-precision delta (e.g. "+0.000"). */
function signed(n: number): string {
  const v = n.toFixed(3);
  return n >= 0 ? `+${v}` : v;
}

/**
 * A compact, human-readable one-paragraph delta report. When there is no
 * comparable baseline (first run on this dataset) it says so explicitly rather
 * than printing meaningless zero-deltas as if they were a real comparison.
 */
export function renderDelta(delta: EvalDelta, current: EvalRecord): string {
  const m = current.metrics;
  if (!delta.comparable) {
    return (
      `recall ${m.recall.toFixed(3)}, precision ${m.precision.toFixed(3)}, ` +
      `fp ${m.falsePositives} — no comparable baseline (first run on this dataset)`
    );
  }
  const bRecall = m.recall - delta.recallDelta;
  const bPrec = m.precision - delta.precisionDelta;
  const bFp = m.falsePositives - delta.fpDelta;
  const reg = delta.regressions.length
    ? ` [${delta.regressions.join(", ")}]`
    : "";
  const gain = delta.gains.length ? ` [${delta.gains.join(", ")}]` : "";
  return (
    `recall ${bRecall.toFixed(3)}→${m.recall.toFixed(3)} (Δ${signed(delta.recallDelta)}), ` +
    `precision ${bPrec.toFixed(3)}→${m.precision.toFixed(3)} (Δ${signed(delta.precisionDelta)}), ` +
    `fp ${bFp}→${m.falsePositives} (Δ${signed(delta.fpDelta)}); ` +
    `${delta.regressions.length} regression(s)${reg}, ${delta.gains.length} gain(s)${gain}; ` +
    `comparable to ${delta.baselineTs}`
  );
}
