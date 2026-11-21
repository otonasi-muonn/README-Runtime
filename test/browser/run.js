#!/usr/bin/env node
// End-to-end proof that the CSS inside the SVG really computes the WebAssembly function.
//
// Conditions close to a GitHub README: the SVG is served as image/svg+xml with GitHub's
// CSP (no scripts, no external resources), embedded with <img>, JavaScript disabled in the
// page. Values are read back from the rendered pixels only and compared with the real
// WebAssembly engine (Node).
//
// For every program the card is generated once; then the initial value is changed *inside
// the generated SVG* (the generator never saw these values). The card must show the exact
// Wasm trajectory, or stop with OUT OF RANGE at the step where a value would leave what CSS
// computes exactly; it must never show a wrong number.
//
// Groups:
//   frozen   the SVG's clock is pinned to a time t (the animation rule is replaced; the
//            computation rules are untouched) -> deterministic in every engine
//   live     the unmodified SVG with "no reduced motion": steps appear over time and
//            always match the trace
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
import { simulateMachine } from '../../src/runtime/machine.js';
import { MODELS } from '../../src/compiler/css.js';
import { decodeCard } from './decode.js';
import { PROGRAMS } from './programs.js';

const root = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const browsers = opt('--browsers', 'chromium,firefox,webkit').split(',');
const quick = args.includes('--quick');
const outDir = path.join(root, 'test-results', 'browser');
fs.mkdirSync(outDir, { recursive: true });
const STEPS = 120;

// ------------------------------------------------------------------ expectations
// What the card must show at clock t for initial value `init`.
async function expectation(p, gen, init, t) {
  const tr = await referenceTrace(p.wasm, { exportName: p.export, haltValue: p.haltValue ?? null, init, steps: STEPS });
  const m = gen.machine;
  const sims = Object.fromEntries(Object.entries(MODELS).map(([k, model]) => [k, simulateMachine(m, { model, init }).levels]));
  const lv = sims.exact;
  const par = (k) => (k === 0 ? 'b' : k % 2 ? 'a' : 'b');
  // first level where the CSS raises its error flag (range guard or trap)
  let flagAt = null;
  for (let k = 0; k <= STEPS; k++) {
    if (lv[k].get(`re${par(k)}`) === 1) { flagAt = k; break; }
  }
  const haltAt = tr.end.kind === 'halt' ? tr.end.at : null;
  const trapAt = tr.end.kind === 'trap' ? tr.end.at : null;
  const candidates = [STEPS, haltAt, trapAt, flagAt].filter((x) => x !== null);
  const endAt = Math.min(...candidates);
  const kind = flagAt === endAt ? 'error' : haltAt === endAt ? 'halt' : 'end';
  // Soundness at the model level: before the flag, every model equals Wasm exactly.
  const lastGood = kind === 'error' ? endAt - 1 : endAt;
  for (const [name, levels] of Object.entries(sims)) {
    for (let k = 0; k <= lastGood; k++) {
      const v = levels[k].get(k === 0 ? m.initProp : `rx${par(k)}`);
      if (v !== tr.values[k]) throw new Error(`model ${name} disagrees with Wasm at step ${k} for init ${init}: ${v} vs ${tr.values[k]}`);
    }
  }
  const shown = Math.min(t, endAt);
  return { values: tr.values, endAt, kind, shown, lastGood: Math.min(lastGood, shown) };
}

function compare(dec, e) {
  const problems = [];
  if (dec.broken) return [`image did not render (screenshot ${dec.size.join('x')})`];
  const errorShown = e.kind === 'error' && e.shown === e.endAt;
  for (let k = 0; k <= e.lastGood; k++) if (dec.cols[k] !== e.values[k]) problems.push(`col ${k}: ${dec.cols[k]} != ${e.values[k]}`);
  for (let k = e.lastGood + 1; k < dec.cols.length; k++) if (dec.cols[k] !== null) problems.push(`col ${k}: ${dec.cols[k]} should be empty`);
  const want = errorShown ? 'error' : e.shown < e.endAt ? 'running' : e.kind === 'halt' ? 'halted' : 'end';
  if (dec.status !== want) problems.push(`status ${dec.status}, expected ${want}`);
  if (!errorShown && dec.led !== e.values[e.shown]) problems.push(`register ${dec.led} != ${e.values[e.shown]}`);
  if (errorShown && dec.led !== 0) problems.push(`register shows ${dec.led} during an error`);
  return problems;
}

// ------------------------------------------------------------------ cards
const cards = new Map(); // name -> { svg, program, gen, init, t }
const pin = (svg, t) => {
  const out = svg.replace(/animation:rrclk [^}]*\}/, `--rt:${t}}`).replace(/@media \(prefers-reduced-motion:reduce\)\{[^\n]*\n/, '');
  if (out === svg || out.includes('rrclk ')) throw new Error('could not pin the clock');
  return out;
};
const programNames = quick ? ['collatz', 'lfsr-rust', 'chain90-c', 'sext20'] : Object.keys(PROGRAMS);
for (const name of programNames) {
  const p = PROGRAMS[name];
  const gen = await generate(p.wasm, { export: p.export, init: p.init, steps: STEPS, haltValue: p.haltValue ?? null, bits: p.bits ?? 20, title: name, wasmName: `${name}.wasm` });
  const attr = `style="--${gen.machine.initProp}:${p.init}"`;
  if (gen.svg.split(attr).length !== 2) throw new Error(`${name}: init attribute not found exactly once`);
  const withInit = (x) => gen.svg.replace(attr, `style="--${gen.machine.initProp}:${x}"`);
  const T = gen.machine.T;
  const edits = quick ? p.edits.slice(0, 2) : p.edits;
  cards.set(`${name}--gen`, { svg: pin(gen.svg, T), p, gen, init: p.init, t: T });
  for (const x of edits) cards.set(`${name}--x${x}`, { svg: pin(withInit(x), T), p, gen, init: x, t: T });
  if (name === 'collatz') {
    for (const [x, t] of quick ? [[97, 40]] : [[27, 0], [27, 7], [97, 40], [871, 99]]) cards.set(`${name}--x${x}-t${t}`, { svg: pin(withInit(x), t), p, gen, init: x, t });
    cards.set('collatz--live97', { svg: withInit(97), p, gen, init: 97, live: true });
    cards.set('collatz--live27', { svg: gen.svg, p, gen, init: 27, live: true });
  }
}

