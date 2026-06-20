/**
 * Turns the live page into something an LLM can reason over.
 *
 * Strategy: in-page, find every visible interactive element, stamp it with a
 * stable `data-qa-ref` integer, and emit a compact one-line-per-element list.
 * The agent acts by ref, so we never ask the LLM to invent CSS selectors
 * (brittle) — it picks a number, and the executor resolves it.
 */

import type { Page } from "playwright";

export interface ObservedElement {
  ref: number;
  tag: string;
  role: string;
  label: string;
  /**
   * Interaction capability hint, when the element supports something beyond a
   * plain click: "draggable" | "slider" | "select" | "editable" | "menu".
   * Surfaced to the agent so it reaches for drag_and_drop / set_range /
   * select_option / hover instead of guessing. Empty/undefined = plain control.
   */
  cap?: string;
}

export interface Observation {
  url: string;
  title: string;
  /** Compact, numbered list of interactive elements. */
  elements: ObservedElement[];
  /** Trimmed visible text, for context the element list misses. */
  visibleText: string;
  /** PNG screenshot as base64, fed to the model's vision. */
  screenshotBase64: string;
  /** Viewport size in CSS pixels — the coordinate space for canvas gestures. */
  viewport: { width: number; height: number };
  /** On-screen interactive elements that exceeded the cap and weren't listed. */
  truncated?: number;
  /** Accessibility signals from the observe DOM scan (best-effort; absent if the
   *  scan failed or found nothing). Rules: <img> with no alt, and an interactive
   *  control with no accessible name. */
  a11y?: {
    imagesMissingAlt?: { total: number; samples: string[] };
    controlsMissingName?: { total: number; samples: string[] };
    fieldsMissingLabel?: { total: number; samples: string[] };
    orphanLabels?: { total: number; samples: string[] };
  };
  /** DOM-correctness signals from the observe scan (best-effort; absent if none).
   *  Rule: element ids that appear more than once in the document. */
  dom?: {
    duplicateIds: { total: number; samples: string[] };
  };
}

/**
 * Most interactive elements shown to the model in one observation. A dense app
 * (e.g. a canvas editor) can expose hundreds of DOM controls; sending them all
 * makes the prompt huge and slow and gives the model worse choices. We show the
 * most prominent on-screen ones and let the agent scroll to reveal the rest.
 */
const MAX_ELEMENTS = 100;

/**
 * Browser-side script that tags the RELEVANT, on-screen interactive elements
 * with a `data-qa-ref` integer and returns the compact list. "Relevant" =
 * within the viewport, not hidden/disabled, and either a real control or a
 * clickable that at least has a role/label (decorative onclick wrappers and
 * canvas overlay handles are dropped). Capped + prioritized by reading order.
 *
 * Authored as a STRING IIFE on purpose: passing a transpiled function reference
 * to page.evaluate leaks bundler helpers (e.g. esbuild's `__name`) into the page
 * context, which throws "__name is not defined". A plain string expression is
 * evaluated verbatim in the page and sidesteps that entirely.
 */
/**
 * Two near-identical in-page "is this element hidden?" tests — they DELIBERATELY
 * differ on opacity:0. Both exclude display:none / visibility:hidden / an [inert]
 * or [aria-hidden] ancestor.
 *
 * HIDDEN_HELPER (TAG_SCRIPT): ALSO treats opacity:0 as hidden — a transparent
 * control is a phantom click target the agent must not be offered.
 *
 * A11Y_HIDDEN_HELPER (A11Y_SCRIPT): does NOT treat opacity:0 as hidden — an
 * opacity:0 element is still in the accessibility tree (keyboard-focusable,
 * announced by a screen reader), so an unlabeled one IS a real a11y violation.
 * Only display:none / visibility:hidden / [inert] / [aria-hidden] actually remove
 * an element from the a11y tree, so only those are excluded from the a11y scan.
 */
const HIDDEN_HELPER = `const hidden = (el) => {
    const s = window.getComputedStyle(el);
    if (s.visibility === 'hidden' || s.display === 'none' || s.opacity === '0') return true;
    return !!el.closest('[inert], [aria-hidden="true"]');
  };`;
const A11Y_HIDDEN_HELPER = `const hidden = (el) => {
    const s = window.getComputedStyle(el);
    if (s.visibility === 'hidden' || s.display === 'none') return true;
    return !!el.closest('[inert], [aria-hidden="true"]');
  };`;

