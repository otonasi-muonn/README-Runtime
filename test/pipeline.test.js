// End-to-end (without a browser): .wasm -> verified SVG, determinism, and the "edit the
// initial value inside the SVG" property checked with the browser arithmetic models.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { generate, OptionError } from '../src/generate.js';
import { VerifyError } from '../src/verify.js';
import { simulateMachine } from '../src/runtime/machine.js';
import { referenceTrace } from '../src/runtime/reference.js';
import { MODELS, STORED_LIMIT } from '../src/compiler/css.js';
import { unary, op, c, get } from './helpers/wasm-builder.js';

const root = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const collatz = fs.readFileSync(path.join(root, 'examples/collatz/collatz.wasm'));
const opts = { export: 'step', init: 27, steps: 120, haltValue: 1, title: 'Collatz', wasmName: 'collatz.wasm' };

test('collatz.wasm compiles, verifies and halts at step 111', async () => {
  const r = await generate(collatz, opts);
  assert.equal(r.verification.trace.end.kind, 'halt');
  assert.equal(r.verification.trace.end.at, 111);
  assert.equal(r.verification.trace.values[3], 124);
  assert.ok(r.svg.length < 60000, `svg is ${r.svg.length} bytes`);
});

test('output is byte-for-byte deterministic', async () => {
  const a = await generate(collatz, opts);
  const b = await generate(collatz, opts);
  assert.equal(a.svg, b.svg);
});

test('the SVG holds the initial value exactly once and no precomputed states', async () => {
  const r = await generate(collatz, opts);
  const attr = `style="--${r.machine.initProp}:27"`;
  assert.equal(r.svg.split(attr).length, 2);
  // Distinctive values of the trajectory (e.g. the peak 9232) must not appear anywhere.
  for (const v of [9232, 4616, 7288, 3077]) assert.ok(!r.svg.includes(String(v)), `found ${v} in the SVG`);
});

test('changing only the initial value reproduces the Wasm trajectory in every browser model', async () => {
  const r = await generate(collatz, opts);
  for (const init of [1, 2, 3, 6, 7, 9, 97, 871, 6171, 77031, -1, -17]) {
    const tr = await referenceTrace(collatz, { exportName: 'step', haltValue: 1, init, steps: 120, rangeLimit: STORED_LIMIT });
    for (const [name, model] of Object.entries(MODELS)) {
      const { levels } = simulateMachine(r.machine, { model, init });
      const last = tr.end.kind === 'trap' || tr.end.kind === 'range' ? tr.end.at - 1 : tr.values.length - 1;
      for (let k = 0; k <= last; k++) {
        const v = levels[k].get(k === 0 ? 'rxb' : k % 2 ? 'rxa' : 'rxb');
        assert.equal(v, tr.values[k], `init=${init} step=${k} model=${name}`);
      }
    }
  }
});

test('the clock drives only the display: levels never read it, so a tick does not restyle the run', async () => {
  const r = await generate(collatz, opts);
  const rule = (sel) => r.svg.match(new RegExp(`\\n\\${sel}\\{\\n([^}]*)\\}`))[1];
  for (const sel of ['.R', '.A', '.B']) assert.ok(!rule(sel).includes('var(--rt)'), `${sel} reads the clock`);
  assert.ok(rule('.D').includes('var(--rt)'), 'the display reads the clock');
  assert.match(r.svg, /\n\.C\{animation:rrclk \d+ms steps\(\d+,jump-none\) (?:infinite|\d+ forwards)\}/);
  // the clock element wraps the display, inside the innermost level
  const opened = r.svg.match(/<g class="[AB]"[^>]*>/g);
  assert.equal(opened.length, opts.steps);
  opened.forEach((g, i) => assert.equal(g, `<g class="${(i + 1) % 2 ? 'A' : 'B'}" style="--rS${i + 1}:var(--rx)">`));
  const tail = r.svg.slice(r.svg.lastIndexOf('<g class="B" style="--rS120:var(--rx)">'));
  assert.ok(tail.includes('<g class="C"><g class="D">') && r.svg.split('class="C"').length === 2);
});

