/**
 * Wait for a page to stop changing before we observe or act on it.
 *
 * The engine used to act after a fixed 500ms, which meant the first observe/act
 * often landed mid-hydration: refs were stamped on nodes React then replaced
 * (stale-ref timeouts), and "act-during-hydration" crashes ("Rendered more
 * hooks than during the previous render") fired. settle() waits for the page to
 * actually quiesce, with hard caps so it can't hang.
 *
 * The decisive signal is DOM quiescence (no mutations for a short window), which
 * is what catches hydration and SPA renders. networkidle is a cheap best-effort
 * on top — capped, because SSE/long-poll apps (e.g. streamed chat) never reach
 * true idle and an unbounded wait would stall every step.
 *
 * settle() returns whether the page actually quiesced (network idle AND DOM
 * quiet within the caps). Some pages — a live canvas editor, a streaming chat —
 * never settle, so paying the full caps every step is pure waste. The engine
 * tracks that and, once a page has demonstrably failed to settle, calls
 * settle(page, {fast:true}) which uses much shorter caps. Initial loads always
 * use the full caps (we genuinely need to wait for first paint / hydration).
 */

import type { Page } from "playwright";

const FULL = {
  networkIdleMs: 1000,
  domQuietMaxMs: 1500,
  domQuietPeriodMs: 200,
};
const FAST = { networkIdleMs: 250, domQuietMaxMs: 500, domQuietPeriodMs: 150 };

/** Returns true if the page reached quiescence (didn't just hit the caps). */
export async function settle(
  page: Page,
  opts: { fast?: boolean } = {},
): Promise<boolean> {
  const t = opts.fast ? FAST : FULL;
  try {
    await page.waitForLoadState("domcontentloaded", { timeout: 5000 });
  } catch {
    /* best-effort */
  }
  // SSE / long-poll apps never reach true network idle — cap and continue.
  let networkIdle = true;
  await page
    .waitForLoadState("networkidle", { timeout: t.networkIdleMs })
    .catch(() => {
      networkIdle = false;
    });
  // Wait until the DOM stops mutating for a quiet window (bounded). Authored as
  // a string so page.evaluate doesn't receive a transpiled function reference,
  // which leaks bundler helpers (e.g. __name) into the page — see observe.ts.
  // Resolves true if a quiet window was reached, false if it hit the hard cap.
  let domQuiet = false;
  try {
    domQuiet = (await page.evaluate(
      domQuietScript(t.domQuietMaxMs, t.domQuietPeriodMs),
    )) as boolean;
  } catch {
    /* page navigated mid-evaluate, etc. — treat as not-quiet */
  }
  return networkIdle && domQuiet;
}

function domQuietScript(maxMs: number, quietMs: number): string {
  return `new Promise((resolve) => {
    if (!document.documentElement) return resolve(true);
    let timer;
    const finish = (quiet) => {
      try { mo.disconnect(); } catch (e) {}
      clearTimeout(timer); clearTimeout(hard); resolve(quiet);
    };
    const bump = () => { clearTimeout(timer); timer = setTimeout(() => finish(true), ${quietMs}); };
    const mo = new MutationObserver(bump);
    mo.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
    const hard = setTimeout(() => finish(false), ${maxMs});
    bump();
  })`;
}
