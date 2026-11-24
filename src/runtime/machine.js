// The CSS "machine": how the compiled step() is chained across nested SVG levels.
//
// Level k (k >= 1) is a <g> nested inside level k-1. CSS custom properties cannot refer to
// themselves, so carried values alternate between two names by depth parity: a level of
// class A reads the *_b values its parent computed and writes *_a, class B does the
// opposite. Every value is a registered <integer> property, so the browser evaluates each
// level to a plain number before the next level reads it.

import { compileStep } from '../compiler/program.js';
import { MODELS, N, V, absV, add, clamp, evalAst, fn, max, min, mul, storeInteger, sub, toCss, translate, STORED_LIMIT } from '../compiler/css.js';
import { analyzeRanges } from '../compiler/range.js';

export const MAX_STEPS = 400; // WebKit stops resolving styles beyond ~510 nested levels (measured)

const P = { A: 'a', B: 'b' };
const other = (p) => (p === 'A' ? 'B' : 'A');

// Carried per-level values (each exists as --r<x>a and --r<x>b).
//   x state | k depth | h halted | e error | f flags of the step where the run stopped
//   q halt step | z last step of the run (levels after a halt or an error are not run)
// None of them depends on the clock: the chain is computed once, when the card is first
// styled, and the clock only drives the display (see `select`), so a tick restyles the
// display and nothing above it.
const CARRIED = ['x', 'k', 'h', 'e', 'f', 'q', 'z'];
const n = (name, parity) => `r${name}${P[parity]}`;
// Each level also exports its state under a name of its own (an unregistered property set in
// the level's style attribute), which the display selects by the clock.
export const exportProp = (k) => `rS${k}`;
export const levelStyle = (k) => `--${exportProp(k)}:var(--rx)`;