test('the display shows the Wasm run at every clock time, also for edited initial values', async () => {
  const r = await generate(collatz, opts);
  const T = r.machine.T;
  // 77671 leaves the exact range at step 14; -17 cycles forever; 27 halts at 111
  for (const init of [27, 97, 1, 77671, -17, 6171]) {
    const tr = await referenceTrace(collatz, { exportName: 'step', haltValue: 1, init, steps: 120, rangeLimit: STORED_LIMIT });
    const stop = tr.end.at;
    const flags = { steps: 0, halt: 1, range: 2, trap: 4 }[tr.end.kind];
    assert.ok(flags !== undefined && stop <= 120, `${init}: ${JSON.stringify(tr.end)}`);
    for (const [name, model] of Object.entries(MODELS)) {
      for (const t of new Set([0, 1, 2, 13, 14, 15, 60, stop - 1, stop, stop + 1, 120, T])) {
        if (t < 0 || t > T) continue;
        const inner = simulateMachine(r.machine, { model, init, t }).levels[120];
        const shown = Math.min(t, stop);
        const at = `init=${init} t=${t} model=${name}`;
        assert.equal(inner.get('rsx'), shown, `step ${at}`);
        if (tr.end.kind !== 'range' || shown < stop) assert.equal(inner.get('rcs'), tr.values[shown], `value ${at}`);
        assert.equal(inner.get('rfs'), shown === stop ? flags : 0, `flags ${at}`);
      }
    }
  }
});

test('altInits: the same file starts from another verified initial value for #x<value>', async () => {
  const r = await generate(collatz, { ...opts, altInits: [97, 871, -17] });
  assert.ok(r.svg.includes('<g id="x97"/><g id="x871"/><g id="x-17"/><g class="R" style="--rxb:27">'));
  for (const x of [97, 871, -17]) assert.ok(r.svg.includes(`#x${x}:target~.R{--rxb:${x}!important}`), String(x));
  assert.deepEqual(r.verification.alt.map((a) => [a.init, a.end.kind, a.end.at]), [[97, 'halt', 118], [871, 'steps', 120], [-17, 'steps', 120]]);
  // still no precomputed state of any run in the file
  for (const init of [97, 871]) {
    const tr = await referenceTrace(collatz, { exportName: 'step', haltValue: 1, init, steps: 120 });
    const big = tr.values.filter((v) => v >= 4000);
    assert.ok(big.length > 3, `${init}: ${big.length} large values`);
    for (const v of big) assert.ok(!r.svg.includes(String(v)), `found ${v} (init ${init})`);
  }
  // each run is verified like the main one
  await assert.rejects(generate(collatz, { ...opts, altInits: [97, 77671] }), (e) => e instanceof VerifyError && /^altInits 77671: step 14/.test(e.message));
  for (const altInits of [[27], [97, 97], [1.5], [1_000_000], Array.from({ length: 17 }, (_, i) => i + 100), 'x97']) {
    await assert.rejects(generate(collatz, { ...opts, altInits }), (e) => e instanceof OptionError && /"altInits"/.test(e.message), JSON.stringify(altInits));
  }
});

test('values beyond the CSS-exact range are refused with an explanation', async () => {
  await assert.rejects(generate(collatz, { ...opts, init: 77671 }), (e) => e instanceof VerifyError && /outside the CSS-exact range/.test(e.message) && /step 14/.test(e.message));
});

test('a trapping step is reported and shown as stopped', async () => {
  // f(x) = 100 / (x - 3): traps when x reaches 3. Sequence from 5: 5 -> 50 -> 2 -> -100 -> 0 -> -33 ...
  const wasm = unary([c(100), get(0), c(3), op.sub, op.div_s]);
  const r = await generate(wasm, { export: 'f', init: 6, steps: 10 });
  const tr = r.verification.trace;
  assert.equal(tr.end.kind, 'trap');
  const { levels } = simulateMachine(r.machine, { model: MODELS.chromium });
  const at = tr.end.at;
  assert.equal(levels[at].get(at % 2 ? 'rea' : 'reb'), 1, 'error flag set at the trapping step');
});

test('halt predicate from an export', async () => {
  // step(x) = x + 7, halt(x) = x > 50
  const { buildModule, I32 } = await import('./helpers/wasm-builder.js');
  const wasm = buildModule({ funcs: [
    { name: 'step', params: [I32], results: [I32], body: [get(0), c(7), op.add] },
    { name: 'done', params: [I32], results: [I32], body: [get(0), c(50), op.gt_s] },
  ] });
  const r = await generate(wasm, { init: 1, steps: 20, haltExport: 'done' });
  assert.equal(r.verification.trace.end.kind, 'halt');
  assert.equal(r.verification.trace.end.at, 8);
});
