// Finite or endless runs? What a card does while the reader is elsewhere, and what it costs
// over a longer view. The mockcraft card at 40 steps (one run: 53 clock steps x 150 ms = 8 s).
//   reachedLate: the card sits below a long page and the reader scrolls to it after 12 s, when
//     one run would be over. Which step does it show, and does it still move? Compared with the
//     same card in view from the start. Tells whether the browser keeps the card's clock
//     running while it is out of view (then a finite card has ended before it is seen).
//   cpu: CPU of the browser process tree (minus an empty page) during the first run and
//     after 30 s, in view and out of view, for loops 3 and "infinite".
//   longView: the endless card in view for 3 minutes: CPU and memory every 30 s (does
//     anything build up?).
// Writes bench/results/policy.json. Run: node bench/policy.mjs (after bench/pipeline.mjs)
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { chromium, firefox, webkit } from 'playwright';
import { ROOT, WORK, CARD, processTree, treeTotals, round, run, writeJson, environment } from './common.mjs';
import { makeProject } from './project.mjs';
import { identify } from './frames.mjs';

const N = 40;
const RUN_MS = (N + 12 + 1) * 150;
const VARIANTS = { once: 1, three: 3, endless: 'infinite' };
const ENGINES = (process.env.BENCH_ENGINES ?? 'chromium,firefox,webkit').split(',');
const LONG_S = Number(process.env.BENCH_LONG_S ?? 180);

// ------------------------------------------------------------------ cards
const dir = path.join(WORK, 'policy');
fs.mkdirSync(dir, { recursive: true });
for (const [name, loops] of Object.entries(VARIANTS)) {
  const proj = path.join(WORK, `policy-proj-${name}`);
  makeProject(proj, N);
  const cfgFile = path.join(proj, 'readme-runtime.json');
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  cfg.cards[0].loops = loops;
  fs.writeFileSync(cfgFile, `${JSON.stringify(cfg, null, 2)}\n`);
  run(process.execPath, [path.join(ROOT, 'bin/readme-runtime.js'), 'build', '--json'], { cwd: proj });
  fs.copyFileSync(path.join(proj, 'readme-runtime/mockcraft.svg'), path.join(dir, `${name}.svg`));
}

// ------------------------------------------------------------------ pages
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/page') {
    const f = u.searchParams.get('f');
    const below = u.searchParams.get('below') === '1';
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(`<!doctype html><meta charset="utf-8"><body style="margin:0">${below ? '<div style="height:6000px"></div>' : ''}${f ? `<img id="m" src="/a/${f}?${Math.random()}" width="${CARD.W}" height="${CARD.H}">` : ''}</body>`);
  }
  const file = path.join(dir, path.basename(u.pathname));
  if (!fs.existsSync(file)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox" });
  res.end(fs.readFileSync(file));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;

const TYPES = { chromium, firefox, webkit };
const LAUNCH = { chromium: { args: ['--force-prefers-no-reduced-motion'] }, firefox: { firefoxUserPrefs: { 'ui.prefersReducedMotion': 0 } }, webkit: {} };
const results = { environment: environment(), steps: N, runMs: RUN_MS, engines: {} };

async function session(engine, fn) {
  const launched = await TYPES[engine].launchServer(LAUNCH[engine]);
  try {
    const browser = await TYPES[engine].connect(launched.wsEndpoint());
    const page = await (await browser.newContext({ viewport: { width: CARD.W + 40, height: CARD.H + 40 }, reducedMotion: 'no-preference' })).newPage();
    return { version: browser.version(), ...(await fn(page, launched.process().pid)) };
  } finally {
    await launched.close().catch(() => {});
  }
}
// three screenshots 0.5 s apart: the steps shown (the hold frames after step 40 look like 40)
async function shown(page) {
  const out = [];
  for (let i = 0; i < 3; i++) {
    if (i) await page.waitForTimeout(500);
    out.push(identify(await page.locator('#m').screenshot(), N));
  }
  return { frames: out.map((x) => x.frame), maxDistance: round(Math.max(...out.map((x) => x.d)), 2), moving: new Set(out.map((x) => x.frame)).size > 1 };
}
const cpuWindow = async (pid, ms) => {
  const a = treeTotals(processTree(pid));
  const t0 = performance.now();
  await new Promise((r) => setTimeout(r, ms));
  const b = treeTotals(processTree(pid));
  return a && b ? round((b.cpuMs - a.cpuMs) / 10 / ((performance.now() - t0) / 1000), 1) : null;
};

for (const engine of ENGINES) {
  const out = { reachedLate: {}, cpu: {} };
  results.engines[engine] = out;
  for (const [name] of Object.entries({ once: 1, endless: 0 })) {
    for (const below of [false, true]) {
      const r = await session(engine, async (page) => {
        await page.goto(`${origin}/page?f=${name}.svg&below=${below ? 1 : 0}`);
        await page.waitForTimeout(12000);
        await page.evaluate(() => document.getElementById('m').scrollIntoView());
        await page.waitForTimeout(100);
        return shown(page);
      });
      out.version = r.version;
      delete r.version;
      out.reachedLate[`${name}-${below ? 'below' : 'inView'}`] = r;
      console.log(engine, name, below ? 'below' : 'in view', JSON.stringify(r));
    }
  }
  // CPU: the empty page, then each card in view and out of view, in the first run and after 30 s
  for (const [name] of Object.entries({ three: 3, endless: 0 })) {
    for (const below of [false, true]) {
      const r = await session(engine, async (page, pid) => {
        await page.goto(`${origin}/page`);
        await page.waitForTimeout(2000);
        const base = await cpuWindow(pid, 6000);
        await page.goto(`${origin}/page?f=${name}.svg&below=${below ? 1 : 0}`);
        await page.waitForTimeout(1000);
        const early = await cpuWindow(pid, 6000);
        await page.waitForTimeout(Math.max(0, 3 * RUN_MS + 2000 - 7000));
        const late = await cpuWindow(pid, 6000);
        return { base, early: round(early - base, 1), afterRuns: round(late - base, 1), afterRunsAtS: round((3 * RUN_MS + 2000) / 1000, 0) };
      });
      delete r.version;
      out.cpu[`${name}-${below ? 'below' : 'inView'}`] = r;
      console.log(engine, 'cpu', name, below ? 'below' : 'in view', JSON.stringify(r));
    }
  }
  // a long view: the endless card in view for LONG_S seconds, CPU and memory every 30 s
  const r = await session(engine, async (page, pid) => {
    await page.goto(`${origin}/page`);
    await page.waitForTimeout(2000);
    const base = await cpuWindow(pid, 6000);
    const ws0 = treeTotals(processTree(pid))?.ws ?? null;
    await page.goto(`${origin}/page?f=endless.svg`);
    const samples = [];
    for (let s = 0; s < LONG_S; s += 30) {
      const cpu = await cpuWindow(pid, 30000);
      const ws = treeTotals(processTree(pid))?.ws ?? null;
      samples.push({ atS: s + 30, cpu: cpu == null ? null : round(cpu - base, 1), memDeltaMB: ws == null || ws0 == null ? null : round((ws - ws0) / 2 ** 20, 0) });
    }
    return { samples };
  });
  out.longView = r.samples;
  console.log(engine, 'long view', JSON.stringify(r.samples));
  writeJson('policy.json', results);
}
server.close();
writeJson('policy.json', results);
