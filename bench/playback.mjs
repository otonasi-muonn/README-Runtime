// Playback in real browsers: does each artifact play correctly (displayed frame vs the
// expected step over time), and what does showing it cost (CPU time and memory of the whole
// browser process tree; in Chromium also a trace split into style / layout / paint / raster /
// image decode / video decode). Needs the artifacts from bench/pipeline.mjs.
// Writes bench/results/playback.json. Run: node bench/playback.mjs
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { chromium, firefox, webkit } from 'playwright';
import { PNG } from 'pngjs';
import { WORK, STEPS, STEP_MS, CARD, processTree, treeTotals, round, writeJson, environment } from './common.mjs';

const WINDOW_MS = Number(process.env.BENCH_WINDOW_MS ?? 8000); // CPU window per artifact
const ENGINES = (process.env.BENCH_ENGINES ?? 'chromium,firefox,webkit,chrome,msedge').split(',');
const FORMATS = (process.env.BENCH_FORMATS ?? 'svg,webp-lossless,webp-q80,mp4-h264-crf18,mp4-av1-crf35').split(',');
// Playwright's Chromium has no H.264; the branded browsers are added for the formats they
// change something for (Chrome: H.264 next to the SVG and WebP; Edge: whether H.264 plays).
const ENGINE_FORMATS = { chrome: ['svg', 'webp-lossless', 'mp4-h264-crf18'], msedge: ['mp4-h264-crf18'] };
const artifact = (N, f) => (f === 'svg' ? `card-n${N}.svg` : `n${N}.${f}.${f.startsWith('mp4') ? 'mp4' : 'webp'}`);

