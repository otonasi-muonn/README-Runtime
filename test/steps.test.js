// Issue #5: multi-step intra-element unrolling (stride > 1, up to MAX_STEPS = 2000 within
// <= MAX_LEVELS = 320 nested <g> blocks), 2D power-of-two factored state selection, 4-digit
// step counters, and trajectory / playback mode classification (finite, finite-replay, halt,
// periodic).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { compileStep } from '../src/compiler/program.js';
import { MODELS, STORED_LIMIT, toCss, textDepth, MAX_DECL_DEPTH } from '../src/compiler/css.js';
import {
  MAX_STEPS, MAX_LEVELS, buildMachine, simulateMachine,
  stateAt, flagAt, rangeFlagAt, defaultStride,
} from '../src/runtime/machine.js';
import { referenceTrace } from '../src/runtime/reference.js';
import { verifyRun, VerifyError } from '../src/verify.js';
import { generate, OptionError } from '../src/generate.js';
import { checkWellFormed } from '../src/render/xml.js';
import { buildModule, unary, I32, op, c, get, uleb } from './helpers/wasm-builder.js';

const root = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const lfsrWasm = fs.readFileSync(path.join(root, 'examples/lfsr-rust/lfsr.wasm'));
const collatzWasm = fs.readFileSync(path.join(root, 'examples/collatz/collatz.wasm'));
const div49Wasm = fs.readFileSync(path.join(root, 'test/fixtures/div49.wasm'));
const VALUES = 'test/fixtures/ui/values.jsx';

test('steps <= 400 keep stride = 1 and flat selection; steps > 400 cap DOM nesting at MAX_LEVELS', async () => {
  assert.equal(MAX_STEPS, 2000);
  assert.equal(MAX_LEVELS, 320);
  assert.equal(defaultStride(1), 1);
  assert.equal(defaultStride(400), 1);
  assert.equal(defaultStride(401), 2);
  assert.equal(defaultStride(1600), 5);
  assert.equal(defaultStride(2000), 7);

  const r1600 = await generate(lfsrWasm, { export: 'step', init: 1, steps: 1600, bits: 16 });
  assert.equal(r1600.machine.stride, 5);
  assert.equal(r1600.machine.blocks, 320);
  assert.equal(r1600.machine.selectionMode, 'factored');
  assert.equal(r1600.perf.report.levels, 320);
  assert.equal(r1600.perf.report.stepsPerLevel, 5);
  assert.ok(r1600.machine.blocks <= MAX_LEVELS);
  assert.ok(checkWellFormed(r1600.svg));

  const r2000 = await generate(lfsrWasm, { export: 'step', init: 1, steps: 2000, bits: 16 });
  assert.equal(r2000.machine.stride, 7);
  assert.equal(r2000.machine.blocks, 286); // 285 full blocks of 7 + 1 tail block (.T) of 5 = 2000
  assert.equal(r2000.machine.tailSteps, 5);
  assert.ok(r2000.svg.includes('\n.T{\n'), 'tail block rule .T emitted for non-divisible step counts');
  // 4-digit step counter rendered for steps >= 1000
  assert.ok(r2000.svg.includes('.s3 use{') && r2000.svg.includes('>2000</text>'));

  await assert.rejects(
    generate(lfsrWasm, { export: 'step', init: 1, steps: MAX_STEPS + 1 }),
    (e) => e instanceof OptionError && /between 1 and 2000/.test(e.message),
  );
});

test('multi-step blocks with tail (.T) reproduce real Wasm at every step under all browser models', async () => {
  // Non-divisible steps = 29, stride = 6 -> 4 full blocks (24 steps) + 1 tail block of 5 steps
  const prog = compileStep(lfsrWasm, { exportName: 'step' });
  const m = buildMachine(prog, { init: 1, steps: 29, hold: 4, stride: 6 });
  assert.equal(m.blocks, 5);
  assert.equal(m.tailSteps, 5);
  await verifyRun(lfsrWasm, prog, m);

  // Also check edited initial values not seen at build time, at every clock step 0..T
  for (const init of [1, 7, 44257, 65535]) {
    const tr = await referenceTrace(lfsrWasm, { exportName: 'step', init, steps: 29, rangeLimit: STORED_LIMIT });
    for (const [name, model] of Object.entries(MODELS)) {
      for (let t = 0; t <= m.T; t++) {
        const sim = simulateMachine(m, { model, init, t });
        const shown = Math.min(t, 29);
        const inner = sim.levels[29];
        assert.equal(inner.get('rsx'), shown, `${name} init=${init} t=${t} step`);
        assert.equal(inner.get('rcs'), tr.values[shown], `${name} init=${init} t=${t} value`);
        assert.equal(inner.get('rfs'), 0, `${name} init=${init} t=${t} flags`);
      }
    }
  }
});

