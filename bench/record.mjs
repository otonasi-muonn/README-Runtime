// The recording pipeline the README Runtime card is compared with: compute the same states
// with the same Wasm, render the same React component for each state in a browser page
// (like an app recorder), screenshot every frame, encode animated WebP / MP4 with ffmpeg.
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { referenceTrace, instantiate } from '../src/runtime/reference.js';
import { bundleEntry, renderWith } from '../src/ui/bundle.js';
import { classCandidates, compileUiCss } from '../src/ui/style.js';
import { CARD, HOLD, INIT, STEP_MS, VIEWS, ffmpeg, sha } from './common.mjs';

const FPS = `${1000}/${STEP_MS}`; // one frame per step, shown for STEP_MS

// The same card chrome as the README Runtime card (light scheme), as plain HTML. The frame
// is an inset shadow, not a border, so absolute positions match the SVG card's pixel for pixel.
export const shell = (css, title) => `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;background:#fff}
.card{position:relative;width:${CARD.W}px;height:${CARD.H}px;box-shadow:inset 0 0 0 1px #d0d7de;border-radius:10px;background:#fff;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif}
.title{position:absolute;left:20px;top:15px;font-size:15px;font-weight:600;color:#1f2328}
.rule{position:absolute;left:0;right:0;border-top:1px solid #d0d7de}
.step{position:absolute;left:24px;top:416px;font:600 13px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:#656d76}
${css}
.rr-ui{background:transparent}
</style></head><body><div class="card"><div class="title">${title}</div><div class="rule" style="top:44px"></div><div id="ui" class="rr-ui" style="position:absolute;left:${CARD.uiX}px;top:${CARD.uiY}px;width:${CARD.uiW}px;height:${CARD.uiH}px"></div><div class="rule" style="top:402px"></div><div id="step" class="step"></div></div></body></html>`;

// States and the component's markup for every frame (steps + hold frames).
export async function frameModel(dir, N) {
  const wasm = fs.readFileSync(path.join(dir, 'mc/logic.wasm'));
  const tr = await referenceTrace(wasm, { exportName: 'step', init: INIT, steps: N });
  const ex = await instantiate(wasm);
  const bundle = await bundleEntry('mc/demo.tsx', { tsconfig: 'mc/tsconfig.json', cwd: dir });
  const frames = [];
  for (let t = 0; t <= N + HOLD; t++) {
    const shown = Math.min(t, tr.values.length - 1);
    const state = tr.values[shown];
    const views = Object.fromEntries(Object.entries(VIEWS).map(([k, e]) => [k, ex[e](state) | 0]));
    frames.push({ t, shown, views, html: renderWith(bundle, views), label: `STEP ${String(shown).padStart(3, '0')} / ${N}` });
  }
  const css = (await compileUiCss(['mc/upstream/src/app/globals.css'], classCandidates(frames.map((f) => f.html)), { cwd: dir })).css;
  return { frames, css };
}

// Screenshot every frame. cache: a folder of frames keyed by what they show (css + markup +
// label); a frame whose key exists is copied instead of rendered. Returns timings.
export async function renderFrames(dir, N, { scale = 1, out, cache = null, browser = null }) {
  const t0 = performance.now();
  const { frames, css } = await frameModel(dir, N);
  const tModel = performance.now() - t0;
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  if (cache) fs.mkdirSync(cache, { recursive: true });
  const own = !browser;
  browser ??= await chromium.launch();
  const t1 = performance.now();
  const page = await (await browser.newContext({ viewport: { width: CARD.W, height: CARD.H }, deviceScaleFactor: scale })).newPage();
  await page.setContent(shell(css, 'mockcraft · editor auto-pilot'));
  const cssKey = sha(`${css}|${scale}`);
  let rendered = 0;
  for (const f of frames) {
    const file = path.join(out, `${String(f.t).padStart(4, '0')}.png`);
    const key = cache && path.join(cache, `${sha(`${cssKey}|${f.html}|${f.label}`)}.png`);
    if (key && fs.existsSync(key)) { fs.copyFileSync(key, file); continue; }
    await page.evaluate(([html, label]) => { document.getElementById('ui').innerHTML = html; document.getElementById('step').textContent = label; }, [f.html, f.label]);
    await page.screenshot({ path: file, clip: { x: 0, y: 0, width: CARD.W, height: CARD.H } });
    if (key) fs.copyFileSync(file, key);
    rendered++;
  }
  await page.context().close();
  if (own) await browser.close();
  return { frames: frames.length, rendered, modelMs: tModel, screenshotMs: performance.now() - t1, totalMs: performance.now() - t0 };
}

// Encoders. Same frames, same frame rate (one frame per step), looping.
export const FORMATS = {
  'webp-lossless': { ext: 'webp', args: ['-c:v', 'libwebp_anim', '-lossless', '1', '-q:v', '75', '-compression_level', '4', '-loop', '0'] },
  'webp-q80': { ext: 'webp', args: ['-c:v', 'libwebp_anim', '-lossless', '0', '-q:v', '80', '-compression_level', '4', '-loop', '0'] },
  'mp4-h264-crf18': { ext: 'mp4', args: ['-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart'] },
  'mp4-h264-crf28': { ext: 'mp4', args: ['-c:v', 'libx264', '-preset', 'medium', '-crf', '28', '-pix_fmt', 'yuv420p', '-movflags', '+faststart'] },
  'mp4-av1-crf35': { ext: 'mp4', args: ['-c:v', 'libsvtav1', '-preset', '8', '-crf', '35', '-pix_fmt', 'yuv420p', '-movflags', '+faststart'] },
};

export function encode(framesDir, file, format) {
  const f = FORMATS[format];
  return ffmpeg(['-framerate', FPS, '-i', path.join(framesDir, '%04d.png'), ...f.args, '-r', FPS, file]).ms;
}

// SSIM / PSNR of the decoded animation against its source frames (RGB, whole card). The
// animation is first decoded to one PNG per step at the constant frame rate (animated WebP
// merges identical frames into longer ones), then compared image by image.
export function quality(file, framesDir) {
  const dec = `${file}.frames`;
  fs.rmSync(dec, { recursive: true, force: true });
  fs.mkdirSync(dec);
  ffmpeg(['-i', file, '-fps_mode', 'cfr', '-r', FPS, '-start_number', '0', path.join(dec, '%04d.png')]);
  const decoded = fs.readdirSync(dec).length;
  const source = fs.readdirSync(framesDir).length;
  const r = ffmpeg(['-loglevel', 'info', '-framerate', FPS, '-i', path.join(dec, '%04d.png'), '-framerate', FPS, '-i', path.join(framesDir, '%04d.png'),
    '-lavfi', '[0:v]format=rgb24[a];[1:v]format=rgb24[b];[a]split[a1][a2];[b]split[b1][b2];[a1][b1]ssim;[a2][b2]psnr', '-f', 'null', '-']);
  fs.rmSync(dec, { recursive: true, force: true });
  const log = `${r.stderr}${r.stdout}`;
  const ssim = Number(/SSIM .*All:([\d.]+)/.exec(log)?.[1]);
  const psnr = /PSNR .*average:(inf|[\d.]+)/.exec(log)?.[1];
  return { decodedFrames: decoded, sourceFrames: source, ssim: Number.isFinite(ssim) ? ssim : null, psnr: psnr === 'inf' ? 'inf' : Number(psnr) || null };
}
