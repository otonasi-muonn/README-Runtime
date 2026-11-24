// The CSS runtime before and after the clock / display separation (cf54637), on the mockcraft
// card: the same card built by both generators, measured alternately in the same environment.
//   - size (raw, gzip -9, brotli), build time
//   - playback: bench/playback.mjs per repeat (fresh browser per card, empty-page baselines
//     before and after, CPU of the browser process tree, memory, the Chromium trace, and which
//     step is on screen over ~4 s: skipped or wrong steps show there)
//   - first render: <img> inserted into a blank page -> decoded + two animation frames
// Needs the reference frames of bench/pipeline.mjs (WORK/n<N>-frames).
// Writes bench/results/clock.json. Run: node bench/clock.mjs
//   CLOCK_BASE   baseline commit (default dfafe10, the commit before the change)
//   CLOCK_REPEAT playback repeats per card (default 3; the 160-step card gets 2 more)
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawnSync, execFileSync } from 'node:child_process';
import { chromium, firefox, webkit } from 'playwright';
import { ROOT, WORK, STEPS, CARD, sizes, median, round, writeJson, environment } from './common.mjs';
import { makeProject } from './project.mjs';

const BASE = process.env.CLOCK_BASE ?? 'dfafe10';
const REPEAT = Number(process.env.CLOCK_REPEAT ?? 3);
const MAIN = 160; // the main condition: mockcraft, 160 steps, 150 ms
const ENGINES = (process.env.BENCH_ENGINES ?? 'chromium,firefox,webkit').split(',');
const FIRST_RENDER_REPEAT = 7;

// ------------------------------------------------------------------ the two generators
// The baseline is the repository at BASE, extracted inside WORK so that it resolves the
// dependencies from the repository's node_modules.
const baseDir = path.join(WORK, `clock-src-${BASE}`);
if (!fs.existsSync(path.join(baseDir, 'bin/readme-runtime.js'))) {
  fs.mkdirSync(baseDir, { recursive: true });
  const tar = execFileSync('git', ['archive', '--format=tar', BASE, 'bin', 'src', 'package.json'], { cwd: ROOT, maxBuffer: 1 << 28 });
  const x = spawnSync('tar', ['-x', '-f', '-'], { cwd: baseDir, input: tar }); // cwd: GNU tar on Windows misreads drive letters
  if (x.status !== 0) throw new Error(`tar: ${x.stderr}`);
}
const head = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
const VARIANTS = {
  before: { cli: path.join(baseDir, 'bin/readme-runtime.js'), commit: BASE },
  after: { cli: path.join(ROOT, 'bin/readme-runtime.js'), commit: head },
};

const results = { environment: environment(), base: BASE, head, repeat: REPEAT, mainRepeat: REPEAT + (STEPS.includes(MAIN) ? 2 : 0), cards: {}, playback: {}, firstRender: {} };
for (const [v, { cli }] of Object.entries(VARIANTS)) {
  const dir = path.join(WORK, `clock-${v}`);
  fs.mkdirSync(dir, { recursive: true });
  for (const N of STEPS) {
    const proj = path.join(WORK, `clock-proj-${v}-${N}`);
    makeProject(proj, N);
    const t0 = performance.now();
    const r = spawnSync(process.execPath, [cli, 'build', '--json'], { cwd: proj, encoding: 'utf8', maxBuffer: 1 << 26 });
    const ms = performance.now() - t0;
    const j = JSON.parse(r.stdout || '{}');
    if (!j.ok) throw new Error(`${v} ${N}: ${r.stdout.slice(0, 800)} ${r.stderr.slice(-800)}`);
    const svg = fs.readFileSync(path.join(proj, 'readme-runtime/mockcraft.svg'));
    fs.writeFileSync(path.join(dir, `card-n${N}.svg`), svg);
    const frames = path.join(WORK, `n${N}-frames`);
    if (!fs.existsSync(frames)) throw new Error(`missing ${frames}: run node bench/pipeline.mjs first`);
    fs.cpSync(frames, path.join(dir, `n${N}-frames`), { recursive: true });
    results.cards[`${v}-${N}`] = { buildMs: round(ms, 0), ...sizes(svg) };
    console.log(v, N, results.cards[`${v}-${N}`]);
  }
}
writeJson('clock.json', results);

