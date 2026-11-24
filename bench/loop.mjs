// Does each artifact keep playing after one full pass? (A sampled frame rate cannot tell:
// WebKit stops a looping <video> after one pass.) 40-step artifacts (8 s), watched across the
// loop boundary. Videos: currentTime / paused from the page. Images: the shown frame is
// identified before and after the boundary. Writes bench/results/loop.json.
// Run: node bench/loop.mjs (needs bench/.work from bench/pipeline.mjs)
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { chromium, firefox, webkit } from 'playwright';
import { PNG } from 'pngjs';
import { WORK, CARD, STEP_MS, HOLD, writeJson, environment } from './common.mjs';

const N = 40;
const DURATION = (N + HOLD + 1) * STEP_MS;
const ARTIFACTS = { svg: `card-n${N}.svg`, 'webp-lossless': `n${N}.webp-lossless.webp`, 'mp4-h264-crf18': `n${N}.mp4-h264-crf18.mp4`, 'mp4-av1-crf35': `n${N}.mp4-av1-crf35.mp4` };
const TYPES = { svg: 'image/svg+xml', webp: 'image/webp', mp4: 'video/mp4' };
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/page') {
    const f = u.searchParams.get('f');
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(`<body style="margin:0">${f.endsWith('.mp4') ? `<video id="m" src="/a/${f}" autoplay loop muted playsinline></video>` : `<img id="m" src="/a/${f}">`}`);
  }
  const file = path.join(WORK, path.basename(u.pathname));
  if (!u.pathname.startsWith('/a/') || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
  const buf = fs.readFileSync(file);
  const headers = { 'Content-Type': TYPES[u.pathname.split('.').pop()], 'Accept-Ranges': 'bytes' };
  const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? '');
  if (m) {
    const s = Number(m[1]), e = m[2] ? Math.min(Number(m[2]), buf.length - 1) : buf.length - 1;
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${s}-${e}/${buf.length}`, 'Content-Length': e - s + 1 });
    return res.end(buf.subarray(s, e + 1));
  }
  res.writeHead(200, { ...headers, 'Content-Length': buf.length });
  res.end(buf);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;

// frame identification as in playback.mjs (grey 4x4 blocks of the UI region)
const sig = (png) => { const out = []; for (let y = CARD.uiY; y < CARD.uiY + CARD.uiH; y += 4) for (let x = CARD.uiX; x < CARD.uiX + CARD.uiW; x += 4) { const i = (y * png.width + x) * 4; out.push(png.data[i] * 0.299 + png.data[i + 1] * 0.587 + png.data[i + 2] * 0.114); } return out; };
const refs = fs.readdirSync(path.join(WORK, `n${N}-frames`)).sort().map((f) => sig(PNG.sync.read(fs.readFileSync(path.join(WORK, `n${N}-frames`, f)))));
const identify = (png) => { const s = sig(png); let best = 0, bestD = Infinity; refs.forEach((r, i) => { let d = 0; for (let k = 0; k < r.length; k++) d += Math.abs(r[k] - s[k]); if (d < bestD) { bestD = d; best = i; } }); return Math.min(best, N); };

const results = { environment: environment(), steps: N, durationMs: DURATION, engines: {} };
for (const [engine, type, opts] of [['chromium', chromium, { args: ['--autoplay-policy=no-user-gesture-required', '--force-prefers-no-reduced-motion'] }], ['firefox', firefox, { firefoxUserPrefs: { 'media.autoplay.default': 0, 'ui.prefersReducedMotion': 0 } }], ['webkit', webkit, {}], ['chrome', chromium, { channel: 'chrome', args: ['--autoplay-policy=no-user-gesture-required', '--force-prefers-no-reduced-motion'] }]]) {
  const browser = await type.launch(opts);
  const out = { version: browser.version(), artifacts: {} };
  for (const [kind, file] of Object.entries(ARTIFACTS)) {
    const page = await browser.newPage({ viewport: { width: CARD.W + 40, height: CARD.H + 40 }, reducedMotion: 'no-preference' });
    await page.goto(`${origin}/page?f=${file}`);
    let r;
    if (file.endsWith('.mp4')) {
      const seen = [];
      for (let t = 0; t < DURATION + 4000; t += 1000) {
        await page.waitForTimeout(1000);
        seen.push(await page.evaluate(() => { const v = document.getElementById('m'); return [Number(v.currentTime.toFixed(2)), v.paused, v.error?.code ?? null]; }));
      }
      const wrapped = seen.findIndex((x, i) => i > 0 && x[0] < seen[i - 1][0]);
      const after = wrapped < 0 ? [] : seen.slice(wrapped);
      r = { plays: !seen.at(-1)[2] && seen.some((x) => x[0] > 0), loops: wrapped > 0 && after.at(-1)[0] > after[0][0] && !after.at(-1)[1], samples: seen };
    } else {
      // two frames just after the loop boundary must both be real steps and advance
      await page.waitForTimeout(DURATION + 1500);
      const a = identify(PNG.sync.read(await page.locator('#m').screenshot()));
      await page.waitForTimeout(700);
      const b = identify(PNG.sync.read(await page.locator('#m').screenshot()));
      r = { plays: true, loops: a < N && b < N && b > a, frames: [a, b] };
    }
    out.artifacts[kind] = r;
    console.log(engine, kind, JSON.stringify({ plays: r.plays, loops: r.loops, frames: r.frames }));
    await page.close();
  }
  results.engines[engine] = out;
  await browser.close();
}
server.close();
writeJson('loop.json', results);