const TAG_SCRIPT = `(() => {
  // Clear refs from the previous observe so the new (smaller, filtered) set is
  // the ONLY thing carrying data-qa-ref — a recycled ref number must not also
  // still match an old, now-unsurfaced element (which would make clicks
  // ambiguous / resolve the wrong node).
  for (const el of document.querySelectorAll('[data-qa-ref]')) el.removeAttribute('data-qa-ref');

  const sel = 'a, button, input, textarea, select, [role=button], [role=link], [role=tab], [role=menuitem], [role=slider], [contenteditable=""], [contenteditable=true], [onclick], [draggable=true], [data-rbd-draggable-id], [aria-roledescription=sortable]';
  // Interaction-capability hint beyond plain click: tells the agent to reach for
  // drag_and_drop / set_range / select_option / hover. Matches the common DnD
  // libraries (react-beautiful-dnd, dnd-kit) by their markers, plus native
  // draggable=true, range/slider, <select>, and contenteditable.
  const capOf = (el, tag, role) => {
    const t = (el.getAttribute('type') || '').toLowerCase();
    if ((tag === 'input' && t === 'range') || role === 'slider') return 'slider';
    if (tag === 'select') return 'select';
    if (el.isContentEditable) return 'editable';
    if (el.getAttribute('draggable') === 'true' || el.closest('[draggable=true],[data-rbd-draggable-id],[aria-roledescription=sortable]')) return 'draggable';
    if (el.getAttribute('aria-haspopup')) return 'menu';
    return '';
  };
  const vw = window.innerWidth, vh = window.innerHeight;
  const onScreen = (r) => r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < vh && r.left < vw;
  ${HIDDEN_HELPER}
  const disabled = (el) => el.disabled === true || el.getAttribute('aria-disabled') === 'true';
  const labelFor = (el) => {
    const aria = el.getAttribute('aria-label');
    if (aria) return aria.trim().slice(0, 120);
    const placeholder = el.getAttribute('placeholder') || '';
    const value = el.value || '';
    const text = (el.innerText || value || placeholder || el.getAttribute('name') || el.getAttribute('title') || '').replace(/\\s+/g, ' ').trim();
    return text.slice(0, 120);
  };
  const STRONG = { a: 1, button: 1, input: 1, textarea: 1, select: 1 };
  const cands = [];
  for (const el of document.querySelectorAll(sel)) {
    const r = el.getBoundingClientRect();
    if (!onScreen(r) || hidden(el) || disabled(el)) continue;
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute('role') || el.getAttribute('type') || '';
    const label = labelFor(el);
    // Drop generic clickable divs/spans with neither a role nor a label
    // (decorative onclick wrappers, canvas overlay handles).
    if (!STRONG[tag] && !role && !label) continue;
    cands.push({ el: el, tag: tag, role: role, label: label, top: r.top, left: r.left });
  }
  // Prioritize by reading order (top band, then left) so the most prominent
  // controls survive the cap.
  cands.sort((a, b) => (Math.round(a.top / 40) - Math.round(b.top / 40)) || (a.left - b.left));
  const out = [];
  let ref = 0;
  for (const c of cands) {
    if (ref >= ${MAX_ELEMENTS}) break;
    c.el.setAttribute('data-qa-ref', String(ref));
    out.push({ ref: ref, tag: c.tag, role: c.role, label: c.label, cap: capOf(c.el, c.tag, c.role) });
    ref++;
  }
  return { elements: out, total: cands.length, shown: out.length };
})()`;

const VISIBLE_TEXT_SCRIPT = `(() => (document.body ? document.body.innerText : ''))()`;

