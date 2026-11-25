// The proof on the live README: the same collatz.svg shown twice (initial value 27, and 97
// through the URL fragment #x97). Each image is read back from pixels (test/browser/decode.js:
// every trace column, the register and the status) and compared with the real Wasm run of its
// initial value, at three moments, in each engine with motion forced on.
// Writes bench/results/github-collatz.json. Run: node bench/github-collatz.mjs
import fs from 'node:fs';
import path from 'node:path';
import { chromium, firefox, webkit } from 'playwright';
import { ROOT, writeJson, environment } from './common.mjs';
import { decodeCard } from '../test/browser/decode.js';
import { referenceTrace } from '../src/runtime/reference.js';

const URL_README = process.env.BENCH_README_URL ?? 'https://github.com/otonasi-muonn/README-Runtime';
const wasm = fs.readFileSync(path.join(ROOT, 'examples/collatz/collatz.wasm'));
const LAUNCH = { chromium: { args: ['--force-prefers-no-reduced-motion'] }, firefox: { firefoxUserPrefs: { 'ui.prefersReducedMotion': 0 } }, webkit: {} };
const IMAGES = { 27: 'article img[src$="readme-runtime/collatz.svg"]', 97: 'article img[src*="collatz.svg?x97#x97"]' };

// the card's 800 x 300 pixels: GitHub places the image at a fractional y, so an element
// screenshot is one row taller; the page re-renders parts of itself, so retry a detached element
async function shot(page, sel) {
  for (let attempt = 1; ; attempt++) {
    try {
      const im = page.locator(sel).first();
      await im.scrollIntoViewIfNeeded();
      await page.waitForFunction((el) => el.complete && el.naturalWidth > 0, await im.elementHandle(), { timeout: 60000 });
      const box = await im.boundingBox();
      return await page.screenshot({ clip: { x: Math.round(box.x), y: Math.round(box.y), width: 800, height: 300 } });
    } catch (e) {
      if (attempt >= 4 || !/not attached|detached/i.test(e.message)) throw e;
      await page.waitForTimeout(1500);
    }
  }
}

const traces = {};
for (const init of Object.keys(IMAGES)) traces[init] = (await referenceTrace(wasm, { exportName: 'step', haltValue: 1, init: Number(init), steps: 120 })).values;

const results = { environment: environment(), url: URL_README, engines: {} };
for (const [engine, type] of Object.entries({ chromium, firefox, webkit })) {
  const browser = await type.launch(LAUNCH[engine]);
  const out = { version: browser.version(), checks: [] };
  results.engines[engine] = out;
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(URL_README, { waitUntil: 'domcontentloaded', timeout: 90000 });
    for (let moment = 0; moment < 3; moment++) {
      if (moment) await page.waitForTimeout(4000);
      for (const [init, sel] of Object.entries(IMAGES)) {
        const dec = decodeCard(await shot(page, sel), { steps: 120, bits: 20 });
        const values = traces[init];
        const shown = dec.cols.findLastIndex((v) => v !== null);
        const problems = [];
        if (dec.broken) problems.push(`not rendered at natural size (${dec.size})`);
        for (let k = 0; k <= shown; k++) if (dec.cols[k] !== values[k]) problems.push(`column ${k}: ${dec.cols[k]} != ${values[k]}`);
        if (shown >= 0 && dec.led !== values[shown]) problems.push(`register ${dec.led} != ${values[shown]}`);
        out.checks.push({ init: Number(init), moment, shownStep: shown, register: dec.led, status: dec.status, ok: !problems.length && shown >= 0, problems: problems.slice(0, 5) });
      }
    }
  } catch (e) {
    out.error = String(e.message).split('\n')[0];
  } finally {
    await browser.close();
  }
  console.log(engine, JSON.stringify(out));
}
writeJson('github-collatz.json', results);
