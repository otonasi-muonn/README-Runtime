#!/usr/bin/env node
// Same proof as test/browser/ui.js, scoped to this experiment. Only the clock rule is
// pinned; state/view CSS is untouched. Both actual and direct-reference SVGs are <img>
// resources under script-blocking CSP, in contexts with JavaScript disabled.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, firefox, webkit } from 'playwright';
import { PNG } from 'pngjs';
import { bundleEntry, renderWith } from '../../src/ui/bundle.js';
import { parseHtml, toXhtml } from '../../src/ui/html.js';
import { instantiate, referenceTrace } from '../../src/runtime/reference.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const out = path.join(here, 'screenshots');
fs.mkdirSync(out, { recursive: true });
const card = JSON.parse(fs.readFileSync(path.join(root, 'readme-runtime.json'))).cards.find(c => c.name === 'air-drawing');
assert.ok(card, 'air-drawing card must be configured');
const svg = fs.readFileSync(path.join(root, card.out ?? 'readme-runtime/air-drawing.svg'), 'utf8');
assert.ok(!/<script\b/i.test(svg), 'card must contain no scripts');
const width = Number(svg.match(/<svg[^>]*\bwidth="(\d+)"/)[1]);
const height = Number(svg.match(/<svg[^>]*\bheight="(\d+)"/)[1]);
const foreign = /<foreignObject x="(\d+)" y="(\d+)" width="(\d+)" height="(\d+)"/.exec(svg);
assert.ok(foreign, 'card must have a UI region');
const ui = { x: +foreign[1], y: +foreign[2], w: +foreign[3], h: +foreign[4] };
const wasm = fs.readFileSync(path.join(root, card.wasm));
const ex = await instantiate(wasm);
const trace = await referenceTrace(wasm, { exportName: card.export, init: card.init, steps: card.steps });
const bundle = await bundleEntry(card.ui.entry, { cwd: root });
const times = [20, 150];
const resources = new Map();
const states = [];
// the reference is the component's own markup, every attribute included
const UI_OPEN = /(<div class="rr-ui" style="[^"]*">)[\s\S]*?(<\/div><\/div><\/foreignObject>)/;
for (const t of times) {
  const pinned = svg.replace(/animation:rrclk [^}]*\}/, `--rt:${t}}`).replace(/@media \(prefers-reduced-motion:reduce\)\{[^\n]*\n/, '');
  assert.notEqual(pinned, svg, 'clock replacement must take effect');
  assert.ok(!pinned.includes('rrclk '), 'clock must be pinned');
  const state = trace.values[t];
  const views = Object.fromEntries(Object.entries(card.ui.views).map(([name, exp]) => [name, ex[exp](state) | 0]));
  const direct = toXhtml(parseHtml(renderWith(bundle, views)));
  const reference = pinned.replace(UI_OPEN, (_, a, b) => `${a}${direct}${b}`);
  assert.notEqual(reference, pinned, 'direct-reference markup replacement must take effect');
  resources.set(`t${t}`, pinned);
  resources.set(`t${t}-reference`, reference);
  states.push({ t, state, views });
}
const server = http.createServer((req, res) => {
  const m = new URL(req.url, 'http://local').pathname.match(/^\/(card|page)\/([\w-]+)\.(svg|html)$/);
  if (!m || !resources.has(m[2])) { res.writeHead(404).end(); return; }
  if (m[1] === 'card') {
    res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox", 'X-Content-Type-Options': 'nosniff' });
    res.end(resources.get(m[2]));
  } else {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><meta charset="utf-8"><body style="margin:0;background:white"><img id="card" src="/card/${m[2]}.svg" alt="air drawing"></body>`);
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
// Stage interior, excluding its rounded border and the toolbar/counters. Its position
// follows the copied upstream header/main CSS and demo.tsx's explicit stage size.
const stage = { x: ui.x + 20, y: ui.y + 84, w: 464, h: 344 };
const pixels = (png, region) => {
  const values = [];
  for (let y = region.y; y < region.y + region.h; y++) for (let x = region.x; x < region.x + region.w; x++) {
    const i = (y * png.width + x) * 4;
    values.push(png.data[i], png.data[i + 1], png.data[i + 2]);
  }
  return values;
};
const diff = (a, b) => {
  assert.equal(a.length, b.length);
  let n = 0;
  for (let i = 0; i < a.length; i += 3) if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) > 30) n++;
  return n;
};
const ink = values => {
  let n = 0;
  for (let i = 0; i < values.length; i += 3) if (values[i] + values[i + 1] + values[i + 2] < 600) n++;
  return n;
};
const results = [];
try {
  for (const [name, engine] of Object.entries({ chromium, firefox, webkit })) {
    const browser = await engine.launch();
    try {
      const context = await browser.newContext({ javaScriptEnabled: false, viewport: { width: width + 20, height: height + 20 }, colorScheme: 'dark' });
      const page = await context.newPage();
      const shots = new Map();
      for (const key of resources.keys()) {
        await page.goto(`${origin}/page/${key}.html`, { waitUntil: 'load' });
        await page.waitForTimeout(250);
        const buffer = await page.locator('#card').screenshot();
        const png = PNG.sync.read(buffer);
        assert.equal(png.width, width, `${name} must load the SVG image`);
        assert.equal(png.height, height);
        shots.set(key, png);
        if (!key.endsWith('-reference')) fs.writeFileSync(path.join(out, `${name}-${key}.png`), buffer);
      }
      const frames = times.map(t => {
        const actual = shots.get(`t${t}`), reference = shots.get(`t${t}-reference`);
        const stagePixels = pixels(actual, stage);
        const stageDiff = diff(stagePixels, pixels(reference, stage));
        assert.equal(stageDiff, 0, `${name} t${t}: drawing must match direct render for real Wasm views`);
        return { t, stageDiff, uiDiff: diff(pixels(actual, ui), pixels(reference, ui)), inkPixels: ink(stagePixels), screenshot: `screenshots/${name}-t${t}.png` };
      });
      const changed = diff(pixels(shots.get(`t${times[0]}`), stage), pixels(shots.get(`t${times[1]}`), stage));
      assert.ok(changed > 500, `${name}: the drawing must change between clock values`);
      assert.ok(frames[1].inkPixels > frames[0].inkPixels, `${name}: later frame must have more drawing ink`);
      results.push({ browser: name, version: browser.version(), javaScriptEnabled: false, frames, changedStagePixels: changed });
      console.log(`PASS ${name}: t20/t150 stage matches direct render (0 differing pixels); ink ${frames.map(f => f.inkPixels).join(' -> ')}, changed ${changed}px`);
    } finally { await browser.close(); }
  }
} finally { await new Promise(resolve => server.close(resolve)); }
const evidence = { svgSha256: crypto.createHash('sha256').update(svg).digest('hex'), clocksPinnedOnly: true, states, stage, results };
fs.writeFileSync(path.join(out, 'results.json'), `${JSON.stringify(evidence, null, 2)}\n`);
console.log('PASS 3/3 browsers: <img>, JavaScript disabled, CSP blocks scripts and external resources');
