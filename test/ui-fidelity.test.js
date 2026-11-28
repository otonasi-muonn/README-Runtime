import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generate } from '../src/generate.js';
import { normalizeLengthZeros } from '../src/ui/style-values.js';
import { bundleEntry, renderWith } from '../src/ui/bundle.js';
import { inferTemplate, instantiate, templateToXhtml } from '../src/ui/infer.js';
import { parseHtml, toXhtml } from '../src/ui/html.js';

async function component(t, source) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-fidelity-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
  fs.writeFileSync(path.join(dir, 'demo.jsx'), source);
  return bundleEntry('demo.jsx', { cwd: dir });
}
const view = (name, lo, hi) => ({ name, range: { lo, hi } });
const direct = (bundle, values) => toXhtml(parseHtml(renderWith(bundle, values)));
const serialize = (template) => templateToXhtml(template, (name) => `v_${name}`);
const cases = (markup) => (markup.match(/<rr-case /g) ?? []).length;

test('React numeric lengths can cross zero without narrowing the view or editing the component', async (t) => {
  const bundle = await component(t, `export default function Demo({ x }) {
    return <div style={{ width: 200, height: 100 }}><i style={{ left: x, top: -x, marginLeft: x * 2, opacity: x / 200, '--n': x }} /></div>;
  }`);
  const { template, info } = inferTemplate(bundle, [view('x', 0, 128)], { base: { x: 0 } });
  assert.equal(info.discrete.length, 0);
  const { markup } = serialize(template);
  assert.match(markup, /left:calc\(\(var\(--v_x\)\) \* 1px\)/);
  assert.match(markup, /opacity:calc\(var\(--v_x\) \* 0\.005\)/);
  assert.match(markup, /--n:calc\(var\(--v_x\)\)/);
  for (const x of [1, 63, 128]) assert.equal(instantiate(template, { x }), direct(bundle, { x }));
  assert.match(instantiate(template, { x: 0 }), /left:0px;top:0px;margin-left:0px;opacity:0;--n:0/);
});

test('equivalent variants share markup while all discrete values and base fallback remain selectable', async (t) => {
  const bundle = await component(t, `export default function Demo({ mode, x }) {
    return <div><b className={mode % 2 ? 'odd' : 'even'} style={{ left: 10 + x }}>{x}</b></div>;
  }`);
  const { template, info } = inferTemplate(bundle, [view('mode', 0, 31), view('x', 0, 100)], { base: { mode: 7, x: 0 } });
  const { markup, css } = serialize(template);
  assert.equal(cases(markup), 2, 'only two visually distinct subtrees are stored');
  assert.equal(info.discrete[0].combinations, 32);
  assert.equal(info.discrete[0].variants, 2);
  for (let mode = 0; mode < 32; mode++) {
    assert.equal(instantiate(template, { mode, x: 53 }), direct(bundle, { mode, x: 53 }));
    if (mode % 2 === 0) assert.ok(css.includes(`style(--v_mode: ${mode})`));
  }
  assert.match(markup, /class="rr-c [^"]*rr-d"><b class="odd"/);
});

test('conditional children keep a shared parent, prefix and suffix once, including an empty case', async (t) => {
  const bundle = await component(t, `export default function Demo({ on, x }) {
    return <main style={{ width: 200, height: 100 }}><header>shared header</header>{on ? <b style={{ left: 1 + x }}>badge {x}</b> : null}<footer>shared footer</footer></main>;
  }`);
  const { template, info } = inferTemplate(bundle, [view('on', 0, 1), view('x', 0, 100)], { base: { on: 0, x: 0 } });
  const { markup } = serialize(template);
  assert.equal((markup.match(/<main /g) ?? []).length, 1);
  assert.equal((markup.match(/<header>/g) ?? []).length, 1);
  assert.equal((markup.match(/<footer>/g) ?? []).length, 1);
  assert.equal(cases(markup), 2);
  assert.equal(info.discrete[0].path, '0.1');
  const { rootSize } = await import('../src/ui/index.js');
  assert.deepEqual(rootSize(template), { width: 200, height: 100 });
  for (const on of [0, 1]) for (const x of [0, 37, 100]) {
    assert.equal(instantiate(template, { on, x }), direct(bundle, { on, x }));
  }
});

