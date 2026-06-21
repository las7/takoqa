/**
 * The agent's action vocabulary and executor.
 *
 * Actions are deliberately human-shaped (click, type, upload, scroll) rather
 * than low-level Playwright calls, so the LLM reasons the way a user would.
 * Elements are addressed by the integer `ref` assigned in observe.ts.
 */

import type { Locator, Page } from "playwright";

export type Action =
  | { type: "click"; ref: number }
  | { type: "type"; ref: number; text: string; submit?: boolean }
  | { type: "upload"; ref: number; fixture: string }
  | { type: "navigate"; path: string }
  | { type: "scroll"; direction: "up" | "down" }
  | { type: "wait"; ms: number }
  // Coordinate (pixel) gestures for areas with no DOM refs — e.g. a <canvas>
  // diagram/editor. Coordinates are viewport pixels read from the screenshot.
  | { type: "click_at"; x: number; y: number }
  | { type: "double_click"; x: number; y: number }
  | { type: "drag"; x: number; y: number; x2: number; y2: number }
  // Ref-addressed complex interactions — more reliable than guessing pixels.
  | { type: "drag_and_drop"; from: number; to: number } // drag element `from` onto `to`
  | { type: "hover"; ref: number } // reveal a hover menu / tooltip
  | { type: "right_click"; ref: number } // open a context menu
  | { type: "select_option"; ref: number; value: string } // pick an <option> by label or value
  | { type: "set_range"; ref: number; value: number } // set a native range/slider input
  | { type: "key"; keys: string; ref?: number } // press a key/chord (ArrowRight, Control+a, Escape); focuses `ref` first if given
  | { type: "finish"; success: boolean; summary: string };

/**
 * The observe-time refs an action targets, if any — used by observation-coverage
 * to mark which seen affordances were actually exercised. Coordinate gestures and
 * non-element actions (navigate/scroll/wait/finish) target nothing and return [].
 */
export function actionRefs(action: Action): number[] {
  switch (action.type) {
    case "click":
    case "type":
    case "upload":
    case "hover":
    case "right_click":
    case "select_option":
    case "set_range":
      return [action.ref];
    case "key":
      return action.ref !== undefined ? [action.ref] : [];
    case "drag_and_drop":
      return [action.from, action.to];
    case "navigate":
    case "scroll":
    case "wait":
    case "click_at":
    case "double_click":
    case "drag":
    case "finish":
      return [];
  }
}

export interface ActionResult {
  ok: boolean;
  /** Human-readable description for the step log / repro. */
  summary: string;
  error?: string;
  /**
   * The target ref no longer resolves to an element. Refs are stamped at
   * observe-time but acted on seconds later (after the model's decision), so a
   * re-render can detach the node. The engine treats this as "the page changed,
   * look again" rather than a real interaction failure.
   */
  stale?: boolean;
  /**
   * A visible, surfaced control was covered by another element at its own centre
   * and stayed covered after a short settle — a persistent occlusion, not a
   * transient overlay (a real "users can't click this" defect). The engine turns
   * this into an `occluded_control` finding instead of a generic failed click.
   */
  occluded?: boolean;
}

function selector(ref: number): string {
  return `[data-qa-ref="${ref}"]`;
}

/** Fast, non-blocking check that a ref still resolves to an element. */
async function present(el: Locator): Promise<boolean> {
  try {
    return (await el.count()) > 0;
  } catch {
    return false;
  }
}

/**
 * If a FOREIGN element covers the ref's centre point, return a short descriptor
 * of the occluder; otherwise null. "Foreign" = not the element itself, a
 * descendant, or an ancestor (so an icon inside the button, or the button's own
 * wrapper, never counts) — this deliberately favours precision: a transparent
 * ancestor "scrim" wrapping the target is not flagged, trading a rare miss for no
 * false alarms on the very common button-inside-its-own-wrapper pattern. An
 * off-screen centre returns null — those are handled by observe's viewport/inert
 * filtering, not flagged as occlusion. Pure DOM read (authored as a string for
 * the same bundler-helper-leak reason as observe.ts).
 */
