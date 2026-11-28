// Multi-step intra-element unrolling and 2D factored selection (#5):
// Isolates DOM nesting depth vs expression splitting vs selection cost across Chromium, Firefox,
// and WebKit, and measures real UI cards (mockcraft-state, K=5) and trace cards up to 2,000 steps.
// Writes bench/results/unroll.json.
// Run: node bench/unroll.mjs (env: BENCH_ENGINES, BENCH_STEPS, BENCH_WINDOW_MS)
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { chromium, firefox, webkit } from 'playwright';
import { PNG } from 'pngjs';
import { ROOT, WORK, processTree, treeTotals, round, writeJson, environment, sizes } from './common.mjs';
import { generate } from '../src/generate.js';
import { instantiate, stateAbi, referenceTrace } from '../src/runtime/reference.js';
import { bundleEntry, renderWith } from '../src/ui/bundle.js';
import { parseHtml, toXhtml } from '../src/ui/html.js';

const ENGINES = (process.env.BENCH_ENGINES ?? 'chromium,firefox,webkit').split(',');
const STEPS_LIST = (process.env.BENCH_STEPS ?? '160,400,800,1200,1600,2000').split(',').map(Number);
const WINDOW_MS = Number(process.env.BENCH_WINDOW_MS ?? 4000);
const DIR = path.join(WORK, 'unroll');
fs.mkdirSync(DIR, { recursive: true });

const mcDir = path.join(ROOT, 'examples/mockcraft');
const mcCfg = JSON.parse(fs.readFileSync(path.join(mcDir, 'readme-runtime.json'), 'utf8')).cards[0];
const mcWasm = fs.readFileSync(path.join(mcDir, mcCfg.wasm));
const mcBundle = await bundleEntry(mcCfg.ui.entry, { tsconfig: mcCfg.ui.tsconfig, cwd: mcDir });
const mcEx = await instantiate(mcWasm);

