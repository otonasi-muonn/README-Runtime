// Build-time proof obligations: the generated CSS must reproduce the real WebAssembly run.
//   1. real Wasm (Node's engine)            -> ground-truth trace
//   2. IR, exact i32 semantics               -> validates the Wasm -> IR lifting
//   3. generated CSS under browser models    -> validates the CSS translation and its range
import { evalExact } from './compiler/ir.js';
import { MODELS, STORED_LIMIT } from './compiler/css.js';
import { simulateMachine, evalDisplay, viewProp } from './runtime/machine.js';
import { referenceTrace, instantiate } from './runtime/reference.js';

export class VerifyError extends Error {
  constructor(message, code = 'INTERNAL') {
    super(message);
    this.code = code;
  }
}

// Firefox computes calc() in float32: integers are exact only up to 2^24.
const INLINE_EXACT = 2 ** 24;

const stateAt = (machine, levels, k) => levels[k].get(k === 0 ? machine.initProp : `rx${k % 2 === 1 ? 'a' : 'b'}`);
const flagAt = (levels, k, f) => levels[k].get(`r${f}${k === 0 ? 'b' : k % 2 === 1 ? 'a' : 'b'}`);

export async function verifyRun(wasmBytes, program, machine, cfg) {
  const trace = await referenceTrace(wasmBytes, {
    exportName: program.exportName, haltExport: program.haltExport, haltValue: machine.haltValue,
    init: machine.init, steps: machine.steps, rangeLimit: STORED_LIMIT,
  });
  const { values, end } = trace;
  if (end.kind === 'range') {
    throw new VerifyError(
      `step ${end.at}: state ${values[end.at]} is outside the CSS-exact range (|x| <= ${STORED_LIMIT.toLocaleString('en-US')}). ` +
      `Chromium keeps only 6 significant digits of computed custom properties, so this value cannot be shown faithfully. ` +
      `Use a smaller "init", fewer "steps", or a halt condition.`, 'RANGE_STATE');
  }
  const lastValid = end.kind === 'trap' ? end.at - 1 : values.length - 1;

  // 2. IR vs real Wasm
  for (let k = 1; k <= Math.min(end.at, machine.steps); k++) {
    const prev = values[k - 1];
    const [next, trapped] = evalExact([program.step, program.trap ?? program.step], [prev]);
    const trapFlag = program.trap ? trapped : 0;
    if (end.kind === 'trap' && k === end.at) {
      if (trapFlag !== 1) throw new VerifyError(`internal: IR misses the trap at step ${k} (input ${prev})`, 'INTERNAL');
      break;
    }
    if (trapFlag !== 0) throw new VerifyError(`internal: IR predicts a trap at step ${k} (input ${prev}) but Wasm returned ${values[k]}`, 'INTERNAL');
    if (next !== values[k]) throw new VerifyError(`internal: IR computes ${next} at step ${k} (input ${prev}) but Wasm returned ${values[k]}`, 'INTERNAL');
  }
  if (program.halt) {
    for (let k = 0; k <= lastValid; k++) {
      const [h] = evalExact([program.halt], [values[k]]);
      const expect = end.kind === 'halt' && k === end.at ? 1 : 0;
      if (h !== expect) throw new VerifyError(`internal: IR halt predicate gives ${h} at step ${k} (expected ${expect})`, 'INTERNAL');
    }
  }

  // 3. CSS under each browser model, full chain
  const models = {};
  const endAt = Math.min(end.at, machine.steps);
  const call = (k) => (k === 0 ? `the initial value ${values[0]}` : `step(${values[k - 1]})`);
  for (const [name, model] of Object.entries(MODELS)) {
    const { levels, stats } = simulateMachine(machine, { model });
    for (let k = 0; k <= lastValid; k++) {
      if (name === 'exact' && stats.levels[k].maxInline > INLINE_EXACT) {
        throw new VerifyError(
          `step ${k}: ${call(k)} needs an intermediate value of ${stats.levels[k].maxInline.toLocaleString('en-US')} inside CSS, ` +
          `beyond 2^24 = 16,777,216: Firefox evaluates calc() in float32, so this cannot be computed exactly in every browser. ` +
          `Keep intermediate values (for example products before a modulo) below 2^23.`, 'RANGE_INTERMEDIATE');
      }
      if (levels[k].get('rrg') !== 0) {
        throw new VerifyError(
          `step ${k}: a value computed by ${call(k)} can leave the range that CSS represents exactly in every browser ` +
          `(stored values |v| <= ${STORED_LIMIT.toLocaleString("en-US")}; intermediate values |v| < 2^24, or < 2^23 for operands of a division); the card would stop here with OUT OF RANGE. ` +
          `CSS evaluates both arms of every conditional, so this includes values on a branch Wasm does not take here. ` +
          `Keep intermediate values smaller, or use fewer "steps" / a halt condition.`, 'RANGE_GUARD');
      }
      const got = stateAt(machine, levels, k);
      if (got !== values[k]) {
        if (name === 'exact') {
          throw new VerifyError(`internal error: the CSS translation computes ${got} for ${call(k)} but WebAssembly computes ${values[k]}. Please report this with the .wasm file.`, 'INTERNAL');
        }
        throw new VerifyError(
          `step ${k}: under the ${name} arithmetic model the CSS computes ${got} for ${call(k)}, but WebAssembly computes ${values[k]} ` +
          `(largest intermediate ${stats.levels[k].maxInline}). The values involved exceed what CSS can represent exactly in that browser.`, 'MODEL_MISMATCH');
      }
    }
    // flags at the end of the run
    if (end.kind === 'halt' && flagAt(levels, endAt, 'h') !== 1) throw new VerifyError(`${name}: halt not detected at step ${endAt}`, 'INTERNAL');
    if (end.kind === 'trap' && flagAt(levels, endAt, 'e') !== 1) throw new VerifyError(`${name}: trap not detected at step ${endAt}`, 'INTERNAL');
    if (end.kind !== 'trap' && flagAt(levels, endAt, 'e') !== 0) throw new VerifyError(`${name}: unexpected error flag at step ${endAt}`, 'INTERNAL');
    // the clock-driven selection shown by the display
    const out = machine.out;
    for (const t of new Set([0, 1, Math.floor(endAt / 2), endAt, machine.T])) {
      const sim = simulateMachine(machine, { model, t });
      const inner = sim.levels[machine.steps];
      const shownStep = Math.min(t, endAt);
      const want = end.kind === 'trap' && shownStep === endAt ? null : values[shownStep];
      if (inner.get(out.s) !== shownStep) throw new VerifyError(`${name}: at t=${t} the display shows step ${inner.get(out.s)}, expected ${shownStep}`, 'INTERNAL');
      if (want !== null && inner.get(out.c) !== want) throw new VerifyError(`${name}: at t=${t} the display shows ${inner.get(out.c)}, expected ${want}`, 'INTERNAL');
    }
    models[name] = { maxInline: stats.maxInline, maxStored: stats.maxStored };
  }
  // 4. view functions: for every state the card shows, the CSS view values equal the real
  //    Wasm view exports under every model, without a range flag
  const viewSamples = [];
  if (program.views?.length) {
    const ex = await instantiate(wasmBytes);
    const seen = new Set();
    for (const x of values.slice(0, lastValid + 1)) {
      if (seen.has(x)) continue;
      seen.add(x);
      const want = Object.fromEntries(program.views.map((v) => [v.name, ex[v.export](x) | 0]));
      for (const [name, model] of Object.entries(MODELS)) {
        const env = evalDisplay(machine, x, model);
        if (env.get('rvf') !== 0) {
          throw new VerifyError(`state ${x}: a view function computes a value outside the range CSS represents exactly (${name} model, 'VIEW_RANGE'); keep view values within ±${STORED_LIMIT.toLocaleString('en-US')}`);
        }
        for (const v of program.views) {
          const got = env.get(viewProp(v.name));
          if (got !== want[v.name]) throw new VerifyError(`state ${x}: view "${v.name}" (${v.export}) is ${want[v.name]} in WebAssembly but ${got} in the generated CSS under the ${name} model`, 'VIEW_MISMATCH');
        }
      }
      viewSamples.push(want);
    }
  }
  return { trace, models, endAt, lastValid, viewSamples };
}
