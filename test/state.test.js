// A state of several values (#6): the "globals" ABI (step(): void updating exported mutable
// globals) and the "functions" ABI (one pure step function per value). For many states the real
// WebAssembly engine, the IR and the generated CSS (every browser model, via generate's
// verification) must agree, and the original one-integer ABI must give the same cards as before.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compileStep, probeStep, UnsupportedError } from '../src/compiler/program.js';
import { evalExact } from '../src/compiler/ir.js';
import { STORED_LIMIT } from '../src/compiler/css.js';
import { generate, OptionError, altInitEmbeds } from '../src/generate.js';
import { buildMachine, declarations, levelStyle, rootStyle } from '../src/runtime/machine.js';
import { verifyRun } from '../src/verify.js';
import { instantiate, stateAbi, referenceTrace } from '../src/runtime/reference.js';
import { build, check, loadConfig, CONFIG_FILE } from '../src/project.js';
import { buildModule, I32, op, c, get, uleb } from './helpers/wasm-builder.js';

const VALUES = 'test/fixtures/ui/values.jsx'; // shows every view as a number

const gget = (i) => [op.global_get, ...uleb(i)];
const gset = (i) => [op.global_set, ...uleb(i)];
const VOID = 0x40;

// step(): void over exported globals a (0) and b (1), through every kind of control flow:
//   a > 10            -> a -= 7, b += 1, leave the block (br out of an if)
//   b & 3 == 0        -> a += 3, return early (the tail below is skipped)
//   b & 3 == 1        -> helper(a) (an inlined call that writes b), a += 1, br out
//   b & 3 == 2        -> trap if a == 5, else a = 2a - b
//   b & 3 == 3        -> br_table default: straight to the tail
//   tail              -> b = b rem 100
const CONTROL = [
  op.block, VOID,
  ...gget(0), ...c(10), op.gt_s,
  op.if, VOID,
  ...gget(0), ...c(7), op.sub, ...gset(0),
  ...gget(1), ...c(1), op.add, ...gset(1),
  op.br, 1,
  op.end,
  op.block, VOID, op.block, VOID, op.block, VOID,
  ...gget(1), ...c(3), op.and,
  op.br_table, 3, 0, 1, 2, 3,
  op.end,
  ...gget(0), ...c(3), op.add, ...gset(0),
  op.return,
  op.end,
  ...gget(0), op.call, 1,
  ...gget(0), ...c(1), op.add, ...gset(0),
  op.br, 1,
  op.end,
  ...gget(0), ...c(5), op.eq, op.if, VOID, op.unreachable, op.end,
  ...gget(0), ...c(2), op.mul, ...gget(1), op.sub, ...gset(0),
  op.end,
  ...gget(1), ...c(100), op.rem_s, ...gset(1),
];
const AB = [{ type: I32, mutable: true, init: 0, export: 'a' }, { type: I32, mutable: true, init: 0, export: 'b' }];
const controlModule = (extra = []) => buildModule({
  funcs: [
    { name: 'step', params: [], results: [], body: CONTROL },
    { name: 'helper', params: [I32], results: [], body: [...gget(1), ...get(0), op.add, ...gset(1)], export: false },
    { name: 'view_sum', params: [], results: [I32], body: [...gget(0), ...gget(1), op.add] },
    { name: 'view_diff', params: [I32, I32], results: [I32], body: [...get(0), ...get(1), op.sub] },
    { name: 'stop', params: [], results: [I32], body: [...gget(0), ...c(-30), op.lt_s] },
    ...extra,
  ],
  globals: AB,
});

// Real Wasm (set the globals, call step) vs the IR, with traps, for every state in the grid.
async function checkAgainstWasm(bytes, program, states) {
  const abi = stateAbi(await instantiate(bytes), program);
  const K = program.state.length;
  const roots = [...program.state.map((s) => s.node), ...(program.trap ? [program.trap] : [])];
  let traps = 0;
  for (const x of states) {
    let want = null;
    try { want = abi.step(x); } catch (e) { if (!(e instanceof WebAssembly.RuntimeError)) throw e; }
    const got = evalExact(roots, x);
    const trapped = program.trap ? got[K] : 0;
    if (want === null) { assert.equal(trapped, 1, `trap for ${x}`); traps++; continue; }
    assert.equal(trapped, 0, `no trap for ${x}`);
    assert.deepEqual(got.slice(0, K), want, `next state of ${x}`);
  }
  return traps;
}

