// Sub-step visual interpolation (#4): separate discrete state transitions (.C / .D, once per
// stepMs) from continuous CSS style rendering (.rr-ui --rf: 0..1) while keeping text counters,
// @container switches, integer-only CSS properties, and halt/hold/trap/range boundaries exact.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MODELS } from '../src/compiler/css.js';
import { generate, OptionError } from '../src/generate.js';
import { simulateMachine, simulateInterpolation, lerpProp, viewProp } from '../src/runtime/machine.js';
import { buildModule, I32, op, c, get, uleb } from './helpers/wasm-builder.js';

const gget = (i) => [op.global_get, ...uleb(i)];
const gset = (i) => [op.global_set, ...uleb(i)];
const VOID = 0x40;

// 4-state module (x, angle, on, hits):
//   x += 10; angle = (angle + 15) rem 360; on = 1 - on; hits += 1
function motionModule() {
  return buildModule({
    funcs: [
      {
        name: 'step', params: [], results: [],
        body: [
          ...gget(0), ...c(10), op.add, ...gset(0),
          ...gget(1), ...c(15), op.add, ...c(360), op.rem_s, ...gset(1),
          ...c(1), ...gget(2), op.sub, ...gset(2),
          ...gget(3), ...c(1), op.add, ...gset(3),
        ],
      },
      { name: 'view_dx', params: [], results: [I32], body: [...gget(0)] },
      { name: 'view_rot', params: [], results: [I32], body: [...gget(1)] },
      { name: 'view_on', params: [], results: [I32], body: [...gget(2), ...c(1), op.and] },
      { name: 'view_hits', params: [], results: [I32], body: [...gget(3)] },
    ],
    globals: [
      { type: I32, mutable: true, init: 0, export: 'x' },
      { type: I32, mutable: true, init: 0, export: 'angle' },
      { type: I32, mutable: true, init: 0, export: 'on' },
      { type: I32, mutable: true, init: 0, export: 'hits' },
    ],
  });
}

function makeDemoDir(t, jsx) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-interp-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
  fs.writeFileSync(path.join(dir, 'demo.jsx'), jsx);
  return dir;
}

const MIXED_DEMO = `export default function Demo({ dx, rot, on, hits }) {
  return (
    <div style={{ position: 'relative', width: 320, height: 120 }}>
      <div
        className={on ? 'actor active' : 'actor'}
        style={{
          position: 'absolute',
          left: 16 + dx * 2,
          zIndex: dx,
          transform: \`translateY(8px) rotate(\${rot}deg)\`,
          opacity: 1,
        }}
      />
      <p>x = {dx} · hits = {hits}</p>
    </div>
  );
}
`;

test('interpolate omitted or false is byte-for-byte identical and adds no animation', async (t) => {
  const dir = makeDemoDir(t, MIXED_DEMO);
  const wasm = motionModule();
  const baseOpts = {
    export: 'step',
    state: ['x', 'angle', 'on', 'hits'],
    init: { x: 0, angle: 0, on: 0, hits: 0 },
    steps: 8,
    cwd: dir,
    ui: { entry: 'demo.jsx', views: { dx: 'view_dx', rot: 'view_rot', on: 'view_on', hits: 'view_hits' } },
  };
  const omitted = await generate(wasm, baseOpts);
  const disabled = await generate(wasm, { ...baseOpts, interpolate: false });
  assert.equal(omitted.svg, disabled.svg);
  assert.ok(!omitted.svg.includes('@keyframes rrf'));
  assert.ok(!omitted.svg.includes('--rlerp_'));
  assert.equal(omitted.perf.report.interpolated, false);
  assert.equal(omitted.execution.interpolation, undefined);
});