// ------------------------------------------------------------------ GitHub-like server
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
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${browser.padEnd(8)} ${name.padEnd(34)} ${detail}`);
};

// The page's load event waits for the <img>; JavaScript is disabled, so no page script
// is needed (and none could run). A broken image is detected from the screenshot size.
async function shoot(page, name) {
  await page.goto(`${origin}/page/${name}.html`, { waitUntil: 'load' });
  await page.waitForTimeout(250);
  return page.locator('#card').screenshot();
}

for (const b of browsers) {
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
        if (c.live) continue;
        if (scheme === 'light' && !['collatz--gen', 'collatz--x97', 'collatz--x97-t40', 'lfsr-rust--gen', 'sext20--x600000'].includes(name)) continue;
        const shot = await shoot(page, name);
        const e = await expectation(c.p, c.gen, c.init, c.t);
        const dec = decodeCard(shot, { steps: STEPS, bits: c.p.bits ?? 20 });
        const problems = compare(dec, e);
        if (problems.length) fs.writeFileSync(path.join(outDir, `${b}-${scheme}-${name}.png`), shot);
        const summary = `x0=${c.init} t=${c.t} -> ${e.kind}@${e.endAt} shows ${dec.status}${e.kind === 'error' ? '' : ` ${dec.led}`}`;
        record(b, `${name} [${scheme}]`, !problems.length, problems.length ? `${summary} :: ${problems.slice(0, 3).join('; ')}` : summary);
      }
      await ctx.close();
    }
    if (b !== 'webkit') { // WebKit has no switch for prefers-reduced-motion
      const ctx = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 840, height: 340 } });
      const page = await ctx.newPage();
      const c = cards.get('collatz--live27');
      const shot = await shoot(page, 'collatz--live27');
      const problems = compare(decodeCard(shot, { steps: STEPS, bits: 20 }), await expectation(c.p, c.gen, 27, c.gen.machine.T));
      if (problems.length) fs.writeFileSync(path.join(outDir, `${b}-reduced-27.png`), shot);
      record(b, 'reduced-motion collatz 27', !problems.length, problems.length ? problems.slice(0, 3).join('; ') : 'final state shown without animation');
      await ctx.close();
    }
  } finally {
    await browser.close();
  }

  // live animation
  try { browser = await launch(b, 'no-preference'); } catch (e) {
    record(b, 'launch', false, `cannot launch: ${e.message.split('\n')[0]}`);
    continue;
  }
  try {
    const ctx = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 840, height: 340 } });
    const page = await ctx.newPage();
    const c = cards.get('collatz--live97');
    await page.goto(`${origin}/page/collatz--live97.html`, { waitUntil: 'load' });
    const e = await expectation(c.p, c.gen, 97, c.gen.machine.T);
    const seen = [];
    for (const wait of [900, 1800, 1800]) {
      await page.waitForTimeout(wait);
      const shot = await page.locator('#card').screenshot();
      const dec = decodeCard(shot, { steps: STEPS, bits: 20 });
      const n = dec.cols.findIndex((v) => v === null);
      const visible = n === -1 ? dec.cols.length : n;
      const problems = [];
      if (dec.broken) problems.push('image did not render');
      // The newest column can be caught mid-update by the screenshot; all older columns
      // and the register (which may lag one step) must match the trace exactly.
      for (let k = 0; k < visible - 1; k++) if (dec.cols[k] !== e.values[k]) problems.push(`col ${k}: ${dec.cols[k]} != ${e.values[k]}`);
      if (![visible - 1, visible - 2, visible].some((k) => k >= 0 && e.values[k] === dec.led)) problems.push(`register ${dec.led} not near step ${visible - 1}`);
      if (dec.status !== 'running') problems.push(`status ${dec.status}, expected running`);
      seen.push(visible);
      if (problems.length) fs.writeFileSync(path.join(outDir, `${b}-live-${seen.length}.png`), shot);
      record(b, `live collatz 97 sample ${seen.length}`, !problems.length, `visible steps=${visible} register=${dec.led}${problems.length ? ' :: ' + problems.slice(0, 3).join('; ') : ''}`);
    }
    record(b, 'live collatz 97 clock advances', seen[0] < seen[1] && seen[1] < seen[2] && seen[0] < STEPS, `visible steps ${seen.join(' -> ')}`);
    await ctx.close();
  } finally {
    await browser.close();
  }
}
server.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed (${browsers.join(', ')}; ${programNames.length} programs)`);
fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify(results, null, 2));
process.exit(failed.length ? 1 : 0);
