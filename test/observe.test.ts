/**
 * observe() must not surface controls inside an explicitly non-interactive
 * subtree — an [inert] container (e.g. a closed slide-over translated off-screen)
 * or an aria-hidden one. Surfacing them makes the agent click phantom targets and
 * stall on pointer-event-interception timeouts.
 *
 * Real browser via setContent (no fixture-server / eval-dataset dependency).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { observe } from "../src/observe.js";

test("observe skips controls inside [inert] and aria-hidden subtrees", async () => {
  const browser = await chromium.launch({
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <button>Visible Button</button>
      <div inert>
        <button>Inert Phantom</button>
        <a href="/x">Inert Link</a>
      </div>
      <div aria-hidden="true">
        <button>AriaHidden Phantom</button>
      </div>
    `);

    const obs = await observe(page);
    const labels = obs.elements.map((e) => e.label);

    assert.ok(
      labels.includes("Visible Button"),
      "a normal interactive control is surfaced",
    );
    assert.ok(
      !labels.some((l) => l.includes("Inert")),
      `inert-subtree controls must not be surfaced — got [${labels.join(", ")}]`,
    );
    assert.ok(
      !labels.some((l) => l.includes("AriaHidden")),
      `aria-hidden-subtree controls must not be surfaced — got [${labels.join(", ")}]`,
    );
  } finally {
    await browser.close();
  }
});
