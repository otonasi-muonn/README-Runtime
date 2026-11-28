// A state of several values (#6): what K values cost against one, for K = 1/2/4/8 and
// N = 40/160/400 steps, with much and with little computation shared between the values, plus
// the real example (mockcraft packed into one integer vs the same logic as 5 state values).
// Every card is a UI card that prints views as text: in "shared" and "independent" the views
// read the first value only, so the display selects one value whatever K is (the cost of the
// levels); in "views" they read every value, so the display selects all K; "copies" (the
// control) shows K numbers like "views" but all of the first value, so it selects one.
// Per card: generate time, size (raw/gzip), registered properties, declarations per level and
// display; per engine: first render (clock pinned at the last step) and the running card's CPU
// and memory over 5 s (Chromium also style recalculation). Writes bench/results/state.json.
// Run: node bench/state.mjs   (env: BENCH_ENGINES, BENCH_K, BENCH_N, BENCH_KINDS, BENCH_EXAMPLE=0, BENCH_WINDOW_MS, BENCH_OUT)
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { chromium, firefox, webkit } from 'playwright';
import { ROOT, WORK, processTree, treeTotals, round, writeJson, environment, sizes } from './common.mjs';
import { generate } from '../src/generate.js';
import { buildModule, I32, op, c, get } from '../test/helpers/wasm-builder.js';

const ENGINES = (process.env.BENCH_ENGINES ?? 'chromium,firefox,webkit').split(',');
const KS = (process.env.BENCH_K ?? '1,2,4,8').split(',').map(Number);
const NS = (process.env.BENCH_N ?? '40,160,400').split(',').map(Number);
const WINDOW_MS = Number(process.env.BENCH_WINDOW_MS ?? 5000);
const DIR = path.join(WORK, 'state');
fs.mkdirSync(DIR, { recursive: true });

// K step functions over the state (x0..x{K-1}), each (i32 x K) -> i32 (the functions ABI).
//   shared:      step_i = (h + i * 7) rem 9973, h = (sum_j x_j * (2j + 3) + 11) rem 9973: one
//                common helper, computed once per level whatever K is
//   independent: step_i = (x_i * 5 + x_{i+1} + 3) rem 9973: nothing in common
function module(K, kind) {
  const xs = Array.from({ length: K }, () => I32);
  const helper = [c(11), ...Array.from({ length: K }, (_, j) => [get(j), c(2 * j + 3), op.mul, op.add]), c(9973), op.rem_s];
  const funcs = Array.from({ length: K }, (_, i) => ({
    name: `step_${i}`, params: xs, results: [I32],
    body: kind === 'shared'
      ? [...Array.from({ length: K }, (_, j) => get(j)), [op.call, K], c(i * 7), op.add, c(9973), op.rem_s]
      : [get(i), c(5), op.mul, get((i + 1) % K), op.add, c(3), op.add, c(9973), op.rem_s],
  }));
  funcs.push({ name: 'h', params: xs, results: [I32], body: helper, export: false });
  for (let i = 0; i < K; i++) funcs.push({ name: `view_${i}`, params: xs, results: [I32], body: [get(i)] });
  return buildModule({ funcs: funcs.map((f) => ({ ...f, body: f.body.flat(Infinity) })) });
}

const count = (s, re) => (s.match(re) ?? []).length;
const cards = {};
async function card(key, wasm, opts) {
  const t0 = performance.now();
  const r = await generate(wasm, { title: key, wasmName: `${key}.wasm`, stepMs: 150, loops: 'infinite', ...opts });
  const file = `${key}.svg`;
  fs.writeFileSync(path.join(DIR, file), r.svg);
  const m = r.machine;
  cards[key] = {
    file, K: m.K, N: m.steps, generateMs: round(performance.now() - t0, 0), ...sizes(Buffer.from(r.svg)),
    registered: count(r.svg, /@property /g), levelDecls: m.level.A.length, selectedValues: r.perf.report.selectedValues, selectionTerms: r.perf.report.selectionTerms, displayDecls: m.select.length + m.display.length,
  };
  console.log(key, JSON.stringify(cards[key]));
}

