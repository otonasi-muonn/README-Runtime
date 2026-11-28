// Compile exported WebAssembly functions into IR for the CSS runtime.
import { parseModule, functionType } from '../wasm/reader.js';
import { liftFunction, UnsupportedError } from './lift.js';
import { IR } from './ir.js';

export { UnsupportedError };

// Most values a state may have: each one is carried through every level and selected by the
// display on every step (see runtime/machine.js), so the cost grows with it.
export const MAX_STATE = 8;

export function listExports(mod) {
  return mod.exports.filter((e) => e.kind === 'func').map((e) => {
    const t = functionType(mod, e.index);
    return { name: e.name, index: e.index, params: t.params, results: t.results };
  });
}

const sig = (e) => `(${e.params.join(', ')}) -> (${e.results.join(', ')})`;
const i32s = (n) => `(${Array(n).fill('i32').join(', ')}) -> i32`;

function findFunc(mod, name, role) {
  const fns = listExports(mod);
  const e = fns.find((x) => x.name === name);
  if (!e) {
    const avail = fns.map((x) => `${x.name}(${x.params.join(', ')}) -> ${x.results.join(', ') || 'void'}`).join(', ') || 'none';
    throw new UnsupportedError(`export "${name}" (${role}) not found. Exported functions: ${avail}`);
  }
  return e;
}

// An export returning one i32 from `arities` i32 parameters (one of them).
function findExport(mod, name, role, arities = [1]) {
  const e = findFunc(mod, name, role);
  if (!arities.includes(e.params.length) || e.results.length !== 1 || e.results[0] !== 'i32' || e.params.some((p) => p !== 'i32')) {
    throw new UnsupportedError(`export "${name}" (${role}) must have signature ${arities.map(i32s).join(' or ')}, found ${sig(e)}`);
  }
  return e;
}

// The exported mutable i32 globals a step(): void updates, by state name: Map(global index -> input index).
function stateGlobalsOf(mod, names) {
  const exported = mod.exports.filter((e) => e.kind === 'global');
  const map = new Map();
  names.forEach((name, i) => {
    const e = exported.find((x) => x.name === name);
    const g = e && mod.globals[e.index];
    const avail = exported.map((x) => x.name).join(', ') || 'none';
    if (!g) throw new UnsupportedError(`state value "${name}" is not an exported global of the module (exported globals: ${avail}); with a step(): void, every key of "init" names an exported mutable i32 global`);
    if (g.type !== 'i32' || !g.mutable || g.imported) throw new UnsupportedError(`state value "${name}" must be a mutable i32 global defined by the module (it is ${g.imported ? 'imported' : `${g.mutable ? 'mutable' : 'immutable'} ${g.type}`})`);
    if (map.has(e.index)) throw new UnsupportedError(`state values "${names[map.get(e.index)]}" and "${name}" are the same global`);
    map.set(e.index, i);
  });
  return map;
}

