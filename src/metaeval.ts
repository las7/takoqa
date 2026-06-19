/**
 * Harness meta-eval — "test the tests".
 *
 * Two gates already exist: the scored self-eval proves the harness CATCHES the
 * planted bugs (absolute recall/precision), and the eval ledger proves it did
 * not REGRESS against the previous state (comparative). This module adds the
 * third question the other two cannot answer: is every DETECTOR the harness
 * ships actually EXERCISED and PROTECTED by the fixture? A detector with no
 * fixture case — or one whose case is always co-caught by another kind — could
 * silently rot (stop firing) and BOTH existing gates would stay green, because
 * neither asks "would we notice if THIS oracle broke?".
 *
 * Two pure measures over the manifest + a scored report:
 *
 *   - detectorCoverage — a deterministic detector kind is COVERED iff some
 *     non-clean case lists it in expectedKinds. Uncovered kinds are blind spots.
 *
 *   - mutationScore (ablation / "test the tests") — a detector kind is PROTECTED
 *     iff ABLATING it (dropping all findings of that kind) from a passing report
 *     makes a previously-caught case go MISSED. That is the load-bearing claim:
 *     the self-eval would actually FAIL if this oracle broke. A covered-but-
 *     SHADOWED kind (always co-caught by another expected kind on the same case)
 *     is NOT protected — its case stays caught even with the oracle removed, so
 *     the eval is blind to that detector breaking. mutationScore is the share of
 *     detector kinds that are protected.
 *
 * KIND_CLASS classifies EVERY FindingKind as a deterministic `detector` or an
 * LLM/agent `judgment`. Because it is a Record<FindingKind, …>, adding a new kind
 * is a COMPILE error until it is classified here — so a detector can never ship
 * without a coverage decision. That compile-time exhaustiveness IS the ratchet.
 *
 * Pure module: src/types + src/selfeval (scoreFixture, also pure) only. No engine
 * or fixture import — the live engine run happens in the CLI (test/metaeval.ts),
 * which injects the scored report, mirroring the selfeval src/↔test/ boundary.
 */

import { scoreFixture } from "./selfeval.js";
import type { PlantedCase } from "./selfeval.js";
import type { FindingKind, RunReport } from "./types.js";

/**
 * Every FindingKind, classified. `detector` = a deterministic oracle/engine
 * signal the planted-bug fixture must exercise and the meta-eval gates on.
 * `judgment` = an LLM-judge verdict (goal_failed / ux_issue) or the agent
 * step-limit signal (agent_stuck): non-deterministic, driven by a real model not
 * the scripted MockClient, so the fixture is not where they are gated — they are
 * covered by the judge/agent unit tests instead.
 *
 * Record<FindingKind, …> ⇒ a new FindingKind fails to compile until added here.
 */
export const KIND_CLASS: Record<FindingKind, "detector" | "judgment"> = {
  page_error: "detector",
  console_error: "detector",
  http_error: "detector",
  dead_link: "detector",
  broken_image: "detector",
  broken_asset: "detector",
  accessibility: "detector",
  duplicate_id: "detector",
  body_error_signature: "detector",
  no_progress: "detector",
  occluded_control: "detector",
  route_gated: "detector",
  broken_authz: "detector",
  missing_authn: "detector",
  sensitive_data_exposure: "detector",
  injection_reflection: "detector",
  insecure_headers: "detector",
  insecure_cookie: "detector",
  verbose_error: "detector",
  goal_failed: "judgment",
  ux_issue: "judgment",
  agent_stuck: "judgment",
};

/** The deterministic detector kinds the self-eval fixture must exercise + protect. */
export const DETECTOR_KINDS: FindingKind[] = (
  Object.keys(KIND_CLASS) as FindingKind[]
).filter((k) => KIND_CLASS[k] === "detector");

// ---------------------------------------------------------------------------
// Coverage — is each detector exercised by a fixture case?
// ---------------------------------------------------------------------------