// A server with GitHub's headers for images (CSP sandbox, nosniff) and byte ranges for video.
const TYPES = { svg: 'image/svg+xml', webp: 'image/webp', mp4: 'video/mp4' };
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/page') {
    const f = u.searchParams.get('f');
    const media = !f ? '' : f.endsWith('.mp4')
      ? `<video id="m" src="/a/${f}" autoplay loop muted playsinline width="${CARD.W}" height="${CARD.H}"></video>`
      : `<img id="m" src="/a/${f}" width="${CARD.W}" height="${CARD.H}">`;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(`<!doctype html><meta charset="utf-8"><body style="margin:0;background:#fff">${media}</body>`);
  }
  const file = path.join(WORK, path.basename(u.pathname));
  if (!u.pathname.startsWith('/a/') || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
  const buf = fs.readFileSync(file);
  const headers = { 'Content-Type': TYPES[file.split('.').pop()], 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox", 'X-Content-Type-Options': 'nosniff', 'Accept-Ranges': 'bytes', 'Cache-Control': 'max-age=300' };
  const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? '');
  if (range) {
    const start = range[1] ? Number(range[1]) : buf.length - Number(range[2]);
    const end = range[1] && range[2] ? Math.min(Number(range[2]), buf.length - 1) : buf.length - 1;
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${buf.length}`, 'Content-Length': end - start + 1 });
    return res.end(buf.subarray(start, end + 1));
  }
  res.writeHead(200, { ...headers, 'Content-Length': buf.length });
  res.end(buf);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;

// Frame signatures: the UI region in 4x4 blocks of grey, to tell which step is shown.
const BLOCK = 4;
function signature(png) {
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
function identify(png, N) {
  const sig = signature(png);
  let best = -1, bestD = Infinity;
  references(N).forEach((r, i) => { const d = distance(sig, r); if (d < bestD) { bestD = d; best = i; } });
  return { frame: best, d: bestD };
}

// Chromium trace: time per group of rendering work, per second. Within a thread the intervals
// of a group are merged (a nested or overlapping event, e.g. Decode Image inside
// ImageDecodeTask, is not counted twice). A group without any matching event is reported as
// null ("not observed"): e.g. Playwright's Chromium decodes video without such events.
const GROUPS = [
  ['style', /^UpdateLayoutTree$/],
  ['layout', /^Layout$/],
  ['paint', /^(Paint|PrePaint|PaintImage)$/],
  ['raster', /^RasterTask$/],
  ['imageDecode', /^(ImageDecodeTask|Decode Image)$/],
  ['videoDecode', /^(D3DVideoDecoder::DoDecode|D3D11VideoDecoder::Decode|FFmpegVideoDecoder::Decode|Dav1dVideoDecoder::Decode|VpxVideoDecoder::Decode)$/],
];
function traceGroups(json, seconds) {
  const events = JSON.parse(json).traceEvents ?? [];
  const byName = new Map();
  for (const e of events) if (e.ph === 'X' && e.dur) byName.set(e.name, (byName.get(e.name) ?? 0) + e.dur);
  const per = {};
  for (const [g, re] of GROUPS) {
    const byThread = new Map();
    for (const e of events) {
      if (e.ph !== 'X' || !e.dur || !re.test(e.name)) continue;
      const k = `${e.pid}:${e.tid}`;
      if (!byThread.has(k)) byThread.set(k, []);
      byThread.get(k).push([e.ts, e.ts + e.dur]);
    }
    let us = 0;
    for (const list of byThread.values()) {
      list.sort((a, b) => a[0] - b[0]);
      let [s0, e0] = list[0];
      for (const [s1, e1] of list.slice(1)) { if (s1 <= e0) e0 = Math.max(e0, e1); else { us += e0 - s0; [s0, e0] = [s1, e1]; } }
      us += e0 - s0;
    }
    per[g] = byThread.size ? round(us / 1000 / seconds, 1) : null; // ms per second
  }
  const top = [...byName].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([n, us]) => [n, round(us / 1000 / seconds, 1)]);
  // style recalculations that do real work (> 1 ms): how often the card updates, and each cost
  const big = events.filter((e) => e.ph === 'X' && e.name === 'UpdateLayoutTree' && e.dur > 1000);
  const updates = { perSecond: round(big.length / seconds, 1), meanMs: big.length ? round(big.reduce((a, e) => a + e.dur, 0) / 1000 / big.length, 1) : null };
  return { msPerSecond: per, styleUpdates: updates, top };
}

const TYPES_BY_ENGINE = { chromium, firefox, webkit, chrome: chromium, msedge: chromium };
const results = { environment: environment(), windowMs: WINDOW_MS, engines: {} };
const ARTIFACT_TIMEOUT_MS = 180000;
// Every artifact gets a fresh browser, measured first on an empty page, so memory and CPU of
// one artifact do not carry over into the next. The browser is always closed afterwards.
async function measureArtifact(engine, N, name) {
  const type = TYPES_BY_ENGINE[engine];
  const opts = engine === 'chrome' || engine === 'msedge' ? { channel: engine } : {};
  if (engine === 'chromium' || opts.channel) opts.args = ['--autoplay-policy=no-user-gesture-required', '--force-prefers-no-reduced-motion'];
  if (engine === 'firefox') opts.firefoxUserPrefs = { 'media.autoplay.default': 0, 'ui.prefersReducedMotion': 0 };
  const launched = await type.launchServer(opts);
  const work = (async () => {
    const browser = await type.connect(launched.wsEndpoint());
    const pid = launched.process().pid;
    const page = await (await browser.newContext({ viewport: { width: CARD.W + 40, height: CARD.H + 40 }, deviceScaleFactor: 1, reducedMotion: 'no-preference' })).newPage();
    const sample = () => { const t0 = performance.now(); const tree = treeTotals(processTree(pid)); return { tree, at: (t0 + performance.now()) / 2, queryMs: round(performance.now() - t0, 0) }; };
    const measure = async () => {
      const a = sample();
      await page.waitForTimeout(WINDOW_MS);
      const b = sample();
      const secs = (b.at - a.at) / 1000;
      return a.tree && b.tree ? { cpuPercent: round((b.tree.cpuMs - a.tree.cpuMs) / 10 / secs, 1), workingSetMB: round(b.tree.ws / 2 ** 20, 0), processes: b.tree.processes, windowS: round(secs, 1), queryMs: [a.queryMs, b.queryMs] } : null;
    };
    await page.goto(`${origin}/page`);
    await page.waitForTimeout(3000); // warm-up after the launch
    const r = { version: browser.version(), baseline: await measure() };
    await page.goto(`${origin}/page?f=${name}`);
    await page.waitForTimeout(1200);
    const state = await page.evaluate(() => {
      const m = document.getElementById('m');
      return m.tagName === 'VIDEO' ? { video: true, error: m.error?.code ?? null, readyState: m.readyState, time: m.currentTime } : { video: false, decoded: m.complete && m.naturalWidth > 0 };
    });
    r.plays = state.video ? state.error === null && state.readyState >= 2 && state.time > 0 : state.decoded;
    if (!r.plays) { r.state = state; return r; }
    // CPU and memory first, undisturbed by screenshots
    r.cpu = await measure();
    // which frame is shown over ~4 s: it must match a source frame and advance one step per
    // STEP_MS. The 12 hold frames at the end look identical (they all identify as frame N), so
    // pairs of samples that touch the hold or wrap around are left out of the rate.
    const samples = [];
    const t0 = performance.now();
    for (let i = 0; i < 14; i++) {
      const png = PNG.sync.read(await page.locator('#m').screenshot({ timeout: 20000 }));
      samples.push({ at: round(performance.now() - t0, 0), ...identify(png, N) });
      await page.waitForTimeout(150);
    }
    const pairs = samples.slice(1).map((x, i) => [samples[i], x]).filter(([a, b]) => a.frame < N && b.frame < N && b.frame >= a.frame);
    const advance = pairs.map(([a, b]) => (b.frame - a.frame) / ((b.at - a.at) / STEP_MS));
    r.match = {
      maxDistance: round(Math.max(...samples.map((x) => x.d)), 2), framesSeen: new Set(samples.map((x) => x.frame)).size,
      rate: advance.length ? round(advance.reduce((a, b) => a + b, 0) / advance.length, 2) : null, pairs: advance.length,
      samples: samples.map((x) => [x.at, x.frame, round(x.d, 2)]),
    };
    if (engine === 'chromium' || engine === 'chrome') {
      await browser.startTracing(page, { categories: ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'blink', 'cc', 'gpu', 'media', 'viz'] });
      await page.waitForTimeout(4000);
      r.trace = traceGroups((await browser.stopTracing()).toString(), 4);
    }
    // the empty page again: the baseline is the mean of before and after
    await page.goto(`${origin}/page`);
    await page.waitForTimeout(1000);
    r.baselineAfter = await measure();
    if (r.cpu && r.baseline && r.baselineAfter) r.cpuDelta = round(r.cpu.cpuPercent - (r.baseline.cpuPercent + r.baselineAfter.cpuPercent) / 2, 1);
    return r;
  })();
  try {
    return await Promise.race([work, new Promise((_, rej) => setTimeout(() => rej(new Error(`no result within ${ARTIFACT_TIMEOUT_MS / 1000} s`)), ARTIFACT_TIMEOUT_MS))]);
  } finally {
    await launched.close().catch(() => {});
  }
}
for (const engine of ENGINES) {
  const out = { version: null, artifacts: {} };
  results.engines[engine] = out;
  for (const N of STEPS) for (const f of FORMATS) {
    if (ENGINE_FORMATS[engine] && !ENGINE_FORMATS[engine].includes(f)) continue;
    const name = artifact(N, f);
    if (!fs.existsSync(path.join(WORK, name))) continue;
    let r;
    try { r = await measureArtifact(engine, N, name); } catch (e) { r = { error: String(e.message).split('\n')[0] }; }
    out.version = r.version ?? out.version;
    delete r.version;
    out.artifacts[name] = r;
    console.log(engine, out.version, name, JSON.stringify({ plays: r.plays, error: r.error, match: r.match && { ...r.match, samples: undefined }, cpu: r.cpu, base: r.baseline, trace: r.trace && { ...r.trace.msPerSecond, updates: r.trace.styleUpdates } }));
    writeJson('playback.json', results);
  }
}
server.close();
writeJson('playback.json', results);
