#!/usr/bin/env node
// Reproduce the useful boundary failures, without changing src/ or the working card.
// Optional checkout argument additionally compares each copied file to its committed blob.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { bundleEntry } from '../../src/ui/bundle.js';
import { inferTemplate } from '../../src/ui/infer.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const checkout = process.argv[2];
const manifest = JSON.parse(fs.readFileSync(path.join(here, 'upstream.json'), 'utf8'));
const hashes = {};
for (const [file, expected] of Object.entries(manifest.files)) {
  const copy = fs.readFileSync(path.join(here, 'upstream', file));
  const actual = crypto.createHash('sha256').update(copy).digest('hex');
  assert.equal(actual, expected, `${file}: upstream hash mismatch`);
  if (checkout) {
    const committed = execFileSync('git', ['-C', checkout, 'show', `${manifest.commit}:${file}`]);
    assert.ok(copy.equals(committed), `${file}: not byte-identical to the committed blob`);
  }
  hashes[file] = actual;
}

async function load(entryPoints) {
  const result = await build({ entryPoints, bundle: true, write: false, format: 'esm', platform: 'neutral', logLevel: 'silent' });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
}
const recorder = await load([path.join(here, 'canvas-svg.ts')]);
const renderer = await load([path.join(here, 'upstream/src/render/canvasRenderer.ts')]);
const drawing = JSON.parse(fs.readFileSync(path.join(here, 'generated/drawing.json')));
let prefixCases = 0;
for (const stroke of drawing.strokes) for (let k = 0; k <= stroke.pts.length; k++) {
  const { ctx, shapes } = recorder.recordCanvas();
  renderer.renderStroke(ctx, { ...stroke, pts: stroke.pts.slice(0, k) });
  assert.equal(shapes.length, k === 0 ? 0 : 1);
  if (k === 1) {
    assert.equal(shapes[0].paint, 'fill');
    assert.equal((shapes[0].d.match(/A/g) ?? []).length, 2, 'arc(0,7) must record a complete circle');
  }
  if (k >= 3) assert.ok(shapes[0].d.includes('Q'), 'real renderer must use quadratic curves');
  prefixCases++;
}
const failures = [];
function rejects(name, code, action) {
  let error;
  try { action(); } catch (e) { error = e; }
  assert.ok(error, `${name}: expected a boundary failure`);
  if (code) assert.equal(error.code, code);
  const failure = { name, code: error.code ?? error.name, message: error.message };
  failures.push(failure);
  console.log(`${failure.code} ${name}: ${failure.message}`);
}
const bundle = await bundleEntry('examples/air-drawing/demo.tsx', { cwd: root });
const base = { k0: 0, k1: 0, k2: 0, k3: 0, col: 0, wid: 1, n: 0, pts: 0 };
rejects('65-value geometry view (deliberate range probe)', 'UI_NONLINEAR', () => {
  inferTemplate(bundle, [{ name: 'k0', range: { lo: 0, hi: 64 } }], { base });
});
rejects('renderAll with the renderStroke-only shim', null, () => renderer.renderAll(recorder.recordCanvas().ctx, drawing.strokes));
rejects('renderActive with the renderStroke-only shim', null, () => renderer.renderActive(recorder.recordCanvas().ctx, drawing.strokes[0]));
rejects('renderStrokesToDataUrl in Node (default canvas factory)', null, () => renderer.renderStrokesToDataUrl(drawing.strokes));
rejects('pixel readback outside the recorder contract', null, () => recorder.recordCanvas().ctx.getImageData(0, 0, 1, 1));
const result = { repository: manifest.repository, commit: manifest.commit, comparedCommittedBlobs: Boolean(checkout), hashes, prefixCases, failures };
fs.writeFileSync(path.join(here, 'boundary-results.json'), `${JSON.stringify(result, null, 2)}\n`);
console.log(`PASS ${Object.keys(hashes).length} upstream hashes; ${prefixCases} real-renderer prefixes; ${failures.length} expected boundary failures`);