test('mid-block halt, trap, and OUT OF RANGE stop at the exact step and never leak across sub-steps', async () => {
  // 1. Mid-block value halt: Collatz from 27 halts at step 111; with stride=8, step 111 is sub-step 6 of block 14 (steps 105..112)
  const colProg = compileStep(collatzWasm, { exportName: 'step' });
  const mCol = buildMachine(colProg, { init: 27, steps: 130, hold: 5, haltValue: 1, stride: 8 });
  const vCol = await verifyRun(collatzWasm, colProg, mCol);
  assert.equal(vCol.endAt, 111);
  for (const [name, model] of Object.entries(MODELS)) {
    const before = simulateMachine(mCol, { model, t: 110 }).levels[130];
    assert.deepEqual([before.get('rsx'), before.get('rcs'), before.get('rfs')], [110, 2, 0], name);
    const atHalt = simulateMachine(mCol, { model, t: 111 }).levels[130];
    assert.deepEqual([atHalt.get('rsx'), atHalt.get('rcs'), atHalt.get('rfs')], [111, 1, 1], name);
    const afterHalt = simulateMachine(mCol, { model, t: 130 }).levels[130];
    assert.deepEqual([afterHalt.get('rsx'), afterHalt.get('rcs'), afterHalt.get('rfs')], [111, 1, 1], name);
  }

  // 2. Mid-block OUT OF RANGE on an edited init: Collatz from 77671 leaves [-999999, 999999] at step 14 (sub-step 5 of block 2)
  const trRange = await referenceTrace(collatzWasm, { exportName: 'step', init: 77671, steps: 130, haltValue: 1, rangeLimit: STORED_LIMIT });
  assert.deepEqual(trRange.end, { kind: 'range', at: 14 });
  for (const [name, model] of Object.entries(MODELS)) {
    const ok13 = simulateMachine(mCol, { model, init: 77671, t: 13 }).levels[130];
    assert.deepEqual([ok13.get('rsx'), ok13.get('rcs'), ok13.get('rfs')], [13, trRange.values[13], 0], name);
    const stop14 = simulateMachine(mCol, { model, init: 77671, t: 50 }).levels[130];
    assert.deepEqual([stop14.get('rsx'), stop14.get('rfs')], [14, 2], `${name}: stops at step 14 with range flag`);
    const full = simulateMachine(mCol, { model, init: 77671 });
    assert.equal(rangeFlagAt(mCol, full.levels, 13), 0, name);
    assert.equal(rangeFlagAt(mCol, full.levels, 14), 1, name);
    assert.equal(flagAt(mCol, full.levels, 14, 'e'), 1, name);
  }

  // 3. Mid-block trap: f(x) = 100 / (x - 3) from 6 traps at step 3 (6 -> 33 -> 3 -> trap; sub-step 2 of block 1 when stride=5)
  const trapWasm = unary([c(100), get(0), c(3), op.sub, op.div_s]);
  const trapProg = compileStep(trapWasm, { exportName: 'f' });
  const mTrap = buildMachine(trapProg, { init: 6, steps: 17, hold: 3, stride: 5 });
  const vTrap = await verifyRun(trapWasm, trapProg, mTrap);
  assert.equal(vTrap.trace.end.kind, 'trap');
  assert.equal(vTrap.endAt, 3);
  for (const [name, model] of Object.entries(MODELS)) {
    const pre = simulateMachine(mTrap, { model, t: 2 }).levels[17];
    assert.deepEqual([pre.get('rsx'), pre.get('rcs'), pre.get('rfs')], [2, 3, 0], name);
    const post = simulateMachine(mTrap, { model, t: 10 }).levels[17];
    assert.equal(post.get('rsx'), 3, name);
    assert.equal(post.get('rfs') & 4, 4, `${name}: trap bit set`);
  }
});