export interface DetectorCoverage {
  /** All deterministic detector kinds (the denominator). */
  detectors: FindingKind[];
  /** Detector kinds a non-clean case exercises (lists in expectedKinds). */
  covered: FindingKind[];
  /** Detector kinds NO case exercises — blind spots. */
  uncovered: FindingKind[];
  /** covered / detectors. */
  coverage: number;
}

/**
 * Detector coverage from the manifest alone (no engine). A detector kind is
 * covered iff some NON-CLEAN case lists it in expectedKinds — a clean case only
 * guards against false positives, it does not positively exercise a detector.
 */
export function detectorCoverage(cases: PlantedCase[]): DetectorCoverage {
  const exercised = new Set<FindingKind>();
  for (const c of cases) {
    if (c.clean) continue;
    for (const k of c.expectedKinds) exercised.add(k);
  }
  const covered = DETECTOR_KINDS.filter((k) => exercised.has(k));
  const uncovered = DETECTOR_KINDS.filter((k) => !exercised.has(k));
  return {
    detectors: [...DETECTOR_KINDS],
    covered,
    uncovered,
    coverage: DETECTOR_KINDS.length
      ? covered.length / DETECTOR_KINDS.length
      : 1,
  };
}

// ---------------------------------------------------------------------------
// Mutation / ablation — would the eval FAIL if a detector broke?
// ---------------------------------------------------------------------------

/** A copy of the report with every finding of `kind` removed. Pure. */
export function ablateKind(report: RunReport, kind: FindingKind): RunReport {
  return {
    ...report,
    results: report.results.map((r) => ({
      ...r,
      findings: r.findings.filter((f) => f.kind !== kind),
    })),
  };
}

export interface MutationResult {
  /** All deterministic detector kinds (the denominator). */
  detectors: FindingKind[];
  /** Kinds whose ablation makes a caught case go missed — the eval protects them. */
  protectedKinds: FindingKind[];
  /** Covered, but never the SOLE signal on a case — the eval is blind if they break. */
  shadowed: FindingKind[];
  /** Not exercised by any case at all. */
  uncovered: FindingKind[];
  /** shadowed ∪ uncovered — every detector the eval would NOT catch breaking. */
  unprotected: FindingKind[];
  /** protectedKinds / detectors. */
  mutationScore: number;
}

/**
 * The mutation/ablation analysis over a PASSING report. For each covered detector
 * kind, drop all its findings and re-score: if a case that was caught is now
 * missed, the kind was that case's SOLE signal, so the self-eval would fail if
 * the oracle broke → PROTECTED. A covered kind that is never the sole signal is
 * SHADOWED (the eval is blind to it breaking); an uncovered kind is, trivially,
 * unprotected. Pure: re-uses scoreFixture, no engine.
 */
export function mutationScore(
  report: RunReport,
  cases: PlantedCase[],
): MutationResult {
  const baseline = scoreFixture(report, cases);
  const caught = new Set(baseline.caught);
  const cov = detectorCoverage(cases);

  const protectedKinds: FindingKind[] = [];
  const shadowed: FindingKind[] = [];
  for (const k of cov.covered) {
    const ablated = scoreFixture(ablateKind(report, k), cases);
    // Protected iff ablating k turns a previously-CAUGHT case into a MISS — i.e.
    // k was the only expected kind that fired on it. (Ablation only removes
    // findings, so it can never create a false positive; recall is the signal.)
    const newlyMissed = ablated.missed.some((id) => caught.has(id));
    (newlyMissed ? protectedKinds : shadowed).push(k);
  }

  const unprotected = [...shadowed, ...cov.uncovered].sort();
  return {
    detectors: [...DETECTOR_KINDS],
    protectedKinds,
    shadowed,
    uncovered: cov.uncovered,
    unprotected,
    mutationScore: DETECTOR_KINDS.length
      ? protectedKinds.length / DETECTOR_KINDS.length
      : 1,
  };
}
