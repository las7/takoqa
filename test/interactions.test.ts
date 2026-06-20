/**
 * Complex-interaction primitives + capability perception, against real Chromium
 * fixtures via setContent (no fixture-server dependency).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium, type Browser } from "playwright";
import { observe } from "../src/observe.js";
import { executeAction } from "../src/act.js";

const resolver = (n: string) => n;

async function withPage<T>(
  html: string,
  fn: (page: Awaited<ReturnType<Browser["newPage"]>>) => Promise<T>,
): Promise<T> {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(html);
    return await fn(page);
  } finally {
    await browser.close();
  }
}

test("observe tags interaction capabilities (slider/select/editable/draggable)", async () => {
  await withPage(
    `<select><option>Alpha</option><option>Beta</option></select>
     <input type="range" min="0" max="100" value="10" aria-label="vol">
     <div contenteditable="true">edit me</div>
     <div draggable="true">a draggable card</div>`,
    async (page) => {
      const obs = await observe(page);
      const caps = obs.elements
        .map((e) => e.cap)
        .filter(Boolean)
        .sort();
      assert.ok(caps.includes("select"), "select tagged");
      assert.ok(caps.includes("slider"), "range tagged as slider");
      assert.ok(caps.includes("editable"), "contenteditable tagged");
      assert.ok(caps.includes("draggable"), "draggable tagged");
      // and it renders into the model-facing line
      const { renderObservation } = await import("../src/observe.js");
      assert.match(renderObservation(obs), /cap=draggable/);
    },
  );
});

test("select_option picks an <option> by visible label", async () => {
  await withPage(
    `<select data-qa-ref="0"><option>Alpha</option><option>Beta</option></select>`,
    async (page) => {
      const res = await executeAction(
        page,
        { type: "select_option", ref: 0, value: "Beta" },
        resolver,
      );
      assert.equal(res.ok, true);
      assert.equal(await page.locator("select").inputValue(), "Beta");
    },
  );
});

test("set_range sets a native range input's value", async () => {
  await withPage(
    `<input data-qa-ref="0" type="range" min="0" max="100" value="10">`,
    async (page) => {
      const res = await executeAction(
        page,
        { type: "set_range", ref: 0, value: 80 },
        resolver,
      );
      assert.equal(res.ok, true);
      assert.equal(await page.locator("input").inputValue(), "80");
    },
  );
});

test("hover triggers a hover-only handler", async () => {
  await withPage(
    `<div data-qa-ref="0" onmouseover="this.dataset.hovered='1'">menu</div>`,
    async (page) => {
      const res = await executeAction(
        page,
        { type: "hover", ref: 0 },
        resolver,
      );
      assert.equal(res.ok, true);
      assert.equal(await page.locator("div").getAttribute("data-hovered"), "1");
    },
  );
});

test("right_click opens a context-menu handler", async () => {
  await withPage(
    `<div data-qa-ref="0" oncontextmenu="this.dataset.ctx='1';return false">r</div>`,
    async (page) => {
      const res = await executeAction(
        page,
        { type: "right_click", ref: 0 },
        resolver,
      );
      assert.equal(res.ok, true);
      assert.equal(await page.locator("div").getAttribute("data-ctx"), "1");
    },
  );
});

test("key presses a key on the focused ref", async () => {
  await withPage(`<input data-qa-ref="0">`, async (page) => {
    const res = await executeAction(
      page,
      { type: "key", keys: "a", ref: 0 },
      resolver,
    );
    assert.equal(res.ok, true);
    assert.equal(await page.locator("input").inputValue(), "a");
  });
});

test("drag_and_drop fires native HTML5 drag/drop on the target", async () => {
  await withPage(
    `<div id="src" data-qa-ref="0" draggable="true" style="width:80px;height:40px">item</div>
     <div id="dst" data-qa-ref="1" style="width:120px;height:80px;margin-top:40px">target</div>
     <script>
       const dst = document.getElementById('dst');
       dst.addEventListener('dragover', e => e.preventDefault());
       dst.addEventListener('drop', e => { e.preventDefault(); dst.textContent = 'DROPPED'; });
     </script>`,
    async (page) => {
      const res = await executeAction(
        page,
        { type: "drag_and_drop", from: 0, to: 1 },
        resolver,
      );
      assert.equal(res.ok, true);
      assert.equal(await page.locator("#dst").textContent(), "DROPPED");
    },
  );
});

test("drag_and_drop / select_option report stale when the ref is gone", async () => {
  await withPage(`<div data-qa-ref="0">only</div>`, async (page) => {
    const dd = await executeAction(
      page,
      { type: "drag_and_drop", from: 0, to: 9 },
      resolver,
    );
    assert.equal(dd.stale, true, "missing drop target → stale");
    const so = await executeAction(
      page,
      { type: "select_option", ref: 7, value: "x" },
      resolver,
    );
    assert.equal(so.stale, true, "missing select → stale");
  });
});
