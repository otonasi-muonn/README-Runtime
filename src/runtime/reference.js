// Run the real WebAssembly module (Node's engine) to get the ground-truth trace.

function stubImports(module) {
  const imports = {};
  for (const imp of WebAssembly.Module.imports(module)) {
    imports[imp.module] ??= {};
    let v;
    switch (imp.kind) {
      case 'function': v = () => { throw new Error(`imported function ${imp.module}.${imp.name} called during reference run`); }; break;
      case 'memory': v = new WebAssembly.Memory({ initial: 1, maximum: 65536 }); break;
      case 'table': v = new WebAssembly.Table({ initial: 0, element: 'anyfunc' }); break;
      case 'global': v = new WebAssembly.Global({ value: 'i32', mutable: false }, 0); break;
      default: v = undefined;
    }
    imports[imp.module][imp.name] = v;
  }
  return imports;
}

export async function instantiate(wasmBytes) {
  const module = await WebAssembly.compile(wasmBytes);
  const instance = await WebAssembly.instantiate(module, stubImports(module));
  return instance.exports;
}

// How the module takes and returns its state (see compiler/program.js), on the real engine.
// A state is an array of K i32 values. step(x) returns the next state; read(fn, x) calls a
// halt or view export on x.
//   abi "single" / "functions": next[i] = step_i(...x), every function on the same x
//   abi "globals": the state globals are set to x, step() runs, the globals are the next state
export function stateAbi(ex, { abi = 'single', stateNames = null, exportName = 'step' } = {}) {
  if (abi === 'globals') {
    const set = (x) => stateNames.forEach((n, i) => { ex[n].value = x[i]; });
    return {
      step: (x) => { set(x); ex[exportName](); return stateNames.map((n) => ex[n].value | 0); },
      read: (fn, x) => { set(x); return ex[fn](...x.slice(0, ex[fn].length)) | 0; },
    };
  }
  const fns = typeof exportName === 'string' ? [exportName] : stateNames.map((n) => exportName[n]);
  return {
    step: (x) => fns.map((f) => ex[f](...x) | 0),
    read: (fn, x) => ex[fn](...x) | 0,
  };
}

// x0, step(x0), step(step(x0)), ... until `steps`, a halt, a trap, or a value outside the
// CSS-exact range. `states` holds each state as an array of its values; `values` is the same
// trace for the original ABI (one plain signed i32 per step), or `states` for a named state.
// `cycle` is `{ start, period }` when the run (or one lookahead step at `steps`) revisits an
// earlier valid state `states[start]`, or `null` otherwise.
export async function referenceTrace(wasmBytes, { exportName = 'step', haltExport = null, haltValue = null, init, steps, rangeLimit, program = null }) {
  const ex = await instantiate(wasmBytes);
  const abi = stateAbi(ex, program ?? { exportName });
  const isHalt = (x) => (haltExport ? abi.read(haltExport, x) !== 0 : haltValue !== null && x.length === 1 && x[0] === haltValue);
  const x0 = (Array.isArray(init) ? init : [init]).map((v) => v | 0);
  const states = [x0];
  let end = { kind: 'steps', at: steps };
  let cycle = null;
  const firstSeen = new Map();
  const outOfRange = (x) => rangeLimit !== undefined && x.some((v) => Math.abs(v) > rangeLimit);
  if (outOfRange(x0)) end = { kind: 'range', at: 0 };
  else if (isHalt(x0)) end = { kind: 'halt', at: 0 };
  else {
    firstSeen.set(x0.join(','), 0);
    for (let k = 1; k <= steps; k++) {
      let x;
      try {
        x = abi.step(states[k - 1]);
      } catch (e) {
        if (e instanceof WebAssembly.RuntimeError) { end = { kind: 'trap', at: k, message: e.message }; break; }
        throw e;
      }
      states.push(x);
      if (outOfRange(x)) { end = { kind: 'range', at: k }; break; }
      const key = x.join(',');
      if (cycle === null) {
        if (firstSeen.has(key)) cycle = { start: firstSeen.get(key), period: k - firstSeen.get(key) };
        else firstSeen.set(key, k);
      }
      if (isHalt(x)) { end = { kind: 'halt', at: k }; break; }
    }
    // Look ahead one step when the run did not stop early: a card configured with steps = P - 1
    // and hold = 0 wraps seamlessly from states[steps] back to states[0] on an infinite clock.
    if (end.kind === 'steps' && cycle === null) {
      try {
        const next = abi.step(states[steps]);
        if (!outOfRange(next)) {
          const key = next.join(',');
          if (firstSeen.has(key)) {
            const start = firstSeen.get(key);
            cycle = { start, period: steps + 1 - start };
          }
        }
      } catch (e) {
        if (!(e instanceof WebAssembly.RuntimeError)) throw e;
      }
    }
  }
  const named = program?.stateNames != null;
  return { values: named ? states : states.map((x) => x[0]), states, end, cycle };
}
