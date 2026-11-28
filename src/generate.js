// .wasm bytes + options -> verified SVG card.
import crypto from 'node:crypto';
import { compileStep, MAX_STATE } from './compiler/program.js';
import { toCss, textDepth, MAX_DECL_DEPTH, STORED_LIMIT } from './compiler/css.js';
import { buildMachine, MAX_STEPS, altInitId } from './runtime/machine.js';
import { renderCard } from './render/card.js';
import { renderUiCard } from './render/ui-card.js';
import { checkWellFormed } from './render/xml.js';
import { verifyRun } from './verify.js';
import { TOOL_VERSION } from './version.js';
import { perfReport, resolveLoops } from './perf.js';

export const DEFAULTS = { export: 'step', steps: 120, hold: 12, stepMs: 150, bits: 20, loops: 'auto', altInits: [] };
export const MAX_ALT_INITS = 16;

export class OptionError extends Error {}

export function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

const isInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const LIMIT = STORED_LIMIT.toLocaleString('en-US');

// The state of a card: one integer ("init": 27, step: (i32) -> i32), or named values in the
// order "state" lists them ("state": ["x", "y"], "init": {"x": 3, "y": 5}; see
// compiler/program.js for how the module takes them). The order is the parameter order of the
// step, view and halt functions and of the URL fragments, so it is an array: tools that sort
// the keys of JSON objects cannot change it. Returns the names (null for one integer), and
// init and altInits as numbers (one integer) or arrays of the values in that order.
export function stateOptions(o) {
  const hasState = o.state !== undefined && o.state !== null;
  if (!isObject(o.init) && !hasState) {
    if (!Number.isInteger(o.init)) throw new OptionError('"init" (the initial state) must be an integer, or an object of named integers for a state of several values (e.g. {"x": 3, "y": 5})');
    if (isObject(o.export)) throw new OptionError(`"export" names one step function per state value (${Object.keys(o.export).join(', ')}): give their order in "state" and "init" as an object, e.g. "state": [${Object.keys(o.export).map((k) => `"${k}"`).join(', ')}], "init": {${Object.keys(o.export).map((k) => `"${k}": 0`).join(', ')}}`);
    if (Math.abs(o.init) > STORED_LIMIT) {
      throw new OptionError(`"init" ${o.init} is outside the range CSS can represent exactly in every browser (|x| <= ${LIMIT})`);
    }
    if (!Array.isArray(o.altInits) || o.altInits.length > MAX_ALT_INITS || !o.altInits.every((x) => isInt(x, -STORED_LIMIT, STORED_LIMIT))
      || new Set([o.init, ...o.altInits]).size !== o.altInits.length + 1) {
      throw new OptionError(`"altInits" must list up to ${MAX_ALT_INITS} other initial values (integers, |x| <= ${LIMIT}, none equal to "init" or repeated); the card shows them for the URL fragments #x<value>`);
    }
    return { names: null, init: o.init, altInits: o.altInits };
  }
  if (!Array.isArray(o.state) || !o.state.length || o.state.length > MAX_STATE) {
    throw new OptionError(`a state of several values needs "state": the names of its 1 to ${MAX_STATE} values in order (e.g. ["x", "y"]), with "init" an object of those names (e.g. {"x": 3, "y": 5})`);
  }
  const names = o.state;
  for (const name of names) {
    if (typeof name !== 'string' || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) throw new OptionError(`state value name ${JSON.stringify(name)} must be an identifier (letters, digits, _)`);
  }
  if (new Set(names).size !== names.length) throw new OptionError(`"state" lists a name twice (${names.join(', ')})`);
  const sameKeys = (obj) => isObject(obj) && Object.keys(obj).length === names.length && names.every((n) => Object.hasOwn(obj, n));
  if (!sameKeys(o.init)) throw new OptionError(`"init" must be an object with exactly the names of "state" (${names.join(', ')}), e.g. {${names.map((n) => `"${n}": 0`).join(', ')}}`);
  for (const name of names) {
    if (!isInt(o.init[name], -STORED_LIMIT, STORED_LIMIT)) throw new OptionError(`"init.${name}" must be an integer with |x| <= ${LIMIT}`);
  }
  if (isObject(o.export) && !sameKeys(o.export)) throw new OptionError(`"export" must map each name of "state" (${names.join(', ')}) to its step function, got ${Object.keys(o.export).join(', ') || 'none'}`);
  if (o.haltValue !== undefined && o.haltValue !== null) throw new OptionError('"halt" (a value) needs a state of one integer; with named state values, use "haltExport" (a predicate on the state)');
  const altError = `"altInits" must list up to ${MAX_ALT_INITS} other initial states, each an object with the names of "state" (${names.join(', ')}) and integers with |x| <= ${LIMIT}, none equal to "init" or repeated; the card shows them for the URL fragments #x<values joined by _>`;
  if (!Array.isArray(o.altInits) || o.altInits.length > MAX_ALT_INITS) throw new OptionError(altError);
  const altInits = o.altInits.map((a) => {
    if (!sameKeys(a) || !names.every((n) => isInt(a[n], -STORED_LIMIT, STORED_LIMIT))) throw new OptionError(altError);
    return names.map((n) => a[n]);
  });
  const init = names.map((n) => o.init[n]);
  if (new Set([init, ...altInits].map((x) => x.join(','))).size !== altInits.length + 1) throw new OptionError(altError);
  return { names, init, altInits };
}

