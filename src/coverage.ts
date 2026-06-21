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
  ObservedSurface,
} from "./types.js";
import { normalizeRoute } from "./progress.js";

/** How many seen-but-never-tried affordances to list in the report. */
const FRONTIER_CAP = 30;

export function affordanceKey(
  route: string,
  el: { role: string; label: string; cap?: string },
): string {
  return `${route}|${el.role}|${el.label}|${el.cap ?? ""}`;
}

/**
 * Labeled controls visible on the current page that haven't been acted on yet
 * this mission — surfaced live to the agent so it exhausts the page instead of
 * finishing the moment its goal is met. Keyed stably (route|role|label|cap), so
 * a control isn't "untried" once exercised under a different positional ref.
 */
export function untriedAffordances(
  steps: { observed?: ObservedSurface }[],
  current: { url: string; elements: ObservedAffordance[] },
  cap = 15,
): { label: string; role: string; cap?: string }[] {
  const route = normalizeRoute(current.url);
  const acted = new Set<string>();
  for (const s of steps) {
    const o = s.observed;
    if (!o || normalizeRoute(o.url) !== route) continue;
    const byRef = new Map<number, ObservedAffordance>();
    for (const el of o.elements) byRef.set(el.ref, el);
    for (const ref of o.actedRefs) {
      const el = byRef.get(ref);
      if (el?.label) acted.add(affordanceKey(route, el));
    }
  }
  const out: { label: string; role: string; cap?: string }[] = [];
  const seen = new Set<string>();
  for (const el of current.elements) {
    if (!el.label) continue;
    const k = affordanceKey(route, el);
    if (acted.has(k) || seen.has(k)) continue;
    seen.add(k);
    out.push({ label: el.label, role: el.role, ...(el.cap ? { cap: el.cap } : {}) });
    if (out.length >= cap) break;
  }
  return out;
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
        const k = affordanceKey(route, el);
        if (!observed.has(k)) {
          observed.set(k, { route, role: el.role, label: el.label });
        }
      }
      for (const ref of o.actedRefs) {
        const el = byRef.get(ref);
        if (!el || !el.label) continue; // coordinate/unlabeled target: not counted
        exercised.add(affordanceKey(route, el));
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

export interface RunAffordance {
  key: string;
  route: string;
  role: string;
  label: string;
  /** Whether the agent acted on this affordance during the run. */
  exercised: boolean;
}

/**
 * Distinct labeled affordances observed across a run, each flagged whether the
 * agent acted on it — the unit folded into cross-run coverage memory
 * (coverageStore.ts) so later runs know what's never been exercised.
 */
export function runAffordances(results: MissionResult[]): RunAffordance[] {
  const observed = new Map<string, { route: string; role: string; label: string }>();
  const exercised = new Set<string>();
  for (const r of results) {
    for (const s of r.steps) {
      const o = s.observed;
      if (!o) continue;
      const route = normalizeRoute(o.url);
      const byRef = new Map<number, ObservedAffordance>();
      for (const el of o.elements) {
        byRef.set(el.ref, el);
        if (!el.label) continue;
        const k = affordanceKey(route, el);
        if (!observed.has(k)) observed.set(k, { route, role: el.role, label: el.label });
      }
      for (const ref of o.actedRefs) {
        const el = byRef.get(ref);
        if (el?.label) exercised.add(affordanceKey(route, el));
      }
    }
  }
  return [...observed].map(([key, d]) => ({
    key,
    ...d,
    exercised: exercised.has(key),
  }));
}
