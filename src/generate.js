// .wasm bytes + options -> verified SVG card.
import crypto from 'node:crypto';
import { compileStep } from './compiler/program.js';
import { toCss } from './compiler/css.js';
import { buildMachine } from './runtime/machine.js';
import { renderCard } from './render/card.js';
import { verifyRun } from './verify.js';
import { TOOL_VERSION } from './version.js';

export const DEFAULTS = { export: 'step', steps: 120, hold: 12, stepMs: 120, bits: 20 };

export function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

export async function generate(wasmBytes, opts) {
  const o = { ...DEFAULTS, ...opts };
  if (!Number.isInteger(o.init)) throw new Error('"init" (the initial state) must be an integer');
  if (!Number.isInteger(o.stepMs) || o.stepMs < 16 || o.stepMs > 10000) throw new Error('"stepMs" must be an integer between 16 and 10000');
  if (!Number.isInteger(o.hold) || o.hold < 0 || o.hold > 1000) throw new Error('"hold" must be an integer between 0 and 1000');
  if (!Number.isInteger(o.bits) || o.bits < 4 || o.bits > 20) throw new Error('"bits" must be an integer between 4 and 20');
  if (o.haltValue !== undefined && o.haltValue !== null && !Number.isInteger(o.haltValue)) throw new Error('"halt" must be an integer');
  const program = compileStep(wasmBytes, { exportName: o.export, haltExport: o.haltExport ?? null });
  const machine = buildMachine(program, { init: o.init, steps: o.steps, hold: o.hold, haltValue: o.haltValue ?? null });
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
  return { svg, verification, machine, program };
}