/**
 * Browser-side accessibility scan. Authored as a STRING for the same bundler-leak
 * reason as TAG_SCRIPT (a function passed to page.evaluate leaks esbuild's
 * __name). Four rules, all conservatively scoped (err toward NOT flagging, so it
 * stays low-false-positive); rules 1-3 are RENDERED-only:
 *   1. imagesMissingAlt — an <img> with no alt attribute (WCAG 1.1.1). alt=""
 *      counts as present (decorative); aria-hidden / role=presentation|none,
 *      non-rendered, and 1–2px tracking-pixel/spacer beacons are excluded.
 *   2. controlsMissingName — a button / link / [role=button|link] with NO
 *      accessible name (WCAG 4.1.2): no aria-label(ledby), no trimmed text
 *      content (which includes visually-hidden sr-only text), no title/value, no
 *      labelled child img/svg. The icon-only-button-with-no-aria-label case.
 *   3. fieldsMissingLabel — an input (non-button type) / select / textarea with
 *      NO label (WCAG 4.1.2 / 3.3.2): no <label for>, no wrapping <label>, no
 *      aria-label(ledby), no title, no placeholder. The unlabeled-form-field case.
 *   4. orphanLabels — a <label for="x"> whose target id does not exist (WCAG
 *      1.3.1): the label is programmatically associated with nothing. (Not
 *      rendered-gated — an orphaned label is broken whether or not it's on-screen.)
 * Returns a capped sample per rule.
 */
const A11Y_SCRIPT = `(() => {
  const SAMPLE_CAP = 25;
  ${A11Y_HIDDEN_HELPER}

  const missingAlt = [];
  const imgs = document.querySelectorAll('img');
  for (let i = 0; i < imgs.length; i++) {
    const img = imgs[i];
    if (img.hasAttribute('alt')) continue;
    const role = (img.getAttribute('role') || '').toLowerCase();
    if (role === 'presentation' || role === 'none') continue;
    if (hidden(img)) continue;
    if (img.getClientRects().length === 0) continue;
    const r = img.getBoundingClientRect();
    if (r.width <= 2 || r.height <= 2) continue;
    const src = (img.currentSrc || img.getAttribute('src') || '(no src)').split('?')[0];
    missingAlt.push(src.length > 80 ? '…' + src.slice(-79) : src);
  }

  const hasName = (el) => {
    const lb = el.getAttribute('aria-labelledby');
    if (lb) {
      let s = '';
      const ids = lb.split(/\\s+/);
      for (let j = 0; j < ids.length; j++) {
        const t = document.getElementById(ids[j]);
        if (t) s += ' ' + (t.textContent || t.getAttribute('aria-label') || '');
      }
      if (s.trim()) return true;
    }
    if ((el.getAttribute('aria-label') || '').trim()) return true;
    if ((el.textContent || '').trim()) return true;
    if ((el.getAttribute('title') || '').trim()) return true;
    if ((el.getAttribute('value') || '').trim()) return true;
    const im = el.querySelector('img[alt]');
    if (im && (im.getAttribute('alt') || '').trim()) return true;
    const svg = el.matches('svg') ? el : el.querySelector('svg');
    if (svg) {
      if ((svg.getAttribute('aria-label') || '').trim()) return true;
      const tt = svg.querySelector('title');
      if (tt && (tt.textContent || '').trim()) return true;
    }
    // A non-empty aria-label on ANY descendant contributes to the subtree name
    // (so an icon wrapped in <i aria-label> counts). This can over-clear in rare
    // nesting, but only in the false-NEGATIVE direction — fine for a low-FP rule.
    const lab = el.querySelector('[aria-label]');
    if (lab && (lab.getAttribute('aria-label') || '').trim()) return true;
    return false;
  };
  const noName = [];
  const ctrls = document.querySelectorAll('button, a[href], [role=button], [role=link]');
  for (let i = 0; i < ctrls.length; i++) {
    const el = ctrls[i];
    if (hidden(el)) continue;
    if (el.getClientRects().length === 0) continue;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    if (hasName(el)) continue;
    const ident = el.id
      ? '#' + el.id
      : (typeof el.className === 'string' && el.className.trim()
          ? '.' + el.className.trim().split(/\\s+/)[0]
          : '');
    noName.push(el.tagName.toLowerCase() + ident);
  }

  const hasFieldLabel = (el) => {
    if (el.id) {
      const esc = (window.CSS && CSS.escape) ? CSS.escape(el.id) : el.id;
      const lf = document.querySelector('label[for="' + esc + '"]');
      if (lf && (lf.textContent || '').trim()) return true;
    }
    const wrap = el.closest('label');
    if (wrap && (wrap.textContent || '').trim()) return true;
    if ((el.getAttribute('aria-label') || '').trim()) return true;
    const lb = el.getAttribute('aria-labelledby');
    if (lb) {
      // KNOWN GAP (rare, false-positive direction, same as hasName above): we read
      // the target's textContent / own aria-label, not the full recursive accname,
      // so an aria-labelledby target named ONLY by a child <img alt>/icon is missed
      // and the field is flagged. Acceptable for a low-FP, non-gating rule.
      let s = '';
      const ids = lb.split(/\\s+/);
      for (let j = 0; j < ids.length; j++) {
        const t = document.getElementById(ids[j]);
        if (t) s += ' ' + (t.textContent || t.getAttribute('aria-label') || '');
      }
      if (s.trim()) return true;
    }
    if ((el.getAttribute('title') || '').trim()) return true;
    // placeholder is the last-resort accessible name (HTML-AAM), so a placeholder
    // satisfies WCAG 4.1.2 'name' even though 3.3.2 still wants a visible label —
    // counting it keeps THIS (no-name) rule conservative and low-false-positive.
    if ((el.getAttribute('placeholder') || '').trim()) return true;
    return false;
  };
  const SKIP_INPUT_TYPES = { hidden: 1, submit: 1, button: 1, image: 1, reset: 1 };
  const noLabel = [];
  const fields = document.querySelectorAll('input, select, textarea');
  for (let i = 0; i < fields.length; i++) {
    const el = fields[i];
    const type = (el.getAttribute('type') || '').toLowerCase();
    if (el.tagName.toLowerCase() === 'input' && SKIP_INPUT_TYPES[type]) continue;
    if (hidden(el)) continue;
    if (el.getClientRects().length === 0) continue;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    if (hasFieldLabel(el)) continue;
    noLabel.push(el.tagName.toLowerCase() + (el.id ? '#' + el.id : (type ? '[type=' + type + ']' : '')));
  }

  // rule 4: a <label for="x"> whose target id does not exist — an orphaned label
  // with no programmatic association (clicking it focuses nothing; SR announces no
  // name for the field). Deduped by for-value.
  const orphan = [];
  const seenFor = Object.create(null);
  const labels = document.querySelectorAll('label[for]');
  for (let i = 0; i < labels.length; i++) {
    const f = labels[i].getAttribute('for');
    if (!f || seenFor[f]) continue;
    seenFor[f] = 1;
    if (!document.getElementById(f)) orphan.push(f.length > 60 ? f.slice(0, 60) : f);
  }

  return {
    imagesMissingAlt: { total: missingAlt.length, samples: missingAlt.slice(0, SAMPLE_CAP) },
    controlsMissingName: { total: noName.length, samples: noName.slice(0, SAMPLE_CAP) },
    fieldsMissingLabel: { total: noLabel.length, samples: noLabel.slice(0, SAMPLE_CAP) },
    orphanLabels: { total: orphan.length, samples: orphan.slice(0, SAMPLE_CAP) },
  };
})()`;

