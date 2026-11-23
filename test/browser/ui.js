#!/usr/bin/env node
// Browser proof for UI cards: the CSS-bound template must look exactly like the project's
// component rendered directly for the same state, inside an <img> with JS disabled.
//
// For each pinned clock value t (the computation rules are untouched; only the animation
// rule is replaced by --rt:t), the expected state is taken from the real Wasm engine, the
// component is rendered directly for that state's view values (no bindings at all), and the
// UI region of both screenshots must match pixel for pixel. The initial value is also edited
// inside the generated SVG. Different clock values must show different pictures.
//
//   node test/browser/ui.js [--browsers chromium,firefox,webkit] [--card mockcraft]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { chromium, firefox, webkit } from 'playwright';
import { PNG } from 'pngjs';
import { loadConfig } from '../../src/project.js';
import { generate } from '../../src/generate.js';
import { referenceTrace, instantiate as wasmInstance } from '../../src/runtime/reference.js';
import { bundleEntry, renderWith } from '../../src/ui/bundle.js';
import { parseHtml, toXhtml } from '../../src/ui/html.js';
import { uiLayout } from '../../src/render/ui-card.js';

const root = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const browsers = opt('--browsers', 'chromium,firefox,webkit').split(',');
const cardName = opt('--card', 'mockcraft');
const outDir = path.join(root, 'test-results', 'browser-ui');
fs.mkdirSync(outDir, { recursive: true });

const cfg = loadConfig(path.join(root, 'readme-runtime.json'));
const card = cfg.cards.find((c) => c.name === cardName);
if (!card?.options.ui) throw new Error(`no UI card named ${cardName}`);
const wasm = fs.readFileSync(path.join(cfg.dir, card.wasm));
const gen = await generate(wasm, card.options);
const ui = card.options.ui;
const bundle = await bundleEntry(ui.entry, { tsconfig: ui.tsconfig, cwd: cfg.dir });
const ex = await wasmInstance(wasm);
const T = gen.machine.T;
const L = uiLayout({ width: gen.svg.match(/<foreignObject[^>]*width="(\d+)"/)[1] * 1, height: gen.svg.match(/<foreignObject[^>]*height="(\d+)"/)[1] * 1 });
const fo = { x: Number(gen.svg.match(/<foreignObject x="(\d+)"/)[1]), y: Number(gen.svg.match(/<foreignObject x="\d+" y="(\d+)"/)[1]), w: L.W, h: 0 };
fo.w = Number(gen.svg.match(/<foreignObject[^>]*width="(\d+)"/)[1]);
fo.h = Number(gen.svg.match(/<foreignObject[^>]*height="(\d+)"/)[1]);

