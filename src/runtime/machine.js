// The CSS "machine": how the compiled step() is chained across nested SVG levels.
//
// Block b (b >= 1) is a <g> nested inside block b-1. CSS custom properties cannot refer to
// themselves on the same element, so:
//   1. Across nested <g> blocks, carried values alternate between *_a and *_b by block parity.
//   2. Inside one <g> block, up to `stride` steps are unrolled sequentially through distinct
//      non-inherited registered <integer> properties (--r0x -> --r1x -> ... -> --rxa/b),
//      keeping DOM nesting at <= MAX_LEVELS (320) even at MAX_STEPS (2000) so WebKit (~512
//      DOM tree-depth limit) and Chromium (~1024 recursion limit) never fail.
// Every step's state is also exported under --rS<k> on the <g> that computes it, and the
// innermost display selects the shown step by the clock (with 2D power-of-two factored
// indicators on long or multi-value runs).

import { compileStep } from '../compiler/program.js';
import {
  MODELS, N, V, absV, add, clamp, div, evalAst, fn, max, min, mod, mul,
  round, storeInteger, storeNumber, sub, toCss, translate, STORED_LIMIT,
} from '../compiler/css.js';
import { topoOrder } from '../compiler/ir.js';
import { analyzeRanges } from '../compiler/range.js';

export const MAX_STEPS = 2000;
export const MAX_LEVELS = 320; // leaves ~190 DOM levels inside <foreignObject> below WebKit's ~512 cap
export const FACTORED_THRESHOLD = 800; // selection terms above which 2D factored selection is used

export const defaultStride = (steps) => (steps <= 400 ? 1 : Math.ceil(steps / MAX_LEVELS));

const P = { A: 'a', B: 'b' };
const other = (p) => (p === 'A' ? 'B' : 'A');

// Carried inter-block values (each exists as --r<x>a and --r<x>b).
//   x state | k depth | h halted | e error | f flags of the step where the run stopped
//   q halt step | z last step of the run (steps after a halt or an error are not run)
// None of them depends on the clock: the chain is computed once, when the card is first
// styled, and the clock only drives the display (see `select`), so a tick restyles the
// display and nothing above it.
const CARRIED = ['x', 'k', 'h', 'e', 'f', 'q', 'z'];
const n = (name, parity) => `r${name}${P[parity]}`;
// A state of several values (compiler/program.js) carries value i >= 1 as --ry<i>a / --ry<i>b;
// value 0 is the x above, so a one-value state gives the same card as the original ABI.
const xName = (i, parity) => (i === 0 ? n('x', parity) : `ry${i}${P[parity]}`);
const blockParity = (b) => (b % 2 === 1 ? 'A' : 'B'); // the root (b = 0) is parity B
const subStateName = (s, count, i, p) => (s === count - 1 ? xName(i, p) : i === 0 ? `r${s}x` : `r${s}y${i}`);
const subCarryName = (s, count, c, p) => (s === count - 1 ? n(c, p) : `r${s}${c}`);
const subPrefix = (s) => (s === 0 ? '' : `${s}`);

// Each step exports its state under a name of its own (an unregistered property set in its
// block's style attribute), which the display selects by the clock.
export const exportProp = (k, i = 0) => (i === 0 ? `rS${k}` : `rS${k}y${i}`);

export const levelClass = (b, machine = null) => (
  machine?.tailSteps > 0 && b === machine.blocks ? 'T' : blockParity(b)
);

export function levelStyle(b, machine = null) {
  if (!machine || machine.stride === 1) {
    return (machine?.shown ?? [0])
      .map((i) => (i === 0 ? `--${exportProp(b)}:var(--rx)` : `--${exportProp(b, i)}:var(--${xName(i, blockParity(b))})`))
      .join(';');
  }
  const p = blockParity(b);
  const count = machine.tailSteps > 0 && b === machine.blocks ? machine.tailSteps : machine.stride;
  const base = (b - 1) * machine.stride;
  const parts = [];
  for (let s = 0; s < count; s++) {
    const k = base + s + 1;
    for (const i of machine.shown) {
      const src = s === count - 1 ? (i === 0 ? 'rx' : xName(i, p)) : subStateName(s, count, i, p);
      parts.push(`--${exportProp(k, i)}:var(--${src})`);
    }
  }
  return parts.join(';');
}

