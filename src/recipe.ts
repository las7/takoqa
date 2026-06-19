/**
 * Record-and-replay: cache the action sequence of a passed mission so later
 * runs can replay it deterministically — no decide() calls — and fall back to
 * the agent the moment a step no longer matches the page or fails to execute.
 *
 * Refs (data-qa-ref) are assigned per-observe and are NOT stable across runs, so
 * a recipe stores each target's DESCRIPTOR (tag/role/label) plus its ordinal
 * among same-descriptor elements, and re-resolves the current ref against a
 * fresh observation at replay time. Coordinate gestures and navigate/scroll/
 * wait/finish replay as-is (coordinate gestures only when the viewport matches).
 *
 * A loaded recipe is untrusted input (it's a file that may be stale or
 * hand-edited): every action is re-validated to the same shape the LLM path
 * produces, unsafe actions are rejected, and any malformation voids the whole
 * recipe (the run then cleanly re-learns with the LLM).
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
import type { Action } from "./act.js";
import type { Observation } from "./observe.js";

/** Ignore absurdly large / corrupt recipe files rather than read them in. */
const MAX_RECIPE_BYTES = 4 * 1024 * 1024;

export interface RecipeStep {
  action: Action;
  /** Target descriptor + ordinal for ref actions (click/type/upload), to
   *  re-resolve the ref on replay. Absent for coordinate / navigate / scroll /
   *  wait / finish. */
  target?: { tag: string; role: string; label: string; nth: number };
}

export interface Recipe {
  missionId: string;
  startPath: string;
  recordedAt: string;
  /** Viewport the gestures were recorded at; coordinate replay requires a match. */
  viewport: { width: number; height: number };
  steps: RecipeStep[];
}

/** Filename-safe and injective per raw id: a hash suffix prevents slug
 *  collisions, and dropping '.' from the allowed set prevents '.'/'..' path
 *  traversal in the recipe path. */
function slug(s: string): string {
  const base = s.replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "") || "x";
  const hash = createHash("sha1").update(s).digest("hex").slice(0, 8);
  return `${base}-${hash}`;
}

function recipePath(dir: string, profile: string, missionId: string): string {
  return join(dir, slug(profile), `${slug(missionId)}.json`);
}

export function loadRecipe(
  dir: string,
  profile: string,
  missionId: string,
): Recipe | null {
  const p = recipePath(dir, profile, missionId);
  if (!existsSync(p)) return null;
  try {
    if (statSync(p).size > MAX_RECIPE_BYTES) return null;
    return validateRecipe(JSON.parse(readFileSync(p, "utf8")));
  } catch {
    return null;
  }
}

export function saveRecipe(dir: string, profile: string, recipe: Recipe): void {
  const p = recipePath(dir, profile, recipe.missionId);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(recipe, null, 2));
}

/** The descriptor (with same-descriptor ordinal) to record for an action's
 *  target, read off the observation the decision was made on. */
export function describeTarget(
  action: Action,
  obs: Observation,
): RecipeStep["target"] {
  if (
    action.type !== "click" &&
    action.type !== "type" &&
    action.type !== "upload"
  ) {
    return undefined;
  }
  const idx = obs.elements.findIndex((e) => e.ref === action.ref);
  if (idx < 0) return undefined;
  const el = obs.elements[idx]!;
  let nth = 0;
  for (let i = 0; i < idx; i++) {
    const e = obs.elements[i]!;
    if (e.tag === el.tag && e.role === el.role && e.label === el.label) nth++;
  }
  return { tag: el.tag, role: el.role, label: el.label, nth };
}

/**
 * Re-resolve a recorded step against the current observation. For ref actions,
 * find the Nth element matching the recorded descriptor and return the action
 * with its CURRENT ref; return null on a miss (descriptor/ordinal no longer
 * present) so the caller falls back to the LLM. Non-ref actions return as-is.
 */
export function resolveStep(step: RecipeStep, obs: Observation): Action | null {
  const a = step.action;
  if (a.type === "click" || a.type === "type" || a.type === "upload") {
    if (!step.target) return null;
    const t = step.target;
    const matches = obs.elements.filter(
      (e) => e.tag === t.tag && e.role === t.role && e.label === t.label,
    );
    const pick = matches[t.nth] ?? (t.nth === 0 ? matches[0] : undefined);
    return pick ? { ...a, ref: pick.ref } : null;
  }
  return a;
}