export function buildMachine(program, { init, steps, hold = 0, haltValue = null }) {
  if (!Number.isInteger(init)) throw new RangeError('init must be an integer');
  if (!Number.isInteger(steps) || steps < 1 || steps > MAX_STEPS) throw new RangeError(`steps must be an integer between 1 and ${MAX_STEPS}`);
  const T = steps + hold;
  const props = new Map(); // name -> inherits
  for (const c of CARRIED) for (const p of ['A', 'B']) props.set(n(c, p), true);
  for (const u of ['rx', 'rk', 'ra', 'rt']) props.set(u, true);

  const level = { A: [], B: [] };
  const usesTrap = program.trap !== null;
  const haltKind = program.halt ? 'export' : haltValue !== null ? 'value' : 'none';
  // Every state the machine accepts lies in [-STORED_LIMIT, STORED_LIMIT] (larger states
  // raise the range flag), so this is the input domain for the guard analysis.
  const domain = { lo: -STORED_LIMIT, hi: STORED_LIMIT };
  const stateGuard = (x) => clamp(N(0), sub(absV(x), N(STORED_LIMIT)), N(1));
  const haltValueFlag = (x) => sub(N(1), clamp(N(0), absV(sub(x, N(haltValue))), N(1)));
  const guardCount = { step: 0, halt: 0 };

  for (const p of ['A', 'B']) {
    const q = other(p);
    const out = level[p];
    const X = V(n('x', q));
    // step(): new state (+ shared temporaries) from the parent's state.
    const roots = [{ node: program.step, name: n('x', p) }];
    if (usesTrap) roots.push({ node: program.trap, name: 'rtr' });
    const st = translate(roots, () => X, { tempPrefix: 'rv', inputRange: domain, checkedRoots: new Set([n('x', p), 'rtr']) });
    out.push(...st.defs);
    for (const t of st.temps) props.set(t, false);
    if (usesTrap) props.set('rtr', false);
    guardCount.step = st.guards.length;
    const xNew = V(n('x', p));
    out.push({ name: n('k', p), ast: add(V(n('k', q)), N(1)) });
    out.push({ name: 'rlv', ast: sub(N(1), max(V(n('h', q)), V(n('e', q)))) });
    // halt predicate on the new state
    let hz;
    let haltGuards = [];
    if (haltKind === 'export') {
      const hs = translate([{ node: program.halt, name: 'rhz' }], () => xNew, { tempPrefix: 'rw', inputRange: domain, checkedRoots: new Set(['rhz']) });
      out.push(...hs.defs);
      for (const t of hs.temps) props.set(t, false);
      haltGuards = hs.guards;
      guardCount.halt = hs.guards.length;
      hz = V('rhz');
    } else if (haltKind === 'value') {
      out.push({ name: 'rhz', ast: haltValueFlag(xNew) });
      hz = V('rhz');
    } else hz = N(0);
    if (haltKind !== 'none') props.set('rhz', false);
    // range flag: the new state, and every value inside step()/halt() that could be inexact
    // Each guard is its own registered property: an inf/NaN in one guard (float32 overflow
    // downstream of a value that already left the range) then becomes 0 only there, instead
    // of turning the whole max() into NaN -> 0 and silencing the guard that did fire.
    out.push(...guardProps([...st.guards, ...haltGuards], props));
    const flags = [stateGuard(xNew), ...[...st.guards, ...haltGuards].map((_, i) => V(guardName(i)))];
    out.push({ name: 'rrg', ast: flags.length === 1 ? flags[0] : fn('max', ...flags) });
    const err = usesTrap ? max(V('rtr'), V('rrg')) : V('rrg');
    const live = V('rlv');
    out.push({ name: n('e', p), ast: max(V(n('e', q)), mul(live, err)) });
    out.push({ name: n('h', p), ast: max(V(n('h', q)), mul(live, hz)) });
    // flags of this step: halted + 2*out-of-range + 4*trap. Only the step where the run stops
    // has any, and later levels are not live, so the sum is the flags of that step.
    const stepFlags = add(add(hz, mul(N(2), V('rrg'))), usesTrap ? mul(N(4), V('rtr')) : N(0));
    out.push({ name: n('f', p), ast: add(V(n('f', q)), mul(live, stepFlags)) });
    out.push({ name: n('q', p), ast: add(V(n('q', q)), mul(mul(live, hz), V(n('k', p)))) });
    out.push({ name: n('z', p), ast: add(V(n('z', q)), live) });
    // trace column of this step (shown once the clock reaches it): run, and the value is valid
    out.push({ name: 'rx', ast: xNew }, { name: 'rk', ast: V(n('k', p)) }, { name: 'ra', ast: mul(live, sub(N(1), err)) });
    props.set('rlv', false); props.set('rrg', false);
  }

  // Root = level 0, parity B (so level 1 is class A).
  const root = [];
  const X0 = V(n('x', 'B'));
  root.push({ name: n('x', 'B'), ast: N(init), literal: true });
  root.push({ name: n('k', 'B'), ast: N(0) });
  let hz0 = N(0);
  let haltGuards0 = [];
  if (haltKind === 'export') {
    const hs = translate([{ node: program.halt, name: 'rhz' }], () => X0, { tempPrefix: 'rw', inputRange: domain, checkedRoots: new Set(['rhz']) });
    root.push(...hs.defs);
    haltGuards0 = hs.guards;
    hz0 = V('rhz');
  } else if (haltKind === 'value') {
    root.push({ name: 'rhz', ast: haltValueFlag(X0) });
    hz0 = V('rhz');
  }
  root.push(...guardProps(haltGuards0, props));
  const flags0 = [stateGuard(X0), ...haltGuards0.map((_, i) => V(guardName(i)))];
  root.push({ name: 'rrg', ast: flags0.length === 1 ? flags0[0] : fn('max', ...flags0) });
  root.push({ name: n('h', 'B'), ast: hz0 });
  root.push({ name: n('e', 'B'), ast: V('rrg') });
  root.push({ name: n('f', 'B'), ast: add(hz0, mul(N(2), V('rrg'))) });
  root.push({ name: n('q', 'B'), ast: N(0) });
  root.push({ name: n('z', 'B'), ast: N(0) });
  root.push({ name: 'rx', ast: X0 }, { name: 'rk', ast: N(0) }, { name: 'ra', ast: sub(N(1), V('rrg')) });
  // the root exports its state like the levels do, from its rule (its style attribute is the input)
  root.push({ name: exportProp(0), ast: V('rx'), unregistered: true });

  const innermost = steps % 2 === 1 ? 'A' : 'B';
  // The clock: the display (innermost) shows step min(t, z) of the run. Its state is picked
  // from the exports of all levels, a sum in which exactly one term is non-zero.
  const S = V('rsx');
  const Z = V(n('z', innermost));
  const isStep = (k) => (k === 0 ? max(N(0), sub(N(1), S)) : max(N(0), min(sub(N(k + 1), S), sub(S, N(k - 1)))));
  let shown = mul(V(exportProp(0)), isStep(0));
  for (let k = 1; k <= steps; k++) shown = add(shown, mul(V(exportProp(k)), isStep(k)));
  const select = [
    { name: 'rsx', ast: min(V('rt'), Z) },
    { name: 'rcs', ast: shown },
    // the flags of the step the run stopped at, once that step is shown
    { name: 'rfs', ast: mul(V(n('f', innermost)), clamp(N(0), add(sub(S, Z), N(1)), N(1))) },
  ];
  for (const s of select) props.set(s.name, true);
  // names readable by the display at the innermost level
  const out = { c: 'rcs', s: 'rsx', f: 'rfs', q: n('q', innermost), h: n('h', innermost), e: n('e', innermost) };

  // View functions run once, on the shown state, where the display lives. Their values are
  // inherited registered properties, so the reused UI markup below can read them.
  const display = [];
  const viewProps = {};
  const viewRanges = {};
  if (program.views?.length) {
    const roots = program.views.map((v) => ({ node: v.node, name: viewProp(v.name) }));
    const tv = translate(roots, () => V(out.c), { tempPrefix: 'ru', inputRange: domain });
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
  return {
    props, root, level, steps, T, hold, init, haltKind, haltValue, guardCount,
    out, select, display, viewProps, viewRanges,
    initProp: n('x', 'B'),
  };
}

export const viewProp = (name) => `rview_${name}`;

// Evaluate the display definitions (view functions) for one shown state under a model.
export function evalDisplay(machine, shown, model = MODELS.exact) {
  const env = new Map([[machine.out.c, model.store(shown)]]);
  for (const d of machine.display) env.set(d.name, storeInteger(evalAst(d.ast, (k) => env.get(k), model), model));
  return env;
}

const guardName = (i) => `rg${i}`;

function guardProps(guards, props) {
  return guards.map((g, i) => {
    props.set(guardName(i), false);
    return { name: guardName(i), ast: g };
  });
}

// CSS declarations for one list of definitions.
export function declarations(defs, indent = '') {
  return defs.map((d) => `${indent}--${d.name}: ${toCss(d.ast)};`).join('\n');
}

// Evaluate the machine exactly as the cascade would, under a browser arithmetic model.
// Returns per-level stored values.
export function simulateMachine(machine, { t = machine.T, model = MODELS.exact, init = machine.init } = {}) {
  const levels = [];
  const stats = { maxInline: 0, maxStored: 0, levels: [] };
  let parent = new Map([['rt', t]]);
  const run = (defs, overrides) => {
    const own = new Map();
    const env = (name) => (own.has(name) ? own.get(name) : parent.get(name));
    const ls = { maxInline: 0 };
    for (const d of defs) {
      let v;
      if (overrides && overrides.has(d.name)) v = model.store(overrides.get(d.name));
      else v = storeInteger(evalAst(d.ast, env, model, ls), model);
      const m = Math.abs(v);
      if (m > stats.maxStored && /^r[xv]/.test(d.name)) stats.maxStored = m;
      own.set(d.name, v);
    }
    stats.levels.push(ls);
    if (ls.maxInline > stats.maxInline) stats.maxInline = ls.maxInline;
    const merged = new Map(parent);
    for (const [k, v] of own) merged.set(k, v);
    return merged;
  };
  parent = run(machine.root, new Map([[machine.initProp, init]]));
  levels.push(parent);
  for (let k = 1; k <= machine.steps; k++) {
    parent = run(machine.level[k % 2 === 1 ? 'A' : 'B']);
    // the level's style attribute: an unregistered copy of its (already stored) state
    parent.set(exportProp(k), parent.get('rx'));
    levels.push(parent);
  }
  // the display: the clock and what it selects, merged into the innermost level
  const shown = run(machine.select);
  levels[machine.steps] = shown;
  stats.levels.pop();
  return { levels, stats };
}

export { compileStep };
