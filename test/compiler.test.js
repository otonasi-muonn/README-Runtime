// Wasm -> IR -> CSS: for many instruction patterns and inputs, the real WebAssembly engine,
// the IR's exact semantics and the generated CSS (under every browser arithmetic model)
// must agree.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileStep, UnsupportedError } from '../src/compiler/program.js';
import { evalExact } from '../src/compiler/ir.js';
import { translate, MODELS, V, evalAst, storeInteger, toCss, STORED_LIMIT } from '../src/compiler/css.js';
import { unary, op, c, get, set, tee, I32, I64 } from './helpers/wasm-builder.js';

const SMALL = [0, 1, 2, 3, 7, 8, 15, 16, 27, 100, 255, 256, 1000, 4095, 65535, 99999, 999999, -1, -2, -7, -8, -100, -999, -65536, -999999];

async function realRun(bytes, x) {
  const { instance } = await WebAssembly.instantiate(bytes);
  try { return { value: instance.exports.f(x) | 0, trap: false }; } catch (e) {
    if (e instanceof WebAssembly.RuntimeError) return { value: null, trap: true };
    throw e;
  }
}

// Evaluate the translated step (with its range guards) under a browser arithmetic model.
// `flagged` is what the card would show as OUT OF RANGE: a guard fired or the new state
// cannot be stored exactly.
function cssEval(program, x, model) {
  const roots = [{ node: program.step, name: 'out' }];
  if (program.trap) roots.push({ node: program.trap, name: 'trap' });
  const { defs, guards } = translate(roots, () => V('in'), { tempPrefix: 't', inputRange: { lo: -STORED_LIMIT, hi: STORED_LIMIT }, checkedRoots: new Set(['out', 'trap']) });
  const env = new Map([['in', model.store(x)]]);
  const get = (n) => env.get(n);
  for (const d of defs) env.set(d.name, storeInteger(evalAst(d.ast, get, model), model));
  const out = env.get('out');
  const flagged = guards.some((g) => evalAst(g, get, model) !== 0) || Math.abs(out) > STORED_LIMIT;
  return { out, flagged, trap: program.trap ? env.get('trap') : 0 };
}

// The property every card relies on: for each input, under every browser model, the CSS
// either equals the real WebAssembly result or raises its range flag. Never a silent wrong
// value. `mustBeExact` lists inputs that may not be flagged.
async function check(name, body, inputs = SMALL, opts = {}) {
  const bytes = unary(body, opts);
  const program = compileStep(bytes, { exportName: 'f' });
  let exact = 0;
  for (const x of inputs) {
    const real = await realRun(bytes, x);
    const [ir] = evalExact([program.step], [x]);
    const irTrap = program.trap ? evalExact([program.trap], [x])[0] : 0;
    assert.equal(irTrap, real.trap ? 1 : 0, `${name}: IR trap flag for x=${x}`);
    if (real.trap) continue;
    assert.equal(ir, real.value, `${name}: IR for x=${x}`);
    const flags = [];
    for (const [m, model] of Object.entries(MODELS)) {
      const css = cssEval(program, x, model);
      assert.equal(css.trap, 0, `${name}: CSS trap flag for x=${x} (${m})`);
      if (!css.flagged) assert.equal(css.out, real.value, `${name}: CSS (${m}) for x=${x} is wrong and not flagged`);
      flags.push(css.flagged);
    }
    assert.ok(flags.every((f) => f === flags[0]), `${name}: models disagree on the range flag for x=${x}`);
    if (Math.abs(real.value) > STORED_LIMIT) assert.ok(flags[0], `${name}: result ${real.value} for x=${x} must be flagged`);
    if (!flags[0]) exact++;
    if ((opts.mustBeExact ?? []).includes(x)) assert.ok(!flags[0], `${name}: x=${x} should compute exactly`);
  }
  assert.ok(exact > 0, `${name}: every input was flagged`);
  return program;
}

test('arithmetic', async () => {
  await check('x*3+1', [get(0), c(3), op.mul, c(1), op.add]);
  await check('x-1000', [get(0), c(1000), op.sub]);
  await check('1000-x', [c(1000), get(0), op.sub]);
  await check('x*x', [get(0), get(0), op.mul], [0, 1, 2, -3, 99, -999, 999]);
  await check('div_s 7', [get(0), c(7), op.div_s]);
  await check('div_s -3', [get(0), c(-3), op.div_s]);
  await check('rem_s 7', [get(0), c(7), op.rem_s]);
  await check('div_u 10', [get(0), c(10), op.div_u]);
  await check('rem_u 10', [get(0), c(10), op.rem_u]);
  await check('rem_u 1000 (C unsigned %)', [get(0), c(31), op.mul, c(7), op.add, c(1000), op.rem_u]);
  await check('div_u -3 (divisor >= 2^31)', [get(0), c(-3), op.div_u]);
  await check('rem_u -3 (divisor >= 2^31)', [get(0), c(-3), op.rem_u], SMALL.filter((x) => x >= -3));
});