// The style attribute of the root (g.R): the initial state, the card's only input.
export const rootStyle = (machine) => machine.initProps.map((p, i) => `--${p}:${machine.initValues[i]}`).join(';');

export function buildMachine(program, { init, steps, hold = 0, haltValue = null, stride = defaultStride(steps) }) {
  const K = program.state?.length ?? 1;
  const initValues = Array.isArray(init) ? init : [init];
  if (initValues.length !== K || !initValues.every(Number.isInteger)) throw new RangeError(K === 1 ? 'init must be an integer' : `init must be ${K} integers`);
  if (!Number.isInteger(steps) || steps < 1 || steps > MAX_STEPS) throw new RangeError(`steps must be an integer between 1 and ${MAX_STEPS}`);
  if (!Number.isInteger(stride) || stride < 1) throw new RangeError('stride must be a positive integer');
  if (K > 1 && haltValue !== null) throw new RangeError('a halt value needs a state of one value; use a halt predicate (haltExport)');

  const blockStride = Math.min(stride, steps);
  const fullBlocks = Math.floor(steps / blockStride);
  const tailSteps = steps % blockStride;
  const blocks = fullBlocks + (tailSteps > 0 ? 1 : 0);

  const T = steps + hold;
  const props = new Map(); // name -> inherits
  for (const c of CARRIED) for (const p of ['A', 'B']) props.set(n(c, p), true);
  for (let i = 1; i < K; i++) for (const p of ['A', 'B']) props.set(xName(i, p), true);
  for (const u of ['rx', 'rk', 'ra', 'rt']) props.set(u, true);
  const nexts = program.state ? program.state.map((s) => s.node) : [program.step];
  // The values the display selects by the clock: those the view functions read, or [0] for trace cards.
  const shown = program.views?.length
    ? [...new Set(topoOrder(program.views.map((v) => v.node)).filter((x) => x.op === 'input').map((x) => x.index))].sort((a, b) => a - b)
    : [0];

  const usesTrap = program.trap !== null;
  const haltKind = program.halt ? 'export' : haltValue !== null ? 'value' : 'none';
  const domain = { lo: -STORED_LIMIT, hi: STORED_LIMIT };
  const stateGuard = (x) => clamp(N(0), sub(absV(x), N(STORED_LIMIT)), N(1));
  const haltValueFlag = (x) => sub(N(1), clamp(N(0), absV(sub(x, N(haltValue))), N(1)));
  const guardCount = { step: 0, halt: 0 };

  function compileBlock(count, p) {
    const q = other(p);
    const out = [];
    const slices = [];
    for (let s = 0; s < count; s++) {
      const start = out.length;
      const pfx = subPrefix(s);
      const inX = (i) => V(s === 0 ? xName(i, q) : subStateName(s - 1, count, i, p));
      const inC = (c) => V(s === 0 ? n(c, q) : subCarryName(s - 1, count, c, p));
      const outX = (i) => subStateName(s, count, i, p);
      const outC = (c) => subCarryName(s, count, c, p);

      // step(): new state (+ shared temporaries) from the previous sub-step's state.
      const roots = nexts.map((node, i) => ({ node, name: outX(i) }));
      const trName = `r${pfx}tr`;
      if (usesTrap) roots.push({ node: program.trap, name: trName });
      const st = translate(roots, inX, { tempPrefix: `r${pfx}v`, inputRange: domain, checkedRoots: new Set(roots.map((r) => r.name)) });
      out.push(...st.defs);
      for (const t of st.temps) props.set(t, false);
      if (usesTrap) props.set(trName, false);
      if (s < count - 1) {
        for (let i = 0; i < K; i++) props.set(outX(i), false);
        for (const c of ['k', 'h', 'e', 'f', 'q', 'z']) props.set(outC(c), false);
      }
      guardCount.step = st.guards.length;

      const xNew = V(outX(0));
      const xNews = nexts.map((_, i) => V(outX(i)));
      const kName = outC('k');
      const lvName = `r${pfx}lv`;
      out.push({ name: kName, ast: add(inC('k'), N(1)) });
      out.push({ name: lvName, ast: sub(N(1), max(inC('h'), inC('e'))) });

      // halt predicate on the new state
      let hz;
      let haltGuards = [];
      const hzName = `r${pfx}hz`;
      if (haltKind === 'export') {
        const hs = translate([{ node: program.halt, name: hzName }], (i) => xNews[i], { tempPrefix: `r${pfx}w`, inputRange: domain, checkedRoots: new Set([hzName]) });
        out.push(...hs.defs);
        for (const t of hs.temps) props.set(t, false);
        haltGuards = hs.guards;
        guardCount.halt = hs.guards.length;
        hz = V(hzName);
      } else if (haltKind === 'value') {
        out.push({ name: hzName, ast: haltValueFlag(xNew) });
        hz = V(hzName);
      } else hz = N(0);
      if (haltKind !== 'none') props.set(hzName, false);

      // range flag: each guard is its own registered property so NaN/Inf in one guard cannot silence another
      out.push(...guardProps([...st.guards, ...haltGuards], props, pfx));
      const flags = [...xNews.map(stateGuard), ...[...st.guards, ...haltGuards].map((_, i) => V(guardName(i, pfx)))];
      const rgName = `r${pfx}rg`;
      out.push({ name: rgName, ast: flags.length === 1 ? flags[0] : fn('max', ...flags) });
      const err = usesTrap ? max(V(trName), V(rgName)) : V(rgName);
      const live = V(lvName);
      out.push({ name: outC('e'), ast: max(inC('e'), mul(live, err)) });
      out.push({ name: outC('h'), ast: max(inC('h'), mul(live, hz)) });
      const stepFlags = add(add(hz, mul(N(2), V(rgName))), usesTrap ? mul(N(4), V(trName)) : N(0));
      out.push({ name: outC('f'), ast: add(inC('f'), mul(live, stepFlags)) });
      out.push({ name: outC('q'), ast: add(inC('q'), mul(mul(live, hz), V(kName))) });
      out.push({ name: outC('z'), ast: add(inC('z'), live) });
      if (s === count - 1) {
        out.push({ name: 'rx', ast: xNew }, { name: 'rk', ast: V(kName) }, { name: 'ra', ast: mul(live, sub(N(1), err)) });
      }
      props.set(lvName, false);
      props.set(rgName, false);
      slices.push({ start, end: out.length });
    }
    return { defs: out, slices };
  }

  const blockA = compileBlock(blockStride, 'A');
  const blockB = compileBlock(blockStride, 'B');
  const blockT = tailSteps > 0 ? compileBlock(tailSteps, blockParity(blocks)) : null;
  const level = { A: blockA.defs, B: blockB.defs, T: blockT ? blockT.defs : null };
  const blockSlices = { A: blockA.slices, B: blockB.slices, ...(blockT ? { T: blockT.slices } : {}) };

  // Root = step 0, parity B (so block 1 is class A).
  const root = [];
  const X0 = V(n('x', 'B'));
  const X0s = nexts.map((_, i) => V(xName(i, 'B')));
  initValues.forEach((v, i) => root.push({ name: xName(i, 'B'), ast: N(v), literal: true }));
  root.push({ name: n('k', 'B'), ast: N(0) });
  let hz0 = N(0);
  let haltGuards0 = [];
  if (haltKind === 'export') {
    const hs = translate([{ node: program.halt, name: 'rhz' }], (i) => X0s[i], { tempPrefix: 'rw', inputRange: domain, checkedRoots: new Set(['rhz']) });
    root.push(...hs.defs);
    haltGuards0 = hs.guards;
    hz0 = V('rhz');
  } else if (haltKind === 'value') {
    root.push({ name: 'rhz', ast: haltValueFlag(X0) });
    hz0 = V('rhz');
  }
  root.push(...guardProps(haltGuards0, props, ''));
  const flags0 = [...X0s.map(stateGuard), ...haltGuards0.map((_, i) => V(guardName(i, '')))];
  root.push({ name: 'rrg', ast: flags0.length === 1 ? flags0[0] : fn('max', ...flags0) });
  root.push({ name: n('h', 'B'), ast: hz0 });
  root.push({ name: n('e', 'B'), ast: V('rrg') });
  root.push({ name: n('f', 'B'), ast: add(hz0, mul(N(2), V('rrg'))) });
  root.push({ name: n('q', 'B'), ast: N(0) });
  root.push({ name: n('z', 'B'), ast: N(0) });
  root.push({ name: 'rx', ast: X0 }, { name: 'rk', ast: N(0) }, { name: 'ra', ast: sub(N(1), V('rrg')) });
  for (const i of shown) root.push({ name: exportProp(0, i), ast: i === 0 ? V('rx') : X0s[i], unregistered: true });

  const innermost = blockParity(blocks);
  // The clock: the display (innermost) shows step min(t, z) of the run.
  const S = V('rsx');
  const Z = V(n('z', innermost));
  const shownNames = nexts.map((_, i) => (!shown.includes(i) ? null : i === 0 ? 'rcs' : `rcy${i}`));
  const selectionMode = steps > 400 || shown.length * (steps + 1) > FACTORED_THRESHOLD ? 'factored' : 'flat';
  const select = [{ name: 'rsx', ast: min(V('rt'), Z), inherits: true }];

  if (selectionMode === 'flat') {
    const isStep = (k) => (k === 0 ? max(N(0), sub(N(1), S)) : max(N(0), min(sub(N(k + 1), S), sub(S, N(k - 1)))));
    const pick = (i) => {
      let acc = mul(V(exportProp(0, i)), isStep(0));
      for (let k = 1; k <= steps; k++) acc = add(acc, mul(V(exportProp(k, i)), isStep(k)));
      return acc;
    };
    for (const i of shown) select.push({ name: shownNames[i], ast: pick(i), inherits: true });
  } else {
    // 2D factored selection with a power-of-two block size B (32 or 64), so 1/B is exact in
    // WebKit's a * (1/b) division, Firefox float32, and Chromium double. Indicator expressions
    // are shared across all blocks and all selected state values, and every calc() sum stays <= 64 terms.
    const B = steps >= 1536 ? 64 : 32;
    const Q = Math.ceil((steps + 1) / B);
    const isAt = (expr, m, hi) => (hi === 0 ? N(1)
      : m === 0 ? max(N(0), sub(N(1), expr))
        : m === hi ? max(N(0), sub(expr, N(m - 1)))
          : max(N(0), min(sub(N(m + 1), expr), sub(expr, N(m - 1)))));
    select.push(
      { name: 'rsq', ast: round('down', div(S, N(B))), inherits: false },
      { name: 'rsr', ast: mod(S, N(B)), inherits: false },
    );
    for (let m = 0; m < B; m++) select.push({ name: `rsri${m}`, ast: isAt(V('rsr'), m, B - 1), inherits: false });
    for (let qIdx = 0; qIdx < Q; qIdx++) select.push({ name: `rsqi${qIdx}`, ast: isAt(V('rsq'), qIdx, Q - 1), inherits: false });
    for (const i of shown) {
      const parts = [];
      for (let qIdx = 0; qIdx < Q; qIdx++) {
        const lo = qIdx * B;
        const hi = Math.min(steps, lo + B - 1);
        let acc = mul(V(exportProp(lo, i)), V('rsri0'));
        for (let k = lo + 1; k <= hi; k++) acc = add(acc, mul(V(exportProp(k, i)), V(`rsri${k - lo}`)));
        const bName = `rsb${i}_${qIdx}`;
        select.push({ name: bName, ast: mul(acc, V(`rsqi${qIdx}`)), inherits: false });
        parts.push(V(bName));
      }
      let sum = parts[0];
      for (let j = 1; j < parts.length; j++) sum = add(sum, parts[j]);
      select.push({ name: shownNames[i], ast: sum, inherits: true });
    }
  }
  select.push({ name: 'rfs', ast: mul(V(n('f', innermost)), clamp(N(0), add(sub(S, Z), N(1)), N(1))), inherits: true });
  for (const s of select) props.set(s.name, s.inherits ?? true);

  const out = { c: 'rcs', cs: shownNames, s: 'rsx', f: 'rfs', q: n('q', innermost), h: n('h', innermost), e: n('e', innermost) };

  // View functions run once, on the shown state, where the display lives.
  const display = [];
  const viewProps = {};
  const viewRanges = {};
  if (program.views?.length) {
    const roots = program.views.map((v) => ({ node: v.node, name: viewProp(v.name) }));
    const tv = translate(roots, (i) => V(out.cs[i]), { tempPrefix: 'ru', inputRange: domain });
    display.push(...tv.defs);
    for (const t of tv.temps) props.set(t, false);
    const ranges = analyzeRanges(program.views.map((v) => v.node), domain);
    for (const v of program.views) {
      viewProps[v.name] = viewProp(v.name);
      props.set(viewProp(v.name), true);
      const r = ranges.get(v.node.id);
      viewRanges[v.name] = { lo: Math.max(r.lo, -STORED_LIMIT), hi: Math.min(r.hi, STORED_LIMIT) };
    }
    display.push(...tv.guards.map((g, i) => ({ name: `rvg${i}`, ast: g })));
    tv.guards.forEach((_, i) => props.set(`rvg${i}`, false));
    display.push({ name: 'rvf', ast: tv.guards.length ? fn('max', ...tv.guards.map((_, i) => V(`rvg${i}`))) : N(0) });
    props.set('rvf', true);
  }

  // Per-step metadata so simulateMachine / verifyRun / tests can inspect any step 0..steps uniformly.
  const stepMeta = [{
    block: 0,
    sub: 0,
    stateProps: nexts.map((_, i) => xName(i, 'B')),
    carryProps: Object.fromEntries(CARRIED.map((c) => [c, n(c, 'B')])),
    rgProp: 'rrg',
  }];
  for (let b = 1; b <= blocks; b++) {
    const cls = tailSteps > 0 && b === blocks ? 'T' : blockParity(b);
    const p = blockParity(b);
    const count = tailSteps > 0 && b === blocks ? tailSteps : blockStride;
    for (let s = 0; s < count; s++) {
      stepMeta.push({
        block: b,
        sub: s,
        cls,
        slice: blockSlices[cls][s],
        stateProps: nexts.map((_, i) => subStateName(s, count, i, p)),
        carryProps: Object.fromEntries(CARRIED.map((c) => [c, subCarryName(s, count, c, p)])),
        rgProp: `r${subPrefix(s)}rg`,
      });
    }
  }

  return {
    props, root, level, blockSlices, stepMeta,
    steps, stride: blockStride, blocks, fullBlocks, tailSteps, selectionMode,
    T, hold, init, haltKind, haltValue, guardCount,
    out, select, display, viewProps, viewRanges,
    K, initValues, shown,
    initProp: n('x', 'B'),
    initProps: nexts.map((_, i) => xName(i, 'B')),
    stateProps: { A: nexts.map((_, i) => xName(i, 'A')), B: nexts.map((_, i) => xName(i, 'B')) },
  };
}