const grid = (as, bs) => as.flatMap((a) => bs.map((b) => [a, b]));
const SMALL = [-999999, -40, -12, -7, -5, -1, 0, 1, 2, 3, 5, 6, 9, 10, 11, 12, 17, 40, 98, 999999];

test('globals ABI: state globals are carried through blocks, branches, br_table, returns and inlined calls', async () => {
  const bytes = controlModule();
  const program = compileStep(bytes, { exportName: 'step', state: ['a', 'b'] });
  assert.equal(program.abi, 'globals');
  const traps = await checkAgainstWasm(bytes, program, grid(SMALL, SMALL));
  assert.ok(traps > 0, 'the grid reaches the trapping branch');
});

test('globals ABI: a verified card, views with and without parameters, a halt predicate and a trap', async () => {
  const bytes = controlModule();
  const opts = { export: 'step', state: ['a', 'b'], init: { a: 3, b: 1 }, steps: 40, haltExport: 'stop', ui: { entry: VALUES, views: { s: 'view_sum', d: 'view_diff' } } };
  const r = await generate(bytes, opts);
  assert.deepEqual(r.state, { abi: 'globals', values: ['a', 'b'], binding: 'step() reads and writes the exported globals a, b; views and halt read them (or take (a, b))' });
  const ref = await referenceTrace(bytes, { program: r.program, init: [3, 1], steps: 40, haltExport: 'stop' });
  assert.deepEqual(r.verification.trace.states, ref.states);
  assert.equal(r.verification.trace.values, r.verification.trace.states, 'a named state is traced as arrays');
  // views: one reads the globals (no parameters), one takes the state as parameters
  const p = compileStep(bytes, { exportName: 'step', state: ['a', 'b'], views: [{ name: 's', export: 'view_sum' }, { name: 'd', export: 'view_diff' }] });
  for (const x of grid([-7, 0, 4, 12], [-3, 0, 2, 9])) {
    assert.deepEqual(evalExact(p.views.map((v) => v.node), x), [x[0] + x[1], x[0] - x[1]]);
  }
  // a = 5, b & 3 == 2: the step traps (after nothing was written); the card stops there
  const t = await generate(bytes, { ...opts, init: { a: 5, b: 2 }, haltExport: null });
  assert.equal(t.verification.trace.end.kind, 'trap');
  assert.equal(t.verification.trace.end.at, 1);
});

test('globals ABI: only the state globals may change, and views may not change them', () => {
  const extra = (body, params = [], results = []) => buildModule({ funcs: [{ name: 'step', params, results, body }], globals: [...AB, { type: I32, mutable: true, init: 0, export: 'hidden' }, { type: I32, mutable: false, init: 4 }] });
  const err = (bytes, opts, re) => assert.throws(() => compileStep(bytes, { exportName: 'step', state: ['a', 'b'], ...opts }), (e) => e instanceof UnsupportedError && re.test(e.message), String(re));
  err(extra([...c(1), ...gset(2)]), {}, /writes global "hidden".*not part of the state.*"init"/);
  err(extra([...gget(2), ...gset(0)]), {}, /reads global "hidden".*not part of the state/);
  err(extra([]), { state: ['a', 'nope'] }, /"nope" is not an exported global.*exported globals: a, b, hidden/);
  // an immutable global is a constant, as before
  const k = compileStep(extra([...gget(3), ...gset(0)]), { exportName: 'step', state: ['a', 'b'] });
  assert.deepEqual(evalExact(k.state.map((s) => s.node), [9, 9]), [4, 9]);
  const viewWrites = buildModule({ funcs: [{ name: 'step', params: [], results: [], body: [] }, { name: 'v', params: [], results: [I32], body: [...c(1), ...gset(0), ...c(0)] }], globals: AB });
  err(viewWrites, { views: [{ name: 'v', export: 'v' }] }, /writes the state global "a".*must be pure/);
  // the same state global twice
  const twice = buildModule({ funcs: [{ name: 'step', params: [], results: [], body: [] }], globals: [{ type: I32, mutable: true, init: 0, export: 'a' }] });
  assert.throws(() => compileStep(twice, { exportName: 'step', state: ['a', 'a'] }));
});

