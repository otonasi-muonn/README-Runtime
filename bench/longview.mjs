// A long view: one artifact in view for 3 minutes, CPU (minus an empty page) and memory of the
// browser process tree every 30 s, to see whether anything builds up. Compares the current
// card (endless and 3 runs), the card before the runtime change and a recording, in WebKit by
// default (where bench/policy.mjs saw memory grow). Needs bench/.work from bench/pipeline.mjs,
// bench/clock.mjs (clock-before/, clock-after/) and bench/policy.mjs (policy/).
// Writes bench/results/longview.json. Run: node bench/longview.mjs
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { chromium, firefox, webkit } from 'playwright';
import { WORK, CARD, processTree, treeTotals, round, writeJson, environment } from './common.mjs';

const ENGINES = (process.env.BENCH_ENGINES ?? 'webkit').split(',');
const LONG_S = Number(process.env.BENCH_LONG_S ?? 180);
const ARTIFACTS = {
  'svg-endless': path.join(WORK, 'policy', 'endless.svg'),
  'svg-three-runs': path.join(WORK, 'policy', 'three.svg'),
  'svg-before-runtime-change': path.join(WORK, 'clock-before', 'card-n40.svg'),
  'webp-lossless': path.join(WORK, 'n40.webp-lossless.webp'),
};
const TYPES = { svg: 'image/svg+xml', webp: 'image/webp' };
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/page') {
    const f = u.searchParams.get('f');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(`<!doctype html><meta charset="utf-8"><body style="margin:0">${f ? `<img src="/a/${f}" width="${CARD.W}" height="${CARD.H}">` : ''}</body>`);
  }
  const file = ARTIFACTS[path.basename(u.pathname)];
  if (!file || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': TYPES[file.split('.').pop()], 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox" });
  res.end(fs.readFileSync(file));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
const BROWSERS = { chromium, firefox, webkit };
const LAUNCH = { chromium: { args: ['--force-prefers-no-reduced-motion'] }, firefox: { firefoxUserPrefs: { 'ui.prefersReducedMotion': 0 } }, webkit: {} };
const results = { environment: environment(), seconds: LONG_S, engines: {} };
for (const engine of ENGINES) {
  const out = { version: null, artifacts: {} };
  results.engines[engine] = out;
  for (const name of Object.keys(ARTIFACTS)) {
    const launched = await BROWSERS[engine].launchServer(LAUNCH[engine]);
    try {
      const browser = await BROWSERS[engine].connect(launched.wsEndpoint());
      out.version = browser.version();
      const pid = launched.process().pid;
      const page = await (await browser.newContext({ viewport: { width: CARD.W + 40, height: CARD.H + 40 }, reducedMotion: 'no-preference' })).newPage();
      await page.goto(`${origin}/page`);
      await page.waitForTimeout(3000);
      const a = treeTotals(processTree(pid));
      const t0 = performance.now();
      await page.waitForTimeout(6000);
      const b = treeTotals(processTree(pid));
      const base = (b.cpuMs - a.cpuMs) / 10 / ((performance.now() - t0) / 1000);
      await page.goto(`${origin}/page?f=${name}`);
      const samples = [];
      let prev = treeTotals(processTree(pid)), at = performance.now();
      for (let s = 30; s <= LONG_S; s += 30) {
        await page.waitForTimeout(30000);
        const now = treeTotals(processTree(pid));
        const secs = (performance.now() - at) / 1000;
        samples.push({ atS: s, cpu: round((now.cpuMs - prev.cpuMs) / 10 / secs - base, 1), memDeltaMB: round((now.ws - b.ws) / 2 ** 20, 0) });
        prev = now; at = performance.now();
      }
      out.artifacts[name] = { base: round(base, 1), samples };
      console.log(engine, name, JSON.stringify(out.artifacts[name]));
    } finally {
      await launched.close().catch(() => {});
    }
    writeJson('longview.json', results);
  }
}
server.close();
writeJson('longview.json', results);
