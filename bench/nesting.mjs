// Deep nesting: README Runtime unrolls one nested <g> per step, and cards are capped at
// MAX_STEPS = 400 because WebKit stopped resolving styles beyond ~510 levels. This generates
// the mockcraft card beyond the cap (with a patched copy of src/, the product is unchanged)
// and checks in each engine whether the deepest state is shown correctly, how long the first
// render takes and what the running animation costs. Writes bench/results/nesting.json.
// Run: node bench/nesting.mjs (needs bench/.work/n160 from bench/pipeline.mjs)
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import http from 'node:http';
import { chromium, firefox, webkit } from 'playwright';
import { PNG } from 'pngjs';
import { ROOT, WORK, CARD, INIT, STEP_MS, HOLD, VIEWS, processTree, treeTotals, round, median, writeJson, environment } from './common.mjs';
import { frameModel, shell } from './record.mjs';

const DEPTHS = (process.env.BENCH_DEPTHS ?? '160,320,400,480,512,544,640,800,1024').split(',').map(Number);
const ENGINES = (process.env.BENCH_ENGINES ?? 'chromium,firefox,webkit').split(',');

// a copy of src/ whose step cap is lifted
const SRC = path.join(WORK, 'src-deep');
fs.rmSync(SRC, { recursive: true, force: true });
fs.cpSync(path.join(ROOT, 'src'), SRC, { recursive: true });
const machineFile = path.join(SRC, 'runtime/machine.js');
fs.writeFileSync(machineFile, fs.readFileSync(machineFile, 'utf8').replace('export const MAX_STEPS = 400;', 'export const MAX_STEPS = 4096;'));
const { generate } = await import(url.pathToFileURL(path.join(SRC, 'generate.js')).href);

const project = path.join(WORK, 'n160');
const wasm = fs.readFileSync(path.join(project, 'mc/logic.wasm'));
const cards = {};
for (const N of DEPTHS) {
  const t0 = performance.now();
  const r = await generate(wasm, {
    export: 'step', init: INIT, steps: N, stepMs: STEP_MS, title: 'mockcraft · editor auto-pilot', wasmName: 'logic.wasm',
    ui: { entry: 'mc/demo.tsx', tsconfig: 'mc/tsconfig.json', css: ['mc/upstream/src/app/globals.css'], views: VIEWS, credit: 'deep' }, cwd: project,
  });
  const file = `deep-n${N}.svg`;
  fs.writeFileSync(path.join(WORK, file), r.svg);
  cards[N] = { file, generateMs: round(performance.now() - t0, 0), bytes: r.svg.length };
  console.log(`generated N=${N}`, JSON.stringify(cards[N]));
}

// the expected UI for a step: the recorder's frame (the component rendered in a plain page)
const pin = (svg, t) => svg.replace(/animation:rrclk [^}]*\}/, `--rt:${t}}`).replace(/@media \(prefers-reduced-motion:reduce\)\{[^\n]*\n/, '');
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/blank') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<!doctype html><body style="margin:0">'); }
  const m = /^\/(live|pin(\d+))\/(deep-n\d+\.svg)/.exec(u.pathname);
  if (!m) { res.writeHead(404); return res.end(); }
  let svg = fs.readFileSync(path.join(WORK, m[3]), 'utf8');
  if (m[2]) svg = pin(svg, Number(m[2]));
  res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox", 'Cache-Control': 'no-store' });
  res.end(svg);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;

const uiPixels = (png) => { const out = []; for (let y = CARD.uiY; y < CARD.uiY + CARD.uiH; y++) for (let x = CARD.uiX; x < CARD.uiX + CARD.uiW; x++) { const i = (y * png.width + x) * 4; out.push(png.data[i], png.data[i + 1], png.data[i + 2]); } return out; };
const differing = (a, b) => { let n = 0; for (let i = 0; i < a.length; i += 3) if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) > 30) n++; return n; };