// functions ABI: step_a(a, b) = h(a, b) + 1, step_b(a, b) = h(a, b) - a with a shared helper
// h(a, b) = (a * 3 + b * 7) rem 101, and a view on the state.
const H = 2;
const fnsModule = () => buildModule({
  funcs: [
    { name: 'step_a', params: [I32, I32], results: [I32], body: [...get(0), ...get(1), op.call, H, ...c(1), op.add] },
    { name: 'step_b', params: [I32, I32], results: [I32], body: [...get(0), ...get(1), op.call, H, ...get(0), op.sub] },
    { name: 'h', params: [I32, I32], results: [I32], body: [...get(0), ...c(3), op.mul, ...get(1), ...c(7), op.mul, op.add, ...c(101), op.rem_s], export: false },
    { name: 'view_v', params: [I32, I32], results: [I32], body: [...get(0), ...get(1), op.add] },
    { name: 'one', params: [I32], results: [I32], body: [...get(0)] },
    { name: 'swap_a', params: [I32, I32], results: [I32], body: [...get(1)] },
    { name: 'swap_b', params: [I32, I32], results: [I32], body: [...get(0)] },
    ...['same_a', 'same_b'].map((name) => ({ name, params: [I32, I32], results: [I32], body: [...get(0), ...c(37), op.mul, ...get(1), ...c(11), op.mul, op.add, ...c(5), op.add, ...c(1009), op.rem_s] })),
  ],
});

test('functions ABI: every value reads the state before the step; common work is computed once per level', async () => {
  const bytes = fnsModule();
  const program = compileStep(bytes, { exportName: { a: 'step_a', b: 'step_b' }, state: ['a', 'b'] });
  assert.equal(program.abi, 'functions');
  await checkAgainstWasm(bytes, program, grid(SMALL, SMALL));
  const r = await generate(bytes, { export: { a: 'step_a', b: 'step_b' }, state: ['a', 'b'], init: { a: 2, b: 5 }, steps: 30, ui: { entry: VALUES, views: { v: 'view_v' } } });
  assert.equal(r.state.binding, 'a = step_a(a, b); b = step_b(a, b), all from the state before the step; views and halt are called as f(a, b)');
  assert.equal(r.verification.trace.end.kind, 'steps');
  // the helper is one shared temporary of the level, not computed once per value
  assert.equal((declarations(r.machine.level.A).match(/, 101\)/g) ?? []).length, 1);
  // values that copy each other (a leaf root per value)
  const s = await generate(bytes, { export: { a: 'swap_a', b: 'swap_b' }, state: ['a', 'b'], init: { a: 7, b: -3 }, steps: 5, ui: { entry: VALUES, views: { v: 'view_v' } } });
  assert.deepEqual(s.verification.trace.states.slice(0, 3), [[7, -3], [-3, 7], [7, -3]]);
});

test('functions ABI: binding errors name the expected signatures and order', () => {
  const bytes = fnsModule();
  const err = (opts, re) => assert.throws(() => compileStep(bytes, opts), (e) => e instanceof UnsupportedError && re.test(e.message), String(re));
  err({ exportName: { a: 'step_a', c: 'step_b' }, state: ['a', 'b'] }, /one step function per state value \(a, b\); got a, c/);
  err({ exportName: { a: 'step_a', b: 'one' }, state: ['a', 'b'] }, /"one" \(step function of "b"\) must have signature \(i32, i32\) -> i32, found \(i32\) -> \(i32\)/);
  err({ exportName: 'step_a', state: ['a', 'b'] }, /needs either a step\(\): void .* or one step function per value/);
  err({ exportName: { a: 'step_a', b: 'step_b' }, state: ['a', 'b'], views: [{ name: 'v', export: 'one' }] }, /must have signature \(i32, i32\) -> i32/);
  assert.throws(() => compileStep(bytes, { exportName: { a: 'one' }, state: Array.from({ length: 9 }, (_, i) => `v${i}`) }), /1 to 8 values/);
});

test('a one-value named state gives the same card as the original ABI', async () => {
  const lfsr = fs.readFileSync('examples/lfsr-rust/lfsr.wasm');
  const base = { steps: 60, bits: 16, title: 'lfsr', wasmName: 'lfsr.wasm' };
  const a = await generate(lfsr, { ...base, export: 'step', init: 1, altInits: [44257] });
  const b = await generate(lfsr, { ...base, export: { s: 'step' }, state: ['s'], init: { s: 1 }, altInits: [{ s: 44257 }] });
  const c1 = await generate(lfsr, { ...base, export: 'step', state: ['s'], init: { s: 1 }, altInits: [{ s: 44257 }] });
  // the same card; only the description names the value
  assert.equal(b.svg.replace('(s=1 as generated)', '(1 as generated)'), a.svg);
  assert.equal(c1.svg.replace('(s=1 as generated)', '(1 as generated)'), a.svg);
});