test('2D factored selection is exact across block boundaries (32 and 64) under WebKit, Firefox and Chromium models', async () => {
  // Check both B=32 (steps=600) and B=64 (steps=1600), including awkward division program under WebKit model
  for (const steps of [600, 1600]) {
    const r = await generate(lfsrWasm, { export: 'step', init: 1, steps, bits: 16 });
    assert.equal(r.machine.selectionMode, 'factored');
    for (const d of r.machine.select) assert.ok(textDepth(toCss(d.ast)) <= MAX_DECL_DEPTH);
    const tr = r.verification.trace;
    for (const boundary of [0, 1, 31, 32, 33, 63, 64, 65, 511, 512, 513, steps - 1, steps]) {
      if (boundary > steps) continue;
      for (const [name, model] of Object.entries(MODELS)) {
        const inner = simulateMachine(r.machine, { model, t: boundary }).levels[steps];
        assert.equal(inner.get('rsx'), boundary, `${name} N=${steps} t=${boundary}`);
        assert.equal(inner.get('rcs'), tr.values[boundary], `${name} N=${steps} t=${boundary}`);
      }
    }
  }
  const d49 = await generate(div49Wasm, { init: 117649, steps: 500 });
  assert.deepEqual(d49.verification.trace.values.slice(0, 5), [117649, 2401, 49, 1, 0]);
});

test('multi-state (#6) + multi-step unrolling + factored selection: K=4 UI card at 1200 steps', async () => {
  const gget = (i) => [op.global_get, ...uleb(i)];
  const gset = (i) => [op.global_set, ...uleb(i)];
  // 4-value globals ABI oscillator/counter
  const wasm = buildModule({
    globals: ['x', 'y', 'dx', 'n'].map((name, i) => ({ type: I32, mutable: true, init: 0, export: name })),
    funcs: [
      {
        name: 'step', params: [], results: [],
        body: [
          ...gget(0), ...gget(2), op.add, ...gset(0),
          ...gget(1), ...c(3), op.add, ...c(97), op.rem_s, ...gset(1),
          ...gget(0), ...c(20), op.gt_s, op.if, 0x40, ...c(-1), ...gset(2), op.end,
          ...gget(0), ...c(0), op.le_s, op.if, 0x40, ...c(1), ...gset(2), op.end,
          ...gget(3), ...c(1), op.add, ...gset(3),
        ],
      },
      { name: 'vx', params: [], results: [I32], body: [...gget(0)] },
      { name: 'vy', params: [], results: [I32], body: [...gget(1)] },
      { name: 'vn', params: [], results: [I32], body: [...gget(3)] },
    ],
  });
  const r = await generate(wasm, {
    export: 'step',
    state: ['x', 'y', 'dx', 'n'],
    init: { x: 0, y: 0, dx: 1, n: 0 },
    steps: 1200,
    ui: { entry: VALUES, views: { x: 'vx', y: 'vy', n: 'vn' } },
  });
  assert.equal(r.machine.stride, 4);
  assert.equal(r.machine.blocks, 300);
  assert.equal(r.machine.selectionMode, 'factored');
  assert.deepEqual(r.machine.shown, [0, 1, 3]); // dx (index 2) is never selected!
  assert.equal(r.perf.report.selectedValues, 3);
  assert.equal(r.perf.report.selectionTerms, 3 * 1201);
  assert.ok(r.svg.includes('>STEP</text>') && r.svg.includes('/ 1200</text>'));
  assert.ok(checkWellFormed(r.svg));
});