test('mixed views: continuous style props use --rlerp_*, while counters, switches, and z-index stay discrete', async (t) => {
  const dir = makeDemoDir(t, MIXED_DEMO);
  const wasm = motionModule();
  const r = await generate(wasm, {
    export: 'step',
    state: ['x', 'angle', 'on', 'hits'],
    init: { x: 0, angle: 0, on: 0, hits: 0 },
    steps: 8,
    loops: 3,
    stepMs: 120,
    interpolate: true,
    cwd: dir,
    ui: { entry: 'demo.jsx', views: { dx: 'view_dx', rot: 'view_rot', on: 'view_on', hits: 'view_hits' } },
  });

  // Only dx and rot have continuous style sites; on (switch) and hits (text) do not.
  assert.deepEqual(r.ui.continuousViews, ['dx', 'rot']);
  assert.deepEqual(r.execution.interpolation, {
    active: true,
    easing: 'linear',
    views: ['dx', 'rot'],
    sites: 4, // 2 variants of `.actor` (on=0, on=1) x 2 continuous sites (left, rotate)
    periodicWrap: false,
  });
  assert.equal(r.perf.report.interpolated, true);

  // Next-step state selection selects ONLY state indices [0, 1] (x, angle), skipping on (2) and hits (3).
  assert.deepEqual(r.machine.shown, [0, 1, 2, 3]);
  assert.deepEqual(r.machine.interpolation.nextShown, [0, 1]);
  assert.ok(!r.svg.includes('--rncy2') && !r.svg.includes('--rncy3'));

  // Continuous style sites bind --rlerp_dx and --rlerp_rot; discrete sites stay --rview_*.
  assert.match(r.svg, /left:calc\(\(var\(--rlerp_dx\) \* 2 \+ 16\) \* 1px\)/);
  assert.match(r.svg, /rotate\(calc\(\(var\(--rlerp_rot\)\) \* 1deg\)\)/);
  assert.match(r.svg, /z-index:calc\(var\(--rview_dx\)\)/, 'integer-only z-index stays discrete');
  assert.match(r.svg, /counter-reset:rr-n var\(--rview_dx\)/, 'text counter for dx stays discrete');
  assert.match(r.svg, /counter-reset:rr-n var\(--rview_hits\)/, 'text counter for hits stays discrete');
  assert.match(r.svg, /@container style\(--rview_on: 1\)/, '@container switch stays discrete');

  // Finite loops: .C runs 3 loops of (T+1)=21 ticks; .rr-ui runs 21*3=63 sub-step iterations and stops.
  assert.match(r.svg, /\.C\{animation:rrclk 2520ms steps\(21,jump-none\) 3 forwards\}/);
  assert.match(r.svg, /\.rr-ui\{animation:rrf 120ms linear 63 forwards!important;/);
  assert.equal(r.perf.report.selectedValues, 4);
  assert.equal(r.perf.report.nextSelectedValues, 2);

  // Reduced-motion rule must follow BOTH .C and .rr-ui animations so equal specificity stops both.
  const cIdx = r.svg.indexOf('.C{animation:rrclk ');
  const uiIdx = r.svg.indexOf('.rr-ui{animation:rrf ');
  const redIdx = r.svg.indexOf('@media (prefers-reduced-motion:reduce){.C{animation:none;--rt:20}.rr-ui{animation:none!important;transition:none!important;--rf:0}');
  assert.ok(cIdx >= 0 && uiIdx > cIdx && redIdx > uiIdx);
});

test('option validation, subset views, cubic-bezier easing, and discrete-only warnings', async (t) => {
  const dir = makeDemoDir(t, MIXED_DEMO);
  const wasm = motionModule();
  const base = {
    export: 'step',
    state: ['x', 'angle', 'on', 'hits'],
    init: { x: 0, angle: 0, on: 0, hits: 0 },
    steps: 6,
    cwd: dir,
    ui: { entry: 'demo.jsx', views: { dx: 'view_dx', rot: 'view_rot', on: 'view_on', hits: 'view_hits' } },
  };

  // Errors on trace card or invalid options
  const singleWasm = buildModule({ funcs: [{ name: 'step', params: [I32], results: [I32], body: [...get(0), ...c(1), op.add] }] });
  await assert.rejects(generate(singleWasm, { init: 0, steps: 4, interpolate: true }), (e) => e instanceof OptionError && /requires "ui"/.test(e.message));
  for (const bad of ['steps(4)', 'cubic-bezier(1.2, 0, 0.5, 1)', 42, { nope: 1 }, { views: [] }, { views: ['dx', 'dx'] }, { views: ['missing'] }]) {
    await assert.rejects(generate(wasm, { ...base, interpolate: bad }), (e) => e instanceof OptionError, JSON.stringify(bad));
  }

  // Subset + cubic-bezier + warning on discrete-only view in interpolate.views
  const sub = await generate(wasm, { ...base, interpolate: { easing: 'cubic-bezier(0.35, 0, 0.65, 1)', views: ['dx', 'hits'] } });
  assert.deepEqual(sub.execution.interpolation.views, ['dx']);
  assert.equal(sub.execution.interpolation.easing, 'cubic-bezier(0.35,0,0.65,1)');
  assert.match(sub.svg, /var\(--rlerp_dx\)/);
  assert.ok(!sub.svg.includes('--rlerp_rot'));
  assert.ok(sub.ui.warnings?.some((w) => w.code === 'UI_INTERPOLATE_DISCRETE_ONLY' && w.message.includes('"hits"')));

  // Purely discrete UI card with interpolate: true omits idle 60fps animation and warns
  const discDir = makeDemoDir(t, 'export default function D({ hits }) { return <div style={{ width: 200, height: 40 }}>count {hits}</div>; }\n');
  const disc = await generate(wasm, {
    export: 'step',
    state: ['x', 'angle', 'on', 'hits'],
    init: { x: 0, angle: 0, on: 0, hits: 0 },
    steps: 4,
    interpolate: true,
    cwd: discDir,
    ui: { entry: 'demo.jsx', views: { hits: 'view_hits' } },
  });
  assert.equal(disc.execution.interpolation.active, false);
  assert.equal(disc.perf.report.interpolated, false);
  assert.ok(!disc.svg.includes('@keyframes rrf'));
  assert.ok(disc.ui.warnings?.some((w) => w.code === 'UI_INTERPOLATE_DISCRETE_ONLY'));
});

test('halt, hold, trap, and edited out-of-range states never interpolate into invalid or post-terminal values', async (t) => {
  const dir = makeDemoDir(t, 'export default function D({ x }) { return <div style={{ width: 200, height: 40 }}><i style={{ left: `${x}px` }} /></div>; }\n');
  // step(x): traps when x == 30 (at step 3 from init 0); otherwise x + 10. Halt when x == 20.
  const trapHaltWasm = buildModule({
    funcs: [
      {
        name: 'step', params: [I32], results: [I32],
        body: [
          ...get(0), ...c(30), op.eq, op.if, VOID, op.unreachable, op.end,
          ...get(0), ...c(10), op.add,
        ],
      },
      { name: 'halt', params: [I32], results: [I32], body: [...get(0), ...c(20), op.eq] },
      { name: 'view_x', params: [I32], results: [I32], body: [...get(0)] },
    ],
  });

  // 1. Halts at step 2 (x = 20): steps 0 and 1 interpolate, steps >= 2 hold still at 20.
  const halted = await generate(trapHaltWasm, {
    init: 0, steps: 6, hold: 3, haltExport: 'halt', interpolate: true, cwd: dir,
    ui: { entry: 'demo.jsx', views: { x: 'view_x' } },
  });
  for (const model of Object.values(MODELS)) {
    const { dispBase } = simulateMachine(halted.machine, { model });
    assert.equal(simulateInterpolation(halted.machine, dispBase, { t: 0, rf: 0.25, model }).ui.get(lerpProp('x')), 2.5);
    assert.equal(simulateInterpolation(halted.machine, dispBase, { t: 1, rf: 0.5, model }).ui.get(lerpProp('x')), 15);
    for (const step of [2, 3, 6, 9]) {
      const s = simulateInterpolation(halted.machine, dispBase, { t: step, rf: 0.75, model });
      assert.equal(s.d.get('rgo'), 0);
      assert.equal(s.ui.get(lerpProp('x')), 20);
    }
  }

  // 2. Traps at step 4 (0 -> 10 -> 20 -> 30, then step(30) traps at k=4):
  //    lastGood = 3, so t=0,1,2 interpolate up to 30, and t=3 (before trap!) has rsn=3, rgo=0.
  const trapped = await generate(trapHaltWasm, {
    init: 0, steps: 6, hold: 2, interpolate: true, cwd: dir,
    ui: { entry: 'demo.jsx', views: { x: 'view_x' } },
  });
  assert.equal(trapped.verification.trace.end.kind, 'trap');
  assert.equal(trapped.verification.trace.end.at, 4);
  for (const model of Object.values(MODELS)) {
    const { dispBase } = simulateMachine(trapped.machine, { model });
    assert.equal(simulateInterpolation(trapped.machine, dispBase, { t: 2, rf: 0.5, model }).ui.get(lerpProp('x')), 25);
    const beforeTrap = simulateInterpolation(trapped.machine, dispBase, { t: 3, rf: 0.5, model });
    assert.equal(beforeTrap.d.get('rsn'), 3);
    assert.equal(beforeTrap.d.get('rgo'), 0);
    assert.equal(beforeTrap.ui.get(lerpProp('x')), 30);

    // Edited initial state out of range at step 0 (init = 1,500,000): rlg = -1, rsn clamped to 0, rgo = 0.
    const { dispBase: oobBase } = simulateMachine(trapped.machine, { model, init: 1500000 });
    const oob = simulateInterpolation(trapped.machine, oobBase, { t: 0, rf: 0.5, model });
    assert.equal(oob.d.get('rsn'), 0);
    assert.equal(oob.d.get('rgo'), 0);
  }
});

test('seamless periodic wrap interpolates x_steps -> x_0 without reset jump, and disables wrap when unsafe', async (t) => {
  const dir = makeDemoDir(t, 'export default function D({ x }) { return <div style={{ width: 200, height: 40 }}><i style={{ left: `${x}px` }} /></div>; }\n');
  // Periodic mod-4 counter for x < 10; non-periodic linear x + 1 for x >= 10
  const cycWasm = buildModule({
    funcs: [
      {
        name: 'step', params: [I32], results: [I32],
        body: [
          ...get(0), ...c(10), op.lt_s,
          op.if, I32,
          ...get(0), ...c(1), op.add, ...c(3), op.and,
          op.else,
          ...get(0), ...c(1), op.add,
          op.end,
        ],
      },
      { name: 'view_x', params: [I32], results: [I32], body: [...get(0), ...c(10), op.mul] },
    ],
  });

  // Seamless periodic: init=0, steps=3 (0->1->2->3, step(3)=0), hold=0, loops="infinite"
  const seamless = await generate(cycWasm, {
    init: 0, steps: 3, hold: 0, loops: 'infinite', interpolate: true, cwd: dir,
    ui: { entry: 'demo.jsx', views: { x: 'view_x' } },
  });
  assert.equal(seamless.execution.mode, 'periodic');
  assert.equal(seamless.execution.interpolation.periodicWrap, true);
  for (const model of Object.values(MODELS)) {
    const { dispBase } = simulateMachine(seamless.machine, { model });
    // At t=3 (view=30), wraps smoothly toward t=0 (view=0): midpoint rf=0.5 is 15, rf=1 is 0!
    const mid = simulateInterpolation(seamless.machine, dispBase, { t: 3, rf: 0.5, model });
    const end = simulateInterpolation(seamless.machine, dispBase, { t: 3, rf: 1, model });
    assert.equal(mid.d.get('rsn'), 0);
    assert.equal(mid.d.get('rgo'), 1);
    assert.equal(mid.ui.get(lerpProp('x')), 15);
    assert.equal(end.ui.get(lerpProp('x')), 0);
  }

  // Adding a non-periodic altInit (init=10 -> 11 -> 12 -> 13, step(13)=14 != 10) disables periodicWrap
  const mixedAlt = await generate(cycWasm, {
    init: 0, altInits: [10], steps: 3, hold: 0, loops: 'infinite', interpolate: true, cwd: dir,
    ui: { entry: 'demo.jsx', views: { x: 'view_x' } },
  });
  assert.equal(mixedAlt.execution.interpolation.periodicWrap, false);
});

test('long multi-step unrolled UI cards (steps > 400) use 2D factored next-state selection', async (t) => {
  const dir = makeDemoDir(t, 'export default function D({ x }) { return <div style={{ width: 200, height: 40 }}><i style={{ left: `${x}px` }} /></div>; }\n');
  const linWasm = buildModule({
    funcs: [
      { name: 'step', params: [I32], results: [I32], body: [...get(0), ...c(1), op.add, ...c(255), op.and] },
      { name: 'view_x', params: [I32], results: [I32], body: [...get(0)] },
    ],
  });
  const r = await generate(linWasm, {
    init: 0, steps: 600, hold: 4, interpolate: 'ease-in-out', cwd: dir,
    ui: { entry: 'demo.jsx', views: { x: 'view_x' } },
  });
  assert.equal(r.machine.stride, 2);
  assert.equal(r.machine.interpolation.nextSelectionMode, 'factored');
  const { dispBase } = simulateMachine(r.machine, { model: MODELS.firefox });
  const sample = simulateInterpolation(r.machine, dispBase, { t: 255, rf: 0.5, model: MODELS.firefox });
  // At step 255, view_x=255; at step 256, view_x=(256 & 255)=0 -> midpoint is 127.5
  assert.equal(sample.d.get(viewProp('x')), 255);
  assert.equal(sample.ui.get(lerpProp('x')), 127.5);
});

test('review regressions: trapped untaken branch range, grid-area/columns/repeat(), and body CSS animations', async (t) => {
  // 1. Trapped step whose untaken CSS branch computes 200,000 while view multiplies by 100:
  //    must NOT falsely trigger RANGE_INTERMEDIATE at t >= endAt when rgo == 0.
  const trapDir = makeDemoDir(t, 'export default function D({ x }) { return <div style={{ width: 200, height: 40 }}><i style={{ left: `${x}px` }} /></div>; }\n');
  const trapBranchWasm = buildModule({
    funcs: [
      {
        name: 'step', params: [I32], results: [I32],
        body: [
          ...get(0), ...c(20), op.eq,
          op.if, I32,
          op.unreachable,
          op.else,
          ...get(0), ...c(10), op.add,
          op.end,
          // add 200000 when x == 20 (dead in Wasm after unreachable, evaluated in CSS on the trapped step)
          ...get(0), ...c(20), op.eq, ...c(200000), op.mul, op.add,
        ],
      },
      { name: 'view_x', params: [I32], results: [I32], body: [...get(0), ...c(100), op.mul] },
    ],
  });
  const tr = await generate(trapBranchWasm, {
    init: 0, steps: 5, hold: 2, interpolate: true, cwd: trapDir,
    ui: { entry: 'demo.jsx', views: { x: 'view_x' } },
  });
  assert.equal(tr.verification.trace.end.kind, 'trap');
  assert.equal(tr.verification.trace.end.at, 3);

  // 2. Discrete CSS shorthands / functions (grid-area, columns, repeat(N, 1fr)) stay discrete,
  //    and body { animation/transition } in ui.css does not hijack .rr-ui's rrf clock.
  const gridDir = makeDemoDir(t, `export default function D({ n, x }) {
    return (
      <div style={{ width: 240, height: 60, gridTemplateColumns: \`repeat(\${n}, 1fr)\`, columns: n }}>
        <span style={{ gridArea: \`\${n} / 1\`, left: \`\${x}px\` }}>cell</span>
      </div>
    );
  }\n`);
  fs.writeFileSync(path.join(gridDir, 'page.css'), 'body { animation: fade 0.3s ease; transition: opacity 0.2s; color: #111; }\n:root body { animation: pulse 1s infinite; }\n');
  const gridWasm = buildModule({
    funcs: [
      { name: 'step', params: [I32], results: [I32], body: [...get(0), ...c(1), op.add] },
      { name: 'view_n', params: [I32], results: [I32], body: [...get(0), ...c(1), op.add] },
      { name: 'view_x', params: [I32], results: [I32], body: [...get(0), ...c(10), op.mul, ...c(4), op.add] },
    ],
  });
  const g = await generate(gridWasm, {
    init: 1, steps: 4, interpolate: true, cwd: gridDir,
    ui: { entry: 'demo.jsx', css: ['page.css'], views: { n: 'view_n', x: 'view_x' } },
  });
  assert.deepEqual(g.ui.continuousViews, ['x']);
  assert.match(g.svg, /repeat\(calc\(var\(--rview_n\)\), 1fr\)/);
  assert.match(g.svg, /columns:calc\(var\(--rview_n\)\)/);
  assert.match(g.svg, /grid-area:calc\(var\(--rview_n\)\) \/ 1/);
  assert.match(g.svg, /left:calc\(\(var\(--rlerp_x\)\) \* 1px\)/);
  assert.ok(!/\.rr-ui\s*\{[^}]*fade/.test(g.svg), 'body animation is stripped from .rr-ui');
});

