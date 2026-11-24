// How much a demo costs while a reader is not looking at it: the same artifacts as in
// bench/playback.mjs, visible, scrolled out of view (a long README) and with the reader's
// "reduce motion" setting. CPU time of the whole browser process tree, minus an empty page.
// Writes bench/results/offscreen.json. Run: node bench/offscreen.mjs
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { chromium, firefox, webkit } from 'playwright';
import { WORK, CARD, processTree, treeTotals, round, writeJson, environment } from './common.mjs';

const N = Number(process.env.BENCH_OFFSCREEN_STEPS ?? 160);
const WINDOW_MS = Number(process.env.BENCH_WINDOW_MS ?? 8000);
const ARTIFACTS = { svg: `card-n${N}.svg`, 'webp-lossless': `n${N}.webp-lossless.webp`, 'mp4-h264-crf18': `n${N}.mp4-h264-crf18.mp4` };
const TYPES = { svg: 'image/svg+xml', webp: 'image/webp', mp4: 'video/mp4' };

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/page') {
    const f = u.searchParams.get('f');
    const below = u.searchParams.get('below') === '1';
    const media = !f ? '' : f.endsWith('.mp4')
      ? `<video src="/a/${f}" autoplay loop muted playsinline width="${CARD.W}" height="${CARD.H}"></video>`
      : `<img src="/a/${f}" width="${CARD.W}" height="${CARD.H}">`;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(`<!doctype html><meta charset="utf-8"><body style="margin:0">${below ? '<div style="height:6000px"></div>' : ''}${media}</body>`);
  }
  const file = path.join(WORK, path.basename(u.pathname));
  if (!fs.existsSync(file)) { res.writeHead(404); return res.end(); }
  const buf = fs.readFileSync(file);
  const headers = { 'Content-Type': TYPES[file.split('.').pop()], 'Accept-Ranges': 'bytes', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox" };
  const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? '');
  if (range) {
    const start = Number(range[1]);
    const end = range[2] ? Math.min(Number(range[2]), buf.length - 1) : buf.length - 1;
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${buf.length}`, 'Content-Length': end - start + 1 });
    return res.end(buf.subarray(start, end + 1));
  }
  res.writeHead(200, { ...headers, 'Content-Length': buf.length });
  res.end(buf);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;

const results = { environment: environment(), steps: N, windowMs: WINDOW_MS, engines: {} };
// The reader's "reduce motion" setting reaches an SVG inside <img> only as a browser setting
// (Playwright's per-page emulation does not apply to image documents), so each mode gets its
// own browser: Chromium flags, Firefox preference, WebKit emulation. Whether something still
// moves is checked with two screenshots 1 s apart.
const LAUNCH = {
  chromium: (reduce) => ({ args: ['--autoplay-policy=no-user-gesture-required', reduce ? '--force-prefers-reduced-motion' : '--force-prefers-no-reduced-motion'] }),
  firefox: (reduce) => ({ firefoxUserPrefs: { 'media.autoplay.default': 0, 'ui.prefersReducedMotion': reduce ? 1 : 0 } }),
  webkit: () => ({}),
};
for (const [engine, type] of Object.entries({ chromium, firefox, webkit })) {
  const out = { version: null, cases: {} };
  results.engines[engine] = out;
  for (const reduce of [false, true]) {
    const launched = await type.launchServer(LAUNCH[engine](reduce));
    const browser = await type.connect(launched.wsEndpoint());
    const pid = launched.process().pid;
    out.version = browser.version();
    const page = await (await browser.newContext({ viewport: { width: CARD.W + 40, height: CARD.H + 40 }, reducedMotion: reduce ? 'reduce' : 'no-preference' })).newPage();
    const cpu = async () => {
      await page.waitForTimeout(1500);
      const a = treeTotals(processTree(pid));
      const t0 = performance.now();
      await page.waitForTimeout(WINDOW_MS);
      const b = treeTotals(processTree(pid));
      return round((b.cpuMs - a.cpuMs) / 10 / ((performance.now() - t0) / 1000), 1);
    };
    const moving = async () => {
      const el = page.locator('img, video');
      const a = await el.screenshot();
      await page.waitForTimeout(1000);
      return !a.equals(await el.screenshot());
    };
    await page.goto(`${origin}/page`);
    const base = await cpu();
    for (const [name, file] of Object.entries(ARTIFACTS)) {
      for (const below of [false, true]) {
        if (reduce && below) continue;
        await page.goto(`${origin}/page?f=${file}&below=${below ? 1 : 0}`);
        const key = `${name} ${reduce ? 'reduced motion' : below ? 'scrolled out of view' : 'visible'}`;
        const c = round((await cpu()) - base, 1);
        out.cases[key] = { cpuPercent: c, moving: below ? null : await moving() };
        console.log(engine, key, JSON.stringify(out.cases[key]));
      }
    }
    await browser.close();
    await launched.close();
  }
}
server.close();
writeJson('offscreen.json', results);
