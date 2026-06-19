/**
 * Per-profile LEARNED-KNOWLEDGE store: the self-improvement ratchet.
 *
 * The known-bugs baseline (baseline.ts) remembers BUGS across runs; recipes
 * (recipe.ts) remember SUCCESS PATHS. This module remembers durable APP FACTS
 * the harness discovers while exploring — facts a human would otherwise have to
 * hand-write into a profile's `knowledge:` block and keep up to date:
 *
 *   - route gates     : "/x redirects to /y" — a route sitting behind a gate
 *   - dead controls   : a control that never makes progress (likely unimplemented)
 *   - route offerings : the interactive controls a route actually exposes
 *   - attempted goals : missions already tried, so a later --loop session does
 *                       NOT re-propose them (cross-session novelty pressure)
 *
 * Distillation is DETERMINISTIC (no LLM): a run's signals map mechanically to
 * learnings, so the store can never hallucinate an app fact, is reproducible,
 * and is unit-testable without a browser or model. The next run MERGES the
 * confident subset (runCount >= CONFIDENCE_FLOOR) into the Knowledge handed to
 * the acting agent — and ONLY the agent. A learned fact must never teach the
 * judge to ignore a real bug, so learnings land in `routes` (which the judge
 * variant of renderKnowledge omits), never in `gotchas`. The single feedback
 * signal that DOES reach the judge is an operator-vetted muted finding, carried
 * separately by baseline.mutedExclusions — a human, not the distiller, decides
 * what the judge stops flagging.
 *
 * The store is a runtime sidecar — never authored by humans, though it is
 * human-inspectable/editable JSON exactly like the baseline, so a wrong learning
 * can be deleted by hand. Safety mirrors baseline.ts/recipe.ts: a byte cap,
 * per-map entry caps with stalest-first prune, and parse-in-try returning an
 * empty store on any corruption.
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
import type { Finding, Knowledge } from "./types.js";
import { normalizeRoute } from "./progress.js";

const MAX_LEARNED_BYTES = 4 * 1024 * 1024;
/** Per-map backstop on entry count: prune stalest beyond this on save. */
const MAX_LEARNED_ENTRIES = 500;
/** Affordances retained per route — matches the crawl's slice(0, 20) (engine.ts). */
const MAX_OFFERINGS = 20;
/**
 * A fact must be seen in at least this many runs before it becomes durable
 * knowledge fed to the agent. A one-off flake (a transient gate while a worker
 * was down, an agent that mis-clicked once) must not ossify into "knowledge".
 */
export const CONFIDENCE_FLOOR = 2;
/**
 * Confidence DECAYS: a gate/dead-control/offering not re-observed within this
 * window stops informing the agent (decay-on-read in mergeLearned), even though
 * the entry lingers in the JSON until prune or a human edit. This is the EXIT
 * side of no-ossification — CONFIDENCE_FLOOR gates entry, this gates persistence,
 * so a transient cause that has since cleared (worker came back up) doesn't keep
 * grounding the agent on a stale fact. A still-real fact is re-seen each run, so
 * its lastSeen keeps refreshing and it never goes stale.
 */
export const STALE_AFTER_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

export interface RouteGate {
  /** The observed effect only (e.g. "redirects to /knowledge") — never an
   *  invented tier name the run can't prove. */
  gate: string;
  firstSeen: string;
  lastSeen: string;
  runCount: number;
}

export interface DeadControl {
  route: string;
  label: string;
  firstSeen: string;
  lastSeen: string;
  runCount: number;
}

export interface RouteOffering {
  affordances: string[];
  lastSeen: string;
}

export interface AttemptedGoal {
  lastSeen: string;
}

export interface LearnedStore {
  /** key: normalized source route */
  routeGates: Record<string, RouteGate>;
  /** key: `${normalizedRoute}|${controlLabel}` */
  deadControls: Record<string, DeadControl>;
  /** key: normalized route */
  routeOfferings: Record<string, RouteOffering>;
  /** key: trimmed goal text */
  attempted: Record<string, AttemptedGoal>;
}

export function emptyStore(): LearnedStore {
  return {
    routeGates: {},
    deadControls: {},
    routeOfferings: {},
    attempted: {},
  };
}

// ---------------------------------------------------------------------------
// Persistence (mirrors baseline.ts: byte cap, prune, corruption-tolerant load).
// ---------------------------------------------------------------------------

function slug(s: string): string {
  const base = s.replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "") || "x";
  return `${base}-${createHash("sha1").update(s).digest("hex").slice(0, 8)}`;
}

function learnedPath(dir: string, profile: string): string {
  return join(dir, `${slug(profile)}.json`);
}

function asRecord<T>(v: unknown): Record<string, T> {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, T>)
    : {};
}

/** Coerce an unknown (possibly hand-edited/corrupt) value into the store shape,
 *  guaranteeing the four maps exist so consumers never crash on a missing key. */
