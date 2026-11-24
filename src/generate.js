// .wasm bytes + options -> verified SVG card.
import crypto from 'node:crypto';
import { compileStep } from './compiler/program.js';
import { toCss, textDepth, MAX_DECL_DEPTH, STORED_LIMIT } from './compiler/css.js';
import { buildMachine, MAX_STEPS } from './runtime/machine.js';
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

export async function generate(wasmBytes, opts) {
  const o = { ...DEFAULTS, ...opts };
  if (!Number.isInteger(o.init)) throw new OptionError('"init" (the initial state) must be an integer');
  if (Math.abs(o.init) > STORED_LIMIT) {
    throw new OptionError(`"init" ${o.init} is outside the range CSS can represent exactly in every browser (|x| <= ${STORED_LIMIT.toLocaleString('en-US')})`);
  }
  if (!isInt(o.steps, 1, MAX_STEPS)) throw new OptionError(`"steps" must be an integer between 1 and ${MAX_STEPS} (WebKit stops resolving styles beyond ~510 nested elements)`);
  if (!isInt(o.stepMs, 16, 10000)) throw new OptionError('"stepMs" must be an integer between 16 and 10000');
  if (!isInt(o.hold, 0, 1000)) throw new OptionError('"hold" must be an integer between 0 and 1000');
  if (o.loops !== 'auto' && o.loops !== 'infinite' && !isInt(o.loops, 1, 1000)) throw new OptionError('"loops" must be "auto" (play for about a minute), "infinite" or an integer between 1 and 1000: how many times the run plays before the card stays on its last step');
  if (!isInt(o.bits, 4, 20)) throw new OptionError('"bits" must be an integer between 4 and 20');
  if (o.haltValue !== undefined && o.haltValue !== null && !isInt(o.haltValue, -STORED_LIMIT, STORED_LIMIT)) {
    throw new OptionError(`"halt" must be an integer with |halt| <= ${STORED_LIMIT.toLocaleString('en-US')}`);
  }
  if (o.haltExport && o.haltValue !== undefined && o.haltValue !== null) throw new OptionError('use either "halt" (a value) or "haltExport" (a predicate), not both');
  if (!Array.isArray(o.altInits) || o.altInits.length > MAX_ALT_INITS || !o.altInits.every((x) => isInt(x, -STORED_LIMIT, STORED_LIMIT))
    || new Set([o.init, ...o.altInits]).size !== o.altInits.length + 1) {
    throw new OptionError(`"altInits" must list up to ${MAX_ALT_INITS} other initial values (integers, |x| <= ${STORED_LIMIT.toLocaleString('en-US')}, none equal to "init" or repeated); the card shows them for the URL fragments #x<value>`);
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
  const program = compileStep(wasmBytes, { exportName: o.export, haltExport: o.haltExport ?? null, views });
  const machine = buildMachine(program, { init: o.init, steps: o.steps, hold: o.hold, haltValue: o.haltValue ?? null });
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
  for (const init of o.altInits) {
    let v;
    try { v = await verifyRun(wasmBytes, program, machine, { init }); } catch (e) { e.message = `altInits ${init}: ${e.message}`; throw e; }
    verification.alt.push({ init, end: v.trace.end, endAt: v.endAt });
    const seen = new Set(verification.viewSamples.map((x) => JSON.stringify(x)));
    for (const x of v.viewSamples) if (!seen.has(JSON.stringify(x))) { seen.add(JSON.stringify(x)); verification.viewSamples.push(x); }
  }
  const stateDef = machine.level.A.find((d) => d.name === 'rxa');
  const meta = {
    title: o.title ?? o.export,
    wasmName: o.wasmName ?? 'module.wasm',
    exportName: o.export,
    stepMs: o.stepMs,
    loops: resolveLoops(o),
    altInits: o.altInits,
    toolVersion: TOOL_VERSION,
    wasmSha256: sha256(wasmBytes),
    cssSnippet: `${o.export}() in CSS → --rxa: ${toCss(stateDef.ast)}`,
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
  return { svg, verification, machine, program, ui: ui?.info ?? null, uiInputs: ui?.inputs ?? [], perf: perfReport(o, svg) };
}