test('division by a variable traps exactly when wasm traps', async () => {
  const p = await check('100/x', [c(100), get(0), op.div_s], [0, 1, -1, 3, -7, 100, 1000]);
  assert.ok(p.trap, 'trap condition expected');
  await check('100%x', [c(100), get(0), op.rem_s], [0, 1, -1, 3, -7, 100]);
});

test('bitwise with constants and variables', async () => {
  await check('x&1', [get(0), c(1), op.and]);
  await check('x&255', [get(0), c(255), op.and]);
  await check('x&-16', [get(0), c(-16), op.and]);
  await check('x&0x5a5a', [get(0), c(0x5a5a), op.and]);
  await check('x|0x101', [get(0), c(0x101), op.or]);
  await check('x^0xff', [get(0), c(0xff), op.xor]);
  await check('~x', [get(0), c(-1), op.xor]);
  await check('x&(x>>1)', [get(0), get(0), c(1), op.shr_s, op.and]);
  await check('x^(x>>2)', [get(0), get(0), c(2), op.shr_s, op.xor]);
  await check('x|(x<<1)', [get(0), get(0), c(1), op.shl, op.or], SMALL.filter((x) => Math.abs(x) < 400000));
});

test('shifts', async () => {
  await check('x<<3', [get(0), c(3), op.shl], SMALL.filter((x) => Math.abs(x) < 100000));
  await check('x>>3 (s)', [get(0), c(3), op.shr_s]);
  await check('x>>>3 (u)', [get(0), c(3), op.shr_u], SMALL.filter((x) => x >= 0));
  await check('x>>>12 (u, negative)', [get(0), c(12), op.shr_u], [-1, -2, -4096, -999999, 5, 4096]);
  await check('x<<(x&3)', [get(0), get(0), c(3), op.and, op.shl], SMALL.filter((x) => Math.abs(x) < 100000));
  await check('x>>(x&7)', [get(0), get(0), c(7), op.and, op.shr_s]);
  await check('rotl 0 / rotr 32', [get(0), c(32), op.rotr]);
});

test('comparisons and select', async () => {
  for (const [name, o] of Object.entries({ eq: op.eq, ne: op.ne, lt_s: op.lt_s, gt_s: op.gt_s, le_s: op.le_s, ge_s: op.ge_s, lt_u: op.lt_u, gt_u: op.gt_u, le_u: op.le_u, ge_u: op.ge_u })) {
    await check(`x ${name} 7`, [get(0), c(7), o]);
    await check(`x ${name} -7`, [get(0), c(-7), o]);
    await check(`-7 ${name} x`, [c(-7), get(0), o]);
  }
  await check('eqz', [get(0), op.eqz]);
  await check('select(x&1 ? 3x+1 : x>>1)', [get(0), c(3), op.mul, c(1), op.add, get(0), c(1), op.shr_s, get(0), c(1), op.and, op.select]);
  await check('select(x : -x, x<0)', [c(0), get(0), op.sub, get(0), get(0), c(0), op.lt_s, op.select]);
});

test('unary bit counting and sign extension', async () => {
  await check('clz', [get(0), op.clz]);
  await check('ctz', [get(0), op.ctz]);
  await check('popcnt', [get(0), op.popcnt]);
  await check('extend8_s', [get(0), op.extend8_s]);
  await check('extend16_s', [get(0), op.extend16_s]);
});

test('structured control flow', async () => {
  // if (x < 10) x = x + 100 else x = x - 1; return x
  await check('if/else on local', [
    get(0), c(10), op.lt_s, op.if, 0x40, get(0), c(100), op.add, set(0), op.else, get(0), c(1), op.sub, set(0), op.end, get(0),
  ]);
  // if (result i32)
  await check('if with result', [get(0), c(1), op.and, op.if, I32, get(0), c(3), op.mul, op.else, get(0), c(2), op.div_s, op.end]);
  // block + br_if early exit: if (x == 0) return 42; else return x*2
  await check('block/br_if', [
    op.block, I32, c(42), get(0), op.eqz, op.br_if, 0, op.drop, get(0), c(2), op.mul, op.end,
  ]);
  // early return
  await check('return', [get(0), c(5), op.gt_s, op.if, 0x40, c(1), op.return, op.end, c(0)]);
  // br_table on x&3
  await check('br_table', [
    op.block, 0x40, op.block, 0x40, op.block, 0x40,
    get(0), c(3), op.and, op.br_table, 2, 0, 1, 2,
    op.end, c(10), op.return,
    op.end, c(20), op.return,
    op.end, c(30),
  ]);
  // nested blocks with locals
  await check('nested', [
    op.block, 0x40, op.block, 0x40,
    get(0), c(0), op.lt_s, op.br_if, 1,
    get(0), c(1000), op.gt_s, op.br_if, 0,
    get(0), c(1), op.add, set(1), op.br, 1,
    op.end, c(-1), set(1),
    op.end, get(1),
  ], SMALL, { locals: [I32] });
  // tee
  await check('local.tee', [get(0), c(5), op.add, tee(1), get(1), op.mul], [0, 1, -5, 30, -300], { locals: [I32] });
});

