// Programs for the browser proof beyond Collatz. Most are hand-assembled Wasm covering
// different instruction mixes (from the P0 critic review); the C fixtures are compiled with
// the pinned clang (tools/cc-wasm.mjs). `edits` are initial values written into the already
// generated SVG: the card must then show the exact Wasm trajectory or stop with OUT OF RANGE.
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { unary, op, c, get, set, I32 } from '../helpers/wasm-builder.js';

const root = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '../..');
const file = (p) => fs.readFileSync(path.join(root, p));

const asm = (body, locals = []) => unary(body, { locals });

export const PROGRAMS = {
  collatz: { wasm: file('examples/collatz/collatz.wasm'), export: 'step', init: 27, haltValue: 1, edits: [97, 7, 703, 1, 871, -5, 77671] },
  'lfsr-rust': { wasm: file('examples/lfsr-rust/lfsr.wasm'), export: 'step', init: 1, bits: 16, edits: [44257, 65535, 2, 70000, -3] },
  'chain90-c': { wasm: file('test/fixtures/chain90.wasm'), export: 'step', init: 1, edits: [123, 4567, -20, 900000] },
  'urem-c': { wasm: file('test/fixtures/urem.wasm'), export: 'step', init: 5, edits: [-5, 999999, -999999] },
  lcg75: { wasm: asm([get(0), c(75), op.mul, c(74), op.add, c(65537), op.rem_s]), export: 'f', init: 1, edits: [65536, 200000] },
  xorshift16: { wasm: asm([get(0), get(0), c(7), op.shl, c(0xffff), op.and, op.xor, set(0), get(0), get(0), c(9), op.shr_u, op.xor, set(0), get(0), get(0), c(8), op.shl, c(0xffff), op.and, op.xor]), export: 'f', init: 1, edits: [12345, -1] },
  negmix: { wasm: asm([get(0), c(-3), op.mul, c(12345), op.add, c(100003), op.rem_s]), export: 'f', init: 1, edits: [-77777] },
  ushr: { wasm: asm([get(0), c(13), op.shr_u, get(0), c(3), op.mul, c(0xfffff), op.and, op.xor, c(300000), op.sub]), export: 'f', init: 5, edits: [-12345] },
  bits: { wasm: asm([get(0), c(11), op.mul, get(0), op.popcnt, op.add, get(0), op.clz, c(3), op.mul, op.add, get(0), c(0x100000), op.or, op.ctz, op.add, c(600011), op.rem_s]), export: 'f', init: 5, edits: [-9] },
  ext16: { wasm: asm([get(0), c(37), op.mul, c(11), op.add, op.extend16_s]), export: 'f', init: 1, edits: [-500000] },
  udiv: { wasm: asm([get(0), get(0), c(15), op.and, c(1), op.add, op.div_u, get(0), c(1000), op.rem_u, op.add, get(0), c(13), op.mul, c(7), op.add, c(70001), op.rem_u, op.add, c(99991), op.rem_u]), export: 'f', init: 12345, edits: [-7] },
  temps: { wasm: asm([get(0), c(29), op.mul, c(7), op.add, c(65521), op.rem_s, set(1), get(1), get(1), c(3), op.shr_s, op.xor, get(1), c(3), op.mul, op.add, c(100000), op.rem_s], [I32]), export: 'f', init: 3, edits: [900000] },
  // (x<<12)>>12 relies on i32 wrap-around: exact for small x, OUT OF RANGE otherwise
  sext20: { wasm: asm([get(0), c(12), op.shl, c(12), op.shr_s, c(5), op.add]), export: 'f', init: 1, edits: [600000, 2000] },
  // x*x % 1000 needs x*x < 2^23 inside CSS
  square: { wasm: asm([get(0), get(0), op.mul, c(1000), op.rem_s, c(1), op.add]), export: 'f', init: 7, edits: [2900, 3000] },
  // --- from the final critic review ---
  // WebKit divides through the reciprocal: exact multiples of 49 / 65521 used to come out one low
  'div49-c': { wasm: file('test/fixtures/div49.wasm'), export: 'step', init: 117649, edits: [2401, 98, 4802] },
  'qr-c': { wasm: file('test/fixtures/qr.wasm'), export: 'step', init: 65521, edits: [131042, 999999] },
  // bit-twiddling demos that the guards used to over-reject
  'lfsr-fib-c': { wasm: file('test/fixtures/lfsr_fib.wasm'), export: 'step', init: 44257, bits: 16, edits: [1, 65535] },
  'rule30-c': { wasm: file('test/fixtures/rule30ring.wasm'), export: 'step', init: 32768, bits: 16, edits: [1, 12345] },
  // bit templates are exact below 2^23 only: x*16 for |x| >= 2^19 must stop with OUT OF RANGE
  popcnt16: { wasm: asm([get(0), c(16), op.mul, op.popcnt, get(0), op.add]), export: 'f', init: 1, edits: [600000, 531676] },
  // float32 overflow to infinity/NaN downstream of a guard must not silence the guard
  nanhash: { wasm: asm([get(0), ...[0, 1, 2, 3, 4].flatMap(() => [c(0x5bd1e995), op.mul]), set(1), get(1), get(1), c(7), op.shr_s, op.xor, c(0xffff), op.and], [I32]), export: 'f', init: 0, edits: [5, 12345] },
  // a trap (division by zero at the third step) stops the card with TRAP
  trap: { wasm: asm([c(100), get(0), c(3), op.sub, op.div_s]), export: 'f', init: 6, edits: [10] },
};