/**
 * Browser-side DOM-correctness scan (string-authored, same bundler-leak reason as
 * TAG_SCRIPT). Rule: element ids that appear MORE THAN ONCE — an unambiguous HTML
 * spec violation that breaks <label for>, getElementById, aria-labelledby refs and
 * fragment navigation (they all silently resolve to the first match). Reports each
 * duplicated id VALUE with its count, capped.
 */
const DOM_AUDIT_SCRIPT = `(() => {
  const SAMPLE_CAP = 25;
  const counts = Object.create(null);
  const els = document.querySelectorAll('[id]');
  for (let i = 0; i < els.length; i++) {
    const id = els[i].id;
    if (!id) continue;
    // Skip ids INSIDE an <svg> — an inlined sprite/<symbol>/<defs> gradient reused
    // across two inline SVGs duplicates ids that <use>/url(#id) resolve to the first
    // (usually identical) match: a technically-invalid but harmless, high-volume
    // pattern. Real duplicate-id BUGS (broken label-for/getElementById) are on HTML
    // elements, so scope to those for signal.
    if (els[i].closest('svg')) continue;
    counts[id] = (counts[id] || 0) + 1;
  }
  const dups = [];
  for (const id in counts) {
    if (counts[id] > 1) dups.push((id.length > 60 ? id.slice(0, 60) : id) + ' (×' + counts[id] + ')');
  }
  return { duplicateIds: { total: dups.length, samples: dups.slice(0, SAMPLE_CAP) } };
})()`;

