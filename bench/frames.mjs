// Which step a screenshot of the mockcraft card shows: the UI region in 4x4 blocks of grey,
// compared with the recorder's reference frames (WORK/n<N>-frames, from bench/pipeline.mjs).
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import { WORK, CARD } from './common.mjs';

const BLOCK = 4;
export function signature(png) {
  const w = Math.floor(CARD.uiW / BLOCK), h = Math.floor(CARD.uiH / BLOCK);
  const out = new Float32Array(w * h);
  for (let by = 0; by < h; by++) for (let bx = 0; bx < w; bx++) {
    let s = 0;
    for (let y = 0; y < BLOCK; y++) for (let x = 0; x < BLOCK; x++) {
      const i = ((CARD.uiY + by * BLOCK + y) * png.width + CARD.uiX + bx * BLOCK + x) * 4;
      s += png.data[i] * 0.299 + png.data[i + 1] * 0.587 + png.data[i + 2] * 0.114;
    }
    out[by * w + bx] = s / (BLOCK * BLOCK);
  }
  return out;
}
const distance = (a, b) => { let d = 0; for (let i = 0; i < a.length; i++) d += Math.abs(a[i] - b[i]); return d / a.length; };
const refs = new Map();
function references(N) {
  if (!refs.has(N)) {
    const dir = path.join(WORK, `n${N}-frames`);
    refs.set(N, fs.readdirSync(dir).sort().map((f) => signature(PNG.sync.read(fs.readFileSync(path.join(dir, f))))));
  }
  return refs.get(N);
}
// frame index (0..N+hold) of the closest reference, and how close it is (0 = identical)
export function identify(buf, N) {
  const sig = signature(PNG.sync.read(buf));
  let best = -1, bestD = Infinity;
  references(N).forEach((r, i) => { const d = distance(sig, r); if (d < bestD) { bestD = d; best = i; } });
  return { frame: best, d: bestD };
}
