// The whole README as a reader sees it: GitHub's rendering of README.md at a pushed commit
// (the API's HTML) with the cards of that commit, in a column as wide as GitHub's. CPU of the
// browser process tree minus an empty page, while the top of the README is in view (a reader
// arriving) and with a window tall enough to show every card (the worst case), plus the time
// until every card is decoded and painted.
// Writes bench/results/readme.json. Run: node bench/readme.mjs <commit> [<commit> ...]
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { chromium, firefox, webkit } from 'playwright';
import { ROOT, WORK, processTree, treeTotals, round, median, writeJson, environment } from './common.mjs';

const REFS = process.argv.slice(2);
if (!REFS.length) throw new Error('usage: node bench/readme.mjs <commit> [<commit> ...]');
const REPEAT = Number(process.env.BENCH_REPEAT ?? 3);
const WINDOW_MS = Number(process.env.BENCH_WINDOW_MS ?? 8000);
const ENGINES = (process.env.BENCH_ENGINES ?? 'chromium,firefox,webkit').split(',');
const REPO = process.env.BENCH_REPO ?? 'otonasi-muonn/README-Runtime';

const pages = {};
for (const ref of REFS) {
  const sha = execFileSync('git', ['rev-parse', ref], { cwd: ROOT, encoding: 'utf8' }).trim();
  const dir = path.join(WORK, `readme-${sha.slice(0, 7)}`);
  fs.mkdirSync(dir, { recursive: true });
  const htmlFile = path.join(dir, 'readme.html');
  if (!fs.existsSync(htmlFile)) fs.writeFileSync(htmlFile, execFileSync('gh', ['api', `repos/${REPO}/readme?ref=${sha}`, '-H', 'Accept: application/vnd.github.html'], { encoding: 'utf8', maxBuffer: 1 << 26 }));
  const html = fs.readFileSync(htmlFile, 'utf8');
  // README images are repository paths; a URL fragment (#x97, see altInits) stays on the src
  const IMG = /<img src="([^"#]+\.svg)(#[^"]*)?"/g;
  const images = [...html.matchAll(IMG)].map((m) => m[1] + (m[2] ?? ''));
  for (const img of new Set(images.map((x) => x.split('#')[0]))) fs.writeFileSync(path.join(dir, path.basename(img)), execFileSync('git', ['show', `${sha}:${img}`], { cwd: ROOT, maxBuffer: 1 << 26 }));
  pages[ref] = { sha, dir, images, body: html.replace(IMG, (m, src, frag) => `<img src="/${sha.slice(0, 7)}/${path.basename(src)}${frag ?? ''}"`) };
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const p = Object.values(pages).find((x) => u.pathname === `/page/${x.sha.slice(0, 7)}`);
  if (u.pathname === '/blank' || p) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    // GitHub's README column: 888 px wide (a 1280 px window), system font, 16 px text
    return res.end(`<!doctype html><meta charset="utf-8"><body style="margin:0;font:16px/1.5 -apple-system,Segoe UI,Helvetica,Arial,sans-serif"><article style="width:840px;margin:0 auto;padding:24px">${p ? p.body : ''}</article></body>`);
  }
  const m = /^\/([0-9a-f]{7})\/([\w.-]+\.svg)$/.exec(u.pathname);
  const x = m && Object.values(pages).find((y) => y.sha.startsWith(m[1]));
  if (!x) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox", 'X-Content-Type-Options': 'nosniff' });
  res.end(fs.readFileSync(path.join(x.dir, m[2])));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;

const TYPES = { chromium, firefox, webkit };
const LAUNCH = { chromium: { args: ['--force-prefers-no-reduced-motion'] }, firefox: { firefoxUserPrefs: { 'ui.prefersReducedMotion': 0 } }, webkit: {} };
const results = { environment: environment(), windowMs: WINDOW_MS, repeat: REPEAT, pages: Object.fromEntries(Object.entries(pages).map(([k, p]) => [k, { sha: p.sha, images: p.images }])), engines: {} };
const cpuWindow = async (page, pid) => {
  const a = treeTotals(processTree(pid));
  const t0 = performance.now();
  await page.waitForTimeout(WINDOW_MS);
  const b = treeTotals(processTree(pid));
  return a && b ? { cpu: (b.cpuMs - a.cpuMs) / 10 / ((performance.now() - t0) / 1000), ws: b.ws / 2 ** 20 } : null;
};

for (const engine of ENGINES) {
  const out = {};
  results.engines[engine] = out;
  for (let i = 0; i < REPEAT; i++) for (const ref of i % 2 ? [...REFS].reverse() : REFS) {
    for (const view of ['top', 'all']) {
      const launched = await TYPES[engine].launchServer(LAUNCH[engine]);
      try {
        const browser = await TYPES[engine].connect(launched.wsEndpoint());
        const pid = launched.process().pid;
        const page = await (await browser.newContext({ viewport: { width: 1280, height: view === 'top' ? 800 : 4000 }, reducedMotion: 'no-preference' })).newPage();
        await page.goto(`${origin}/blank`);
        await page.waitForTimeout(3000);
        const base = await cpuWindow(page, pid);
        const t0 = performance.now();
        await page.goto(`${origin}/page/${pages[ref].sha.slice(0, 7)}`);
        await page.evaluate(async () => {
          await Promise.all([...document.images].map((im) => im.decode().catch(() => {})));
          await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        });
        const firstPaintMs = performance.now() - t0;
        if (view === 'all') {
          const h = await page.evaluate(() => document.documentElement.scrollHeight);
          if (h > 4000) await page.setViewportSize({ width: 1280, height: Math.min(h, 8000) });
        }
        await page.waitForTimeout(1500);
        const shown = await cpuWindow(page, pid);
        const k = `${ref}-${view}`;
        (out[k] ??= { cpuDelta: [], memDeltaMB: [], firstPaintMs: [] });
        out[k].version = browser.version();
        if (base && shown) { out[k].cpuDelta.push(round(shown.cpu - base.cpu, 1)); out[k].memDeltaMB.push(round(shown.ws - base.ws, 0)); }
        out[k].firstPaintMs.push(round(firstPaintMs, 0));
        console.log(engine, k, JSON.stringify(out[k]));
      } finally {
        await launched.close().catch(() => {});
      }
    }
  }
  for (const v of Object.values(out)) for (const f of ['cpuDelta', 'memDeltaMB', 'firstPaintMs']) v[`${f}Median`] = v[f].length ? median(v[f]) : null;
  writeJson('readme.json', results);
}
server.close();
writeJson('readme.json', results);
