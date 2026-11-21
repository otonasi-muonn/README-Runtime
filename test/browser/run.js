#!/usr/bin/env node
// End-to-end proof that the CSS inside the SVG really computes the WebAssembly function.
//
// Conditions close to a GitHub README: the SVG is served as image/svg+xml with GitHub's
// CSP (no scripts, no external resources), embedded with <img>, JavaScript disabled in the
// page. Values are read back from the rendered pixels only and compared with the real
// WebAssembly engine (Node).
//
// The decisive cases change the initial value *inside the already generated SVG* (the
// generator never saw these values) and still expect the exact Wasm trajectory.
//
// Three groups:
//   frozen   the SVG's clock is pinned to a time t (the animation rule is replaced; the
//            computation rules are untouched) -> deterministic in every engine
//   live     the unmodified SVG, browser configured for "no reduced motion": steps must
//            appear over time and always match the trace
//   reduced  the unmodified SVG with prefers-reduced-motion: the final state is shown
//
//   node test/browser/run.js [--browsers chromium,firefox,webkit,chrome,msedge] [--quick]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { chromium, firefox, webkit } from 'playwright';
import { generate } from '../../src/generate.js';
import { referenceTrace } from '../../src/runtime/reference.js';
import { STORED_LIMIT } from '../../src/compiler/css.js';
import { decodeCard } from './decode.js';

const root = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const browsers = opt('--browsers', 'chromium,firefox,webkit').split(',');
const quick = args.includes('--quick');
const outDir = path.join(root, 'test-results', 'browser');
fs.mkdirSync(outDir, { recursive: true });

const wasm = fs.readFileSync(path.join(root, 'examples/collatz/collatz.wasm'));
const base = { export: 'step', init: 27, steps: 120, haltValue: 1, title: 'Collatz', wasmName: 'collatz.wasm' };
const gen = await generate(wasm, base);
const T = gen.machine.T;
const info = { steps: base.steps, bits: 20 };
const initAttr = `style="--${gen.machine.initProp}:${base.init}"`;
if (gen.svg.split(initAttr).length !== 2) throw new Error('init attribute not found exactly once in the SVG');

// Edit the generated SVG text: only the initial value changes.
const withInit = (svg, x) => svg.replace(initAttr, `style="--${gen.machine.initProp}:${x}"`);
// Pin the clock: drop the animation and set --rt. Computation rules are left untouched.
const frozen = (svg, t) => {
  const out = svg.replace(/animation:rrclk [^}]*\}/, `--rt:${t}}`).replace(/@media \(prefers-reduced-motion:reduce\)\{[^\n]*\n/, '');
  if (out === svg || out.includes('rrclk ')) throw new Error('could not pin the clock');
  return out;
};
const traceOf = (init) => referenceTrace(wasm, { exportName: 'step', haltValue: 1, init, steps: base.steps, rangeLimit: STORED_LIMIT });

const inits = quick ? [27, 97, 7, 77671] : [27, 97, 7, 703, 1, 2, 3, 255, 871, 6171, 77031, -5, 77671];
const cards = new Map();
for (const x of inits) cards.set(`final-${x}`, { svg: frozen(withInit(gen.svg, x), T), init: x, t: T });
for (const [x, t] of quick ? [[97, 40]] : [[27, 0], [27, 7], [97, 40], [871, 99]]) {
  cards.set(`t${t}-${x}`, { svg: frozen(withInit(gen.svg, x), t), init: x, t });
}
cards.set('live-97', { svg: withInit(gen.svg, 97), init: 97 });
cards.set('live-27', { svg: gen.svg, init: 27 });

// GitHub-like static server
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const m = u.pathname.match(/^\/(card|page)\/([\w-]+)\.(svg|html)$/);
  if (!m || !cards.has(m[2])) { res.writeHead(404); res.end(); return; }
  if (m[1] === 'card') {
    res.writeHead(200, {
      'Content-Type': 'image/svg+xml',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-cache',
    });
    res.end(cards.get(m[2]).svg);
  } else {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><meta charset="utf-8"><body style="margin:0;background:#ffffff"><article class="markdown-body"><p><img id="card" src="/card/${m[2]}.svg" alt="README Runtime" style="max-width:100%"></p></article></body>`);
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;

// motion: 'reduce' | 'no-preference'. SVG images do not see Playwright's media emulation,
// so the preference is set at the browser level where the engine allows it.
const launch = (b, motion) => {
  const cflag = motion === 'reduce' ? '--force-prefers-reduced-motion' : '--force-prefers-no-reduced-motion';
  const fprefs = { 'ui.prefersReducedMotion': motion === 'reduce' ? 1 : 0 };
  switch (b) {
    case 'chromium': return chromium.launch({ args: [cflag] });
    case 'chrome': return chromium.launch({ channel: 'chrome', args: [cflag] });
    case 'msedge': return chromium.launch({ channel: 'msedge', args: [cflag] });
    case 'firefox': return firefox.launch({ firefoxUserPrefs: fprefs });
    case 'webkit': return webkit.launch();
    default: throw new Error(`unknown browser ${b}`);
  }
};

const results = [];
const record = (browser, name, ok, detail) => {
  results.push({ browser, name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${browser.padEnd(8)} ${name.padEnd(26)} ${detail}`);
};

// Expected display at clock t for a trace.
function expectAt(tr, t) {
  const { values, end } = tr;
  const endAt = Math.min(end.at, base.steps);
  const shown = Math.min(t, endAt);
  return { shown, values, end, endAt };
}

