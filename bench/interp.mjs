#!/usr/bin/env node
// Benchmark & 3-browser rendering proof for Issue #4 (sub-step visual interpolation):
// Compares `none` (discrete baseline), `linear` (`interpolate: true`), and `ease`
// (`interpolate: "ease"`) on `examples/mockcraft` (5-value state, 160 steps, 150ms/step)
// inside a real `<img src>` with GitHub's image CSP and JavaScript disabled.
//
// Measures across Chromium, Firefox, and WebKit:
//   - Painted sub-step smoothness (`distinctX` over ~950ms = ~6 steps, `maxStepPx`, `backwardGlitches`)
//   - `prefers-reduced-motion: reduce` stillness (`reducedMotionDistinctX === 1`)
//   - Steady-state CPU %, Working Set MB, and Chromium `UpdateLayoutTree` / `Paint` ms/s over 4s.

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import url from 'node:url';
import { chromium, firefox, webkit } from 'playwright';
import { PNG } from 'pngjs';
import { loadConfig } from '../src/project.js';
import { generate } from '../src/generate.js';
import { uiLayout } from '../src/render/ui-card.js';
import { processTree, treeTotals, round, environment, writeJson } from './common.mjs';

const root = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const cfg = loadConfig(path.join(root, 'examples/mockcraft/readme-runtime.json'));
const baseCard = cfg.cards.find((c) => c.name === 'mockcraft-state');
const wasm = fs.readFileSync(path.join(cfg.dir, baseCard.wasm));
const WINDOW_MS = Number(process.env.BENCH_WINDOW_MS ?? 4000);
const ENGINES = (process.env.BENCH_ENGINES ?? 'chromium,firefox,webkit').split(',');

const MODES = [
  { name: 'none', interpolate: false },
  { name: 'linear', interpolate: true },
  { name: 'ease', interpolate: 'ease' },
];

const cards = new Map();
for (const m of MODES) {
  const t0 = performance.now();
  const gen = await generate(wasm, { ...baseCard.options, loops: 'infinite', interpolate: m.interpolate });
  const generateMs = round(performance.now() - t0, 1);
  cards.set(m.name, { ...m, gen, generateMs });
}

const sampleSvg = cards.get('linear').gen.svg;
const foW = Number(sampleSvg.match(/<foreignObject[^>]*width="(\d+)"/)[1]);
const foH = Number(sampleSvg.match(/<foreignObject[^>]*height="(\d+)"/)[1]);
const L = uiLayout({ width: foW, height: foH });