// ------------------------------------------------------------------ playback (alternating)
function playback(v, steps, tag) {
  const res = path.join(WORK, 'clock-results', `${v}-${tag}`);
  const r = spawnSync(process.execPath, [path.join(ROOT, 'bench/playback.mjs')], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 26,
    env: { ...process.env, BENCH_WORK: path.join(WORK, `clock-${v}`), BENCH_RESULTS: res, BENCH_STEPS: steps.join(','), BENCH_FORMATS: 'svg', BENCH_ENGINES: ENGINES.join(',') },
  });
  if (r.status !== 0) throw new Error(`playback ${v} ${tag}: ${r.stderr.slice(-1500)}`);
  return JSON.parse(fs.readFileSync(path.join(res, 'playback.json'), 'utf8'));
}
const runs = [];
const extra = STEPS.includes(MAIN) ? 2 : 0;
for (let i = 0; i < REPEAT + extra; i++) {
  const steps = i < REPEAT ? STEPS : [MAIN];
  for (const v of i % 2 ? ['after', 'before'] : ['before', 'after']) {
    const p = playback(v, steps, `r${i}`);
    for (const [engine, e] of Object.entries(p.engines)) {
      for (const [name, a] of Object.entries(e.artifacts)) {
        const N = Number(/card-n(\d+)/.exec(name)[1]);
        runs.push({
          v, engine, version: e.version, N, repeat: i, plays: a.plays ?? false, error: a.error ?? null,
          cpuDelta: a.cpuDelta ?? null,
          memDeltaMB: a.cpu && a.baseline ? a.cpu.workingSetMB - a.baseline.workingSetMB : null,
          rate: a.match?.rate ?? null, framesSeen: a.match?.framesSeen ?? null, maxDistance: a.match?.maxDistance ?? null,
          styleMsPerS: a.trace?.msPerSecond.style ?? null, updatesPerS: a.trace?.styleUpdates.perSecond ?? null, updateMeanMs: a.trace?.styleUpdates.meanMs ?? null,
        });
        console.log(JSON.stringify(runs.at(-1)));
      }
    }
    results.runs = runs;
    writeJson('clock.json', results);
  }
}

// ------------------------------------------------------------------ first render
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/blank') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<!doctype html><body style="margin:0">'); }
  const m = /^\/(before|after)\/(card-n\d+\.svg)$/.exec(u.pathname);
  if (!m) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox", 'Cache-Control': 'no-store' });
  res.end(fs.readFileSync(path.join(WORK, `clock-${m[1]}`, m[2])));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
const TYPES = { chromium, firefox, webkit };
const OPTS = { chromium: { args: ['--force-prefers-no-reduced-motion'] }, firefox: { firefoxUserPrefs: { 'ui.prefersReducedMotion': 0 } }, webkit: {} };
for (const engine of ENGINES) {
  const browser = await TYPES[engine].launch(OPTS[engine]);
  const page = await (await browser.newContext({ viewport: { width: CARD.W + 40, height: CARD.H + 40 }, reducedMotion: 'no-preference' })).newPage();
  for (const N of STEPS) for (let i = 0; i < FIRST_RENDER_REPEAT; i++) for (const v of i % 2 ? ['after', 'before'] : ['before', 'after']) {
    await page.goto(`${origin}/blank`);
    const ms = await page.evaluate(async (src) => {
      const img = new Image();
      const t0 = performance.now();
      img.src = src;
      document.body.append(img);
      await img.decode().catch(() => {});
      await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
      return performance.now() - t0;
    }, `${origin}/${v}/card-n${N}.svg?${i}`);
    const k = `${engine}-${v}-${N}`;
    (results.firstRender[k] ??= []).push(round(ms, 0));
  }
  await browser.close();
}
server.close();

// ------------------------------------------------------------------ summary: median [min, max]
const stat = (xs) => { const v = xs.filter((x) => x != null); return v.length ? { median: round(median(v), 1), min: Math.min(...v), max: Math.max(...v), n: v.length } : null; };
results.summary = {};
for (const engine of ENGINES) for (const N of STEPS) for (const v of Object.keys(VARIANTS)) {
  const rs = runs.filter((r) => r.engine === engine && r.N === N && r.v === v);
  results.summary[`${engine}-${N}-${v}`] = {
    plays: rs.every((r) => r.plays), cpuDelta: stat(rs.map((r) => r.cpuDelta)), memDeltaMB: stat(rs.map((r) => r.memDeltaMB)),
    rate: stat(rs.map((r) => r.rate)), framesSeen: stat(rs.map((r) => r.framesSeen)), maxDistance: stat(rs.map((r) => r.maxDistance)),
    styleMsPerS: stat(rs.map((r) => r.styleMsPerS)), updatesPerS: stat(rs.map((r) => r.updatesPerS)), updateMeanMs: stat(rs.map((r) => r.updateMeanMs)),
    firstRenderMs: stat(results.firstRender[`${engine}-${v}-${N}`] ?? []),
  };
}
writeJson('clock.json', results);
console.log(JSON.stringify(results.summary, null, 1));