// Per-step values from a simulated run (see simulateMachine).
export const stateAt = (machine, levels, k) => machine.stepMeta[k].stateProps.map((p) => levels[k].get(p));
export const flagAt = (machine, levels, k, f) => levels[k].get(machine.stepMeta[k].carryProps[f]);
export const rangeFlagAt = (machine, levels, k) => levels[k].get(machine.stepMeta[k].rgProp);

export const viewProp = (name) => `rview_${name}`;
export const nextViewProp = (name) => `rnview_${name}`;
export const lerpProp = (name) => `rlerp_${name}`;

export const altInitId = (x) => `x${Array.isArray(x) ? x.join('_') : x}`;
export const altInitAnchors = (altInits = []) => altInits.map((x) => `<g id="${altInitId(x)}"/>`).join('');
export const altInitCss = (machine, altInits = []) => altInits.map((x) => {
  const v = Array.isArray(x) ? x : [x];
  return `#${altInitId(x)}:target~.R{${machine.initProps.map((p, i) => `--${p}:${v[i]}!important`).join(';')}}\n`;
}).join('');

export function clockAnimation(machine, { stepMs, loops = 'infinite' }) {
  return `rrclk ${(machine.T + 1) * stepMs}ms steps(${machine.T + 1},jump-none) ${loops === 'infinite' ? 'infinite' : `${loops} forwards`}`;
}