function normalizeStore(raw: unknown): LearnedStore {
  const r = asRecord<unknown>(raw);
  return {
    routeGates: asRecord<RouteGate>(r.routeGates),
    deadControls: asRecord<DeadControl>(r.deadControls),
    routeOfferings: asRecord<RouteOffering>(r.routeOfferings),
    attempted: asRecord<AttemptedGoal>(r.attempted),
  };
}

export function loadLearned(dir: string, profile: string): LearnedStore {
  const p = learnedPath(dir, profile);
  if (!existsSync(p)) return emptyStore();
  try {
    if (statSync(p).size > MAX_LEARNED_BYTES) {
      process.stderr.write(
        `takoqa: learned store ${p} exceeds ${MAX_LEARNED_BYTES} bytes — ignoring it (it will be rewritten fresh)\n`,
      );
      return emptyStore();
    }
    return normalizeStore(JSON.parse(readFileSync(p, "utf8")));
  } catch {
    return emptyStore();
  }
}

function pruneMap<T extends { lastSeen: string }>(
  m: Record<string, T>,
): Record<string, T> {
  const keys = Object.keys(m);
  if (keys.length <= MAX_LEARNED_ENTRIES) return m;
  const kept = keys
    .sort((a, b) => (m[a]!.lastSeen < m[b]!.lastSeen ? 1 : -1))
    .slice(0, MAX_LEARNED_ENTRIES);
  const out: Record<string, T> = {};
  for (const k of kept) out[k] = m[k]!;
  return out;
}

function prune(s: LearnedStore): LearnedStore {
  return {
    routeGates: pruneMap(s.routeGates),
    deadControls: pruneMap(s.deadControls),
    routeOfferings: pruneMap(s.routeOfferings),
    attempted: pruneMap(s.attempted),
  };
}

export function saveLearned(
  dir: string,
  profile: string,
  store: LearnedStore,
): void {
  const p = learnedPath(dir, profile);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(prune(store), null, 2));
}

// ---------------------------------------------------------------------------
// Distillation: loop journal -> learnings (pure, deterministic).
// ---------------------------------------------------------------------------

export interface LoopJournal {
  /** [normalizedRoute, affordances] pairs the crawl saw on each page. */
  routeOfferings: Array<[string, string[]]>;
  /** Every finding accumulated across the loop's rounds. */
  findings: Finding[];
  /** Mission goals attempted this loop. */
  attempted: string[];
}

// These regexes mirror the title formats emitted by engine.ts (gatedFinding's
// `Route gated: ${startPath} → ${pathOf(landedUrl)}` and the no_progress
// `No progress: "${actionLabel}" repeated ...`). If those titles change, update
// these in lockstep — that coupling is the price of distilling structured facts
// from human-readable finding titles.
// Source captured lazily up to the arrow (tolerates an authored startPath with
// a query string or spaces); destination is a whitespace-free pathname.
const ROUTE_GATED_TITLE = /^Route gated:\s*(.+?)\s*→\s*(\S+)/;
const NO_PROGRESS_TITLE = /^No progress:\s*"(.+?)"\s+repeated/;

/**
 * Deterministically turn a loop's journal into a fresh LearnedStore. Every entry
 * is stamped firstSeen=lastSeen=`now`, runCount=1; mergeIntoStore folds this
 * delta into the persisted store. Pure: no clock, no fs, no LLM — so a given
 * journal always yields the same learnings and it is testable in isolation.
 */
export function distillFromLoop(
  journal: LoopJournal,
  now: string,
): LearnedStore {
  const store = emptyStore();

  for (const f of journal.findings) {
    if (f.kind === "route_gated") {
      const m = ROUTE_GATED_TITLE.exec(f.title);
      if (m) {
        const route = normalizeRoute(m[1]!);
        store.routeGates[route] = {
          // Normalize the destination too, so the displayed gate is stable
          // across runs (no trailing-slash / query-string / id flip-flop).
          gate: `redirects to ${normalizeRoute(m[2]!)}`,
          firstSeen: now,
          lastSeen: now,
          runCount: 1,
        };
      }
    } else if (f.kind === "no_progress") {
      const m = NO_PROGRESS_TITLE.exec(f.title);
      if (m) {
        const route = normalizeRoute(f.url);
        const label = m[1]!;
        store.deadControls[`${route}|${label}`] = {
          route,
          label,
          firstSeen: now,
          lastSeen: now,
          runCount: 1,
        };
      }
    }
  }

  for (const [route, affordances] of journal.routeOfferings) {
    if (!affordances.length) continue;
    store.routeOfferings[normalizeRoute(route)] = {
      affordances: affordances.slice(0, MAX_OFFERINGS),
      lastSeen: now,
    };
  }

  for (const goal of journal.attempted) {
    const key = goal.trim();
    if (key) store.attempted[key] = { lastSeen: now };
  }

  return store;
}

/**
 * Merge a freshly-distilled delta into the persisted store: a recurring fact
 * bumps runCount + lastSeen (carrying firstSeen forward), a new fact is added.
 * Does not mutate `prev`. Pruned on the way out so the store stays bounded.
 */
