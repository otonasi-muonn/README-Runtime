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

// x0, step(x0), step(step(x0)), ... until `steps`, a halt, a trap, or a value outside the
// CSS-exact range. Each entry is a plain signed i32.
export async function referenceTrace(wasmBytes, { exportName = 'step', haltExport = null, haltValue = null, init, steps, rangeLimit }) {
  const ex = await instantiate(wasmBytes);
  const step = ex[exportName];
  const halt = haltExport ? ex[haltExport] : null;
  const isHalt = (x) => (halt ? halt(x) !== 0 : haltValue !== null && x === haltValue);
  const values = [init | 0];
  let end = { kind: 'steps', at: steps };
  const outOfRange = (x) => rangeLimit !== undefined && Math.abs(x) > rangeLimit;
  if (outOfRange(values[0])) end = { kind: 'range', at: 0 };
  else if (isHalt(values[0])) end = { kind: 'halt', at: 0 };
  else {
    for (let k = 1; k <= steps; k++) {
      let x;
      try {
        x = step(values[k - 1]) | 0;
      } catch (e) {
        if (e instanceof WebAssembly.RuntimeError) { end = { kind: 'trap', at: k, message: e.message }; break; }
        throw e;
      }
      values.push(x);
      if (outOfRange(x)) { end = { kind: 'range', at: k }; break; }
      if (isHalt(x)) { end = { kind: 'halt', at: k }; break; }
    }
  }
  return { values, end };
}