// ---------------------------------------------------------------------------
// Validation / sanitization of a loaded (untrusted) recipe.
// ---------------------------------------------------------------------------

function validateRecipe(raw: unknown): Recipe | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.missionId !== "string" || typeof r.startPath !== "string") {
    return null;
  }
  if (!Array.isArray(r.steps)) return null;
  const steps: RecipeStep[] = [];
  for (const s of r.steps) {
    const step = validateStep(s);
    if (!step) return null; // any bad step voids the whole recipe
    steps.push(step);
  }
  const vp = r.viewport as { width?: unknown; height?: unknown } | undefined;
  const viewport =
    vp && typeof vp.width === "number" && typeof vp.height === "number"
      ? { width: vp.width, height: vp.height }
      : { width: 0, height: 0 };
  return {
    missionId: r.missionId,
    startPath: r.startPath,
    recordedAt: typeof r.recordedAt === "string" ? r.recordedAt : "",
    viewport,
    steps,
  };
}

function validateStep(s: unknown): RecipeStep | null {
  if (!s || typeof s !== "object") return null;
  const obj = s as Record<string, unknown>;
  const action = sanitizeAction(obj.action);
  if (!action) return null;
  const t = obj.target as Record<string, unknown> | undefined | null;
  let target: RecipeStep["target"];
  if (t != null) {
    if (
      typeof t.tag !== "string" ||
      typeof t.role !== "string" ||
      typeof t.label !== "string"
    ) {
      return null;
    }
    target = {
      tag: t.tag,
      role: t.role,
      label: t.label,
      nth: typeof t.nth === "number" ? t.nth : 0,
    };
  }
  return { action, target };
}

/** Re-validate a loaded action to the shape the LLM path produces, and refuse
 *  unsafe ones (absolute/traversal upload paths, off-origin navigation). */
function sanitizeAction(a: unknown): Action | null {
  if (!a || typeof a !== "object") return null;
  const o = a as Record<string, unknown>;
  switch (o.type) {
    case "click":
      return typeof o.ref === "number" ? { type: "click", ref: o.ref } : null;
    case "type":
      return typeof o.ref === "number"
        ? {
            type: "type",
            ref: o.ref,
            text: String(o.text ?? ""),
            submit: Boolean(o.submit),
          }
        : null;
    case "upload": {
      if (typeof o.ref !== "number" || typeof o.fixture !== "string")
        return null;
      // In-profile fixtures only — no absolute paths or traversal (would read
      // arbitrary host files via setInputFiles).
      if (o.fixture.startsWith("/") || o.fixture.includes("..")) return null;
      return { type: "upload", ref: o.ref, fixture: o.fixture };
    }
    case "navigate": {
      if (typeof o.path !== "string") return null;
      // Same-origin relative paths only (executeAction resolves against the
      // current URL); reject absolute URLs and protocol-relative paths.
      if (
        !o.path.startsWith("/") ||
        o.path.startsWith("//") ||
        o.path.includes("://")
      ) {
        return null;
      }
      return { type: "navigate", path: o.path };
    }
    case "scroll":
      return {
        type: "scroll",
        direction: o.direction === "up" ? "up" : "down",
      };
    case "wait":
      return { type: "wait", ms: typeof o.ms === "number" ? o.ms : 1000 };
    case "click_at":
      return typeof o.x === "number" && typeof o.y === "number"
        ? { type: "click_at", x: o.x, y: o.y }
        : null;
    case "double_click":
      return typeof o.x === "number" && typeof o.y === "number"
        ? { type: "double_click", x: o.x, y: o.y }
        : null;
    case "drag":
      return typeof o.x === "number" &&
        typeof o.y === "number" &&
        typeof o.x2 === "number" &&
        typeof o.y2 === "number"
        ? { type: "drag", x: o.x, y: o.y, x2: o.x2, y2: o.y2 }
        : null;
    case "finish":
      return {
        type: "finish",
        success: Boolean(o.success),
        summary: String(o.summary ?? ""),
      };
    default:
      return null;
  }
}