export function mergeIntoStore(
  prev: LearnedStore,
  delta: LearnedStore,
): LearnedStore {
  const base = normalizeStore(prev);
  // Normalize the delta too, so a malformed caller can never make this throw.
  const d = normalizeStore(delta);
  const out: LearnedStore = {
    routeGates: { ...base.routeGates },
    deadControls: { ...base.deadControls },
    routeOfferings: { ...base.routeOfferings },
    attempted: { ...base.attempted },
  };

  for (const [k, e] of Object.entries(d.routeGates)) {
    const old = out.routeGates[k];
    out.routeGates[k] = old
      ? {
          ...old,
          gate: e.gate,
          lastSeen: e.lastSeen,
          runCount: old.runCount + 1,
        }
      : e;
  }
  for (const [k, e] of Object.entries(d.deadControls)) {
    const old = out.deadControls[k];
    out.deadControls[k] = old
      ? { ...old, lastSeen: e.lastSeen, runCount: old.runCount + 1 }
      : e;
  }
  // Offerings + attempted have no confidence dimension — the latest wins.
  for (const [k, e] of Object.entries(d.routeOfferings))
    out.routeOfferings[k] = e;
  for (const [k, e] of Object.entries(d.attempted)) out.attempted[k] = e;

  return prune(out);
}

// ---------------------------------------------------------------------------
// Merge into Knowledge (agent-facing only) + cross-session novelty seed.
// ---------------------------------------------------------------------------

function appendNote(desc: string | undefined, note: string): string {
  const base = (desc ?? "").trim();
  return base ? `${base} — ${note}` : note;
}

/**
 * Fold confident learned facts (runCount >= CONFIDENCE_FLOOR for gates/dead
 * controls; offerings always) into the Knowledge object handed to the ACTING
 * agent. Gates become a route's `requires`; dead controls + offerings augment a
 * route's `description`. All of these live under `routes`, which the judge
 * variant of renderKnowledge omits — so a learned fact informs the agent's app
 * map without ever becoming a judge exclusion. Returns the input Knowledge
 * unchanged when there is nothing confident to add (back-compat).
 */
export function mergeLearned(
  knowledge: Knowledge | undefined,
  store: LearnedStore,
  /**
   * Current time (ISO). When given, facts not re-observed within STALE_AFTER_MS
   * are treated as expired and excluded — confidence decays so a since-cleared
   * transient cause stops grounding the agent. Omitted (e.g. in pure tests) ⇒
   * no decay, so the function stays clock-free and deterministic.
   */
  now?: string,
): Knowledge | undefined {
  const fresh = (lastSeen: string): boolean => {
    if (!now) return true;
    const age = Date.parse(now) - Date.parse(lastSeen);
    return Number.isNaN(age) || age <= STALE_AFTER_MS;
  };
  const gates = Object.entries(store.routeGates).filter(
    ([, e]) => e.runCount >= CONFIDENCE_FLOOR && fresh(e.lastSeen),
  );
  const dead = Object.entries(store.deadControls).filter(
    ([, e]) => e.runCount >= CONFIDENCE_FLOOR && fresh(e.lastSeen),
  );
  const offerings = Object.entries(store.routeOfferings).filter(([, e]) =>
    fresh(e.lastSeen),
  );
  if (!gates.length && !dead.length && !offerings.length) return knowledge;

  const base: Knowledge = knowledge ?? {
    overview: "",
    routes: [],
    glossary: [],
    gotchas: [],
  };
  const routes = base.routes.map((r) => ({ ...r }));
  const ensure = (path: string): (typeof routes)[number] => {
    const norm = normalizeRoute(path);
    let i = routes.findIndex((r) => normalizeRoute(r.path) === norm);
    if (i < 0) {
      routes.push({ path, description: "(learned)" });
      i = routes.length - 1;
    }
    return routes[i]!;
  };

  for (const [route, e] of gates) {
    const r = ensure(route);
    if (!r.requires) r.requires = `${e.gate} (learned)`;
  }

  const deadByRoute = new Map<string, string[]>();
  for (const [, e] of dead) {
    const norm = normalizeRoute(e.route);
    const arr = deadByRoute.get(norm) ?? [];
    arr.push(e.label);
    deadByRoute.set(norm, arr);
  }
  for (const [route, labels] of deadByRoute) {
    const r = ensure(route);
    r.description = appendNote(
      r.description,
      `learned: ${labels.map((l) => `"${l}"`).join(", ")} appears to be a dead end / not yet implemented`,
    );
  }

  for (const [route, e] of offerings) {
    if (!e.affordances.length) continue;
    const r = ensure(route);
    r.description = appendNote(
      r.description,
      `offers: ${e.affordances.join(", ")}`,
    );
  }

  return { ...base, routes };
}

/** The N most-recently-attempted goals (newest first), to seed a fresh --loop
 *  session's novelty pressure so it does not re-propose missions a prior session
 *  already tried. Bounded so the proposer prompt stays compact. */
export function recentAttempted(store: LearnedStore, max: number): string[] {
  return Object.entries(store.attempted)
    .sort((a, b) => (a[1].lastSeen < b[1].lastSeen ? 1 : -1))
    .slice(0, max)
    .map(([goal]) => goal);
}