test('factoring preserves interacting switches, affine bindings and inline SVG definition ownership', async (t) => {
  const bundle = await component(t, `export default function Demo({ a, b, x }) {
    return <section><h1>shared</h1>{a ? <i className={b ? 'hot' : 'cold'} style={{ left: 1 + x }}>value {x}</i> : null}<svg width="40" height="20"><defs><linearGradient id="g"><stop stopColor="red" /></linearGradient></defs><rect width="40" height="20" fill="url(#g)" stroke={b ? 'red' : 'blue'} /></svg></section>;
  }`);
  const { template } = inferTemplate(bundle, [view('a', 0, 1), view('b', 0, 1), view('x', 0, 100)], { base: { a: 0, b: 0, x: 0 } });
  const { markup } = serialize(template);
  assert.equal((markup.match(/<h1>/g) ?? []).length, 1);
  assert.ok(!/<svg[^>]*>(?:(?!<\/svg>)[\s\S])*<rr-/.test(markup));
  assert.match(markup, /id="g-rr\d+-\d+"/);
  for (const a of [0, 1]) for (const b of [0, 1]) for (const x of [0, 91]) {
    assert.equal(instantiate(template, { a, b, x }), direct(bundle, { a, b, x }));
  }
});

test('zero normalization leaves unitless values, custom properties, explicit units and quoted CSS intact', async (t) => {
  assert.equal(normalizeLengthZeros('left:0;opacity:0;--x:0;line-height:0;stroke-width:0;content:";left:0";background:url("data:;top:0");top:0%;width:0em'),
    'left:0px;opacity:0;--x:0;line-height:0;stroke-width:0;content:";left:0";background:url("data:;top:0");top:0%;width:0em');
  const bundle = await component(t, `export default function Demo({ x }) { return <div style={{ strokeWidth: x, lineHeight: x, order: x }} />; }`);
  const { template } = inferTemplate(bundle, [view('x', 0, 100)], { base: { x: 0 } });
  for (const x of [0, 1, 100]) assert.equal(instantiate(template, { x }), direct(bundle, { x }));
});

test('compression retains the combination budget and refuses unsupported numeric formatting', async (t) => {
  const bundle = await component(t, `export default function Demo({ x }) { return <b className={x % 2 ? 'odd' : 'even'}>{String(x).padStart(3, '0')}</b>; }`);
  assert.throws(() => inferTemplate(bundle, [view('x', 0, 100)], { base: { x: 0 } }), (e) => ['UI_NONLINEAR', 'UI_VERIFY'].includes(e.code));
  const combined = await component(t, `export default function Demo({ a, b, c }) { return <b className={a + '-' + b + '-' + c} />; }`);
  assert.throws(() => inferTemplate(combined, ['a', 'b', 'c'].map((name) => view(name, 0, 8)), { base: { a: 0, b: 0, c: 0 } }),
    (e) => e.code === 'UI_TOO_MANY_VARIANTS');
});