test('altInits of a named state: one verified run and one URL fragment per state', async () => {
  const bytes = fnsModule();
  const opts = { export: { a: 'step_a', b: 'step_b' }, state: ['a', 'b'], init: { a: 2, b: 5 }, steps: 20, altInits: [{ b: -4, a: 9 }, { a: 0, b: 0 }], ui: { entry: VALUES, views: { v: 'view_v' } } };
  const r = await generate(bytes, opts);
  assert.deepEqual(r.verification.alt.map((x) => x.init), [[9, -4], [0, 0]]);
  assert.match(r.svg, /<g id="x9_-4"\/><g id="x0_0"\/>/);
  assert.match(r.svg, /#x9_-4:target~\.R\{--rxb:9!important;--ry1b:-4!important\}/);
  assert.match(r.svg, /<g class="R" style="--rxb:2;--ry1b:5">/);
  assert.deepEqual(altInitEmbeds(opts), [{ id: 'x9_-4', label: 'a=9, b=-4' }, { id: 'x0_0', label: 'a=0, b=0' }]);
  const bad = async (o, re) => assert.rejects(generate(bytes, { ...opts, ...o }), (e) => e instanceof OptionError && re.test(e.message), JSON.stringify(o));
  for (const altInits of [[{ a: 1 }], [{ a: 1, b: 2, c: 3 }], [5], [{ a: 2, b: 5 }], [{ a: 1, b: 1 }, { b: 1, a: 1 }], [{ a: STORED_LIMIT + 1, b: 0 }]]) await bad({ altInits }, /"altInits"/);
  await bad({ state: ['a', '2b'], init: { a: 1, '2b': 2 } }, /must be an identifier/);
  await bad({ state: ['a', 'a'] }, /lists a name twice/);
  await bad({ init: { a: 1.5, b: 2 } }, /"init.a" must be an integer/);
  await bad({ init: { a: 1, c: 2 } }, /"init" must be an object with exactly the names of "state" \(a, b\)/);
  await bad({ export: { a: 'step_a', c: 'step_b' } }, /"export" must map each name of "state"/);
  await bad({ state: undefined }, /needs "state": the names of its 1 to 8 values in order/);
  await bad({ state: Array.from({ length: 9 }, (_, i) => `v${i}`) }, /1 to 8 values/);
  await bad({ haltValue: 3 }, /"halt" \(a value\) needs a state of one integer/);
  await bad({ ui: null }, /a state of several values \(a, b\) is shown by a UI card: add "ui"/);
  await bad({ state: undefined, init: 2 }, /"export" names one step function per state value \(a, b\): give their order in "state"/);
  await bad({ init: [2, 5] }, /"init" must be an object with exactly the names of "state"/);
  await bad({ state: undefined, export: 'step_a', init: [2, 5] }, /"init" \(the initial state\) must be an integer, or an object/);
});

test('readme-runtime.json: a named state builds, checks, and returns its embed lines', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-state-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
  fs.writeFileSync(path.join(dir, 'step.wasm'), controlModule());
  fs.copyFileSync(path.resolve(VALUES), path.join(dir, 'values.jsx'));
  const card = { name: 'ab', wasm: 'step.wasm', export: 'step', state: ['a', 'b'], init: { a: 3, b: 1 }, altInits: [{ a: -2, b: 7 }], steps: 30, ui: { entry: 'values.jsx', views: { s: 'view_sum' } } };
  fs.writeFileSync(path.join(dir, CONFIG_FILE), JSON.stringify({ cards: [card] }));
  assert.deepEqual(loadConfig(path.join(dir, CONFIG_FILE)).cards[0].options.init, { a: 3, b: 1 });
  const [r] = await build(path.join(dir, CONFIG_FILE), { log: () => {} });
  assert.equal(r.state.abi, 'globals');
  assert.deepEqual(r.embed, ['![ab](readme-runtime/ab.svg)', '![ab from a=-2, b=7](readme-runtime/ab.svg?x-2_7#x-2_7)']);
  assert.deepEqual(await check(path.join(dir, CONFIG_FILE), { log: () => {} }), []);
  // tools that sort the keys of JSON objects (jq -S, sort_keys) do not change the card: the
  // order of the state is the array "state"
  const sorted = { altInits: [{ b: 7, a: -2 }], build: undefined, export: 'step', init: { b: 1, a: 3 }, name: 'ab', state: ['a', 'b'], steps: 30, ui: { entry: 'values.jsx', views: { s: 'view_sum' } }, wasm: 'step.wasm' };
  fs.writeFileSync(path.join(dir, CONFIG_FILE), JSON.stringify({ cards: [sorted] }));
  assert.deepEqual(await check(path.join(dir, CONFIG_FILE), { log: () => {} }), []);
  fs.writeFileSync(path.join(dir, CONFIG_FILE), JSON.stringify({ cards: [{ ...card, init: [3, 1] }] }));
  assert.throws(() => loadConfig(path.join(dir, CONFIG_FILE)), /"init" \(the initial state: an integer, or an object/);
});

test('the CSS of a state of two values: style attributes, and equal next values computed once', async () => {
  const bytes = fnsModule();
  const r = await generate(bytes, { export: { a: 'same_a', b: 'same_b' }, state: ['a', 'b'], init: { a: 2, b: 5 }, steps: 6, ui: { entry: VALUES, views: { a: 'swap_b' } } }); // swap_b(a, b) = a
  assert.equal(rootStyle(r.machine), '--rxb:2;--ry1b:5');
  // views that read only the first value: the display selects nothing else
  assert.deepEqual(r.machine.shown, [0]);
  assert.equal(levelStyle(3, r.machine), '--rS3:var(--rx)');
  assert.ok(!r.svg.includes('rcy1') && !r.svg.includes('rS3y1'));
  // views that read the second value: it is exported by every level and selected
  const p = compileStep(bytes, { exportName: { a: 'same_a', b: 'same_b' }, state: ['a', 'b'], views: [{ name: 'v', export: 'view_v' }] });
  const m = buildMachine(p, { init: [2, 5], steps: 6 });
  assert.deepEqual(m.shown, [0, 1]);
  assert.equal(levelStyle(3, m), '--rS3:var(--rx);--rS3y1:var(--ry1a)');
  assert.equal(levelStyle(4, m), '--rS4:var(--rx);--rS4y1:var(--ry1b)');
  assert.equal(levelStyle(4), '--rS4:var(--rx)', 'one integer: unchanged');
  await verifyRun(bytes, p, m);
  for (let k = 1; k <= 6; k++) assert.ok(r.svg.includes(`style="${levelStyle(k, r.machine)}"`), `level ${k}`);
  const second = r.machine.level.A.find((d) => d.name === 'ry1a');
  assert.deepEqual(second.ast, { k: 'v', name: 'rxa' });
  assert.equal((declarations(r.machine.level.A).match(/1009\)/g) ?? []).length, 1);
});