// a demo that prints every view: the display selects every value of the state
fs.writeFileSync(path.join(DIR, 'demo.jsx'), `export default function Demo(v) {
  return <div style={{ width: 360, height: 40, font: "16px monospace" }}>{Object.keys(v).sort().map((k) => <span key={k}>{v[k]} </span>)}</div>;
}
`);
const KINDS = (process.env.BENCH_KINDS ?? 'shared,independent,views,copies').split(',');
const EXAMPLE = process.env.BENCH_EXAMPLE !== '0';
for (const kind of KINDS) {
  for (const K of KS) {
    const wasm = module(K, kind === 'views' || kind === 'copies' ? 'shared' : kind);
    const names = Array.from({ length: K }, (_, i) => `v${i}`);
    for (const N of NS) {
      const shownViews = kind === 'views' ? names.map((n, i) => [n, `view_${i}`]) : kind === 'copies' ? names.map((n) => [n, 'view_0']) : [[names[0], 'view_0']];
      const ui = { entry: 'demo.jsx', views: Object.fromEntries(shownViews), credit: 'bench' };
      await card(`${kind}-k${K}-n${N}`, wasm, { export: Object.fromEntries(names.map((n, i) => [n, `step_${i}`])), state: names, init: Object.fromEntries(names.map((n, i) => [n, i + 1])), steps: N, ui, cwd: DIR });
    }
  }
}
// the real example: one packed integer vs 5 state values, the same UI and views
for (const [name, dir] of EXAMPLE ? [['mockcraft', ROOT], ['mockcraft-state', path.join(ROOT, 'examples/mockcraft')]] : []) {
  const c0 = JSON.parse(fs.readFileSync(path.join(dir, 'readme-runtime.json'), 'utf8')).cards.find((x) => x.name === name);
  await card(name, fs.readFileSync(path.join(dir, c0.wasm)), { export: c0.export, state: c0.state, init: c0.init, steps: 160, ui: c0.ui, cwd: dir });
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/blank') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<!doctype html><body style="margin:0">'); }
  const m = /^\/(live|last)\/([\w-]+\.svg)$/.exec(u.pathname);
  if (!m) { res.writeHead(404); return res.end(); }
  let svg = fs.readFileSync(path.join(DIR, m[2]), 'utf8');
  // the clock pinned at the end of the run: the first render computes every level
  if (m[1] === 'last') svg = svg.replace(/animation:rrclk [^}]*\}/, `--rt:${cards[m[2].slice(0, -4)].N}}`);
  res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox", 'Cache-Control': 'no-store' });
  res.end(svg);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;

const results = { environment: environment(), windowMs: WINDOW_MS, cards, engines: {} };
const TYPES = { chromium, firefox, webkit };
const OPTS = { firefox: { firefoxUserPrefs: { 'ui.prefersReducedMotion': 0 } }, chromium: { args: ['--force-prefers-no-reduced-motion'] }, webkit: {} };
const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what} did not finish in ${ms / 1000} s`)), ms))]);

async function cpuWindow(browser, page, pid, engine) {
  const a = treeTotals(processTree(pid));
  const t0 = performance.now();
  if (engine === 'chromium') await browser.startTracing(page, { categories: ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'blink'] });
  await page.waitForTimeout(WINDOW_MS);
  let style = null;
  if (engine === 'chromium') {
    const ev = (JSON.parse((await browser.stopTracing()).toString()).traceEvents ?? []).filter((e) => e.ph === 'X' && e.name === 'UpdateLayoutTree');
    style = { msPerS: round(ev.reduce((s, e) => s + e.dur, 0) / 1000 / (WINDOW_MS / 1000), 1) };
  }
  const b = treeTotals(processTree(pid));
  const secs = (performance.now() - t0) / 1000;
  return { cpuPercent: a && b ? round((b.cpuMs - a.cpuMs) / 10 / secs, 1) : null, workingSetMB: b ? round(b.ws / 2 ** 20, 0) : null, style };
}

for (const engine of ENGINES) {
  const launched = await TYPES[engine].launchServer(OPTS[engine]);
  const browser = await TYPES[engine].connect(launched.wsEndpoint());
  const pid = launched.process().pid;
  const out = { version: browser.version(), blank: null, cards: {} };
  results.engines[engine] = out;
  const page = await (await browser.newContext({ viewport: { width: 860, height: 520 }, reducedMotion: 'no-preference' })).newPage();
  await page.goto(`${origin}/blank`);
  await page.waitForTimeout(1000);
  out.blank = await cpuWindow(browser, page, pid, engine);
  for (const key of Object.keys(cards)) {
    const r = {};
    try {
      await page.goto(`${origin}/blank`);
      r.firstRenderMs = round(await withTimeout(page.evaluate(async (src) => {
        const img = new Image();
        const t0 = performance.now();
        img.src = src;
        document.body.append(img);
        await img.decode().catch(() => {});
        await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
        return performance.now() - t0;
      }, `${origin}/last/${cards[key].file}?${key}`), 60000, 'first render'), 0);
      await page.goto(`${origin}/blank`);
      await page.evaluate((src) => { const img = new Image(); img.src = src; document.body.append(img); }, `${origin}/live/${cards[key].file}`);
      await page.waitForTimeout(1500);
      Object.assign(r, await cpuWindow(browser, page, pid, engine));
    } catch (e) {
      r.error = String(e.message).split('\n')[0];
    }
    out.cards[key] = r;
    console.log(engine, key, JSON.stringify(r));
    writeJson(process.env.BENCH_OUT ?? 'state.json', results);
  }
  await browser.close().catch(() => {});
  await launched.close().catch(() => {});
}
server.close();
writeJson(process.env.BENCH_OUT ?? 'state.json', results);