const UI_OPEN = /(<div class="rr-ui" style="[^"]*">)[\s\S]*?(<\/div><\/div><\/foreignObject>)/;
const pin = (svg, t) => svg.replace(/animation:rrclk [^}]*\}/, `--rt:${t}}`).replace(/@media \(prefers-reduced-motion:reduce\)\{[^\n]*\n/, '');
const count = (s, re) => (s.match(re) ?? []).length;

const cards = {};
const svgs = new Map();

for (const N of STEPS_LIST) {
  const t0 = performance.now();
  const r = await generate(mcWasm, {
    export: mcCfg.export, state: mcCfg.state, init: mcCfg.init,
    steps: N, stepMs: 150, loops: 'infinite', title: `mockcraft-state-${N}`, wasmName: 'state.wasm',
    ui: mcCfg.ui, cwd: mcDir,
  });
  const genMs = round(performance.now() - t0, 0);
  const key = `mockcraft-state-n${N}`;
  fs.writeFileSync(path.join(DIR, `${key}.svg`), r.svg);

  const abi = stateAbi(mcEx, r.program);
  const tr = await referenceTrace(mcWasm, { program: r.program, init: mcCfg.state.map((k) => mcCfg.init[k]), steps: N });
  const endViews = Object.fromEntries(Object.entries(mcCfg.ui.views).map(([name, exp]) => [name, abi.read(exp, tr.states[N])]));
  const direct = toXhtml(parseHtml(renderWith(mcBundle, endViews)));
  const pinned = pin(r.svg, r.machine.T);
  const ref = pinned.replace(UI_OPEN, (_, a, b) => `${a}${direct}${b}`);
  const foMatch = r.svg.match(/<foreignObject x="(\d+)" y="(\d+)" width="(\d+)" height="(\d+)">/);
  const fo = { x: Number(foMatch[1]), y: Number(foMatch[2]), w: Number(foMatch[3]), h: Number(foMatch[4]) };

  svgs.set(`${key}-live`, r.svg);
  svgs.set(`${key}-pin`, pinned);
  svgs.set(`${key}-ref`, ref);

  cards[key] = {
    steps: N,
    levels: r.machine.blocks,
    stepsPerLevel: r.machine.stride,
    selection: r.machine.selectionMode,
    generateMs: genMs,
    ...sizes(Buffer.from(r.svg)),
    registered: count(r.svg, /@property /g),
    levelDecls: r.machine.level.A.length,
    selectDecls: r.machine.select.length,
    selectedValues: r.perf.report.selectedValues,
    selectionTerms: r.perf.report.selectionTerms,
    fo,
  };
  console.log(key, JSON.stringify({ ...cards[key], fo: undefined }));
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/blank') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<!doctype html><body style="margin:0">'); }
  const m = /^\/(svg|page)\/([\w-]+)$/.exec(u.pathname);
  if (!m || !svgs.has(m[2])) { res.writeHead(404); return res.end(); }
  if (m[1] === 'svg') {
    res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox", 'Cache-Control': 'no-store' });
    res.end(svgs.get(m[2]));
  } else {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<!doctype html><body style="margin:0"><img id="card" src="/svg/${m[2]}?${Math.random()}"></body>`);
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;

const crop = (png, fo) => {
  const out = [];
  for (let y = fo.y; y < fo.y + fo.h; y++) for (let x = fo.x; x < fo.x + fo.w; x++) { const i = (y * png.width + x) * 4; out.push(png.data[i], png.data[i + 1], png.data[i + 2]); }
  return out;
};
const diffPx = (a, b) => { let n = 0; for (let i = 0; i < a.length; i += 3) if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) > 30) n++; return n; };

const TYPES = { chromium, firefox, webkit };
const OPTS = { firefox: { firefoxUserPrefs: { 'ui.prefersReducedMotion': 0 } }, chromium: { args: ['--force-prefers-no-reduced-motion'] }, webkit: {} };
const results = {
  environment: environment(),
  windowMs: WINDOW_MS,
  cards: Object.fromEntries(Object.entries(cards).map(([k, v]) => { const { fo, ...rest } = v; return [k, rest]; })),
  engines: {},
};

for (const engine of ENGINES) {
  const launched = await TYPES[engine].launchServer(OPTS[engine]);
  const browser = await TYPES[engine].connect(launched.wsEndpoint());
  const pid = launched.process().pid;
  const out = { version: browser.version(), cards: {} };
  results.engines[engine] = out;

  const pageNoJs = await (await browser.newContext({ javaScriptEnabled: false, viewport: { width: 860, height: 520 } })).newPage();
  const pageLive = await (await browser.newContext({ viewport: { width: 860, height: 520 }, reducedMotion: 'no-preference' })).newPage();

  for (const [key, meta] of Object.entries(cards)) {
    const r = {};
    await pageNoJs.goto(`${origin}/page/${key}-pin`, { waitUntil: 'load' });
    await pageNoJs.waitForTimeout(200);
    const liveShot = crop(PNG.sync.read(await pageNoJs.locator('#card').screenshot()), meta.fo);
    await pageNoJs.goto(`${origin}/page/${key}-ref`, { waitUntil: 'load' });
    await pageNoJs.waitForTimeout(200);
    const refShot = crop(PNG.sync.read(await pageNoJs.locator('#card').screenshot()), meta.fo);
    const px = diffPx(liveShot, refShot);
    r.deepestMatch = { ok: px <= (engine === 'chromium' ? 150 : 0), differingPx: px };

    await pageLive.goto(`${origin}/blank`);
    r.firstRenderMs = round(await pageLive.evaluate(async (src) => {
      const img = new Image();
      const t0 = performance.now();
      img.src = src;
      document.body.append(img);
      await img.decode().catch(() => {});
      await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
      return performance.now() - t0;
    }, `${origin}/svg/${key}-pin?${Math.random()}`), 0);

    await pageLive.goto(`${origin}/blank`);
    await pageLive.evaluate((src) => { const img = new Image(); img.src = src; document.body.append(img); }, `${origin}/svg/${key}-live?${Math.random()}`);
    await pageLive.waitForTimeout(1000);
    const a = treeTotals(processTree(pid));
    const t0 = performance.now();
    if (engine === 'chromium') await browser.startTracing(pageLive, { categories: ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'blink'] });
    await pageLive.waitForTimeout(WINDOW_MS);
    let style = null;
    if (engine === 'chromium') {
      const ev = (JSON.parse((await browser.stopTracing()).toString()).traceEvents ?? []).filter((e) => e.ph === 'X' && e.name === 'UpdateLayoutTree');
      style = { msPerS: round(ev.reduce((s, e) => s + e.dur, 0) / 1000 / (WINDOW_MS / 1000), 1) };
    }
    const b = treeTotals(processTree(pid));
    const secs = (performance.now() - t0) / 1000;
    r.cpuPercent = a && b ? round((b.cpuMs - a.cpuMs) / 10 / secs, 1) : null;
    r.workingSetMB = b ? round(b.ws / 2 ** 20, 0) : null;
    r.style = style;

    out.cards[key] = r;
    console.log(engine, key, JSON.stringify(r));
    writeJson('unroll.json', results);
  }
  await browser.close().catch(() => {});
  await launched.close().catch(() => {});
}
server.close();
writeJson('unroll.json', results);