export function interpAnimation(machine, { stepMs, loops = 'infinite' }, { easing = 'linear' } = {}) {
  return `rrf ${stepMs}ms ${easing} ${loops === 'infinite' ? 'infinite' : `${(machine.T + 1) * loops} forwards`}`;
}

// Sub-step visual interpolation (#4): keep .C and .D discrete (once per stepMs), select the
// next valid state (--rsn) and its views (--rnview_<v>) in .D, and blend only continuous style
// bindings on .rr-ui via a single <number> animation (--rf: 0..1 per stepMs).
export function buildInterpolation(program, machine, viewNames, { easing = 'linear', periodic = false } = {}) {
  if (!viewNames?.length) return null;
  const views = (program.views ?? []).filter((v) => viewNames.includes(v.name));
  if (!views.length) return null;
  const nextShown = [...new Set(topoOrder(views.map((v) => v.node)).filter((x) => x.op === 'input').map((x) => x.index))].sort((a, b) => a - b);
  const K = program.state?.length ?? 1;
  const nextStateNames = Array.from({ length: K }, (_, i) => (!nextShown.includes(i) ? null : i === 0 ? 'rnc' : `rncy${i}`));
  const innermost = blockParity(machine.blocks);
  const Z = V(n('z', innermost)), H = V(n('h', innermost)), E = V(n('e', innermost));
  const steps = machine.steps;
  const intProps = new Map();
  const numProps = new Map();
  const dDefs = [];

  // Last good step: z on a normal or halted run, and z - 1 when step z trapped or left range,
  // so step z - 1 never selects or interpolates toward an invalid state x_z.
  dDefs.push({ name: 'rlg', ast: sub(Z, E) });
  intProps.set('rlg', false);
  const stdNext = max(N(0), min(add(V('rt'), N(1)), V('rlg')));
  const stdGo = clamp(N(0), sub(V('rlg'), V('rt')), N(1));
  if (periodic) {
    dDefs.push({ name: 'rpcyc', ast: sub(N(1), max(H, E)) });
    intProps.set('rpcyc', false);
    const atSteps = sub(N(1), clamp(N(0), sub(N(steps), V('rt')), N(1)));
    dDefs.push({ name: 'rsn', ast: mul(stdNext, sub(N(1), mul(V('rpcyc'), atSteps))) });
    intProps.set('rsn', false);
  } else {
    dDefs.push({ name: 'rsn', ast: stdNext });
    intProps.set('rsn', false);
  }

  const SN = V('rsn');
  const nextSelectionMode = steps > 400 || nextShown.length * (steps + 1) > FACTORED_THRESHOLD ? 'factored' : 'flat';
  if (nextShown.length) {
    if (nextSelectionMode === 'flat') {
      const isStep = (k) => (k === 0 ? max(N(0), sub(N(1), SN)) : max(N(0), min(sub(N(k + 1), SN), sub(SN, N(k - 1)))));
      for (const i of nextShown) {
        let acc = mul(V(exportProp(0, i)), isStep(0));
        for (let k = 1; k <= steps; k++) acc = add(acc, mul(V(exportProp(k, i)), isStep(k)));
        dDefs.push({ name: nextStateNames[i], ast: acc });
        intProps.set(nextStateNames[i], false);
      }
    } else {
      const B = steps >= 1536 ? 64 : 32;
      const Q = Math.ceil((steps + 1) / B);
      const isAt = (expr, m, hi) => (hi === 0 ? N(1)
        : m === 0 ? max(N(0), sub(N(1), expr))
          : m === hi ? max(N(0), sub(expr, N(m - 1)))
            : max(N(0), min(sub(N(m + 1), expr), sub(expr, N(m - 1)))));
      dDefs.push(
        { name: 'rnq', ast: round('down', div(SN, N(B))) },
        { name: 'rnr', ast: mod(SN, N(B)) },
      );
      intProps.set('rnq', false);
      intProps.set('rnr', false);
      for (let m = 0; m < B; m++) {
        dDefs.push({ name: `rnri${m}`, ast: isAt(V('rnr'), m, B - 1) });
        intProps.set(`rnri${m}`, false);
      }
      for (let qIdx = 0; qIdx < Q; qIdx++) {
        dDefs.push({ name: `rnqi${qIdx}`, ast: isAt(V('rnq'), qIdx, Q - 1) });
        intProps.set(`rnqi${qIdx}`, false);
      }
      for (const i of nextShown) {
        const parts = [];
        for (let qIdx = 0; qIdx < Q; qIdx++) {
          const lo = qIdx * B;
          const hi = Math.min(steps, lo + B - 1);
          let acc = mul(V(exportProp(lo, i)), V('rnri0'));
          for (let k = lo + 1; k <= hi; k++) acc = add(acc, mul(V(exportProp(k, i)), V(`rnri${k - lo}`)));
          const bName = `rnb${i}_${qIdx}`;
          dDefs.push({ name: bName, ast: mul(acc, V(`rnqi${qIdx}`)) });
          intProps.set(bName, false);
          parts.push(V(bName));
        }
        let sum = parts[0];
        for (let j = 1; j < parts.length; j++) sum = add(sum, parts[j]);
        dDefs.push({ name: nextStateNames[i], ast: sum });
        intProps.set(nextStateNames[i], false);
      }
    }
  }

  const domain = { lo: -STORED_LIMIT, hi: STORED_LIMIT };
  const roots = views.map((v) => ({ node: v.node, name: nextViewProp(v.name) }));
  const ntv = translate(roots, (i) => V(nextStateNames[i]), { tempPrefix: 'rnu', inputRange: domain });
  dDefs.push(...ntv.defs);
  for (const t of ntv.temps) intProps.set(t, false);
  for (const v of views) intProps.set(nextViewProp(v.name), true);
  if (ntv.guards.length) {
    dDefs.push(...ntv.guards.map((g, i) => ({ name: `rnvg${i}`, ast: g })));
    ntv.guards.forEach((_, i) => intProps.set(`rnvg${i}`, false));
    dDefs.push({ name: 'rnvf', ast: ntv.guards.length === 1 ? V('rnvg0') : fn('max', ...ntv.guards.map((_, i) => V(`rnvg${i}`))) });
    intProps.set('rnvf', false);
  }
  const baseGo = periodic ? max(stdGo, V('rpcyc')) : stdGo;
  const viewErr = ntv.guards.length ? max(V('rvf'), V('rnvf')) : V('rvf');
  dDefs.push({ name: 'rgo', ast: mul(baseGo, sub(N(1), viewErr)) });
  intProps.set('rgo', true);

  numProps.set('rf', false);
  const uiDefs = views.map((v) => {
    const lp = lerpProp(v.name), vp = viewProp(v.name), nvp = nextViewProp(v.name);
    numProps.set(lp, true);
    return { name: lp, ast: add(V(vp), mul(mul(sub(V(nvp), V(vp)), V('rf')), V('rgo'))) };
  });

  return {
    views: views.map((v) => v.name),
    easing,
    periodic,
    nextShown,
    nextSelectionMode,
    intProps,
    numProps,
    dDefs,
    uiDefs,
  };
}