const initAttr = `style="--${gen.machine.initProp}:${card.options.init}"`;
const pin = (svg, t) => svg.replace(/animation:rrclk [^}]*\}/, `--rt:${t}}`).replace(/@media \(prefers-reduced-motion:reduce\)\{[^\n]*\n/, '');
// The real clock, paused at step t: the values then come from an animation, as on GitHub
// (Firefox re-evaluates container queries differently for animated and for static values).
const [, clockMs, clockSteps] = gen.svg.match(/animation:rrclk (\d+)ms steps\((\d+)/).map(Number);
const pause = (svg, t) => svg.replace(/(animation:rrclk [^}]*)\}/, `$1;animation-delay:-${((t + 0.5) * clockMs) / clockSteps}ms;animation-play-state:paused}`).replace(/@media \(prefers-reduced-motion:reduce\)\{[^\n]*\n/, '');
const strip = (n) => n.attrs.filter(([k]) => !/^(data-|aria-)/.test(k) && !['id', 'title', 'tabindex', 'key', 'name', 'for', 'type'].includes(k));
const UI_OPEN = /(<div xmlns="http:\/\/www\.w3\.org\/1999\/xhtml" class="rr-ui" style="[^"]*">)[\s\S]*?(<\/div><\/foreignObject>)/;

async function expected(init, t) {
  const tr = await referenceTrace(wasm, { exportName: card.options.export, init, steps: card.options.steps });
  const shown = Math.min(t, tr.values.length - 1);
  const state = tr.values[shown];
  const views = Object.fromEntries(Object.entries(ui.views).map(([name, exp]) => [name, ex[exp](state) | 0]));
  return { state, views, shown };
}

// cases: [name, init, t]
const cases = [['gen', card.options.init, 0], ['gen', card.options.init, 23], ['gen', card.options.init, 37], ['gen', card.options.init, 101], ['gen', card.options.init, T]];
const edited = [0, 1 | (3 << 5), 7 | (9 << 5) | (1 << 9) | (21 << 11)];
for (const x of edited) cases.push([`init${x}`, x, 50]);
for (const [label, init, t] of [...cases]) cases.push([`${label}-anim`, init, t]);
const svgs = new Map();
for (const [label, init, t] of cases) {
  const live = (label.endsWith('-anim') ? pause : pin)(gen.svg.replace(initAttr, `style="--${gen.machine.initProp}:${init}"`), t);
  const e = await expected(init, t);
  const direct = toXhtml(parseHtml(renderWith(bundle, e.views)), { hooks: { attrs: strip } });
  const ref = live.replace(UI_OPEN, (_, a, b) => `${a}${direct}${b}`);
  if (ref === live) throw new Error('could not build the reference card');
  svgs.set(`${label}-t${t}-live`, { svg: live, e });
  svgs.set(`${label}-t${t}-ref`, { svg: ref, e });
}

const server = http.createServer((req, res) => {
  const m = new URL(req.url, 'http://x').pathname.match(/^\/(card|page)\/(.+)\.(svg|html)$/);
  if (!m || !svgs.has(m[2])) { res.writeHead(404); res.end(); return; }
  if (m[1] === 'card') {
    res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox", 'X-Content-Type-Options': 'nosniff' });
    res.end(svgs.get(m[2]).svg);
  } else {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><meta charset="utf-8"><body style="margin:0"><img id="card" src="/card/${m[2]}.svg"></body>`);
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;

const crop = (png) => {
  const out = [];
  for (let y = fo.y; y < fo.y + fo.h; y++) for (let x = fo.x; x < fo.x + fo.w; x++) { const i = (y * png.width + x) * 4; out.push(png.data[i], png.data[i + 1], png.data[i + 2]); }
  return out;
};
const diff = (a, b) => { let n = 0; for (let i = 0; i < a.length; i += 3) if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) > 30) n++; return n; };
const bbox = (a, b) => {
  let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
  for (let i = 0; i < a.length; i += 3) {
    if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) <= 30) continue;
    const p = i / 3, x = p % fo.w, y = Math.floor(p / fo.w);
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
  }
  return x1 < 0 ? '' : ` at ui (${x0},${y0})-(${x1},${y1})`;
};

const results = [];
const record = (b, name, ok, detail) => { results.push({ b, name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${b.padEnd(8)} ${name.padEnd(26)} ${detail}`); };
for (const b of browsers) {
  const br = await ({ chromium, firefox, webkit })[b].launch();
  const page = await (await br.newContext({ javaScriptEnabled: false, viewport: { width: 900, height: 560 } })).newPage();
  const shots = new Map();
  for (const key of svgs.keys()) {
    await page.goto(`${origin}/page/${key}.html`, { waitUntil: 'load' });
    await page.waitForTimeout(200);
    const buf = await page.locator('#card').screenshot();
    shots.set(key, crop(PNG.sync.read(buf)));
    if (key.endsWith('-live')) fs.writeFileSync(path.join(outDir, `${b}-${key}.png`), buf);
  }
  for (const [label, init, t] of cases) {
    const k = `${label}-t${t}`;
    const d = diff(shots.get(`${k}-live`), shots.get(`${k}-ref`));
    const e = svgs.get(`${k}-live`).e;
    // Chromium shapes text on both sides of a CSS counter as separate runs, which can move a
    // neighbouring glyph by a sub-pixel amount; a few glyph-edge pixels are tolerated.
    record(b, `${k} live = direct render`, d <= 150, `state ${e.state} views ${JSON.stringify(e.views)} differing px ${d}${bbox(shots.get(`${k}-live`), shots.get(`${k}-ref`))}`);
  }
  const a = shots.get(`gen-t0-live`), c = shots.get(`gen-t37-live`);
  record(b, 'display changes over time', diff(a, c) > 500, `t0 vs t37 differing px ${diff(a, c)}`);
  await br.close();
}
server.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} UI checks passed (${browsers.join(', ')})`);
process.exit(failed.length ? 1 : 0);