// Detect the left X edge of the moving white Mockcraft card (#fff against #f6f4ef board)
function detectCardLeftX(png) {
  const y = L.uiY + 150;
  for (let x = L.uiX + 4; x < L.uiX + 460; x++) {
    const idx = (y * png.width + x) * 4;
    if (png.data[idx] >= 252 && png.data[idx + 1] >= 252 && png.data[idx + 2] >= 252) return x - L.uiX;
  }
  return -1;
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/blank') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<!doctype html><body style="margin:0">'); return; }
  const m = u.pathname.match(/^\/(card|page)\/([a-z-]+)\.(svg|html)$/);
  if (!m || !cards.has(m[2])) { res.writeHead(404); res.end(); return; }
  if (m[1] === 'card') {
    res.writeHead(200, {
      'Content-Type': 'image/svg+xml',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
    });
    res.end(cards.get(m[2]).gen.svg);
  } else {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><meta charset="utf-8"><body style="margin:0;background:#fff"><img id="card" src="/card/${m[2]}.svg?${u.searchParams.toString()}"></body>`);
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;

const TYPES = { chromium, firefox, webkit };
const OPTS = {
  chromium: { args: ['--force-prefers-no-reduced-motion'] },
  firefox: { firefoxUserPrefs: { 'ui.prefersReducedMotion': 0 } },
  webkit: {},
};

const report = {
  environment: environment(),
  windowMs: WINDOW_MS,
  card: 'examples/mockcraft (5-value state, 160 steps, stepMs=150)',
  modes: {},
};

for (const m of MODES) {
  const { gen, generateMs } = cards.get(m.name);
  report.modes[m.name] = {
    interpolate: m.interpolate,
    generateMs,
    bytes: gen.perf.report.bytes,
    gzipBytes: gen.perf.report.gzipBytes,
    selectedValues: gen.perf.report.selectedValues,
    ...(gen.perf.report.nextSelectedValues ? { nextSelectedValues: gen.perf.report.nextSelectedValues } : {}),
    interpolation: gen.execution.interpolation ?? null,
    browsers: {},
  };
}

for (const bName of ENGINES) {
  const launched = await TYPES[bName].launchServer(OPTS[bName]);
  const br = await TYPES[bName].connect(launched.wsEndpoint());
  const pid = launched.process().pid;

  for (const m of MODES) {
    // 1. Sample painted <img> frames over ~900ms (~6 discrete steps before first horizontal bounce)
    //    using direct pipe launch + 2px-tall scanline clip so screenshot IPC takes ~15-25ms
    //    (3-6 samples per 150ms step, clearly separating 8px discrete jumps from 1-2px lerp).
    const sampleBr = await TYPES[bName].launch(OPTS[bName]);
    const noJsCtx = await sampleBr.newContext({ javaScriptEnabled: false, reducedMotion: 'no-preference', viewport: { width: 900, height: 520 } });
    const noJsPage = await noJsCtx.newPage();
    await noJsPage.goto(`${origin}/page/${m.name}.html?run=${Math.random()}`, { waitUntil: 'load' });
    await noJsPage.waitForTimeout(80);
    const clip = { x: L.uiX, y: L.uiY + 150, width: 460, height: 2 };
    const xs = [];
    const tStart = performance.now();
    while (performance.now() - tStart < 900) {
      const buf = await noJsPage.screenshot({ clip });
      const png = PNG.sync.read(buf);
      let xHit = -1;
      for (let x = 4; x < png.width; x++) {
        const idx = x * 4;
        if (png.data[idx] >= 252 && png.data[idx + 1] >= 252 && png.data[idx + 2] >= 252) { xHit = x; break; }
      }
      if (xHit >= 0) xs.push(xHit);
      await noJsPage.waitForTimeout(12);
    }
    await sampleBr.close();

    let backwardGlitches = 0;
    let maxStepPx = 0;
    for (let i = 1; i < xs.length; i++) {
      const d = xs[i] - xs[i - 1];
      if (d < 0) backwardGlitches++;
      if (d > maxStepPx) maxStepPx = d;
    }
    const distinctX = new Set(xs).size;

    // 2. Steady-state CPU / RAM / Chromium trace over WINDOW_MS
    const liveCtx = await br.newContext({ reducedMotion: 'no-preference', viewport: { width: 900, height: 520 } });
    const livePage = await liveCtx.newPage();
    await livePage.goto(`${origin}/page/${m.name}.html?steady=${Math.random()}`, { waitUntil: 'load' });
    await livePage.waitForTimeout(800);
    const p0 = treeTotals(processTree(pid));
    const wall0 = performance.now();
    if (bName === 'chromium') {
      await br.startTracing(livePage, { categories: ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'blink', 'cc'] });
    }
    await livePage.waitForTimeout(WINDOW_MS);
    let styleMsPerSec = null;
    let paintMsPerSec = null;
    if (bName === 'chromium') {
      const traceEvents = JSON.parse((await br.stopTracing()).toString()).traceEvents ?? [];
      let styleUs = 0, paintUs = 0;
      for (const ev of traceEvents) {
        if (ev.ph !== 'X' || !ev.dur) continue;
        if (ev.name === 'UpdateLayoutTree' || ev.name === 'RecalculateStyles') styleUs += ev.dur;
        else if (ev.name === 'Paint' || ev.name === 'CompositeLayers') paintUs += ev.dur;
      }
      const secs = (performance.now() - wall0) / 1000;
      styleMsPerSec = round(styleUs / 1000 / secs, 1);
      paintMsPerSec = round(paintUs / 1000 / secs, 1);
    }
    const p1 = treeTotals(processTree(pid));
    const wallSec = (performance.now() - wall0) / 1000;
    await liveCtx.close();

    // 3. Reduced-motion check on `linear` (note: Windows Playwright WebKit has no CLI/pref flag
    //    for OS reduced-motion inside <img>; Chromium uses --force-prefers-reduced-motion and
    //    Firefox uses ui.prefersReducedMotion=1)
    let reducedMotionDistinctX = null;
    if (m.name === 'linear' && bName !== 'webkit') {
      const redBr = await TYPES[bName].launch(
        bName === 'chromium'
          ? { args: ['--force-prefers-reduced-motion'] }
          : { firefoxUserPrefs: { 'ui.prefersReducedMotion': 1 } },
      );
      const redCtx = await redBr.newContext({ javaScriptEnabled: false, reducedMotion: 'reduce', viewport: { width: 900, height: 520 } });
      const redPage = await redCtx.newPage();
      await redPage.goto(`${origin}/page/linear.html?run=reduce`, { waitUntil: 'load' });
      await redPage.waitForTimeout(80);
      const rxs = [];
      for (let k = 0; k < 6; k++) {
        const buf = await redPage.locator('#card').screenshot();
        rxs.push(detectCardLeftX(PNG.sync.read(buf)));
        await redPage.waitForTimeout(60);
      }
      reducedMotionDistinctX = new Set(rxs).size;
      await redBr.close();
    }

    const entry = {
      samples: xs.length,
      distinctX,
      maxStepPx,
      backwardGlitches,
      ...(reducedMotionDistinctX !== null ? { reducedMotionDistinctX } : {}),
      cpuPct: p0 && p1 ? round((p1.cpuMs - p0.cpuMs) / 10 / wallSec, 1) : null,
      wsMB: p1 ? round(p1.ws / 2 ** 20, 0) : null,
      ...(styleMsPerSec !== null ? { styleMsPerSec, paintMsPerSec } : {}),
    };
    report.modes[m.name].browsers[bName] = entry;
    console.log(`${bName.padEnd(9)} ${m.name.padEnd(7)} distinctX=${String(distinctX).padStart(2)}/${xs.length} maxStep=${maxStepPx}px back=${backwardGlitches} cpu=${entry.cpuPct}% ws=${entry.wsMB}MB${styleMsPerSec !== null ? ` style=${styleMsPerSec}ms/s paint=${paintMsPerSec}ms/s` : ''}${reducedMotionDistinctX !== null ? ` redMotionDistinct=${reducedMotionDistinctX}` : ''}`);
  }

  await br.close().catch(() => {});
  await launched.close().catch(() => {});
}

server.close();
writeJson('interp.json', report);
console.log('\nwrote bench/results/interp.json');