test('a stylesheet that selects on direct children keeps variants where they were inferred; sizes are UTF-8 bytes', async (t) => {
  // shared parents would put a wrapper between <ul> and its <li>: .list > li and .list:empty
  // would stop matching. The card keeps the variants at the inferred region (the whole <ul>).
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-fidelity-report-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
  fs.writeFileSync(path.join(dir, 'demo.jsx'), `export default function Demo({ on }) {
    return <ul className="list" style={{ width: 200, height: 100 }}>{on ? <li>状態</li> : null}</ul>;
  }`);
  const wasm = fs.readFileSync(fileURLToPath(new URL('../examples/mockcraft/logic.wasm', import.meta.url)));
  const card = async (css) => {
    fs.writeFileSync(path.join(dir, 'style.css'), css);
    return generate(wasm, { init: 1536, steps: 4, cwd: dir, ui: { entry: 'demo.jsx', css: ['style.css'], views: { on: 'view_on' } } });
  };
  const r = await card('.list > li { color: red; } .list:empty { background: blue; }');
  assert.equal(r.ui.sharedParents.used, false);
  assert.match(r.ui.sharedParents.reason, /\.list > li/);
  assert.match(r.svg, /<ul class="list"[^>]*><li>状態<\/li><\/ul>/, 'the <li> stays a direct child of the <ul>');
  assert.match(r.svg, /<ul class="list"[^>]*><\/ul>/, 'the empty <ul> stays empty');
  assert.ok(r.ui.cssBytes > 0 && r.ui.bindingCssBytes > 0);
  const inferred = inferTemplate(await bundleEntry('demo.jsx', { cwd: dir }), [view('on', 0, 1)], { base: { on: 1 } });
  const { markup, variantBytes } = serialize(inferred.merged.template);
  assert.equal(r.ui.markupBytes, Buffer.byteLength(markup));
  assert.equal(r.ui.variantBytes, variantBytes);
  // without such selectors the parent is shared: only the <li> is a variant
  const plain = await card('.list { color: red; }');
  assert.equal(plain.ui.sharedParents.used, true);
  assert.match(plain.svg, /<ul class="list"[^>]*>(?:<rr-case[^>]*>(?:<li>状態<\/li>)?<\/rr-case>){2}<\/ul>/);
  assert.equal(plain.ui.elements, 4, 'ul, two case wrappers and the conditional li');
  // :has() sees the hidden copies, url(#id) in CSS the renamed definitions: no shared parents
  for (const [css, why] of [['.list:has(li) { color: red; }', /\.list:has\(li\)/], ['.list { fill: url(#paint); }', /url\(#id\)/]]) {
    const c = await card(css);
    assert.equal(c.ui.sharedParents.used, false, css);
    assert.match(c.ui.sharedParents.reason, why);
  }
});

test('elements whose content is their value or their direct children keep variants outside them', async (t) => {
  // a wrapper inside <textarea> hides its text, one inside <select> hides its options
  const bundle = await component(t, `export default function Demo({ on }) {
    return <div style={{ width: 100, height: 50 }}>
      <textarea readOnly value={on ? 'enabled' : 'disabled'} />
      <select value={on ? 'b' : 'a'} onChange={() => {}}><option value="a">A</option><option value="b">B</option></select>
      <table><tbody><tr><td>{on ? 'yes' : 'no'}</td></tr></tbody></table>
    </div>;
  }`);
  const { template } = inferTemplate(bundle, [view('on', 0, 1)], { base: { on: 0 } });
  const { markup } = serialize(template);
  for (const tag of ['textarea', 'select', 'table']) {
    for (const [inside] of markup.matchAll(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}>`, 'g'))) {
      assert.doesNotMatch(inside, /<rr-case/, `no variant wrapper inside <${tag}>`);
    }
  }
  for (const on of [0, 1]) assert.equal(instantiate(template, { on }), direct(bundle, { on }));
});

test('a shared part never refers to a definition that a changing part renames', async (t) => {
  // a conditional child makes the whole <div> the region; its gradient changes and the
  // rectangle that paints with it does not: factoring must not move the rectangle out of the
  // variants, because each variant renames its own gradient
  const bundle = await component(t, `export default function Demo({ on }) {
    return <div style={{ width: 100, height: 50 }}>
      <svg width="0" height="0"><defs><linearGradient id="g"><stop stopColor={on ? 'red' : 'blue'} /></linearGradient></defs></svg>
      {on ? <i /> : null}
      <svg width="40" height="40"><rect width="40" height="40" fill="url(#g)" /></svg>
    </div>;
  }`);
  const { template } = inferTemplate(bundle, [view('on', 0, 1)], { base: { on: 0 } });
  const { markup } = serialize(template);
  // every url(#…) points at an element of the same variant (or a shared one)
  for (const piece of markup.split(/<rr-case /).slice(1)) {
    for (const [, id] of piece.matchAll(/url\(#([^)]+)\)/g)) assert.match(piece, new RegExp(`id="${id}"`), `url(#${id}) and its definition are in the same variant`);
  }
  assert.doesNotMatch(markup.replace(/<rr-case[\s\S]*<\/rr-case>/g, ''), /url\(#g/, 'no shared element refers to the gradient');
  for (const on of [0, 1]) assert.equal(instantiate(template, { on }), direct(bundle, { on }));
});