const results = { environment: environment(), maxSteps: 400, cards, engines: {} };
const TYPES = { chromium, firefox, webkit };
const OPTS = { firefox: { firefoxUserPrefs: { 'ui.prefersReducedMotion': 0 } }, chromium: { args: ['--force-prefers-no-reduced-motion'] }, webkit: {} };
const CHROMIUM_TEXT_TOLERANCE = 150; // Chromium shapes text beside CSS counters as separate runs (see test/browser/ui.js)
const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what} did not finish in ${ms / 1000} s`)), ms))]);
for (const engine of ENGINES) {
  const out = { version: null, depths: {} };
  results.engines[engine] = out;
  for (const N of DEPTHS) {
    // a fresh browser per depth: a renderer crash at one depth must not end the experiment
    const launched = await TYPES[engine].launchServer(OPTS[engine]);
    const browser = await TYPES[engine].connect(launched.wsEndpoint());
    const pid = launched.process().pid;
    out.version = browser.version();
    const page = await (await browser.newContext({ viewport: { width: CARD.W + 40, height: CARD.H + 40 }, reducedMotion: 'no-preference' })).newPage();
    const r = { correct: {} };
    try {
      // expected UI at step 1 and at the deepest step (the hold shows step N): the recorder's frame
      const { frames, css } = await frameModel(project, N);
      await page.setContent(shell(css, 'x'));
      const expected = {};
      for (const t of [1, N + HOLD]) {
        await page.evaluate(([html]) => { document.getElementById('ui').innerHTML = html; }, [frames[t].html]);
        expected[t] = uiPixels(PNG.sync.read(await page.screenshot({ clip: { x: 0, y: 0, width: CARD.W, height: CARD.H } })));
      }
      // the card pinned at those steps: time to the first painted frame, and is it right
      for (const t of [1, N + HOLD]) {
        const key = t === 1 ? 'step1' : 'deepest';
        await page.goto(`${origin}/blank`);
        const ms = await withTimeout(page.evaluate(async (src) => {
          const img = new Image();
          const t0 = performance.now();
          img.src = src;
          document.body.append(img);
          await img.decode().catch(() => {});
          await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
          return performance.now() - t0;
        }, `${origin}/pin${t}/${cards[N].file}?${Math.random()}`), 60000, 'first render');
        await page.waitForTimeout(300);
        const px = differing(uiPixels(PNG.sync.read(await page.locator('img').screenshot())), expected[t]);
        const tolerance = engine === 'chromium' ? CHROMIUM_TEXT_TOLERANCE : 0;
        r.correct[key] = { ok: px <= tolerance, differingPx: px, firstRenderMs: round(ms, 0) };
      }
      // the running animation: CPU of the browser process tree over 5 s (and style time in Chromium)
      await page.goto(`${origin}/blank`);
      await page.evaluate((src) => { const img = new Image(); img.src = src; document.body.append(img); }, `${origin}/live/${cards[N].file}`);
      await page.waitForTimeout(1500);
      const a = treeTotals(processTree(pid));
      const t0 = performance.now();
      if (engine === 'chromium') await browser.startTracing(page, { categories: ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'blink'] });
      await page.waitForTimeout(5000);
      let style = null;
      if (engine === 'chromium') {
        const big = (JSON.parse((await browser.stopTracing()).toString()).traceEvents ?? []).filter((e) => e.ph === 'X' && e.name === 'UpdateLayoutTree' && e.dur > 1000);
        style = { msPerS: round(big.reduce((s, e) => s + e.dur, 0) / 1000 / 5, 0), updatesPerS: round(big.length / 5, 1), meanMs: big.length ? round(big.reduce((s, e) => s + e.dur, 0) / 1000 / big.length, 1) : null };
      }
      const b = treeTotals(processTree(pid));
      const secs = (performance.now() - t0) / 1000;
      r.animation = { cpuPercent: a && b ? round((b.cpuMs - a.cpuMs) / 10 / secs, 1) : null, workingSetMB: b ? round(b.ws / 2 ** 20, 0) : null, style };
    } catch (e) {
      r.crashed = String(e.message).split('\n')[0];
    }
    out.depths[N] = r;
    console.log(engine, N, JSON.stringify(r));
    writeJson('nesting.json', results);
    await browser.close().catch(() => {});
    await launched.close().catch(() => {});
  }
}
server.close();
writeJson('nesting.json', results);
