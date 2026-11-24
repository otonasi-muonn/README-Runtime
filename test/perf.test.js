// What a card asks of its viewers: the clock's loops, and the performance report and
// warnings (with a fix for readme-runtime.json) that build returns.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import { spawnSync } from 'node:child_process';
import { generate, OptionError, DEFAULTS } from '../src/generate.js';
import { perfReport, PERF_LIMITS } from '../src/perf.js';

const root = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const collatz = fs.readFileSync(path.join(root, 'examples/collatz/collatz.wasm'));
const base = { export: 'step', init: 27, steps: 40, haltValue: 1 };
const clock = (svg) => svg.match(/\.C\{animation:([^}]*)\}/)[1];

test('loops: a finite clock stops on the last step, "infinite" keeps running', async () => {
  // the default ("auto"): whole runs for at least a minute; 53 clock steps x 150 ms = 7.95 s
  const auto = await generate(collatz, base);
  assert.equal(DEFAULTS.loops, 'auto');
  assert.match(clock(auto.svg), /^rrclk 7950ms steps\(53,jump-none\) 8 forwards$/);
  assert.deepEqual([auto.perf.report.loops, auto.perf.report.activeSeconds], [8, 63.6]);
  assert.match(clock((await generate(collatz, { ...base, steps: 400, stepMs: 1000 })).svg), / 1 forwards$/);
  assert.match(clock((await generate(collatz, { ...base, loops: 3 })).svg), /^rrclk \d+ms steps\(53,jump-none\) 3 forwards$/);
  assert.match(clock((await generate(collatz, { ...base, loops: 'infinite' })).svg), /^rrclk \d+ms steps\(53,jump-none\) infinite$/);
  for (const loops of [0, -1, 1.5, 'forever', null]) {
    await assert.rejects(generate(collatz, { ...base, loops }), (e) => e instanceof OptionError && /"loops"/.test(e.message), String(loops));
  }
});

test('perf report: update rate, run length and display size, with a fix per warning', async () => {
  const r = await generate(collatz, { ...base, stepMs: 60, loops: 2 });
  assert.equal(r.perf.report.updatesPerSecond, 16.7);
  assert.equal(r.perf.report.loopSeconds, 3.2); // (40 + 12 + 1) x 60 ms
  assert.equal(r.perf.report.activeSeconds, 6.4);
  assert.ok(r.perf.report.displayElements > 50 && r.perf.report.gzipBytes < r.perf.report.bytes);
  assert.deepEqual(r.perf.warnings.map((w) => [w.code, w.fix]), [['PERF_FAST_CLOCK', { stepMs: 150 }]]);
  const long = perfReport({ ...DEFAULTS, ...base, steps: PERF_LIMITS.longRun + 1, loops: 'infinite' }, r.svg);
  assert.deepEqual(long.warnings.map((w) => w.code), ['PERF_ENDLESS', 'PERF_LONG_RUN']);
  assert.ok(long.warnings.every((w) => w.message.length > 40 && Object.keys(w.fix).length === 1));
});

test('build --json reports perf and warnings, also for a card that did not change', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-perf-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
  fs.copyFileSync(path.join(root, 'examples/collatz/collatz.wasm'), path.join(dir, 'c.wasm'));
  fs.writeFileSync(path.join(dir, 'readme-runtime.json'), JSON.stringify({ cards: [{ name: 'c', wasm: 'c.wasm', init: 27, steps: 40, halt: 1, stepMs: 60, loops: 1 }] }));
  for (const state of ['written', 'cached']) {
    const r = spawnSync(process.execPath, [path.join(root, 'bin/readme-runtime.js'), 'build', '--json'], { cwd: dir, encoding: 'utf8' });
    const card = JSON.parse(r.stdout).cards[0];
    assert.equal(card.card, state);
    assert.equal(card.perf.updatesPerSecond, 16.7);
    assert.deepEqual(card.warnings.map((w) => w.code), ['PERF_FAST_CLOCK'], state);
  }
});
