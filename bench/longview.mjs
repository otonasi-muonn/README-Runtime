// A long view: one artifact in view for minutes, CPU (minus an empty page) and memory of the
// browser process tree every 30 s, to see whether anything builds up.
//   BENCH_LONGVIEW_SET=compare (default): the 40-step card endless and with 3 runs, the card
//     before the runtime change and a recording (needs bench/.work from bench/pipeline.mjs,
//     bench/clock.mjs and bench/policy.mjs)
//   BENCH_LONGVIEW_SET=readme: the cards of this repository's README as built now
//     (readme-runtime/): mockcraft alone, and the three README images on one page
// Writes bench/results/longview<BENCH_TAG>.json. Run: node bench/longview.mjs
//   BENCH_ENGINES (default webkit), BENCH_LONG_S (default 180), BENCH_LONGVIEW_ONLY (a subset)
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { chromium, firefox, webkit } from 'playwright';
import { ROOT, WORK, CARD, processTree, treeTotals, round, writeJson, environment } from './common.mjs';

const ENGINES = (process.env.BENCH_ENGINES ?? 'webkit').split(',');
const LONG_S = Number(process.env.BENCH_LONG_S ?? 180);
const OUT = `longview${process.env.BENCH_TAG ?? ''}.json`;
const card = (f) => ({ files: [f], html: (src) => `<img src="${src[0]}" width="${CARD.W}" height="${CARD.H}">`, viewport: { width: CARD.W + 40, height: CARD.H + 40 } });
const SETS = {
  compare: {
    'svg-endless': card(path.join(WORK, 'policy', 'endless.svg')),
    'svg-three-runs': card(path.join(WORK, 'policy', 'three.svg')),
    'svg-before-runtime-change': card(path.join(WORK, 'clock-before', 'card-n40.svg')),
    'webp-lossless': card(path.join(WORK, 'n40.webp-lossless.webp')),
  },
  readme: {
    'mockcraft': card(path.join(ROOT, 'readme-runtime', 'mockcraft.svg')),
    // the README's three images: one file twice, with distinct URLs (see README)
    'readme-images': {
      files: [path.join(ROOT, 'readme-runtime', 'mockcraft.svg'), path.join(ROOT, 'readme-runtime', 'collatz.svg')],
      html: (src) => `<img src="${src[0]}" width="760"><br><img src="${src[1]}" width="800"><br><img src="${src[1]}?x97#x97" width="800">`,
      viewport: { width: 840, height: 1150 },
    },
  },
};
// BENCH_LONGVIEW_ONLY=name,...: a subset of the set
const ONLY = process.env.BENCH_LONGVIEW_ONLY?.split(',');
const ARTIFACTS = Object.fromEntries(Object.entries(SETS[process.env.BENCH_LONGVIEW_SET ?? 'compare']).filter(([k]) => !ONLY || ONLY.includes(k)));
const TYPES = { svg: 'image/svg+xml', webp: 'image/webp' };
const served = new Map(Object.values(ARTIFACTS).flatMap((a) => a.files.map((f) => [path.basename(f), f])));
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/page') {
    const a = ARTIFACTS[u.searchParams.get('a')];
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(`<!doctype html><meta charset="utf-8"><body style="margin:0">${a ? a.html(a.files.map((f) => `/a/${path.basename(f)}`)) : ''}</body>`);
  }
  const file = served.get(path.basename(u.pathname));
  if (!file || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': TYPES[file.split('.').pop()], 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox" });
  res.end(fs.readFileSync(file));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
const BROWSERS = { chromium, firefox, webkit };
const LAUNCH = { chromium: { args: ['--force-prefers-no-reduced-motion'] }, firefox: { firefoxUserPrefs: { 'ui.prefersReducedMotion': 0 } }, webkit: {} };
const results = { environment: environment(), seconds: LONG_S, set: process.env.BENCH_LONGVIEW_SET ?? 'compare', engines: {} };
const MB = (b) => round(b / 2 ** 20, 0);
for (const engine of ENGINES) {
  const out = { version: null, artifacts: {} };
  results.engines[engine] = out;
  for (const [name, art] of Object.entries(ARTIFACTS)) {
    const launched = await BROWSERS[engine].launchServer(LAUNCH[engine]);
    try {
      const browser = await BROWSERS[engine].connect(launched.wsEndpoint());
      out.version = browser.version();
      const pid = launched.process().pid;
      const page = await (await browser.newContext({ viewport: art.viewport, reducedMotion: 'no-preference' })).newPage();
      await page.goto(`${origin}/page`);
      await page.waitForTimeout(3000);
      const a = treeTotals(processTree(pid));
      const t0 = performance.now();
      await page.waitForTimeout(6000);
      const b = treeTotals(processTree(pid));
      const base = (b.cpuMs - a.cpuMs) / 10 / ((performance.now() - t0) / 1000);
      await page.goto(`${origin}/page?a=${name}`);
      const samples = [];
      let prev = treeTotals(processTree(pid)), at = performance.now();
      for (let s = 30; s <= LONG_S; s += 30) {
        await page.waitForTimeout(30000);
        const now = treeTotals(processTree(pid));
        const secs = (performance.now() - at) / 1000;
        samples.push({ atS: s, cpu: round((now.cpuMs - prev.cpuMs) / 10 / secs - base, 1), memDeltaMB: MB(now.ws - b.ws), privDeltaMB: MB(now.priv - b.priv) });
        prev = now; at = performance.now();
      }
      // still moving at the end? (two shots of the first image, 1 s apart)
      const im = page.locator('img').first();
      const shot = await im.screenshot();
      await page.waitForTimeout(1000);
      out.artifacts[name] = { base: round(base, 1), samples, movingAtEnd: !shot.equals(await im.screenshot()) };
      console.log(engine, name, JSON.stringify(out.artifacts[name]));
    } finally {
      await launched.close().catch(() => {});
    }
    writeJson(OUT, results);
  }
}
server.close();
writeJson(OUT, results);
