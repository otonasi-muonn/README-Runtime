// Build-time proof obligations: the generated CSS must reproduce the real WebAssembly run.
//   1. real Wasm (Node's engine)            -> ground-truth trace
//   2. IR, exact i32 semantics               -> validates the Wasm -> IR lifting
//   3. generated CSS under browser models    -> validates the CSS translation and its range
import { evalExact } from './compiler/ir.js';
import { MODELS, STORED_LIMIT } from './compiler/css.js';
import { simulateMachine } from './runtime/machine.js';
import { referenceTrace } from './runtime/reference.js';

export class VerifyError extends Error {}

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
      `Use a smaller "init", fewer "steps", or a halt condition.`);
  }
  const lastValid = end.kind === 'trap' ? end.at - 1 : values.length - 1;

  // 2. IR vs real Wasm
  for (let k = 1; k <= Math.min(end.at, machine.steps); k++) {
    const prev = values[k - 1];
    const [next, trapped] = evalExact([program.step, program.trap ?? program.step], [prev]);
    const trapFlag = program.trap ? trapped : 0;
    if (end.kind === 'trap' && k === end.at) {
      if (trapFlag !== 1) throw new VerifyError(`internal: IR misses the trap at step ${k} (input ${prev})`);
      break;
    }
    if (trapFlag !== 0) throw new VerifyError(`internal: IR predicts a trap at step ${k} (input ${prev}) but Wasm returned ${values[k]}`);
    if (next !== values[k]) throw new VerifyError(`internal: IR computes ${next} at step ${k} (input ${prev}) but Wasm returned ${values[k]}`);
  }
  if (program.halt) {
    for (let k = 0; k <= lastValid; k++) {
      const [h] = evalExact([program.halt], [values[k]]);
      const expect = end.kind === 'halt' && k === end.at ? 1 : 0;
      if (h !== expect) throw new VerifyError(`internal: IR halt predicate gives ${h} at step ${k} (expected ${expect})`);
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
          `Keep intermediate values (for example products before a modulo) below 2^23.`);
      }
      if (levels[k].get('rrg') !== 0) {
        throw new VerifyError(
          `step ${k}: a value computed by ${call(k)} can leave the range that CSS represents exactly in every browser ` +
          `(stored values |v| <= ${STORED_LIMIT.toLocaleString('en-US')}, intermediate values |v| < 2^23); the card would stop here with OUT OF RANGE. ` +
          `Keep intermediate values smaller, or use fewer "steps" / a halt condition.`);
      }
      const got = stateAt(machine, levels, k);
      if (got !== values[k]) {
        if (name === 'exact') {
          throw new VerifyError(`internal error: the CSS translation computes ${got} for ${call(k)} but WebAssembly computes ${values[k]}. Please report this with the .wasm file.`);
        }
        throw new VerifyError(
          `step ${k}: under the ${name} arithmetic model the CSS computes ${got} for ${call(k)}, but WebAssembly computes ${values[k]} ` +
          `(largest intermediate ${stats.levels[k].maxInline}). The values involved exceed what CSS can represent exactly in that browser.`);
      }
    }
    // flags at the end of the run
    if (end.kind === 'halt' && flagAt(levels, endAt, 'h') !== 1) throw new VerifyError(`${name}: halt not detected at step ${endAt}`);
    if (end.kind === 'trap' && flagAt(levels, endAt, 'e') !== 1) throw new VerifyError(`${name}: trap not detected at step ${endAt}`);
    if (end.kind !== 'trap' && flagAt(levels, endAt, 'e') !== 0) throw new VerifyError(`${name}: unexpected error flag at step ${endAt}`);
    // the clock-driven selection shown by the display
    const out = machine.out;
    for (const t of new Set([0, 1, Math.floor(endAt / 2), endAt, machine.T])) {
      const sim = simulateMachine(machine, { model, t });
      const inner = sim.levels[machine.steps];
      const shownStep = Math.min(t, endAt);
      const want = end.kind === 'trap' && shownStep === endAt ? null : values[shownStep];
      if (inner.get(out.s) !== shownStep) throw new VerifyError(`${name}: at t=${t} the display shows step ${inner.get(out.s)}, expected ${shownStep}`);
      if (want !== null && inner.get(out.c) !== want) throw new VerifyError(`${name}: at t=${t} the display shows ${inner.get(out.c)}, expected ${want}`);
    }
    models[name] = { maxInline: stats.maxInline, maxStored: stats.maxStored };
  }
  return { trace, models, endAt, lastValid };
}