test('calls are inlined; traps from unreachable are tracked', async () => {
  const helper = { name: 'sq', params: [I32], results: [I32], body: [get(0), get(0), op.mul], export: false };
  await check('call', [get(0), op.call, 1, c(1), op.add], [0, 2, -3, 100, -999], { extraFuncs: [helper] });
  await check('unreachable when x<0', [get(0), c(0), op.lt_s, op.if, 0x40, op.unreachable, op.end, get(0)], [0, 1, -1, 5, -5]);
});

test('immutable globals are constants', async () => {
  await check('global', [get(0), op.global_get, 0, op.add], SMALL, { globals: [{ type: I32, mutable: false, init: 1234 }] });
});

test('unsupported features fail with precise errors', () => {
  const cases = [
    [[op.loop, 0x40, op.end, get(0)], /loop/],
    [[c(0), op.i32_load, 2, 0], /linear memory/, { memory: true }],
    [[op.global_get, 0], /mutable global/, { globals: [{ type: I32, mutable: true, init: 0 }] }],
    [[get(0), op.call, 0], /imported function env\.ext/, { imports: [{ module: 'env', name: 'ext', params: [I32], results: [I32] }] }],
    [[get(0), op.call, 0], /recursion/],
    [[op.i64_const, 1, op.drop, get(0)], /i64|only i32/],
    [[get(0), get(0), op.rotl], /variable rotation/],
  ];
  for (const [body, re, opts = {}] of cases) {
    let bytes;
    if (opts.imports) {
      bytes = unary([get(0), op.call, 0], { imports: opts.imports });
    } else bytes = unary(body, opts);
    assert.throws(() => compileStep(bytes, { exportName: 'f' }), (e) => e instanceof UnsupportedError && re.test(e.message), `expected ${re}`);
  }
});

test('export selection and signature errors', () => {
  const bytes = unary([get(0)]);
  assert.throws(() => compileStep(bytes, { exportName: 'nope' }), /export "nope".*not found.*f\(i32\) -> i32/);
  const bad = unary([get(0)], { extraFuncs: [{ name: 'two', params: [I32, I32], results: [I32], body: [get(0)] }] });
  assert.throws(() => compileStep(bad, { exportName: 'two' }), /must have signature \(i32\) -> i32/);
  assert.throws(() => compileStep(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), { exportName: 'f' }), /not a WebAssembly binary/);
});

test('serialized CSS is plain calc() text', () => {
  const p = compileStep(unary([get(0), c(3), op.mul, c(1), op.add]), { exportName: 'f' });
  const { defs } = translate([{ node: p.step, name: 'out' }], () => V('in'));
  assert.equal(toCss(defs[0].ast), 'calc(var(--in) * 3 + 1)');
});

// Final critic review, FB1: the bit templates are exact below 2^23 only; operands between 2^23
// and 2^24 must be flagged, never computed wrongly.
test('bit-level operations on operands in [2^23, 2^24) are exact or flagged', async () => {
  const W = [0, 1, -1, 300000, 531676, 600000, 935545, -705894, 999999, -999999];
  await check('popcnt(x*16)+x', [get(0), c(16), op.mul, op.popcnt, get(0), op.add], W);
  await check('clz(x*16)+x', [get(0), c(16), op.mul, op.clz, get(0), op.add], W);
  await check('((x*9)&0xF00000)>>16 + x', [get(0), c(9), op.mul, c(0xF00000), op.and, c(16), op.shr_s, get(0), op.add], W);
  await check('((x*12)|x)>>4', [get(0), c(12), op.mul, get(0), op.or, c(4), op.shr_s], W);
  await check('popcnt((x*9)<<20)', [get(0), c(9), op.mul, c(20), op.shl, op.popcnt], W);
  await check('((x*16)&~2)>>16 + 7', [get(0), c(16), op.mul, c(-3), op.and, c(16), op.shr_s, c(7), op.add], W);
  await check('(x<<15)&0x8000 (rewritten to (x&1)<<15)', [get(0), c(15), op.shl, c(0x8000), op.and], W);
});

// Final critic review, FB2: WebKit evaluates a/b as a*(1/b); exact multiples must still divide exactly.
test('division by awkward divisors is exact in every model, WebKit included', async () => {
  for (const d of [49, 98, 237, 729, 32749, 65521]) {
    const xs = [d, 2 * d, 3 * d, 13 * d, d - 1, d + 1, -d, -7 * d, Math.floor(999999 / d) * d, 0, 1];
    await check(`x/${d}`, [get(0), c(d), op.div_s], xs);
    await check(`x%${d}`, [get(0), c(d), op.rem_s], xs);
    await check(`x/u${d}`, [get(0), c(d), op.div_u], xs);
    await check(`x%u${d}`, [get(0), c(d), op.rem_u], xs);
  }
});