test('execution & cycle classification distinguishes finite, finite-replay, halt, and true periodic continuation', async () => {
  // mod-4 cycle: step(x) = (x + 1) rem 4 -> 0, 1, 2, 3, 0, ... (period 4 from start 0)
  const mod4 = unary([get(0), c(1), op.add, c(4), op.rem_s]);

  // 1. Seamless periodic continuation: steps = 3 (1 period) or steps = 7 (2 periods), hold = 0, loops = "infinite" -> wraps to 0 = step(3)!
  const periodic = await generate(mod4, { export: 'f', init: 0, steps: 3, hold: 0, loops: 'infinite' });
  assert.deepEqual(periodic.execution, {
    mode: 'periodic', steps: 3, levels: 3, stepsPerLevel: 1, selection: 'flat',
    cycle: { start: 0, period: 4 },
  });
  const periodic2 = await generate(mod4, { export: 'f', init: 0, steps: 7, hold: 0, loops: 'infinite' });
  assert.equal(periodic2.execution.mode, 'periodic', 'multiple full periods wrap seamlessly too');
  const nonMultiple = await generate(mod4, { export: 'f', init: 0, steps: 5, hold: 0, loops: 'infinite' });
  assert.equal(nonMultiple.execution.mode, 'finite-replay', 'partial period jumps on wrap');

  // 2. With hold > 0 or wrong step count, infinite loop resets rather than continuing seamlessly -> "finite-replay"
  const withHold = await generate(mod4, { export: 'f', init: 0, steps: 3, hold: 4, loops: 'infinite' });
  assert.equal(withHold.execution.mode, 'finite-replay');
  assert.deepEqual(withHold.execution.cycle, { start: 0, period: 4 });

  // 3. Lasso (transient before cycle): step(x) = x < 3 ? x + 1 : 3 + ((x - 3 + 1) % 2) -> 0, 1, 2, 3, 4, 3, 4... (start=3, period=2)
  const lasso = unary([
    get(0), c(3), op.lt_s, op.if, I32,
    get(0), c(1), op.add,
    op.else,
    c(3), get(0), c(2), op.sub, c(2), op.rem_s, op.add,
    op.end,
  ]);
  const rLasso = await generate(lasso, { export: 'f', init: 0, steps: 6, hold: 0, loops: 'infinite' });
  assert.equal(rLasso.execution.mode, 'finite-replay'); // cannot loop 0..6 seamlessly since start=3 > 0
  assert.deepEqual(rLasso.execution.cycle, { start: 3, period: 2 });

  // 4. Single finite run (loops = 1) vs halt
  const once = await generate(lfsrWasm, { export: 'step', init: 1, steps: 20, loops: 1, bits: 16 });
  assert.equal(once.execution.mode, 'finite');
  assert.equal(once.execution.cycle, null);

  const halted = await generate(collatzWasm, { export: 'step', init: 27, steps: 120, haltValue: 1 });
  assert.equal(halted.execution.mode, 'halt');
});

test('trace card columns with stride > 1 and tail (.T) partition [tr.x, tr.x + tr.w] without overlap or overflow', async () => {
  const { renderCard, layout } = await import('../src/render/card.js');
  const prog = compileStep(lfsrWasm, { exportName: 'step' });
  // Test both default stride (steps = 401 -> stride 2, tail 1; steps = 2000 -> stride 7, tail 5) and explicit large stride (steps = 29, stride = 6 -> tail 5)
  for (const [steps, stride] of [[401, undefined], [2000, undefined], [29, 6]]) {
    const m = buildMachine(prog, { init: 1, steps, ...(stride ? { stride } : {}) });
    const L = layout(m, { bits: 16 });
    const svg = renderCard(m, {
      title: 't', wasmName: 't.wasm', exportName: 'step', stepMs: 150, loops: 1,
      altInits: [], toolVersion: 'test', wasmSha256: '0'.repeat(64), cssSnippet: '',
    }, { bits: 16 });
    assert.ok(checkWellFormed(svg));
    const widthOf = (id) => Number(new RegExp(`<g id="${id}"><rect [^>]*width="([\\d.]+)"`).exec(svg)[1]);
    const w0 = widthOf('col0');
    const wFull = widthOf('col');
    const wTail = m.tailSteps > 0 ? widthOf('colt') : 0;
    const cw = Number(L.cw.toFixed(4));
    // Verify intervals [start_b, start_b + w_b] are strictly non-overlapping and inside [0, tr.w + 0.5]
    const intervals = [[0, w0]];
    for (let b = 1; b <= m.blocks; b++) {
      const isTail = m.tailSteps > 0 && b === m.blocks;
      const count = isTail ? m.tailSteps : m.stride;
      const rk = isTail ? steps : b * m.stride;
      const x0 = (rk - (count - 1)) * cw;
      const w = isTail ? wTail : wFull;
      intervals.push([x0, x0 + w]);
    }
    for (let i = 1; i < intervals.length; i++) {
      assert.ok(intervals[i][0] >= intervals[i - 1][1] - 1e-6, `N=${steps} block ${i} overlaps previous: ${intervals[i - 1]} vs ${intervals[i]}`);
    }
    const maxRight = intervals.at(-1)[1];
    assert.ok(maxRight <= L.tr.w + 0.5, `N=${steps} overflows trace panel (${maxRight} > ${L.tr.w})`);
  }
});

