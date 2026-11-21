// Regressions for the P0 critic review: cases where a card used to be reported as verified
// while a real browser showed a wrong number, or where the SVG itself was broken.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { generate } from '../src/generate.js';
import { VerifyError } from '../src/verify.js';
import { textDepth, MAX_DECL_DEPTH, MODELS } from '../src/compiler/css.js';
import { simulateMachine } from '../src/runtime/machine.js';
import { checkWellFormed } from '../src/render/xml.js';
import { unary, op, c, get } from './helpers/wasm-builder.js';

const root = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');

test('B1: products beyond float32 exactness are refused, not verified', async () => {
  // step(x) = (x * 65536) % 32749 + 1: Firefox computes rem() of a dividend >= 2^24 differently
  const wasm = unary([get(0), c(65536), op.mul, c(32749), op.rem_s, c(1), op.add]);
  await assert.rejects(generate(wasm, { export: 'f', init: 300 }), (e) => e instanceof VerifyError && /2\^24|exactly/.test(e.message));
});

test('B1: the Firefox model reproduces rem()/mod() on large float32 dividends', async () => {
  const { evalAst, N } = await import('../src/compiler/css.js');
  const rem = { k: 'f', fn: 'rem', args: [N(19660800), N(32749)] };
  // Firefox computes a - b*trunc(a/b) with float32 rounding: 19660800 - 32749*600 = 11400 exactly,
  // but the float32 quotient 600.3329... is fine here; a dividend that is not representable
  // diverges. The model must at least agree with exact arithmetic when inputs are exact.
  assert.equal(evalAst(rem, () => 0, MODELS.firefox), 19660800 % 32749);
  const big = { k: 'f', fn: 'mod', args: [{ k: '*', a: N(16777217), b: N(3) }, N(1000)] };
  assert.notEqual(evalAst(big, () => 0, MODELS.firefox), (16777217 * 3) % 1000, 'float32 model must not be exact here');
});

test('B2: deep if-chains are split so no declaration nests too deeply', async () => {
  const wasm = fs.readFileSync(path.join(root, 'test/fixtures/chain90.wasm'));
  const r = await generate(wasm, { init: 1 });
  let deepest = 0;
  for (const line of r.svg.split('\n')) {
    const m = line.match(/^ --[\w-]+: (.*);$/);
    if (m) deepest = Math.max(deepest, textDepth(m[1]));
  }
  assert.ok(deepest <= MAX_DECL_DEPTH, `deepest declaration ${deepest}`);
  assert.ok(r.svg.length < 200000, `svg is ${r.svg.length} bytes`);
});

test('M1: an edited init either reproduces Wasm or raises the range flag (wrap-around)', async () => {
  // (x << 12) >> 12 relies on i32 wrap-around for |x| >= 2^19
  const wasm = unary([get(0), c(12), op.shl, c(12), op.shr_s, c(5), op.add]);
  const r = await generate(wasm, { export: 'f', init: 1, steps: 20 });
  const { instance } = await WebAssembly.instantiate(wasm);
  for (const init of [600000, 2000, -999999, 3]) {
    for (const [name, model] of Object.entries(MODELS)) {
      const { levels } = simulateMachine(r.machine, { model, init });
      let x = init;
      for (let k = 1; k <= 20; k++) {
        const par = k % 2 ? 'a' : 'b';
        if (levels[k].get(`re${par}`) === 1) break; // flagged: the card stops with OUT OF RANGE
        x = instance.exports.f(x);
        assert.equal(levels[k].get(`rx${par}`), x, `${name}: init ${init} step ${k} is wrong and not flagged`);
      }
    }
  }
});

test('M2: unsigned remainder of a negative state matches Wasm', async () => {
  const wasm = fs.readFileSync(path.join(root, 'test/fixtures/urem.wasm'));
  const r = await generate(wasm, { init: -5, steps: 30 });
  assert.equal(r.verification.trace.values[1], 148);
});

test('M4: names containing "--" or "-->" still give a well-formed SVG', async () => {
  const wasm = fs.readFileSync(path.join(root, 'examples/collatz/collatz.wasm'));
  const r = await generate(wasm, { init: 7, haltValue: 1, title: 'a -- b --> <c>', wasmName: 'my--card-->.wasm' });
  assert.ok(checkWellFormed(r.svg));
});

test('the XML check rejects what browsers would render as a broken image', () => {
  assert.throws(() => checkWellFormed('<svg><!-- a -- b --></svg>'), /--/);
  assert.throws(() => checkWellFormed('<svg><g></svg>'), /mismatched|unclosed/);
  assert.throws(() => checkWellFormed('<svg><text>a < b</text></svg>'), /malformed start tag|raw "<"/);
  assert.throws(() => checkWellFormed('<svg a="1" a="2"/>'), /duplicate/);
  assert.ok(checkWellFormed('<svg><style><![CDATA[a<b]]></style><text>&amp; &#x41;</text></svg>'));
});

test('init outside the exact range is rejected up front, not wrapped', async () => {
  const wasm = fs.readFileSync(path.join(root, 'examples/collatz/collatz.wasm'));
  await assert.rejects(generate(wasm, { init: 4294967297 }), /outside the range/);
});
