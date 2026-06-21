/**
 * Observation coverage: of the interactive affordances the agent SAW across a
 * run, how many did it actually EXERCISE (act on)? Answers "did we exhaust
 * what's been observed, or did the agent see controls and skip them?".
 *
 * Pure, deterministic, derived from the run's StepRecords alone (each carries
 * the pre-decision observed surface + the refs its action touched). No I/O.
 *
 * Affordances are keyed by `${route}|${role}|${label}|${cap}` — NOT the raw
 * observe-time `ref`, which is positional per page — so the same control seen
 * across steps/pages counts once. Unlabeled elements are unstable to key, so
 * they're excluded from the ratio and reported separately as a caveat.
 */

import type {
  MissionResult,
  ObservationCoverage,
  ObservedAffordance,
} from "./types.js";
import { normalizeRoute } from "./progress.js";

/** How many seen-but-never-tried affordances to list in the report. */
const FRONTIER_CAP = 30;

function keyOf(route: string, el: ObservedAffordance): string {
  return `${route}|${el.role}|${el.label}|${el.cap ?? ""}`;
}

export function computeObservationCoverage(
  results: MissionResult[],
): ObservationCoverage {
  // key -> display (first sighting wins; identical keys share a display).
  const observed = new Map<string, { route: string; role: string; label: string }>();
  const exercised = new Set<string>();
  let truncated = 0;
  let unlabeled = 0;

  for (const r of results) {
    for (const s of r.steps) {
      const o = s.observed;
      if (!o) continue;
      const route = normalizeRoute(o.url);
      truncated += o.truncated ?? 0;

      const byRef = new Map<number, ObservedAffordance>();
      for (const el of o.elements) {
        byRef.set(el.ref, el);
        if (!el.label) {
          unlabeled++;
          continue; // labeled-only metric
        }
        const k = keyOf(route, el);
        if (!observed.has(k)) {
          observed.set(k, { route, role: el.role, label: el.label });
        }
      }
      for (const ref of o.actedRefs) {
        const el = byRef.get(ref);
        if (!el || !el.label) continue; // coordinate/unlabeled target: not counted
        exercised.add(keyOf(route, el));
      }
    }
  }

  const observedCount = observed.size;
  const exercisedCount = exercised.size;
  const coverage = observedCount === 0 ? 1 : exercisedCount / observedCount;

  const frontier: { route: string; role: string; label: string }[] = [];
  for (const [k, disp] of observed) {
    if (!exercised.has(k)) frontier.push(disp);
  }
  frontier.sort(
    (a, b) => a.route.localeCompare(b.route) || a.label.localeCompare(b.label),
  );

  return {
    coverage,
    observed: observedCount,
    exercised: exercisedCount,
    truncated,
    unlabeled,
    frontier: frontier.slice(0, FRONTIER_CAP),
    frontierTotal: frontier.length,
  };
}