async function occludedBy(page: Page, ref: number): Promise<string | null> {
  const script = `(() => {
    const el = document.querySelector('[data-qa-ref="${ref}"]');
    if (!el) return null;
    const b = el.getBoundingClientRect();
    if (b.width === 0 || b.height === 0) return null;
    const cx = b.left + b.width / 2, cy = b.top + b.height / 2;
    if (cx < 0 || cy < 0 || cx > window.innerWidth || cy > window.innerHeight) return null;
    const top = document.elementFromPoint(cx, cy);
    if (!top || top === el || el.contains(top) || top.contains(el)) return null;
    const cls = (typeof top.className === 'string' && top.className.trim())
      ? '.' + top.className.trim().split(/\\s+/)[0] : '';
    return (top.tagName.toLowerCase() + (top.id ? '#' + top.id : '') + cls).slice(0, 60);
  })()`;
  try {
    return (await page.evaluate(script)) as string | null;
  } catch {
    return null; // page navigated mid-probe etc. — treat as not-occluded
  }
}

function staleResult(ref: number): ActionResult {
  return {
    ok: false,
    stale: true,
    summary: `Target [${ref}] is no longer on the page — it changed since you looked; pick from the current elements`,
  };
}

/**
 * Draws a visible highlight box, label badge, and click marker over the target
 * element so the recording makes the agent's intent obvious — without this, a
 * DOM-resolved click is invisible in the video. Authored as a string IIFE
 * (interpolating the ref/label) to avoid leaking bundler helpers into the page.
 * The overlay auto-removes after ~1.4s so it doesn't pollute later steps.
 */
