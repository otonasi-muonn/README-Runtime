// What a reader of the README on github.com sees: which step the mockcraft card shows and
// whether it moves, on the first visit and when the page is shown again after a run would have
// ended (same tab, reload, a new tab, away and back), in each engine and motion setting.
//   motion "os": the browser follows the OS setting (on this machine Windows animation
//   effects are off, so Chromium and Firefox report prefers-reduced-motion: reduce);
//   "no-preference" / "reduce": forced by launch flag or preference. WebKit has no switch.
// The step is identified from the card's UI region against the recorder's reference frames
// (bench/pipeline.mjs, WORK/n160-frames); the Collatz cards are only checked for motion.
// Writes bench/results/github-playback<BENCH_TAG>.json. Run: node bench/github-playback.mjs
import { chromium, firefox, webkit } from 'playwright';
import { writeJson, environment } from './common.mjs';
import { identify } from './frames.mjs';

const URL_README = process.env.BENCH_README_URL ?? 'https://github.com/otonasi-muonn/README-Runtime';
const WAIT_S = Number(process.env.BENCH_WAIT_S ?? 90); // longer than the card's finite runs (78 s)
const MODES = {
  chromium: { os: {}, 'no-preference': { args: ['--force-prefers-no-reduced-motion'] }, reduce: { args: ['--force-prefers-reduced-motion'] } },
  firefox: { os: {}, 'no-preference': { firefoxUserPrefs: { 'ui.prefersReducedMotion': 0 } }, reduce: { firefoxUserPrefs: { 'ui.prefersReducedMotion': 1 } } },
  webkit: { os: {} },
};
const ENGINES = (process.env.BENCH_ENGINES ?? 'chromium,firefox,webkit').split(',');
const OUT = `github-playback${process.env.BENCH_TAG ?? ''}.json`;
const TYPES = { chromium, firefox, webkit };

// GitHub re-renders parts of the page after load (the element can be replaced while it is
// being looked at): retry on a detached element
async function look(page) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await lookOnce(page);
    } catch (e) {
      if (attempt >= 4 || !/not attached|detached|Target closed|Execution context was destroyed/i.test(e.message)) throw e;
      await page.waitForTimeout(1500);
    }
  }
}
async function lookOnce(page) {
  const card = page.locator('article img[src*="readme-runtime/mockcraft.svg"]').first();
  await card.waitFor({ timeout: 60000 });
  await card.scrollIntoViewIfNeeded();
  await page.waitForFunction((el) => el.complete && el.naturalWidth > 0, await card.elementHandle(), { timeout: 60000 });
  await page.waitForTimeout(2500);
  const steps = [];
  for (let i = 0; i < 3; i++) {
    if (i) await page.waitForTimeout(700);
    steps.push(identify(await card.screenshot(), 160).frame);
  }
  // Collatz: the two proof images, moving or not (two shots 1 s apart)
  const collatz = [];
  for (const sel of ['article img[src$="readme-runtime/collatz.svg"]', 'article img[src*="collatz.svg?x97"]']) {
    const im = page.locator(sel).first();
    if (!(await im.count())) { collatz.push(null); continue; }
    await im.scrollIntoViewIfNeeded();
    await page.waitForTimeout(400);
    const a = await im.screenshot();
    await page.waitForTimeout(1000);
    collatz.push(!a.equals(await im.screenshot()));
  }
  await card.scrollIntoViewIfNeeded();
  return { steps, moving: new Set(steps).size > 1, collatzMoving: collatz };
}

const results = { environment: environment(), url: URL_README, waitS: WAIT_S, runs: [] };
for (const engine of ENGINES) for (const [mode, opts] of Object.entries(MODES[engine])) {
  const browser = await TYPES[engine].launch(opts);
  const r = { engine, mode, version: browser.version() };
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    r.reducedMotionInPage = null;
    const t0 = Date.now();
    await page.goto(URL_README, { waitUntil: 'domcontentloaded', timeout: 90000 });
    r.reducedMotionInPage = await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches);
    r.first = await look(page);
    await page.waitForTimeout(Math.max(0, WAIT_S * 1000 - (Date.now() - t0)));
    r.sameTabLater = await look(page);
    await page.reload({ waitUntil: 'domcontentloaded' });
    r.reload = await look(page);
    const tab = await ctx.newPage();
    await tab.goto(URL_README, { waitUntil: 'domcontentloaded', timeout: 90000 });
    r.newTab = await look(tab);
    await tab.goto(`${URL_README}/issues`, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await tab.goBack({ waitUntil: 'domcontentloaded' });
    r.awayAndBack = await look(tab);
    // a new browser context: an empty cache, like a first visit
    const fresh = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
    await fresh.goto(URL_README, { waitUntil: 'domcontentloaded', timeout: 90000 });
    r.freshProfile = await look(fresh);
  } catch (e) {
    r.error = String(e.message).split('\n')[0];
  } finally {
    await browser.close();
  }
  results.runs.push(r);
  console.log(JSON.stringify(r));
  writeJson(OUT, results);
}
writeJson(OUT, results);
