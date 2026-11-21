// .wasm bytes + options -> verified SVG card.
import crypto from 'node:crypto';
import { compileStep } from './compiler/program.js';
import { toCss, textDepth, MAX_DECL_DEPTH, STORED_LIMIT } from './compiler/css.js';
import { buildMachine, MAX_STEPS } from './runtime/machine.js';
import { renderCard } from './render/card.js';
import { checkWellFormed } from './render/xml.js';
import { verifyRun } from './verify.js';
import { TOOL_VERSION } from './version.js';

export const DEFAULTS = { export: 'step', steps: 120, hold: 12, stepMs: 120, bits: 20 };

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
  if (!isInt(o.bits, 4, 20)) throw new OptionError('"bits" must be an integer between 4 and 20');
  if (o.haltValue !== undefined && o.haltValue !== null && !isInt(o.haltValue, -STORED_LIMIT, STORED_LIMIT)) {
    throw new OptionError(`"halt" must be an integer with |halt| <= ${STORED_LIMIT.toLocaleString('en-US')}`);
  }
  const program = compileStep(wasmBytes, { exportName: o.export, haltExport: o.haltExport ?? null });
  const machine = buildMachine(program, { init: o.init, steps: o.steps, hold: o.hold, haltValue: o.haltValue ?? null });
  // Browsers silently drop calc() trees nested too deeply; the translation splits
  // expressions, and this makes sure nothing slipped through.
  for (const d of [...machine.root, ...machine.level.A, ...machine.level.B]) {
    const depth = textDepth(toCss(d.ast));
    if (depth > MAX_DECL_DEPTH) throw new Error(`internal: --${d.name} is nested ${depth} levels deep (limit ${MAX_DECL_DEPTH})`);
  }
  const verification = await verifyRun(wasmBytes, program, machine);
  const stateDef = machine.level.A.find((d) => d.name === 'rxa');
  const meta = {
    title: o.title ?? o.export,
    wasmName: o.wasmName ?? 'module.wasm',
    exportName: o.export,
    stepMs: o.stepMs,
    toolVersion: TOOL_VERSION,
    wasmSha256: sha256(wasmBytes),
    cssSnippet: `${o.export}() in CSS → --rxa: ${toCss(stateDef.ast)}`,
  };
  const svg = renderCard(machine, meta, { bits: o.bits });
  checkWellFormed(svg);
  return { svg, verification, machine, program };
}
