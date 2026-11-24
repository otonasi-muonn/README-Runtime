// Build cost of the README Runtime card vs the recording pipeline, for N steps each:
// cold build, no-op rebuild with and without cache, a style edit and a logic edit.
// Writes bench/results/pipeline.json. Run: node bench/pipeline.mjs
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { WORK, STEPS, REPEAT, STEP_MS, HOLD, run, sizes, median, round, sha, writeJson, environment } from './common.mjs';
import { renderFrames, encode, quality, FORMATS } from './record.mjs';
import { CLI, ASC, ASC_ARGS, makeProject, rrBuild, edit } from './project.mjs';

// The recorder's own no-op check: a hash of everything the frames depend on.
const recInputs = (dir, N) => sha(['mc/demo.tsx', 'mc/logic.wasm', 'mc/upstream/src/app/globals.css', 'mc/upstream/src/components/board/ElementView.tsx', 'mc/upstream/src/lib/elementStyle.ts']
  .map((f) => fs.readFileSync(path.join(dir, f))).join('|') + N);

const ms = (xs) => round(median(xs), 0);

const results = { environment: environment(), stepMs: STEP_MS, hold: HOLD, repeat: REPEAT, formats: FORMATS, n: {} };
const browser = await chromium.launch();
for (const N of STEPS) {
  console.log(`\n== N = ${N} (${N + HOLD + 1} frames, ${((N + HOLD + 1) * STEP_MS / 1000).toFixed(2)} s)`);
  const dir = path.join(WORK, `n${N}`);
  const r = { frames: N + HOLD + 1, durationMs: (N + HOLD + 1) * STEP_MS, rr: {}, rec: {} };

  // ---- README Runtime -------------------------------------------------------------------
  const cold = [];
  for (let i = 0; i < REPEAT; i++) { makeProject(dir, N); const b = rrBuild(dir); if (b.build !== 'built' || b.card !== 'written') throw new Error(`cold build: ${JSON.stringify(b)}`); cold.push(b.ms); }
  const asc = [];
  for (let i = 0; i < REPEAT; i++) asc.push(run(process.execPath, [ASC, ...ASC_ARGS], { cwd: dir }).ms);
  rrBuild(dir); // settle the lock after the separate asc runs
  const noop = [], force = [], check = [], style = [], logic = [];
  for (let i = 0; i < REPEAT; i++) { const b = rrBuild(dir); if (b.card !== 'cached') throw new Error(`no-op: ${JSON.stringify(b)}`); noop.push(b.ms); }
  for (let i = 0; i < REPEAT; i++) force.push(rrBuild(dir, ['--force']).ms);
  for (let i = 0; i < REPEAT; i++) check.push(run(process.execPath, [CLI, 'check', '--json'], { cwd: dir }).ms);
  for (let i = 0; i < REPEAT; i++) { edit(dir, 'style', i + 1); const b = rrBuild(dir); if (b.card !== 'written') throw new Error(`style: ${JSON.stringify(b)}`); style.push(b.ms); }
  edit(dir, 'style', 0); rrBuild(dir);
  for (let i = 0; i < REPEAT; i++) { edit(dir, 'logic', i + 1); const b = rrBuild(dir); if (b.build !== 'built') throw new Error(`logic: ${JSON.stringify(b)}`); logic.push(b.ms); }
  edit(dir, 'logic', 0); rrBuild(dir);
  const svg = fs.readFileSync(path.join(dir, 'readme-runtime/mockcraft.svg'));
  fs.copyFileSync(path.join(dir, 'readme-runtime/mockcraft.svg'), path.join(WORK, `card-n${N}.svg`));
  r.rr = { coldMs: ms(cold), ascMs: ms(asc), noopCachedMs: ms(noop), noopForcedMs: ms(force), checkMs: ms(check), styleEditMs: ms(style), logicEditMs: ms(logic), size: sizes(svg) };
  console.log('README Runtime', JSON.stringify(r.rr));

  // ---- recording ------------------------------------------------------------------------
  const frames = path.join(WORK, `n${N}-frames`);
  const cache = path.join(WORK, `n${N}-frame-cache`);
  fs.rmSync(cache, { recursive: true, force: true });
  const recCold = [], launch = [];
  for (let i = 0; i < REPEAT; i++) {
    const t0 = performance.now();
    const b = await chromium.launch();
    launch.push(performance.now() - t0);
    recCold.push((await renderFrames(dir, N, { out: frames, browser: b })).totalMs + launch.at(-1));
    await b.close();
  }
  const enc = {};
  for (const f of Object.keys(FORMATS)) {
    const file = path.join(WORK, `n${N}.${f}.${FORMATS[f].ext}`);
    const times = [];
    for (let i = 0; i < REPEAT; i++) times.push(encode(frames, file, f));
    enc[f] = { ms: ms(times), size: sizes(fs.readFileSync(file)), ...quality(file, frames) };
  }
  // no-op: the recorder skips when its input hash is unchanged (cached) or redoes it all
  const noopRec = [];
  for (let i = 0; i < REPEAT; i++) { const t0 = performance.now(); recInputs(dir, N); noopRec.push(performance.now() - t0); }
  // edits: frames are re-rendered, with a frame cache keyed by what a frame shows (holding the
  // frames of the version before the edit) or without one. Every repeat edits to a value
  // not seen before, from a cache that holds only the original frames.
  const styleRec = [], logicRecCached = [], logicRecUncached = [], ascRec = [], reused = [];
  const freshCache = async () => { fs.rmSync(cache, { recursive: true, force: true }); await renderFrames(dir, N, { out: frames, cache, browser }); };
  for (let i = 0; i < REPEAT; i++) {
    await freshCache();
    edit(dir, 'style', i + 1);
    const c = await renderFrames(dir, N, { out: frames, cache, browser });
    // every distinct state is drawn again (the identical hold frames dedupe within the pass)
    if (c.rendered < N + 1) throw new Error(`style edit reused frames of the previous version (${c.rendered} drawn)`);
    styleRec.push(c.totalMs);
    edit(dir, 'style', 0);
  }
  for (let i = 0; i < REPEAT; i++) {
    await freshCache();
    edit(dir, 'logic', i + 1);
    ascRec.push(run(process.execPath, [ASC, ...ASC_ARGS], { cwd: dir }).ms);
    const c = await renderFrames(dir, N, { out: frames, cache, browser });
    logicRecCached.push(c.totalMs);
    reused.push(N + 1 - c.rendered); // distinct states taken from the previous version
    logicRecUncached.push((await renderFrames(dir, N, { out: frames, browser })).totalMs);
    edit(dir, 'logic', 0);
    run(process.execPath, [ASC, ...ASC_ARGS], { cwd: dir });
  }
  await renderFrames(dir, N, { out: frames, browser }); // leave the original frames for playback.mjs
  r.rec = {
    browserLaunchMs: ms(launch), framesColdMs: ms(recCold), noopCachedMs: round(median(noopRec), 1),
    styleFramesMs: ms(styleRec), logicFramesCachedMs: ms(logicRecCached), logicFramesUncachedMs: ms(logicRecUncached), logicFramesReused: median(reused), ascMs: ms(ascRec),
    encode: enc,
  };
  console.log('recording', JSON.stringify({ ...r.rec, encode: Object.fromEntries(Object.entries(enc).map(([k, v]) => [k, [v.ms, v.size.raw, v.ssim]])) }));
  results.n[N] = r;
  writeJson('pipeline.json', results);
}

// HiDPI: the SVG is vector; a recording needs 2x pixels to look as sharp on a 2x screen.
const N2 = STEPS.includes(160) ? 160 : STEPS[0];
const dir2 = path.join(WORK, `n${N2}`);
const frames2 = path.join(WORK, `n${N2}-frames-2x`);
const f2 = await renderFrames(dir2, N2, { scale: 2, out: frames2, browser });
results.hidpi = { n: N2, framesMs: round(f2.totalMs, 0), encode: {} };
for (const f of ['webp-lossless', 'webp-q80', 'mp4-h264-crf18']) {
  const file = path.join(WORK, `n${N2}-2x.${f}.${FORMATS[f].ext}`);
  const t = encode(frames2, file, f);
  results.hidpi.encode[f] = { ms: round(t, 0), size: sizes(fs.readFileSync(file)), ...quality(file, frames2) };
}
console.log('2x', JSON.stringify(results.hidpi));
await browser.close();
writeJson('pipeline.json', results);