// Returns IR roots: step (next state), trap (0/1, or null when step can never trap),
// halt (0/1 predicate from an optional export).
//
// state: null for the original ABI (one unnamed i32, step: (i32) -> i32), or the names of the
// state values in order (the keys of "init"). The state is then K i32 values, and
//   - exportName { name: export }: one pure step function per value (the "functions" ABI), each
//     (i32 × K) -> i32 taking the whole state in this order. All of them read the state before
//     the step; the new values are committed together.
//   - exportName "step" of type () -> (): it updates exported mutable i32 globals with these
//     names (the "globals" ABI). For K = 1, an (i32) -> i32 export is the functions ABI.
// halt and view exports take the state the same way: (i32 × K) -> i32 in this order, or, with
// the globals ABI, () -> i32 reading the globals.
// `state` lists the next value of each state value (state[0].node is `step`).
export function compileStep(wasmBytes, { exportName = 'step', haltExport = null, views = [], state = null } = {}) {
  const mod = parseModule(wasmBytes);
  // Structural problems (bad indices, type errors) are reported by the engine's validator
  // rather than surfacing later as confusing internal errors.
  if (!WebAssembly.validate(wasmBytes)) throw new UnsupportedError('the file is not a valid WebAssembly module (WebAssembly.validate failed)');
  const ir = new IR();
  const names = state ?? [null];
  const K = names.length;
  if (state !== null && (!Array.isArray(state) || !K || K > MAX_STATE)) throw new UnsupportedError(`a state has 1 to ${MAX_STATE} values, got ${state.length}`);
  let abi, next, stepTraps, stateGlobals = null;
  if (state === null) {
    abi = 'single';
    const lifted = liftFunction(mod, findExport(mod, exportName, 'step function').index, { ir });
    next = [lifted.results[0]];
    stepTraps = lifted.traps;
  } else if (exportName && typeof exportName === 'object') {
    abi = 'functions';
    const keys = Object.keys(exportName);
    if (keys.length !== K || !names.every((n) => Object.hasOwn(exportName, n))) {
      throw new UnsupportedError(`"export" must name one step function per state value (${names.join(', ')}); got ${keys.join(', ') || 'none'}`);
    }
    next = [];
    stepTraps = [];
    for (const name of names) {
      const lifted = liftFunction(mod, findExport(mod, exportName[name], `step function of "${name}"`, [K]).index, { ir });
      next.push(lifted.results[0]);
      stepTraps.push(...lifted.traps);
    }
  } else {
    const e = findFunc(mod, exportName, 'step function');
    if (!e.params.length && !e.results.length) {
      abi = 'globals';
      stateGlobals = stateGlobalsOf(mod, names);
      const lifted = liftFunction(mod, e.index, { ir, stateGlobals, writable: true });
      next = lifted.globals;
      stepTraps = lifted.traps;
    } else if (K === 1) {
      abi = 'functions';
      const lifted = liftFunction(mod, findExport(mod, exportName, 'step function').index, { ir });
      next = [lifted.results[0]];
      stepTraps = lifted.traps;
    } else {
      throw new UnsupportedError(`export "${exportName}" (step function) has signature ${sig(e)}; a state of ${K} values (${names.join(', ')}) needs either a step(): void that updates exported globals of these names, or one step function per value ("export": {${names.map((n) => `"${n}": "step_${n}"`).join(', ')}}), each ${i32s(K)}`);
    }
  }
  let trap = null;
  for (const t of stepTraps) trap = trap ? ir.op('lor', trap, t) : t;
  if (trap && trap.op === 'const' && trap.value === 0) trap = null;
  // halt and views read the state like step does, and may not change it
  const arities = abi === 'globals' ? [0, K] : [K];
  const liftReader = (exp, role) => liftFunction(mod, findExport(mod, exp, role, arities).index, { ir, stateGlobals });
  let halt = null;
  if (haltExport) {
    const lh = liftReader(haltExport, 'halt predicate');
    const liveTraps = lh.traps.filter((t) => !(t.op === 'const' && t.value === 0));
    if (liveTraps.length) throw new UnsupportedError(`halt predicate "${haltExport}" may trap; it must be total`);
    halt = ir.bool(lh.results[0]);
  }
  // View functions: exports evaluated on the shown state; their values drive the reused UI.
  // Like the halt predicate they must be total.
  const viewNodes = views.map(({ name, export: exp }) => {
    const lv = liftReader(exp, `view "${name}"`);
    if (lv.traps.some((t) => !(t.op === 'const' && t.value === 0))) throw new UnsupportedError(`view function "${exp}" may trap; it must be total`);
    return { name, export: exp, node: lv.results[0] };
  });
  return {
    mod, ir, abi, stateNames: state,
    state: next.map((node, i) => ({ name: names[i], node })),
    step: next[0], trap, halt, views: viewNodes, exportName, haltExport,
  };
}

// What an export can be, for analyze and inspect: the step function of one integer
// ((i32) -> i32), a step(): void over the module's exported mutable i32 globals (as a state of
// those values, in export order), or the step function of one value of a state of K values
// ((i32 × K) -> i32). Returns { supported, abi, state?, error? }.
export function probeStep(wasmBytes, name) {
  let error;
  try { compileStep(wasmBytes, { exportName: name }); return { supported: true, abi: 'single' }; } catch (e) { error = e; }
  const mod = parseModule(wasmBytes);
  const f = listExports(mod).find((x) => x.name === name);
  const tryState = (abi, exportName, state) => {
    try { compileStep(wasmBytes, { exportName, state }); return { supported: true, abi, state }; } catch (e) { return { supported: false, abi, state, error: e }; }
  };
  if (f && !f.params.length && !f.results.length) {
    const globals = mod.exports.filter((e) => { const g = e.kind === 'global' && mod.globals[e.index]; return g && g.mutable && g.type === 'i32' && !g.imported; }).map((e) => e.name);
    if (globals.length && globals.length <= MAX_STATE) return tryState('globals', name, globals);
  }
  if (f && f.params.length >= 2 && f.params.length <= MAX_STATE && f.results.length === 1 && [...f.params, ...f.results].every((t) => t === 'i32')) {
    const names = f.params.map((_, i) => `v${i}`);
    const r = tryState('functions', Object.fromEntries(names.map((n) => [n, name])), names);
    return { ...r, state: undefined, values: names.length };
  }
  return { supported: false, error };
}
