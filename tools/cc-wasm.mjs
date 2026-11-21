#!/usr/bin/env node
// Reproducible C -> WebAssembly compile for the bundled examples.
// Uses a pinned WebAssembly build of clang (@yowasp/clang), so the same .wasm bytes are
// produced on every OS. Flags are fixed here on purpose: see README "Demo build conditions".
//
//   node tools/cc-wasm.mjs <input.c> <output.wasm>
import { runClang } from '@yowasp/clang';
import fs from 'node:fs';
import path from 'node:path';

export const CFLAGS = ['--target=wasm32', '-O2', '-nostdlib', '-Wl,--no-entry'];

const [src, out] = process.argv.slice(2);
if (!src || !out) {
  console.error('usage: node tools/cc-wasm.mjs <input.c> <output.wasm>');
  process.exit(2);
}
const name = path.basename(src);
const files = { [name]: fs.readFileSync(src, 'utf8') };
let result;
try {
  result = await runClang(['clang', ...CFLAGS, name, '-o', 'out.wasm'], files);
} catch (e) {
  console.error(`cc-wasm: clang failed${e.code !== undefined ? ` (exit ${e.code})` : ''}`);
  process.exit(1);
}
fs.writeFileSync(out, result['out.wasm']);
console.log(`cc-wasm: ${src} -> ${out} (${result['out.wasm'].length} bytes)`);
