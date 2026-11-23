// Compile exported WebAssembly functions into IR for the CSS runtime.
import { parseModule, functionType } from '../wasm/reader.js';
import { liftFunction, UnsupportedError } from './lift.js';
import { IR } from './ir.js';

export { UnsupportedError };

export function listExports(mod) {
  return mod.exports.filter((e) => e.kind === 'func').map((e) => {
    const t = functionType(mod, e.index);
    return { name: e.name, index: e.index, params: t.params, results: t.results };
  });
}

function findExport(mod, name, role) {
  const fns = listExports(mod);
  const e = fns.find((x) => x.name === name);
  if (!e) {
    const avail = fns.map((x) => `${x.name}(${x.params.join(', ')}) -> ${x.results.join(', ') || 'void'}`).join(', ') || 'none';
    throw new UnsupportedError(`export "${name}" (${role}) not found. Exported functions: ${avail}`);
  }
  if (e.params.length !== 1 || e.results.length !== 1 || e.params[0] !== 'i32' || e.results[0] !== 'i32') {
    throw new UnsupportedError(`export "${name}" (${role}) must have signature (i32) -> i32, found (${e.params.join(', ')}) -> (${e.results.join(', ')})`);
  }
  return e;
}

// Returns IR roots: step (next state), trap (0/1, or null when step can never trap),
// halt (0/1 predicate from an optional export).
export function compileStep(wasmBytes, { exportName = 'step', haltExport = null, views = [] } = {}) {
  const mod = parseModule(wasmBytes);
  // Structural problems (bad indices, type errors) are reported by the engine's validator
  // rather than surfacing later as confusing internal errors.
  if (!WebAssembly.validate(wasmBytes)) throw new UnsupportedError('the file is not a valid WebAssembly module (WebAssembly.validate failed)');
  const ir = new IR();
  const stepExp = findExport(mod, exportName, 'step function');
  const lifted = liftFunction(mod, stepExp.index, { ir });
  let trap = null;
  for (const t of lifted.traps) trap = trap ? ir.op('lor', trap, t) : t;
  if (trap && trap.op === 'const' && trap.value === 0) trap = null;
  let halt = null;
  if (haltExport) {
    const h = findExport(mod, haltExport, 'halt predicate');
    const lh = liftFunction(mod, h.index, { ir });
    const liveTraps = lh.traps.filter((t) => !(t.op === 'const' && t.value === 0));
    if (liveTraps.length) throw new UnsupportedError(`halt predicate "${haltExport}" may trap; it must be total`);
    halt = ir.bool(lh.results[0]);
  }
  // View functions: (i32) -> i32 exports evaluated on the shown state; their values drive
  // the reused UI. Like the halt predicate they must be total.
  const viewNodes = views.map(({ name, export: exp }) => {
    const e = findExport(mod, exp, `view "${name}"`);
    const lv = liftFunction(mod, e.index, { ir });
    if (lv.traps.some((t) => !(t.op === 'const' && t.value === 0))) throw new UnsupportedError(`view function "${exp}" may trap; it must be total`);
    return { name, export: exp, node: lv.results[0] };
  });
  return { mod, ir, step: lifted.results[0], trap, halt, views: viewNodes, exportName, haltExport };
}