// URL fragment and description of each other initial state (README embed lines).
export function altInitEmbeds(o) {
  const st = stateOptions({ ...DEFAULTS, ...o });
  return st.altInits.map((x) => ({
    id: altInitId(x),
    label: st.names ? st.names.map((n, i) => `${n}=${x[i]}`).join(', ') : String(x),
  }));
}

export async function generate(wasmBytes, opts) {
  const o = { ...DEFAULTS, ...opts };
  const st = stateOptions(o);
  if (!isInt(o.steps, 1, MAX_STEPS)) throw new OptionError(`"steps" must be an integer between 1 and ${MAX_STEPS} (WebKit stops resolving styles beyond ~510 nested elements)`);
  if (!isInt(o.stepMs, 16, 10000)) throw new OptionError('"stepMs" must be an integer between 16 and 10000');
  if (!isInt(o.hold, 0, 1000)) throw new OptionError('"hold" must be an integer between 0 and 1000');
  if (o.loops !== 'auto' && o.loops !== 'infinite' && !isInt(o.loops, 1, 1000)) throw new OptionError('"loops" must be "auto" (play for about a minute), "infinite" or an integer between 1 and 1000: how many times the run plays before the card stays on its last step');
  if (!isInt(o.bits, 4, 20)) throw new OptionError('"bits" must be an integer between 4 and 20');
  if (o.haltValue !== undefined && o.haltValue !== null && !isInt(o.haltValue, -STORED_LIMIT, STORED_LIMIT)) {
    throw new OptionError(`"halt" must be an integer with |halt| <= ${LIMIT}`);
  }
  if (o.haltExport && o.haltValue !== undefined && o.haltValue !== null) throw new OptionError('use either "halt" (a value) or "haltExport" (a predicate), not both');
  // The trace card shows one integer (its digits, bits and "the only input"); a state of several
  // values is shown by the project's UI, whose views read the values they need.
  if (st.names && st.names.length > 1 && !o.ui) {
    throw new OptionError(`a state of several values (${st.names.join(', ')}) is shown by a UI card: add "ui" with a demo component and the views it reads, e.g. "ui": {"entry": "demo.jsx", "views": {"x": "view_x"}} where demo.jsx is export default function Demo({ x }) { return <div style={{ width: 200, height: 40 }}>x = {x}</div>; }. The trace card shows a single integer`);
  }
  if (!(typeof o.export === 'string' || (isObject(o.export) && Object.values(o.export).every((e) => typeof e === 'string')))) {
    throw new OptionError('"export" must name the step function, or (for named state values) map each value to its step function, e.g. {"x": "step_x"}');
  }
  let views = [];
  if (o.ui) {
    if (!o.ui.entry || typeof o.ui.entry !== 'string') throw new OptionError('"ui.entry" (the demo component file) is required');
    if (!o.ui.views || typeof o.ui.views !== 'object' || !Object.keys(o.ui.views).length) throw new OptionError('"ui.views" must map view names to exported (i32) -> i32 functions, e.g. {"x": "view_x"}');
    views = Object.entries(o.ui.views).map(([name, exp]) => {
      if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(name)) throw new OptionError(`view name "${name}" must be an identifier (letters, digits, _)`);
      return { name, export: exp };
    });
  }
  const program = compileStep(wasmBytes, { exportName: o.export, haltExport: o.haltExport ?? null, views, state: st.names });
  const machine = buildMachine(program, { init: st.init, steps: o.steps, hold: o.hold, haltValue: o.haltValue ?? null });
  // Browsers silently drop calc() trees nested too deeply; the translation splits
  // expressions, and this makes sure nothing slipped through.
  for (const d of [...machine.root, ...machine.level.A, ...machine.level.B, ...machine.select, ...machine.display]) {
    const depth = textDepth(toCss(d.ast));
    if (depth > MAX_DECL_DEPTH) throw new Error(`internal: --${d.name} is nested ${depth} levels deep (limit ${MAX_DECL_DEPTH})`);
  }
  const verification = await verifyRun(wasmBytes, program, machine);
  // the other initial values the card can show (img src="card.svg#x97"): each run is verified
  // like the main one, and the UI is checked on the states of every run
  verification.alt = [];
  for (const init of st.altInits) {
    let v;
    const label = st.names ? `(${st.names.map((n, i) => `${n}=${init[i]}`).join(', ')})` : init;
    try { v = await verifyRun(wasmBytes, program, machine, { init }); } catch (e) { e.message = `altInits ${label}: ${e.message}`; throw e; }
    verification.alt.push({ init, end: v.trace.end, endAt: v.endAt });
    const seen = new Set(verification.viewSamples.map((x) => JSON.stringify(x)));
    for (const x of v.viewSamples) if (!seen.has(JSON.stringify(x))) { seen.add(JSON.stringify(x)); verification.viewSamples.push(x); }
  }
  const stateDef = machine.level.A.find((d) => d.name === 'rxa');
  // shown as `${exportName}()`: one step function per value reads "step_x() + step_y()"
  const steps = typeof o.export === 'string' ? [o.export] : st.names.map((n) => o.export[n]);
  const exportName = steps.join('() + ');
  const args = st.names ? st.names.join(', ') : 'i32';
  const signature = program.abi === 'globals' ? `${o.export}() → ${args}`
    : program.abi === 'functions' && st.names.length > 1 ? `${steps.join(', ')}(${args})` : `${steps[0]}(i32) → i32`;
  const meta = {
    title: o.title ?? exportName,
    wasmName: o.wasmName ?? 'module.wasm',
    exportName,
    signature,
    initLabel: st.names ? st.names.map((n, i) => `${n}=${st.init[i]}`).join(', ') : String(st.init),
    stepMs: o.stepMs,
    loops: resolveLoops(o),
    altInits: st.altInits,
    toolVersion: TOOL_VERSION,
    wasmSha256: sha256(wasmBytes),
    cssSnippet: `${exportName}() in CSS → --rxa: ${toCss(stateDef.ast)}`,
  };
  let svg, ui = null;
  if (o.ui) {
    const { buildUi } = await import('./ui/index.js');
    ui = await buildUi(o.ui, machine, verification, { cwd: o.cwd ?? process.cwd() });
    svg = renderUiCard(machine, { ...meta, credit: o.ui.credit ?? '' }, ui);
  } else {
    svg = renderCard(machine, meta, { bits: o.bits });
  }
  // A CRLF checkout puts \r into rendered markup (e.g. multi-line class strings); XML reads
  // \r\n as \n anyway, and a Linux build must give the same bytes.
  svg = svg.replace(/\r\n?/g, '\n');
  checkWellFormed(svg);
  // how the module was called, for humans and agents to check the binding
  const state = !st.names ? null : {
    abi: program.abi,
    values: st.names,
    binding: program.abi === 'globals'
      ? `${o.export}() reads and writes the exported globals ${args}; views and halt read them (or take (${args}))`
      : `${st.names.map((n, i) => `${n} = ${steps[i] ?? steps[0]}(${args})`).join('; ')}, all from the state before the step; views and halt are called as f(${args})`,
  };
  return { svg, verification, machine, program, state, ui: ui?.info ?? null, uiInputs: ui?.inputs ?? [], perf: perfReport(o, svg) };
}