export function evalDisplay(machine, shown, model = MODELS.exact) {
  const xs = Array.isArray(shown) ? shown : [shown];
  const env = new Map(machine.shown.map((i) => [machine.out.cs[i], model.store(xs[i])]));
  for (const d of machine.display) env.set(d.name, storeInteger(evalAst(d.ast, (k) => env.get(k), model), model));
  return env;
}

const guardName = (i, pfx = '') => `r${pfx}g${i}`;

function guardProps(guards, props, pfx = '') {
  return guards.map((g, i) => {
    const name = guardName(i, pfx);
    props.set(name, false);
    return { name, ast: g };
  });
}

export function declarations(defs, indent = '') {
  return defs.map((d) => `${indent}--${d.name}: ${toCss(d.ast)};`).join('\n');
}

// Evaluate the machine exactly as the CSS cascade would, under a browser arithmetic model.
// Non-inherited registered properties (inherits: false) stay inside the element that defines
// them and do not leak to child <g> blocks or .D. Returns one entry per step 0..steps.
export function simulateMachine(machine, { t = machine.T, model = MODELS.exact, init = machine.init } = {}) {
  const levels = [];
  const stats = { maxInline: 0, maxStored: 0, levels: [] };
  // Unregistered --rS<k> exports are inherited down to .D and never read by .A/.B/.T; keeping
  // them in one accumulator avoids copying O(steps) keys at every block.
  const exported = new Map();
  const inheritedProps = (map) => {
    const next = new Map();
    for (const [k, v] of map) if (machine.props.has(k) ? machine.props.get(k) !== false : false) next.set(k, v);
    return next;
  };
  const evalSlice = (defs, parent, own, overrides) => {
    const env = (name) => (own.has(name) ? own.get(name) : parent.get(name));
    const ls = { maxInline: 0 };
    for (const d of defs) {
      let v;
      if (overrides && overrides.has(d.name)) v = model.store(overrides.get(d.name));
      else v = storeInteger(evalAst(d.ast, env, model, ls), model);
      const m = Math.abs(v);
      if (m > stats.maxStored && /^r(?:\d+)?[xyv]/.test(d.name)) stats.maxStored = m;
      if (d.unregistered) exported.set(d.name, v);
      own.set(d.name, v);
    }
    stats.levels.push(ls);
    if (ls.maxInline > stats.maxInline) stats.maxInline = ls.maxInline;
  };

  const inits = Array.isArray(init) ? init : [init];
  const rootParent = new Map([['rt', t]]);
  const rootOwn = new Map();
  evalSlice(machine.root, rootParent, rootOwn, new Map(machine.initProps.map((p, i) => [p, inits[i]])));
  let currentBlock = new Map([...rootParent, ...rootOwn]);
  levels.push(currentBlock);

  for (let b = 1; b <= machine.blocks; b++) {
    const parent = inheritedProps(currentBlock);
    const cls = levelClass(b, machine);
    const defs = machine.level[cls];
    const slices = machine.blockSlices[cls];
    const own = new Map();
    for (let s = 0; s < slices.length; s++) {
      evalSlice(defs.slice(slices[s].start, slices[s].end), parent, own, null);
    }
    const p = blockParity(b);
    const count = slices.length;
    const base = (b - 1) * machine.stride;
    for (let s = 0; s < count; s++) {
      const k = base + s + 1;
      for (const i of machine.shown) {
        const src = s === count - 1 ? (i === 0 ? 'rx' : xName(i, p)) : subStateName(s, count, i, p);
        exported.set(exportProp(k, i), own.get(src));
      }
    }
    currentBlock = new Map([...parent, ...own]);
    for (let s = 0; s < count; s++) levels.push(currentBlock);
  }

  const dispBase = new Map([...inheritedProps(currentBlock), ...exported]);
  const dispOwn = evalSelectDefs(machine, dispBase, t, model);
  levels[machine.steps] = new Map([...currentBlock, ...exported, ...dispOwn]);
  return { levels, stats, dispBase };
}

