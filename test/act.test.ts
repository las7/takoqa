/**
 * The click occlusion probe: a control whose centre is PERSISTENTLY covered by a
 * foreign element is reported occluded (fast, instead of burning the click
 * timeout); a TRANSIENT overlay that clears within the settle window does NOT
 * trip it — the click proceeds and succeeds. This is the low-false-positive
 * guarantee (a closing dropdown / mid-flight animation must not read as occluded).
 *
 * Real browser via setContent (no fixture-server / eval-dataset dependency).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { executeAction } from "../src/act.js";

const resolver = (n: string) => n;
const BTN = `<button data-qa-ref="0" style="position:fixed;top:50px;left:50px;width:140px;height:32px">Go</button>`;
const COVER = (extra = "") =>
  `<div style="position:fixed;top:0;left:0;width:320px;height:200px;background:rgba(0,0,0,0.35);z-index:5"${extra}></div>`;

test("click reports occluded when a foreign overlay PERSISTENTLY covers the target", async () => {
  const browser = await chromium.launch({
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const page = await browser.newPage();
  try {
    await page.setContent(BTN + COVER());
    const res = await executeAction(page, { type: "click", ref: 0 }, resolver);
    assert.equal(res.ok, false, "a covered control cannot be clicked");
    assert.equal(res.occluded, true, "it is reported as occluded");
    assert.match(res.summary, /covered by/);
  } finally {
    await browser.close();
  }
});

test("click is NOT occluded by a transient overlay that clears within the settle window", async () => {
  const browser = await chromium.launch({
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const page = await browser.newPage();
  try {
    await page.setContent(
      BTN +
        COVER(' id="ov"') +
        `<script>setTimeout(() => document.getElementById('ov').remove(), 150)</script>`,
    );
    const res = await executeAction(page, { type: "click", ref: 0 }, resolver);
    assert.equal(res.ok, true, "the click proceeds once the overlay clears");
    assert.notEqual(res.occluded, true, "a transient overlay is not occlusion");
  } finally {
    await browser.close();
  }
});

test("click on an unobstructed control works (no false occlusion)", async () => {
  const browser = await chromium.launch({
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const page = await browser.newPage();
  try {
    await page.setContent(BTN);
    const res = await executeAction(page, { type: "click", ref: 0 }, resolver);
    assert.equal(res.ok, true);
    assert.notEqual(res.occluded, true);
  } finally {
    await browser.close();
  }
});
