// UI cards: reused files are unchanged, the binding inference is faithful, UI inputs drive
// differential builds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import crypto from 'node:crypto';
import { bundleEntry, renderWith, UiError } from '../src/ui/bundle.js';
import { inferTemplate, instantiate, templateToXhtml } from '../src/ui/infer.js';
import { parseHtml, toXhtml } from '../src/ui/html.js';
import { build, check } from '../src/project.js';

const root = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const parseAndSerialize = (html) => toXhtml(parseHtml(html));

test('the examples use the upstream files byte-for-byte', () => {
  const repos = {};
  for (const name of fs.readdirSync(path.join(root, 'examples'))) {
    const dir = path.join(root, 'examples', name);
    if (!fs.existsSync(path.join(dir, 'upstream.json'))) continue;
    const m = JSON.parse(fs.readFileSync(path.join(dir, 'upstream.json'), 'utf8'));
    repos[name] = m.repository;
    for (const [f, hash] of Object.entries(m.files)) {
      const got = crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, 'upstream', f))).digest('hex');
      assert.equal(got, hash, `${name}: ${f}`);
    }
  }
  assert.match(repos.mockcraft, /otonasi-muonn\/UIdesign/);
  assert.match(repos['air-drawing'], /otonasi-muonn\/air-drawing-board/);
});

test('inference: affine style numbers, text counters, discrete variants', async () => {
  const b = await bundleEntry('test/fixtures/ui/widget.jsx', { cwd: root });
  const views = [{ name: 'x', range: { lo: 0, hi: 100 } }, { name: 'on', range: { lo: 0, hi: 1 } }, { name: 'n', range: { lo: 0, hi: 50 } }];
  const samples = [{ x: 0, on: 0, n: 0 }, { x: 37, on: 1, n: 5 }, { x: 100, on: 0, n: 50 }];
  const { template, info } = inferTemplate(b, views, { base: samples[0], samples });
  assert.deepEqual(info.numeric.map((v) => [v.view, v.sites]), [['x', 1], ['on', 0], ['n', 1]]);
  assert.ok(info.discrete.some((d) => d.views.includes('on')));
  for (const s of [{ x: 12, on: 1, n: 7 }, { x: 99, on: 0, n: 0 }]) {
    assert.equal(instantiate(template, s), instantiate(template, s));
  }
  const { markup, css } = templateToXhtml(template, (v) => `rview_${v}`);
  assert.match(markup, /left:calc\(\(var\(--rview_x\) \* 2 \+ 10\) \* 1px\)/);
  assert.match(markup, /counter-reset:rr-n calc\(var\(--rview_n\) \* 3 \+ 1\)/);
  assert.match(css, /@container style\(--rview_on: 1\)/);
  assert.ok(!/\b(ON|OFF)\b/.test(markup.replace(/<rr-case[^>]*>.*?<\/rr-case>/g, '')), 'text that depends on a view only appears inside variants');
});

