// Build-time proof obligations: the generated CSS must reproduce the real WebAssembly run.
//   1. real Wasm (Node's engine)            -> ground-truth trace
//   2. IR, exact i32 semantics               -> validates the Wasm -> IR lifting
//   3. generated CSS under browser models    -> validates the CSS translation and its range
import { evalExact } from './compiler/ir.js';
import { MODELS, STORED_LIMIT } from './compiler/css.js';
import { simulateMachine, simulateSelect, evalDisplay, viewProp, stateAt, flagAt, rangeFlagAt } from './runtime/machine.js';
import { referenceTrace, instantiate, stateAbi } from './runtime/reference.js';

export class VerifyError extends Error {
  constructor(message, code = 'INTERNAL') {
    super(message);
    this.code = code;
  }
}

// Firefox computes calc() in float32: integers are exact only up to 2^24.
const INLINE_EXACT = 2 ** 24;

const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

// `init`: the run to verify (an alternative initial value of the card, see altInits): a number,
// or an array of the state's values.
export async function verifyRun(wasmBytes, program, machine, { init = machine.init } = {}) {
  const trace = await referenceTrace(wasmBytes, {
    exportName: program.exportName, haltExport: program.haltExport, haltValue: machine.haltValue,
    init, steps: machine.steps, rangeLimit: STORED_LIMIT, program,
  });
  const { states, end } = trace;
  const K = states[0].length;
  // a state in messages: 27, or (x=3, y=5) for a named state
  const show = (x) => (program.stateNames ? `(${program.stateNames.map((name, i) => `${name}=${x[i]}`).join(', ')})` : String(x[0]));
  if (end.kind === 'range') {
    throw new VerifyError(
      `step ${end.at}: state ${show(states[end.at])} is outside the CSS-exact range (|x| <= ${STORED_LIMIT.toLocaleString('en-US')}${K > 1 ? ' for every value' : ''}). ` +
      `Chromium keeps only 6 significant digits of computed custom properties, so this value cannot be shown faithfully. ` +
      `Use a smaller "init", fewer "steps", or a halt condition.`, 'RANGE_STATE');
  }
  const lastValid = end.kind === 'trap' ? end.at - 1 : states.length - 1;
  const nexts = program.state ? program.state.map((x) => x.node) : [program.step];

  // 2. IR vs real Wasm
  for (let k = 1; k <= Math.min(end.at, machine.steps); k++) {
    const prev = states[k - 1];
    const out = evalExact([...nexts, program.trap ?? nexts[0]], prev);
    const next = out.slice(0, K);
    const trapFlag = program.trap ? out[K] : 0;
    if (end.kind === 'trap' && k === end.at) {
      if (trapFlag !== 1) throw new VerifyError(`internal: IR misses the trap at step ${k} (input ${show(prev)})`, 'INTERNAL');
      break;
    }
    if (trapFlag !== 0) throw new VerifyError(`internal: IR predicts a trap at step ${k} (input ${show(prev)}) but Wasm returned ${show(states[k])}`, 'INTERNAL');
    if (!same(next, states[k])) throw new VerifyError(`internal: IR computes ${show(next)} at step ${k} (input ${show(prev)}) but Wasm returned ${show(states[k])}`, 'INTERNAL');
  }
  if (program.halt) {
    for (let k = 0; k <= lastValid; k++) {
      const [h] = evalExact([program.halt], states[k]);
      const expect = end.kind === 'halt' && k === end.at ? 1 : 0;
      if (h !== expect) throw new VerifyError(`internal: IR halt predicate gives ${h} at step ${k} (expected ${expect})`, 'INTERNAL');
    }
  }

  // 3. CSS under each browser model, full chain (every unrolled step and block boundary)
  const models = {};
  const endAt = Math.min(end.at, machine.steps);
  const call = (k) => (k === 0 ? `the initial value ${show(states[0])}` : `step(${show(states[k - 1])})`);
  const sampleTimes = new Set(
    [0, 1, machine.stride - 1, machine.stride, machine.stride + 1, 31, 32, 33, 63, 64, 65, Math.floor(endAt / 2), endAt, machine.T]
      .filter((t) => t >= 0 && t <= machine.T),
  );
  for (const [name, model] of Object.entries(MODELS)) {
    const { levels, stats, dispBase } = simulateMachine(machine, { model, init });
    for (let k = 0; k <= lastValid; k++) {
      if (name === 'exact' && stats.levels[k].maxInline > INLINE_EXACT) {
        throw new VerifyError(
          `step ${k}: ${call(k)} needs an intermediate value of ${stats.levels[k].maxInline.toLocaleString('en-US')} inside CSS, ` +
          `beyond 2^24 = 16,777,216: Firefox evaluates calc() in float32, so this cannot be computed exactly in every browser. ` +
          `Keep intermediate values (for example products before a modulo) below 2^23.`, 'RANGE_INTERMEDIATE');
      }
      if (rangeFlagAt(machine, levels, k) !== 0) {
        throw new VerifyError(
          `step ${k}: a value computed by ${call(k)} can leave the range that CSS represents exactly in every browser ` +
          `(stored values |v| <= ${STORED_LIMIT.toLocaleString("en-US")}; intermediate values |v| < 2^24, or < 2^23 for operands of a division); the card would stop here with OUT OF RANGE. ` +
          `CSS evaluates both arms of every conditional, so this includes values on a branch Wasm does not take here. ` +
          `Keep intermediate values smaller, or use fewer "steps" / a halt condition.`, 'RANGE_GUARD');
      }
      const got = stateAt(machine, levels, k);
      if (!same(got, states[k])) {
        if (name === 'exact') {
          throw new VerifyError(`internal error: the CSS translation computes ${show(got)} for ${call(k)} but WebAssembly computes ${show(states[k])}. Please report this with the .wasm file.`, 'INTERNAL');
        }
        throw new VerifyError(
          `step ${k}: under the ${name} arithmetic model the CSS computes ${show(got)} for ${call(k)}, but WebAssembly computes ${show(states[k])} ` +
          `(largest intermediate ${stats.levels[k].maxInline}). The values involved exceed what CSS can represent exactly in that browser.`, 'MODEL_MISMATCH');
      }
    }
    // flags at the end of the run
    if (end.kind === 'halt' && flagAt(machine, levels, endAt, 'h') !== 1) throw new VerifyError(`${name}: halt not detected at step ${endAt}`, 'INTERNAL');
    if (end.kind === 'trap' && flagAt(machine, levels, endAt, 'e') !== 1) throw new VerifyError(`${name}: trap not detected at step ${endAt}`, 'INTERNAL');
    if (end.kind !== 'trap' && flagAt(machine, levels, endAt, 'e') !== 0) throw new VerifyError(`${name}: unexpected error flag at step ${endAt}`, 'INTERNAL');
    // the clock-driven selection shown by the display
    const out = machine.out;
    for (const t of sampleTimes) {
      const inner = simulateSelect(machine, dispBase, t, model);
      const shownStep = Math.min(t, endAt);
      const want = end.kind === 'trap' && shownStep === endAt ? null : states[shownStep];
      if (inner.get(out.s) !== shownStep) throw new VerifyError(`${name}: at t=${t} the display shows step ${inner.get(out.s)}, expected ${shownStep}`, 'INTERNAL');
      for (const i of machine.shown) {
        const got = inner.get(out.cs[i]);
        if (want !== null && got !== want[i]) throw new VerifyError(`${name}: at t=${t} the display shows ${got} for value ${program.stateNames?.[i] ?? i} of ${show(want)}`, 'INTERNAL');
      }
      const flags = inner.get(out.f);
      const stopped = shownStep === endAt && end.kind !== 'steps';
      const flagsOk = !stopped ? flags === 0 : end.kind === 'halt' ? flags === 1 : end.kind === 'trap' ? (flags & 4) === 4 : false;
      if (!flagsOk) throw new VerifyError(`${name}: at t=${t} the display shows status flags ${flags} for a run that ${stopped ? `${end.kind}s at step ${endAt}` : `has not stopped by step ${shownStep}`}`, 'INTERNAL');
    }
    models[name] = { maxInline: stats.maxInline, maxStored: stats.maxStored };
  }
  // 4. view functions: for every state the card shows, the CSS view values equal the real
  //    Wasm view exports under every model, without a range flag
  const viewSamples = [];
  if (program.views?.length) {
    const abi = stateAbi(await instantiate(wasmBytes), program);
    const seen = new Set();
    const seenViews = new Set();
    for (const x of states.slice(0, lastValid + 1)) {
      const key = x.join(',');
      if (seen.has(key)) continue;
      seen.add(key);
      const want = Object.fromEntries(program.views.map((v) => [v.name, abi.read(v.export, x)]));
      for (const [name, model] of Object.entries(MODELS)) {
        const env = evalDisplay(machine, x, model);
        if (env.get('rvf') !== 0) {
          throw new VerifyError(`state ${show(x)}: a view function computes a value outside the range CSS represents exactly (${name} model, 'VIEW_RANGE'); keep view values within ±${STORED_LIMIT.toLocaleString('en-US')}`, 'VIEW_RANGE');
        }
        for (const v of program.views) {
          const got = env.get(viewProp(v.name));
          if (got !== want[v.name]) throw new VerifyError(`state ${show(x)}: view "${v.name}" (${v.export}) is ${want[v.name]} in WebAssembly but ${got} in the generated CSS under the ${name} model`, 'VIEW_MISMATCH');
        }
      }
      const vKey = JSON.stringify(want);
      if (!seenViews.has(vKey)) { seenViews.add(vKey); viewSamples.push(want); }
    }
  }
  return { trace, models, endAt, lastValid, viewSamples };
}