test('inspect and analyze recognise the step functions of every ABI', () => {
  assert.deepEqual(probeStep(controlModule(), 'step'), { supported: true, abi: 'globals', state: ['a', 'b'] });
  const f = probeStep(fnsModule(), 'step_a');
  assert.equal(f.supported, true);
  assert.equal(f.abi, 'functions');
  assert.equal(f.values, 2);
  assert.deepEqual(probeStep(fnsModule(), 'one'), { supported: true, abi: 'single' });
  const v = probeStep(controlModule(), 'view_sum');
  assert.equal(v.supported, false);
  assert.match(v.error.message, /must have signature \(i32\) -> i32/);
});

test('examples/mockcraft: the state of 5 values shows the same views as the packed logic.ts, and its card is up to date', async () => {
  const cfg = loadConfig('examples/mockcraft/readme-runtime.json');
  assert.deepEqual(await check('examples/mockcraft/readme-runtime.json', { log: () => {} }), []);
  // the same views at every step as the card of the packed integer (readme-runtime.json)
  const packed = loadConfig(CONFIG_FILE).cards.find((x) => x.name === 'mockcraft');
  const steps = 60;
  const views = async (card, dir) => (await generate(fs.readFileSync(path.join(dir, card.wasm)), { ...card.options, steps, altInits: [] })).verification.viewSamples;
  assert.deepEqual(await views(cfg.cards[0], cfg.dir), await views(packed, '.'));
});