test('inference: numbers and elements that exist only for some values of another view', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-ui-'));
  try {
    // the box (and its numbers) exist only in mode 1; the badge only in mode 2, and its class
    // depends on "on" there only
    fs.writeFileSync(path.join(dir, 'c.jsx'), `export default function C({ mode, x, on }) {
  return <div style={{ width: 300, height: 100 }}>
    <span className={mode === 1 ? 'tab sel' : 'tab'}>edit</span>
    {mode === 1 && <i className="box" style={{ left: 20 + x * 4, top: 8 }}>{x * 2}</i>}
    {mode === 2 && <b className={on ? 'badge on' : 'badge'}>preview</b>}
  </div>;
}
`);
    const b = await bundleEntry('c.jsx', { cwd: dir });
    const views = [{ name: 'mode', range: { lo: 0, hi: 2 } }, { name: 'x', range: { lo: 0, hi: 200 } }, { name: 'on', range: { lo: 0, hi: 1 } }];
    const { template } = inferTemplate(b, views, { base: { mode: 0, x: 0, on: 0 }, samples: [{ mode: 0, x: 0, on: 0 }] });
    for (const s of [{ mode: 1, x: 0, on: 0 }, { mode: 1, x: 137, on: 1 }, { mode: 2, x: 5, on: 1 }, { mode: 2, x: 5, on: 0 }]) {
      assert.equal(instantiate(template, s), parseAndSerialize(renderWith(b, s)), JSON.stringify(s));
    }
    const { markup } = templateToXhtml(template, (v) => `rview_${v}`);
    assert.match(markup, /left:calc\(\(var\(--rview_x\) \* 4 \+ 20\) \* 1px\)/, 'x is bound inside the mode-1 variant');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Tailwind 3 projects are compiled with their own Tailwind 3 and config', async (t) => {
  // a Tailwind 3 project: its own tailwindcss 3 (README Runtime's dev copy) and postcss
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-tw3-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
  fs.mkdirSync(path.join(dir, 'node_modules'));
  fs.symlinkSync(path.join(root, 'node_modules/tailwindcss3'), path.join(dir, 'node_modules/tailwindcss'), 'junction');
  fs.symlinkSync(path.join(root, 'node_modules/postcss'), path.join(dir, 'node_modules/postcss'), 'junction');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'tw3', devDependencies: { tailwindcss: '3.4.19' } }));
  fs.writeFileSync(path.join(dir, 'tailwind.config.js'), 'module.exports = { content: ["./src/**/*.jsx"], theme: { extend: { colors: { brand: "#123456" } } } };\n');
  fs.writeFileSync(path.join(dir, 'app.css'), '@tailwind base;\r\n@tailwind components;\r\n@tailwind utilities;\r\nbody { color: #0f172a; }\r\n');
  const { compileUiCss } = await import('../src/ui/style.js');
  const out = await compileUiCss(['app.css'], ['bg-brand', 'px-4', 'text-slate-700'], { cwd: dir });
  assert.match(out.css, /\.bg-brand \{[^}]*rgb\(18 52 86/, 'the project config (theme.extend) is used');
  assert.match(out.css, /\.px-4 \{\s*padding-left: 1rem;/, 'the v3 default theme is used');
  assert.match(out.css, /\.rr-ui \{\s*color: #0f172a;/, 'body rules move to the UI wrapper');
  assert.ok(!out.css.includes('\r'), 'line endings are normalized');
  assert.deepEqual(out.inputs, ['app.css', 'tailwind.config.js']);
});

test('the UI size comes from the root element, also when the root has variants', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-ui-'));
  try {
    fs.writeFileSync(path.join(dir, 'r.jsx'), 'export default function R({ on }) { return <div style={{ width: 320, height: 90 }}>{on ? <b>banner</b> : null}<p>body</p></div>; }\n');
    const b = await bundleEntry('r.jsx', { cwd: dir });
    const { template, info } = inferTemplate(b, [{ name: 'on', range: { lo: 0, hi: 1 } }], { base: { on: 0 } });
    assert.equal(info.discrete[0].path, '0', 'the root element is the variant region');
    const { rootSize } = await import('../src/ui/index.js');
    assert.deepEqual(rootSize(template), { width: 320, height: 90 });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('renders do not depend on the host time zone or locale; missing dependencies are named', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-ui-'));
  try {
    fs.writeFileSync(path.join(dir, 'd.jsx'), 'export default function D() { const d = new Date(); return <p>{d.getHours()}|{d.toLocaleDateString()}|{(1234567.5).toLocaleString()}|{new Intl.DateTimeFormat(undefined, { hour: "numeric" }).format(d)}</p>; }\n');
    const b = await bundleEntry('d.jsx', { cwd: dir });
    assert.equal(renderWith(b, {}), '<p>0|1/1/2026|1,234,567.5|12 AM</p>');
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', dependencies: { 'tiny-cls': '1.0.0' } }));
    fs.writeFileSync(path.join(dir, 'e.jsx'), 'import cls from "tiny-cls";\nexport default function E() { return <p className={cls("a")}>x</p>; }\n');
    await assert.rejects(bundleEntry('e.jsx', { cwd: dir }), (e) => e.code === 'DEPS_NOT_INSTALLED' && /"tiny-cls" is a dependency/.test(e.message));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('attributes stay: type, ids, CSS-selected data-*; SVG defs get per-variant ids; number text is kept', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-ui-'));
  try {
    fs.writeFileSync(path.join(dir, 'a.jsx'), `export default function A({ on, x }) {
  return <div style={{ width: 300, height: 100 }}>
    <input type="checkbox" readOnly checked={false} />
    <b data-state={on ? 'on' : 'off'} data-debug={on ? 'yes' : 'no'}>pill</b>
    <i style={{ left: 10 + x, background: '#0a0', opacity: '0.50' }} />
    <svg width="50" height="20"><defs><marker id="arrow"><path d="M0 0L5 5" /></marker></defs><path d="M0 0L40 0" stroke={on ? 'red' : 'blue'} markerEnd="url(#arrow)" /></svg>
  </div>;
}
`);
    const b = await bundleEntry('a.jsx', { cwd: dir });
    const views = [{ name: 'on', range: { lo: 0, hi: 1 } }, { name: 'x', range: { lo: 0, hi: 200 } }];
    const { template, info } = inferTemplate(b, views, { base: { on: 0, x: 0 }, samples: [{ on: 0, x: 0 }], cssAttrs: new Set(['data-state']) });
    const { markup } = templateToXhtml(template, (v) => `rview_${v}`);
    assert.match(markup, /<input type="checkbox"/, 'type is kept');
    assert.ok(info.discrete.some((d) => d.views.includes('on') && /^0\.1$/.test(d.path)), 'a data-state change that CSS selects on makes variants');
    assert.deepEqual(info.ignoredAttributes, ['data-debug (on)'], 'a data-* change nobody selects on is ignored');
    assert.match(markup, /data-debug="no"/, '...and keeps its base value instead of disappearing');
    assert.match(markup, /background:#0a0;opacity:0\.50/, 'number-like text that is not bound stays as written');
    assert.match(markup, /<marker id="arrow">[\s\S]*url\(#arrow\)/, 'the base variant keeps the original id');
    assert.match(markup, /<marker id="arrow-rr\d+-1">[\s\S]*url\(#arrow-rr\d+-1\)/, 'another variant references its own marker');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('cards keep what CSS uses: attr(), url(#id) from a stylesheet, inherited resets; structural selectors warn', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-ui-css-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
  fs.copyFileSync(path.join(root, 'examples/mockcraft/logic.wasm'), path.join(dir, 'logic.wasm'));
  fs.writeFileSync(path.join(dir, 'd.jsx'), `export default function D({ on }) {
  return <div style={{ width: 300, height: 120 }}>
    <b className="label" data-label={on ? 'OPEN' : 'CLOSED'} />
    <svg width="60" height="20"><defs><linearGradient id="g1"><stop offset="0" stopColor="red" /></linearGradient></defs><rect className="grad" width="60" height="20" stroke={on ? 'black' : 'white'} /></svg>
    <ul className="list"><li className={on ? 'on' : 'off'}><span className="label">a</span></li><li><span className="label">b</span></li></ul>
  </div>;
}
`);
  fs.writeFileSync(path.join(dir, 'a.css'), 'html { box-sizing: border-box; display: grid; min-height: 100vh; }\n*, *::before, *::after { box-sizing: inherit; }\n.label::after { content: attr(data-label); }\n.grad { fill: url(#g1); }\n.list > li .label { color: red; }\n');
  const card = { name: 'c', wasm: 'logic.wasm', export: 'step', init: 1536, steps: 4, ui: { entry: 'd.jsx', css: ['a.css'], views: { on: 'view_on' } } };
  fs.writeFileSync(path.join(dir, 'readme-runtime.json'), JSON.stringify({ cards: [card] }));
  const [r] = await build(path.join(dir, 'readme-runtime.json'), { log: () => {} });
  const svg = fs.readFileSync(path.join(dir, 'readme-runtime/c.svg'), 'utf8');
  assert.ok(svg.includes('data-label="OPEN"') && svg.includes('data-label="CLOSED"'), 'an attribute read by attr() is visual: both values are in the card');
  assert.ok(!r.ui.ignoredAttributes.some((a) => a.startsWith('data-label')));
  assert.match(svg, /\.rr-s(\d+-\d) \.grad \{ fill: url\(#g1-rr\1\); \}/, 'a stylesheet url(#id) follows the renamed id in the non-base variant');
  assert.match(svg, /\.rr-ui \{ box-sizing: border-box; \}/, 'an inherited reset reaches the UI; page layout (grid, 100vh) does not');
  assert.ok(r.ui.warnings?.some((w) => w.code === 'UI_STRUCTURAL_CSS' && w.message.includes('.list > li .label')), 'a child combinator above a switched element warns');
});

test('an exact-value condition on a wide view fails loudly instead of rendering wrong', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-ui-'));
  try {
    fs.writeFileSync(path.join(dir, 'h.jsx'), 'export default function H({ x }) { return <div style={{ width: 300, height: 50 }}><i className={x === 150 ? "hit" : "miss"} style={{ left: x }} /></div>; }\n');
    const b = await bundleEntry('h.jsx', { cwd: dir });
    assert.throws(() => inferTemplate(b, [{ name: 'x', range: { lo: 1, hi: 255 } }], { base: { x: 1 }, samples: [{ x: 1 }] }), (e) => e.code === 'UI_VERIFY' && /"x":150/.test(e.message));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('numbers inside SVG text become variants of the <svg> element', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-ui-'));
  try {
    fs.writeFileSync(path.join(dir, 's.jsx'), 'export default function S({ n }) { return <div style={{ width: 200, height: 60 }}><svg width="100" height="40"><text x="5" y="20">{`score ${n}`}</text></svg><p>{n}</p></div>; }\n');
    const b = await bundleEntry('s.jsx', { cwd: dir });
    const { template, info } = inferTemplate(b, [{ name: 'n', range: { lo: 0, hi: 9 } }], { base: { n: 0 }, samples: [{ n: 0 }] });
    const paths = info.discrete.map((d) => d.path);
    assert.ok(paths.includes('0.0') && !paths.some((p) => p.startsWith('0.0.')), 'the region is the <svg> element, not its text');
    for (const n of [0, 7]) assert.equal(instantiate(template, { n }), parseAndSerialize(renderWith(b, { n })));
    assert.ok(!/<svg[^>]*>(?:(?!<\/svg>)[\s\S])*<rr-/.test(templateToXhtml(template, (v) => `rview_${v}`).markup), 'no HTML-only element inside an <svg>');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the step clock is the only animation of a card, so "reduce motion" stops all motion', () => {
  // any other animated element in an <img> SVG makes browsers re-rasterize the whole image
  // every frame: a pulsing dot kept ~20% of a CPU core busy on a static card (bench/)
  for (const f of fs.readdirSync(path.join(root, 'readme-runtime')).filter((x) => x.endsWith('.svg'))) {
    const svg = fs.readFileSync(path.join(root, 'readme-runtime', f), 'utf8');
    // the card's own CSS comes after the project's stylesheet (which may define animations)
    const own = svg.slice(svg.indexOf('.R{\n'));
    assert.deepEqual([...own.matchAll(/@keyframes (\w+)/g)].map((m) => m[1]), ['rrclk'], f);
    assert.deepEqual([...own.matchAll(/animation:(?!none)[^;}]*/g)].map((m) => m[0].split(' ')[0]), ['animation:rrclk'], f);
    // the reduced-motion rule has the same specificity as the clock's, so it must come later
    const clock = own.indexOf('.C{animation:rrclk ');
    const reduce = own.search(/@media \(prefers-reduced-motion:reduce\)\{\.C\{animation:none;/);
    assert.ok(clock >= 0 && reduce > clock, `${f}: the reduced-motion rule must follow .C's animation`);
    if (svg.includes('class="rr-ui"')) assert.match(svg, /\.rr-ui \*,\.rr-ui \*::before,\.rr-ui \*::after\{animation:none!important;transition:none!important\}/, f);
  }
});

test('inference refuses a non-affine dependence on a wide view', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-ui-'));
  try {
    fs.writeFileSync(path.join(dir, 'sq.jsx'), 'export default function S({ x }) { return <div style={{ width: 300, height: 50 }}><i style={{ left: x * x }} /></div>; }\n');
    const b = await bundleEntry('sq.jsx', { cwd: dir });
    assert.throws(() => inferTemplate(b, [{ name: 'x', range: { lo: 0, hi: 1000 } }], { base: { x: 0 } }), (e) => e instanceof UiError && e.code === 'UI_NONLINEAR');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('framework-only imports fail with a precise message', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-ui-'));
  try {
    fs.writeFileSync(path.join(dir, 'f.jsx'), 'import Image from "next/image";\nexport default function F() { return <Image src="a.png" />; }\n');
    await assert.rejects(bundleEntry('f.jsx', { cwd: dir }), (e) => e.code === 'UI_BUNDLE' && /next\/image.*framework runtime/.test(e.message));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('renders are deterministic even when the component uses Math.random', async () => {
  const b = await bundleEntry('examples/mockcraft/demo.tsx', { tsconfig: 'examples/mockcraft/tsconfig.json', cwd: root });
  const p = { dx: 8, dy: 16, on: 1, sel: 2, hits: 3 };
  assert.equal(renderWith(b, p), renderWith(b, p));
});

test('a CRLF checkout builds the same card, and check accepts it', async (t) => {
  // Windows checkouts with autocrlf: a multi-line class string then contains "\r\n"
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-ui-crlf-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
  fs.cpSync(path.join(root, 'examples/mockcraft'), path.join(dir, 'mc'), { recursive: true });
  const demo = path.join(dir, 'mc/demo.tsx');
  const src = fs.readFileSync(demo, 'utf8').replace('<div style={{', '<div className="rr-a\n      rr-b" style={{');
  assert.ok(src.includes('rr-b'), 'the fixture edit applies');
  fs.writeFileSync(demo, src.replace(/\r?\n/g, '\r\n'));
  const card = {
    name: 'mc', wasm: 'mc/logic.wasm', export: 'step', init: 1536, steps: 8,
    ui: { entry: 'mc/demo.tsx', tsconfig: 'mc/tsconfig.json', views: { dx: 'view_dx', dy: 'view_dy', on: 'view_on', sel: 'view_sel', hits: 'view_hits' } },
  };
  const cfg = path.join(dir, 'readme-runtime.json');
  fs.writeFileSync(cfg, JSON.stringify({ cards: [card] }));
  await build(cfg, { log: () => {} });
  const svg = fs.readFileSync(path.join(dir, 'readme-runtime/mc.svg'), 'utf8');
  assert.match(svg, /class="rr-a\n {6}rr-b"/);
  assert.ok(!svg.includes('\r'));
  assert.deepEqual(await check(cfg, { log: () => {} }), []);
});

test('editing a reused component or stylesheet regenerates the UI card; nothing else does', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-ui-proj-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
  fs.cpSync(path.join(root, 'examples/mockcraft'), path.join(dir, 'mc'), { recursive: true });
  const card = {
    name: 'mc', wasm: 'mc/logic.wasm', export: 'step', init: 1536, steps: 24,
    ui: { entry: 'mc/demo.tsx', tsconfig: 'mc/tsconfig.json', css: ['mc/upstream/src/app/globals.css'], views: { dx: 'view_dx', dy: 'view_dy', on: 'view_on', sel: 'view_sel', hits: 'view_hits' } },
  };
  fs.writeFileSync(path.join(dir, 'readme-runtime.json'), JSON.stringify({ cards: [card] }));
  const cfg = path.join(dir, 'readme-runtime.json');
  const log = () => {};
  const [first] = await build(cfg, { log });
  assert.equal(first.card, 'written');
  const [second] = await build(cfg, { log });
  assert.equal(second.card, 'cached');
  const css = path.join(dir, 'mc/upstream/src/app/globals.css');
  fs.writeFileSync(css, fs.readFileSync(css, 'utf8').replace('.el-badge {', '.el-badge {\n  letter-spacing: 0.2em;'));
  assert.ok((await check(cfg, { log })).length, 'check notices the changed stylesheet');
  const [third] = await build(cfg, { log });
  assert.equal(third.card, 'written');
  assert.match(fs.readFileSync(path.join(dir, 'readme-runtime/mc.svg'), 'utf8'), /letter-spacing: 0\.2em/);
  assert.deepEqual(await check(cfg, { log }), []);
});
