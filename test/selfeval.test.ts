/**
 * The harness-coverage CI gate. Runs the REAL engine over the planted-bug
 * fixture in two passes (functional + security) via runFixtureEval, scores the
 * merged findings against the ground-truth manifest, and asserts:
 *
 *   - recall === 1 over MUST_CATCH (a regression names the exact missed case),
 *   - ZERO false positives on the clean routes,
 *   - manifest parity: every manifest kind is a real FindingKind, and every
 *     must-catch id was actually evaluated.
 *
 * This is the regression gate: if a refactor stops an oracle from firing (or
 * starts crying wolf on a clean page), this test fails and names the case.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { runFixtureEval } from "../src/selfeval.js";
import { mutationScore } from "../src/metaeval.js";
import type { FindingKind } from "../src/types.js";
import { startFixtureServer } from "./fixture-server.js";
import { PLANTED, MUST_CATCH, CLEAN_ROUTES } from "./fixture-manifest.js";

// ---- Thresholds (named constants — the gate is explicit, not buried) -------
const REQUIRED_RECALL = 1; // every must-catch case must be caught
const MAX_FALSE_POSITIVES = 0; // no crying wolf on a clean route

/**
 * Cases excluded from the gating MUST_CATCH set (with a reason). Empty: every
 * planted case proved reliable under MockClient. Add an id here ONLY with a
 * clear comment if it becomes flaky/timing-dependent — never silently drop it.
 */
const EXCLUDED_FROM_GATE: ReadonlySet<string> = new Set([]);

/** Every FindingKind value, for the runtime manifest-parity check. Keep in sync
 *  with the FindingKind union in src/types.ts (a missing entry fails parity). */
const ALL_FINDING_KINDS: ReadonlySet<FindingKind> = new Set<FindingKind>([
  "page_error",
  "console_error",
  "http_error",
  "dead_link",
  "broken_image",
  "broken_asset",
  "accessibility",
  "duplicate_id",
  "body_error_signature",
  "goal_failed",
  "ux_issue",
  "agent_stuck",
  "no_progress",
  "occluded_control",
  "route_gated",
  "broken_authz",
  "missing_authn",
  "sensitive_data_exposure",
  "injection_reflection",
  "insecure_headers",
  "insecure_cookie",
  "verbose_error",
]);

test("manifest parity: every expected kind is a real FindingKind", () => {
  for (const c of PLANTED) {
    for (const kind of c.expectedKinds) {
      assert.ok(
        ALL_FINDING_KINDS.has(kind),
        `manifest case "${c.id}" references unknown FindingKind "${kind}"`,
      );
    }
  }
});

test("self-eval gate: full recall over must-catch cases + zero false positives", async () => {
  const { report, score } = await runFixtureEval({
    startServer: startFixtureServer,
    cases: PLANTED,
  });

  const evaluated = new Set([...score.caught, ...score.missed]);

  // Manifest parity: every must-catch case is scored (in caught∪missed). NOTE
  // this is necessarily true (scoreFixture buckets every non-clean case), so the
  // real guard that a case was actually EXERCISED by the engine is the recall
  // assertion below — an un-exercised case lands in `missed` and trips recall.
  for (const id of MUST_CATCH) {
    assert.ok(
      evaluated.has(id),
      `must-catch case "${id}" never ran (not evaluated)`,
    );
  }

  // Recall over the GATED must-catch set (exclusions removed, with reasons).
  const gated = MUST_CATCH.filter((id) => !EXCLUDED_FROM_GATE.has(id));
  const missedGated = score.missed.filter((id) => !EXCLUDED_FROM_GATE.has(id));
  const caughtGated = gated.filter((id) => !score.missed.includes(id));
  const recall = gated.length ? caughtGated.length / gated.length : 1;
  assert.ok(
    recall >= REQUIRED_RECALL,
    `recall ${recall.toFixed(3)} < ${REQUIRED_RECALL} — missed: [${missedGated.join(", ")}]`,
  );

  // Zero false positives on the clean routes.
  assert.ok(
    score.falsePositives.length <= MAX_FALSE_POSITIVES,
    `expected <=${MAX_FALSE_POSITIVES} false positives, got ${score.falsePositives.length}: ` +
      score.falsePositives.map((fp) => `${fp.id}:${fp.kind}`).join(", "),
  );

  // Sanity: the clean-route ids did not appear among caught/missed (they're
  // scored only for FPs, never recall).
  for (const id of CLEAN_ROUTES) {
    assert.ok(
      !evaluated.has(id),
      `clean route "${id}" must not be scored for recall`,
    );
  }

  // ABSOLUTE meta-eval floor (reuses this run's report — no extra engine run):
  // every shipped detector must be PROTECTED — exercised AND the SOLE signal on
  // ≥1 case, so the self-eval would actually fail if that oracle broke. This is
  // the CI-enforced backstop the comparative `npm run metaeval` gate builds on;
  // it catches a detector going covered-but-SHADOWED (which recall alone misses).
  const mut = mutationScore(report, PLANTED);
  assert.equal(
    mut.unprotected.length,
    0,
    `unprotected detectors (shipped but the eval can't see them break): ` +
      `[${mut.unprotected.join(", ")}] — uncovered: [${mut.uncovered.join(", ") || "none"}], ` +
      `shadowed: [${mut.shadowed.join(", ") || "none"}]`,
  );
});