/** 1x1 transparent PNG, used when a screenshot can't be captured. */
const BLANK_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

/**
 * Captures a PNG screenshot, tolerant of transient capture failures. Headless
 * Chromium intermittently rejects `Page.captureScreenshot` ("Unable to capture
 * screenshot — waiting for fonts to load") under load; left unguarded this
 * throws and aborts the entire mission. A missing frame should degrade the
 * model's vision for a single step, never crash the run — so we retry a few
 * times and fall back to a blank frame.
 */
export async function captureScreenshot(page: Page): Promise<Buffer> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await page.screenshot({ type: "png", timeout: 5000 });
    } catch {
      await page.waitForTimeout(150).catch(() => {});
    }
  }
  return BLANK_PNG;
}

export async function observe(page: Page): Promise<Observation> {
  const tagged = (await page.evaluate(TAG_SCRIPT)) as {
    elements: ObservedElement[];
    total: number;
    shown: number;
  };
  const visibleText = (await page.evaluate(VISIBLE_TEXT_SCRIPT)) as string;
  const screenshot = await captureScreenshot(page);

  // a11y scan is best-effort: an evaluate failure must never abort a mission.
  let a11y: Observation["a11y"];
  try {
    const scan = (await page.evaluate(A11Y_SCRIPT)) as {
      imagesMissingAlt: { total: number; samples: string[] };
      controlsMissingName: { total: number; samples: string[] };
      fieldsMissingLabel: { total: number; samples: string[] };
      orphanLabels: { total: number; samples: string[] };
    };
    const a: NonNullable<Observation["a11y"]> = {};
    if (scan.imagesMissingAlt.total > 0)
      a.imagesMissingAlt = scan.imagesMissingAlt;
    if (scan.controlsMissingName.total > 0)
      a.controlsMissingName = scan.controlsMissingName;
    if (scan.fieldsMissingLabel.total > 0)
      a.fieldsMissingLabel = scan.fieldsMissingLabel;
    if (scan.orphanLabels.total > 0) a.orphanLabels = scan.orphanLabels;
    if (
      a.imagesMissingAlt ||
      a.controlsMissingName ||
      a.fieldsMissingLabel ||
      a.orphanLabels
    )
      a11y = a;
  } catch {
    /* degrade to no a11y data for this step */
  }

  // DOM-correctness scan is best-effort too.
  let dom: Observation["dom"];
  try {
    const scan = (await page.evaluate(DOM_AUDIT_SCRIPT)) as {
      duplicateIds: { total: number; samples: string[] };
    };
    if (scan.duplicateIds.total > 0) dom = { duplicateIds: scan.duplicateIds };
  } catch {
    /* degrade to no dom data for this step */
  }

  const vp = page.viewportSize() ?? { width: 1280, height: 900 };

  return {
    url: page.url(),
    title: await page.title(),
    elements: tagged.elements,
    truncated: Math.max(0, tagged.total - tagged.shown),
    visibleText: visibleText.replace(/\s+\n/g, "\n").trim().slice(0, 3000),
    screenshotBase64: screenshot.toString("base64"),
    viewport: vp,
    a11y,
    dom,
  };
}

/** Renders the observation as the text block shown to the model. */
export function renderObservation(obs: Observation): string {
  const lines = obs.elements.map(
    (e) =>
      `[${e.ref}] <${e.tag}${e.role ? ` role=${e.role}` : ""}${e.cap ? ` cap=${e.cap}` : ""}> ${e.label}`,
  );
  const parts = [
    `URL: ${obs.url}`,
    `TITLE: ${obs.title}`,
    `VIEWPORT: ${obs.viewport.width}x${obs.viewport.height} px (coordinate space for click_at/double_click/drag on canvas areas)`,
    ``,
    `INTERACTIVE ELEMENTS (on-screen only — scroll to reveal others):`,
    lines.length ? lines.join("\n") : "(none detected)",
  ];
  if (obs.truncated && obs.truncated > 0) {
    parts.push(
      `(+${obs.truncated} more on-screen element(s) beyond the top ${MAX_ELEMENTS} — refine by scrolling or acting on what's visible)`,
    );
  }
  parts.push(``, `VISIBLE TEXT (truncated):`, obs.visibleText);
  return parts.join("\n");
}
