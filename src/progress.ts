/**
 * Progress detection: did an action actually change anything?
 *
 * The agent can't tell a click that navigated from one that did nothing — both
 * come back as "Clicked [6] Playground". Without a progress signal it loops on a
 * dead control until it runs out of steps (observed: the same nav item clicked
 * 17 times while the URL never moved). This module gives the engine a cheap,
 * deterministic answer it can both surface to the model and use to break loops.
 *
 * The fingerprint deliberately uses only url + title + interactive-element count
 * — NOT a hash of the page text/DOM. Many apps stream content over SSE and
 * render live timestamps (e.g. "3s ago") and spinners, so a full content hash
 * would report "changed" every step even when nothing meaningful happened,
 * defeating the guard. url/title/element-count moves on real navigation and most
 * modal / view transitions while staying stable on a genuine no-op.
 */

import type { Action } from "./act.js";
import type { Observation } from "./observe.js";

/** Identifies an action for repeat-detection (same target + same payload). */
export function actionSignature(action: Action): string {
  switch (action.type) {
    case "click":
      return `click:${action.ref}`;
    case "type":
      return `type:${action.ref}:${action.text}`;
    case "upload":
      return `upload:${action.ref}:${action.fixture}`;
    case "navigate":
      return `navigate:${action.path}`;
    case "scroll":
      return `scroll:${action.direction}`;
    case "wait":
      return "wait";
    case "click_at":
      return `click_at:${action.x},${action.y}`;
    case "double_click":
      return `double_click:${action.x},${action.y}`;
    case "drag":
      return `drag:${action.x},${action.y}-${action.x2},${action.y2}`;
    case "finish":
      return "finish";
  }
}

/** Coarse, volatility-resistant fingerprint of the page state. */
export function progressSignature(obs: Observation): string {
  return `${obs.url}|${obs.title}|${obs.elements.length}`;
}

export interface ProgressDiff {
  urlChanged: boolean;
  /** Any observable change to url, title, or the interactive-element set. */
  changed: boolean;
}

export function diffProgress(
  pre: Observation,
  post: Observation,
): ProgressDiff {
  return {
    urlChanged: pre.url !== post.url,
    changed: progressSignature(pre) !== progressSignature(post),
  };
}

/** Short human note describing an action's effect, appended to the step log. */
export function progressNote(diff: ProgressDiff, post: Observation): string {
  if (diff.urlChanged) return `→ ${pathOf(post.url)}`;
  if (!diff.changed) return `no change: still on ${pathOf(post.url)}`;
  return "page updated";
}

/**
 * Whether opening `startPath` landed somewhere unrelated — the hallmark of an
 * auth / tier / feature gate or an unmet precondition. Root ("/") is exempt
 * because a landing redirect from "/" is normal; a landed path that nests under
 * (or is nested by) the requested one is treated as the same area, not a gate.
 */
export function isGatedRedirect(startPath: string, landedUrl: string): boolean {
  if (startPath === "/" || startPath === "") return false;
  const want = normalizePath(startPath);
  let got: string;
  try {
    got = normalizePath(new URL(landedUrl).pathname);
  } catch {
    return false;
  }
  if (got === want) return false;
  return !got.startsWith(`${want}/`) && !want.startsWith(`${got}/`);
}

export function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

function normalizePath(p: string): string {
  const path = p.split("?")[0]!.split("#")[0]!;
  return path.length > 1 ? path.replace(/\/$/, "") : path;
}

/**
 * A route key for coverage: the pathname with dynamic segments (UUIDs, numeric
 * ids, long hashes) collapsed to "[id]", so /knowledge/<uuid> and
 * /knowledge/<other-uuid> count as the same route /knowledge/[id].
 */
export function normalizeRoute(urlOrPath: string): string {
  let path: string;
  try {
    path = new URL(urlOrPath).pathname;
  } catch {
    path = urlOrPath.split("?")[0]!.split("#")[0]!;
  }
  const dynamic = (seg: string): boolean =>
    /^[0-9]+$/.test(seg) ||
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      seg,
    ) ||
    /^[0-9a-f]{16,}$/i.test(seg);
  const out = path
    .split("/")
    .map((seg) => (dynamic(seg) ? "[id]" : seg))
    .join("/");
  return out.length > 1 ? out.replace(/\/$/, "") : out;
}