function evalSelectDefs(machine, dispBase, t, model) {
  const own = new Map();
  const env = (name) => (name === 'rt' ? t : own.has(name) ? own.get(name) : dispBase.get(name));
  for (const d of machine.select) own.set(d.name, storeInteger(evalAst(d.ast, env, model), model));
  return own;
}

// Re-evaluate only the clock-driven display selection (.D) for another clock value `t` on an
// already-simulated chain (the chain itself never depends on `rt`).
export function simulateSelect(machine, dispBase, t, model = MODELS.exact) {
  return evalSelectDefs(machine, dispBase, t, model);
}

// Evaluate .D and .rr-ui sub-step interpolation at integer clock `t` and fractional progress `rf` in [0, 1].
export function simulateInterpolation(machine, dispBase, { t, rf = 0, model = MODELS.exact } = {}) {
  const interp = machine.interpolation;
  if (!interp) throw new Error('simulateInterpolation requires machine.interpolation');
  const stats = { maxInline: 0 };
  const dOwn = new Map();
  const dEnv = (name) => (name === 'rt' ? t : dOwn.has(name) ? dOwn.get(name) : dispBase.get(name));
  // machine.select and machine.display are already verified over 0..lastValid by verifyRun();
  // track intermediate range on the interpolation declarations themselves.
  for (const d of [...machine.select, ...machine.display]) {
    dOwn.set(d.name, storeInteger(evalAst(d.ast, dEnv, model), model));
  }
  for (const d of interp.dDefs) {
    dOwn.set(d.name, storeInteger(evalAst(d.ast, dEnv, model, stats), model));
  }
  const uiOwn = new Map([['rf', storeNumber(rf, model)]]);
  const uiEnv = (name) => (uiOwn.has(name) ? uiOwn.get(name) : dOwn.has(name) ? dOwn.get(name) : dispBase.get(name));
  for (const d of interp.uiDefs) {
    uiOwn.set(d.name, storeNumber(evalAst(d.ast, uiEnv, model, stats), model));
  }
  return { d: dOwn, ui: uiOwn, stats };
}

export { compileStep };