function compare(dec, tr, t) {
  const { shown, values, end, endAt } = expectAt(tr, t);
  const problems = [];
  const errorShown = end.kind === 'range' && shown === endAt;
  const lastGood = errorShown ? shown - 1 : shown;
  for (let k = 0; k <= lastGood; k++) if (dec.cols[k] !== values[k]) problems.push(`col ${k}: ${dec.cols[k]} != ${values[k]}`);
  for (let k = lastGood + 1; k <= base.steps; k++) if (dec.cols[k] !== null) problems.push(`col ${k}: ${dec.cols[k]} should be blank`);
  if (errorShown) {
    if (dec.status !== 'error') problems.push(`status ${dec.status}, expected error`);
  } else {
    if (dec.led !== values[shown]) problems.push(`register ${dec.led} != ${values[shown]}`);
    const want = end.kind === 'halt' && shown === endAt ? 'halted' : shown < endAt ? 'running' : 'end';
    if (dec.status !== want) problems.push(`status ${dec.status}, expected ${want}`);
  }
  return problems;
}

async function shoot(page, name) {
  await page.goto(`${origin}/page/${name}.html`);
  await page.waitForFunction(() => { const i = document.getElementById('card'); return i && i.complete && i.naturalWidth > 0; }, null, { timeout: 15000, polling: 100 }).catch(() => {});
  await page.waitForTimeout(300);
  return page.locator('#card').screenshot();
}

for (const b of browsers) {
  // ---------------------------------------------------------------- frozen clock
  let browser;
  try { browser = await launch(b, 'reduce'); } catch (e) {
    record(b, 'launch', false, `cannot launch: ${e.message.split('\n')[0]}`);
    continue;
  }
  try {
    for (const scheme of quick ? ['dark'] : ['dark', 'light']) {
      const ctx = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 840, height: 340 }, colorScheme: scheme });
      const page = await ctx.newPage();
      for (const [name, c] of cards) {
        if (c.t === undefined) continue;
        if (scheme === 'light' && !['final-27', 'final-97', 't40-97'].includes(name)) continue;
        const shot = await shoot(page, name);
        const tr = await traceOf(c.init);
        const dec = decodeCard(shot, info);
        const problems = compare(dec, tr, c.t);
        if (problems.length) fs.writeFileSync(path.join(outDir, `${b}-${scheme}-${name}.png`), shot);
        const summary = `x0=${c.init} t=${c.t} trace=${tr.end.kind}@${tr.end.at} register=${dec.led} status=${dec.status}`;
        record(b, `${name} [${scheme}]`, !problems.length, problems.length ? `${summary} :: ${problems.slice(0, 3).join('; ')}` : summary);
      }
      await ctx.close();
    }
    // ---------------------------------------------------------------- reduced motion
    if (b !== 'webkit') {
      const ctx = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 840, height: 340 } });
      const page = await ctx.newPage();
      const shot = await shoot(page, 'live-27');
      const tr = await traceOf(27);
      const problems = compare(decodeCard(shot, info), tr, T);
      if (problems.length) fs.writeFileSync(path.join(outDir, `${b}-reduced-27.png`), shot);
      record(b, 'reduced-motion-27', !problems.length, problems.length ? problems.slice(0, 3).join('; ') : 'final state shown without animation');
      await ctx.close();
    }
  } finally {
    await browser.close();
  }

  // ---------------------------------------------------------------- live animation
  try { browser = await launch(b, 'no-preference'); } catch (e) {
    record(b, 'launch', false, `cannot launch: ${e.message.split('\n')[0]}`);
    continue;
  }
  try {
    const ctx = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 840, height: 340 } });
    const page = await ctx.newPage();
    await page.goto(`${origin}/page/live-97.html`);
    const tr = await traceOf(97);
    const seen = [];
    for (const wait of [900, 1800, 1800]) {
      await page.waitForTimeout(wait);
      const shot = await page.locator('#card').screenshot();
      const dec = decodeCard(shot, info);
      const n = dec.cols.findIndex((c) => c === null);
      const visible = n === -1 ? dec.cols.length : n;
      const problems = [];
      // The newest column can be caught mid-update by the screenshot; all older columns
      // and the register (which may lag one step) must match the trace exactly.
      for (let k = 0; k < visible - 1; k++) if (dec.cols[k] !== tr.values[k]) problems.push(`col ${k}: ${dec.cols[k]} != ${tr.values[k]}`);
      const okLed = [visible - 1, visible - 2, visible].some((k) => k >= 0 && tr.values[k] === dec.led);
      if (dec.status !== 'running') problems.push(`status ${dec.status}, expected running`);
      if (!okLed) problems.push(`register ${dec.led} not near step ${visible - 1}`);
      seen.push(visible);
      if (problems.length) fs.writeFileSync(path.join(outDir, `${b}-live-${seen.length}.png`), shot);
      record(b, `live-97 sample ${seen.length}`, !problems.length, `visible steps=${visible} register=${dec.led} status=${dec.status}${problems.length ? ' :: ' + problems.slice(0, 3).join('; ') : ''}`);
    }
    const advancing = seen[0] < seen[1] && seen[1] < seen[2] && seen[0] < base.steps;
    record(b, 'live-97 clock advances', advancing, `visible steps ${seen.join(' -> ')}`);
    await ctx.close();
  } finally {
    await browser.close();
  }
}
server.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed (${browsers.join(', ')})`);
fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify(results, null, 2));
process.exit(failed.length ? 1 : 0);