export async function annotateTarget(
  page: Page,
  ref: number,
  label: string,
): Promise<void> {
  const safeLabel = label.replace(/[<>&"'`\\]/g, " ").slice(0, 48);
  const script = `(() => {
    const el = document.querySelector('[data-qa-ref="${ref}"]');
    if (!el) return false;
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const r = el.getBoundingClientRect();
    const top = r.top + window.scrollY, left = r.left + window.scrollX;
    const layer = document.createElement('div');
    layer.id = 'qa-agent-annotation';
    layer.style.cssText = 'position:absolute;z-index:2147483647;pointer-events:none;top:0;left:0;';
    const box = document.createElement('div');
    box.style.cssText = 'position:absolute;top:'+(top-3)+'px;left:'+(left-3)+'px;width:'+(r.width+6)+'px;height:'+(r.height+6)+'px;border:3px solid #ff2d55;border-radius:6px;box-shadow:0 0 0 3px rgba(255,45,85,.25),0 0 14px rgba(255,45,85,.6);';
    const tag = document.createElement('div');
    tag.textContent = '${safeLabel}';
    tag.style.cssText = 'position:absolute;top:'+(top-26)+'px;left:'+left+'px;background:#ff2d55;color:#fff;font:600 12px/1.4 ui-sans-serif,system-ui,sans-serif;padding:2px 8px;border-radius:5px;white-space:nowrap;';
    const dot = document.createElement('div');
    dot.style.cssText = 'position:absolute;top:'+(top+r.height/2-7)+'px;left:'+(left+r.width/2-7)+'px;width:14px;height:14px;border-radius:50%;background:rgba(255,45,85,.9);box-shadow:0 0 0 6px rgba(255,45,85,.25);';
    layer.appendChild(box); layer.appendChild(tag); layer.appendChild(dot);
    document.body.appendChild(layer);
    setTimeout(() => layer.remove(), 1400);
    return true;
  })()`;
  try {
    await page.evaluate(script);
  } catch {
    /* annotation is cosmetic; never fail a step over it */
  }
}

/** Short human label for an action, used on the annotation badge. */
export function actionLabel(action: Action): string {
  switch (action.type) {
    case "click":
      return "click";
    case "type":
      return `type: ${action.text.slice(0, 24)}`;
    case "upload":
      return `upload: ${action.fixture}`;
    case "double_click":
      return "double-click";
    case "drag":
      return "drag";
    case "drag_and_drop":
      return "drag → drop";
    case "hover":
      return "hover";
    case "right_click":
      return "right-click";
    case "select_option":
      return `select: ${action.value.slice(0, 24)}`;
    case "set_range":
      return `set: ${action.value}`;
    case "key":
      return `key: ${action.keys.slice(0, 24)}`;
    default:
      return action.type;
  }
}

/** The element ref an action targets, if any (for the on-page annotation). */
export function actionRef(action: Action): number | undefined {
  switch (action.type) {
    case "click":
    case "type":
    case "upload":
    case "hover":
    case "right_click":
    case "select_option":
    case "set_range":
      return action.ref;
    case "key":
      return action.ref;
    case "drag_and_drop":
      return action.from; // annotate the source element
    default:
      return undefined;
  }
}

/**
 * Annotates the agent's intended action on the page before it acts, so the
 * recording shows it: a highlight on the target element (ref actions) or a
 * marker/box at the coordinates (canvas gestures). Returns whether anything was
 * drawn (the engine pauses briefly after, so the overlay is visible on video).
 */
export async function annotateAction(
  page: Page,
  action: Action,
): Promise<boolean> {
  const ref = actionRef(action);
  if (ref !== undefined) {
    await annotateTarget(page, ref, actionLabel(action));
    return true;
  }
  if (action.type === "click_at" || action.type === "double_click") {
    await annotatePoint(page, action.x, action.y, actionLabel(action));
    return true;
  }
  if (action.type === "drag") {
    await annotateBox(page, action.x, action.y, action.x2, action.y2);
    return true;
  }
  return false;
}

/** Draws a marker dot + label at a viewport coordinate (cosmetic, for video). */
async function annotatePoint(
  page: Page,
  x: number,
  y: number,
  label: string,
): Promise<void> {
  const safeLabel = label.replace(/[<>&"'`\\]/g, " ").slice(0, 24);
  const script = `(() => {
    const layer = document.createElement('div');
    layer.id = 'qa-agent-annotation';
    layer.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;top:0;left:0;';
    const dot = document.createElement('div');
    dot.style.cssText = 'position:fixed;top:'+(${y}-9)+'px;left:'+(${x}-9)+'px;width:18px;height:18px;border-radius:50%;background:rgba(255,45,85,.9);box-shadow:0 0 0 6px rgba(255,45,85,.25);';
    const tag = document.createElement('div');
    tag.textContent = '${safeLabel}';
    tag.style.cssText = 'position:fixed;top:'+(${y}-28)+'px;left:'+(${x}+10)+'px;background:#ff2d55;color:#fff;font:600 12px/1.4 ui-sans-serif,system-ui,sans-serif;padding:2px 8px;border-radius:5px;white-space:nowrap;';
    layer.appendChild(dot); layer.appendChild(tag);
    document.body.appendChild(layer);
    setTimeout(() => layer.remove(), 1400);
    return true;
  })()`;
  try {
    await page.evaluate(script);
  } catch {
    /* annotation is cosmetic; never fail a step over it */
  }
}

/** Draws the rectangle a drag will sweep out (cosmetic, for video). */
async function annotateBox(
  page: Page,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): Promise<void> {
  const left = Math.min(x1, x2),
    top = Math.min(y1, y2),
    w = Math.abs(x2 - x1),
    h = Math.abs(y2 - y1);
  const script = `(() => {
    const layer = document.createElement('div');
    layer.id = 'qa-agent-annotation';
    layer.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;top:0;left:0;';
    const box = document.createElement('div');
    box.style.cssText = 'position:fixed;top:${top}px;left:${left}px;width:${w}px;height:${h}px;border:3px solid #ff2d55;border-radius:4px;background:rgba(255,45,85,.12);box-shadow:0 0 14px rgba(255,45,85,.6);';
    layer.appendChild(box);
    document.body.appendChild(layer);
    setTimeout(() => layer.remove(), 1400);
    return true;
  })()`;
  try {
    await page.evaluate(script);
  } catch {
    /* annotation is cosmetic; never fail a step over it */
  }
}

export async function executeAction(
  page: Page,
  action: Action,
  fixtureResolver: (name: string) => string,
): Promise<ActionResult> {
  try {
    switch (action.type) {
      case "click": {
        const el = page.locator(selector(action.ref));
        if (!(await present(el))) return staleResult(action.ref);
        const label =
          (await el.textContent({ timeout: 2000 }).catch(() => ""))
            ?.trim()
            .slice(0, 60) ?? "";
        // Persistent-occlusion probe: if a foreign element covers the target's
        // centre, settle briefly and re-check. If it's STILL covered, the control
        // is genuinely unclickable — report it fast as occluded instead of
        // burning the full click timeout and flailing. The settle re-check filters
        // transient overlays (a closing dropdown, a mid-flight animation).
        const occ = await occludedBy(page, action.ref);
        if (occ) {
          await page.waitForTimeout(400);
          if (!(await present(el))) return staleResult(action.ref);
          const occ2 = await occludedBy(page, action.ref);
          if (occ2) {
            return {
              ok: false,
              occluded: true,
              summary:
                `Click on [${action.ref}] ${label} blocked — covered by ${occ2}`.trim(),
              error: `target occluded by ${occ2}`,
            };
          }
        }
        await el.click({ timeout: 8000 });
        return { ok: true, summary: `Clicked [${action.ref}] ${label}`.trim() };
      }
      case "type": {
        const el = page.locator(selector(action.ref));
        if (!(await present(el))) return staleResult(action.ref);
        await el.fill(action.text, { timeout: 8000 });
        if (action.submit) await el.press("Enter");
        return {
          ok: true,
          summary: `Typed "${action.text.slice(0, 40)}"${
            action.submit ? " + Enter" : ""
          } into [${action.ref}]`,
        };
      }
      case "upload": {
        const el = page.locator(selector(action.ref));
        if (!(await present(el))) return staleResult(action.ref);
        const path = fixtureResolver(action.fixture);
        await el.setInputFiles(path);
        return {
          ok: true,
          summary: `Uploaded ${action.fixture} via [${action.ref}]`,
        };
      }
      case "navigate": {
        await page.goto(new URL(action.path, page.url()).toString(), {
          waitUntil: "domcontentloaded",
        });
        return { ok: true, summary: `Navigated to ${action.path}` };
      }
      case "scroll": {
        const dy = action.direction === "down" ? 600 : -600;
        await page.mouse.wheel(0, dy);
        return { ok: true, summary: `Scrolled ${action.direction}` };
      }
      case "click_at": {
        await page.mouse.click(action.x, action.y);
        return { ok: true, summary: `Clicked at (${action.x}, ${action.y})` };
      }
      case "double_click": {
        await page.mouse.dblclick(action.x, action.y);
        return {
          ok: true,
          summary: `Double-clicked at (${action.x}, ${action.y})`,
        };
      }
      case "drag": {
        // Press, move in steps (canvas draw handlers need intermediate moves),
        // release — sweeps a box from (x,y) to (x2,y2).
        await page.mouse.move(action.x, action.y);
        await page.mouse.down();
        await page.mouse.move(action.x2, action.y2, { steps: 12 });
        await page.mouse.up();
        return {
          ok: true,
          summary: `Dragged (${action.x},${action.y}) → (${action.x2},${action.y2})`,
        };
      }
      case "drag_and_drop": {
        const src = page.locator(selector(action.from));
        const dst = page.locator(selector(action.to));
        if (!(await present(src))) return staleResult(action.from);
        if (!(await present(dst))) return staleResult(action.to);
        // Playwright's dragTo performs the full sequence (hover → mousedown →
        // stepped mousemove → mouseup) AND dispatches the HTML5 drag events, so
        // it covers both native draggable=true DnD and most pointer-based
        // framework DnD (react-dnd, dnd-kit, react-beautiful-dnd).
        await src.dragTo(dst, { timeout: 8000 });
        return {
          ok: true,
          summary: `Dragged [${action.from}] onto [${action.to}]`,
        };
      }
      case "hover": {
        const el = page.locator(selector(action.ref));
        if (!(await present(el))) return staleResult(action.ref);
        await el.hover({ timeout: 8000 });
        return { ok: true, summary: `Hovered [${action.ref}]` };
      }
      case "right_click": {
        const el = page.locator(selector(action.ref));
        if (!(await present(el))) return staleResult(action.ref);
        await el.click({ button: "right", timeout: 8000 });
        return { ok: true, summary: `Right-clicked [${action.ref}]` };
      }
      case "select_option": {
        const el = page.locator(selector(action.ref));
        if (!(await present(el))) return staleResult(action.ref);
        // The agent sees the visible option text, so try label first, then value.
        await el
          .selectOption({ label: action.value }, { timeout: 4000 })
          .catch(() => el.selectOption(action.value, { timeout: 4000 }));
        return {
          ok: true,
          summary: `Selected "${action.value}" in [${action.ref}]`,
        };
      }
      case "set_range": {
        const el = page.locator(selector(action.ref));
        if (!(await present(el))) return staleResult(action.ref);
        // Native <input type=range>: fill sets the value and fires input/change.
        // Custom (div/role=slider) sliders aren't fillable — use `key` with arrows.
        await el.fill(String(action.value), { timeout: 8000 });
        return {
          ok: true,
          summary: `Set [${action.ref}] to ${action.value}`,
        };
      }
      case "key": {
        if (action.ref !== undefined) {
          const el = page.locator(selector(action.ref));
          if (await present(el)) await el.focus().catch(() => {});
        }
        await page.keyboard.press(action.keys);
        return {
          ok: true,
          summary: `Pressed ${action.keys}${
            action.ref !== undefined ? ` on [${action.ref}]` : ""
          }`,
        };
      }
      case "wait": {
        await page.waitForTimeout(Math.min(action.ms, 10000));
        return { ok: true, summary: `Waited ${action.ms}ms` };
      }
      case "finish": {
        return {
          ok: true,
          summary: `Finished: ${action.success ? "success" : "give up"} — ${action.summary}`,
        };
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, summary: `Failed ${action.type}`, error: message };
  }
}

/** JSON-schema description of actions, handed to the model as a tool. */
export const ACTION_TOOL_SCHEMA = {
  name: "act",
  description:
    "Take a single action on the page as a human user would. Prefer addressing elements by their [ref] number. Elements carry a cap= hint for special interactions: cap=draggable → drag_and_drop {from,to}; cap=slider → set_range {ref,value} or key with ArrowLeft/ArrowRight; cap=select → select_option {ref,value}; cap=editable → click then type; cap=menu → hover or click to open it. Use right_click to open context menus, hover to reveal hover-only menus/tooltips, and key for keyboard interactions (ArrowRight, Enter, Escape, Control+a). For areas drawn on a <canvas> with no refs (a diagram/editor), act by pixel coordinates from the screenshot using click_at/double_click/drag.",
  input_schema: {
    type: "object" as const,
    properties: {
      type: {
        type: "string",
        enum: [
          "click",
          "type",
          "upload",
          "navigate",
          "scroll",
          "wait",
          "click_at",
          "double_click",
          "drag",
          "drag_and_drop",
          "hover",
          "right_click",
          "select_option",
          "set_range",
          "key",
          "finish",
        ],
      },
      from: {
        type: "number",
        description: "Source element ref to pick up (drag_and_drop).",
      },
      to: {
        type: "number",
        description: "Target element ref to drop onto (drag_and_drop).",
      },
      value: {
        type: "string",
        description:
          "Option label/value for select_option, or the numeric value for set_range.",
      },
      keys: {
        type: "string",
        description:
          "Key or chord to press (key action): e.g. ArrowRight, Enter, Escape, Control+a.",
      },
      ref: {
        type: "number",
        description: "Element ref for click/type/upload.",
      },
      text: { type: "string", description: "Text to type (type action)." },
      submit: { type: "boolean", description: "Press Enter after typing." },
      fixture: {
        type: "string",
        description: "Fixture file name (upload action).",
      },
      path: {
        type: "string",
        description: "Path to navigate to (navigate action).",
      },
      direction: { type: "string", enum: ["up", "down"] },
      ms: {
        type: "number",
        description: "Milliseconds to wait (wait action).",
      },
      x: {
        type: "number",
        description:
          "X pixel (from screenshot left) for click_at/double_click/drag start.",
      },
      y: {
        type: "number",
        description:
          "Y pixel (from screenshot top) for click_at/double_click/drag start.",
      },
      x2: {
        type: "number",
        description: "X pixel of the drag end point (drag action).",
      },
      y2: {
        type: "number",
        description: "Y pixel of the drag end point (drag action).",
      },
      success: {
        type: "boolean",
        description: "For finish: whether the goal was accomplished.",
      },
      summary: {
        type: "string",
        description: "For finish: one sentence on the outcome.",
      },
      rationale: {
        type: "string",
        description: "Why you chose this action, in one sentence.",
      },
    },
    required: ["type", "rationale"],
  },
};
