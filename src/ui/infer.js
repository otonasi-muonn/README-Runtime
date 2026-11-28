// Turn a React component's static markup into a CSS-driven template.
//
// The component is rendered with different view values. Wherever the markup changes:
//   - numbers inside a style value or a text node that change affinely with one view value
//     become calc(var(--view) * a + b) (text numbers are shown with a CSS counter);
//   - anything else (a class, a text, an added element) becomes a set of variants of the
//     smallest enclosing element, one per value of the views involved, switched by
//     @container style(--view: k) queries.
// Nothing is rendered per time step: the browser computes the view values from the live
// state and the template follows them. The result is checked against direct renders.
import { parseHtml, toXhtml } from './html.js';
import { renderWith, UiError } from './bundle.js';
import { normalizeLengthZeros } from './style-values.js';
import { optimizeVariants, KEEP_WHOLE } from './variants.js';

export const MAX_DISCRETE = 64; // values of one discrete view
export const MAX_COMBINATIONS = 512; // variants of one group of interacting views
const EXHAUSTIVE_BUDGET = 8192; // renders spent on checking wide views value by value

// A number token keeps its source text: an unbound "0.50" or "#000" must come out unchanged.
class Num {
  constructor(text) { this.text = text; this.v = Number(text); }
  toString() { return this.text; }
}
const NUM = /-?(?:\d+(?:\.\d+)?|\.\d+)/g;
function tokenize(s) {
  const parts = [];
  let last = 0;
  for (const m of s.matchAll(NUM)) {
    let start = m.index, text = m[0];
    // a "-" glued to a letter or digit is a hyphen, not a sign
    if (text[0] === '-' && start > 0 && /[\w)]/.test(s[start - 1])) { start++; text = text.slice(1); }
    // digits glued to a name or a "#" are part of it (h1, translate3d, #0969da), not numbers
    if (start > 0 && /[\w#]/.test(s[start - 1])) continue;
    if (start > last) parts.push(s.slice(last, start));
    parts.push(new Num(text));
    last = start + text.length;
  }
  if (last < s.length) parts.push(s.slice(last));
  return parts;
}
const isNum = (p) => p instanceof Num;
const skeleton = (parts) => parts.map((p) => (isNum(p) ? '#' : p)).join('');
const styleTokens = (s) => tokenize(normalizeLengthZeros(s));

const nodeAt = (tree, path) => path.reduce((n, i) => n?.children?.[i], tree);
const pathKey = (p) => p.join('.');
const isPrefix = (a, b) => a.length <= b.length && a.every((x, i) => x === b[i]);
const isSvg = (n) => n?.type === 'el' && n.tag.toLowerCase() === 'svg';

// Attributes that change nothing on screen unless a stylesheet selects on them. When one of
// them changes with a view and no CSS mentions it, its change is ignored (the base value is
// kept in the card); every other attribute change makes variants.
const QUIET = (name) => /^(data-|aria-)/.test(name) || ['title', 'tabindex', 'role', 'name', 'for'].includes(name);

// CSS style properties whose grammar accepts <integer> only (substituting a <number> custom
// property into them is invalid at computed-value time or changes discrete layout slots).
export const DISCRETE_STYLE_PROPS = new Set([
  'z-index', 'order',
  'grid-area',
  'grid-row', 'grid-row-start', 'grid-row-end',
  'grid-column', 'grid-column-start', 'grid-column-end',
  'columns', 'column-count', 'line-clamp', '-webkit-line-clamp',
  'counter-reset', 'counter-increment', 'counter-set',
  'orphans', 'widows', 'math-depth',
]);

export function stylePropAt(parts, index) {
  const before = parts.slice(0, index).map(String).join('');
  let depth = 0, quote = '', declStart = 0, colon = -1;
  for (let i = 0; i < before.length; i++) {
    const ch = before[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '(') depth++;
    else if (ch === ')' && depth > 0) depth--;
    else if (depth === 0 && ch === ';') { declStart = i + 1; colon = -1; }
    else if (depth === 0 && ch === ':' && colon < 0) colon = i;
  }
  return colon < 0 ? null : before.slice(declStart, colon).trim().toLowerCase();
}

export function isContinuousStyleSite(parts, index) {
  const prop = stylePropAt(parts, index);
  if (!prop || DISCRETE_STYLE_PROPS.has(prop)) return false;
  const before = parts.slice(0, index).map(String).join('');
  if (/\b(?:steps|repeat)\(\s*$/i.test(before)) return false;
  return true;
}

// Compare two trees: numeric sites { path, where, index, a, b, continuous? }, structural sites
// { path, why } and ignored attribute changes. ctx: { visual(name), svg }.
function compare(a, b, ctx, path = [], out = { num: [], struct: [], ignored: [] }) {
  if (!a || !b) { out.struct.push({ path, why: 'structure' }); return out; }
  // a different node: the parent element is the region; a different child list: this element
  if (a.type !== b.type || (a.type === 'el' && a.tag !== b.tag)) { out.struct.push({ path: path.slice(0, -1), why: 'structure' }); return out; }
  if (a.children && a.children.length !== b.children.length) { out.struct.push({ path, why: 'structure' }); return out; }
  if (a.type === 'text') {
    if (a.value !== b.value) {
      const pa = tokenize(a.value), pb = tokenize(b.value);
      // CSS counters do not apply inside SVG: a number in SVG text cannot be bound
      if (ctx.svg) out.struct.push({ path: path.slice(0, -1), why: 'svg-text' });
      else if (skeleton(pa) !== skeleton(pb)) out.struct.push({ path: path.slice(0, -1), why: 'text' });
      else pa.forEach((x, i) => { if (isNum(x) && x.v !== pb[i].v) out.num.push({ path, where: 'text', index: i, a: x.v, b: pb[i].v }); });
    }
    return out;
  }
  if (a.type === 'el') {
    const names = a.attrs.map(([k]) => k).join(' ');
    if (names !== b.attrs.map(([k]) => k).join(' ')) { out.struct.push({ path, why: 'attributes' }); return out; }
    a.attrs.forEach(([k, va], i) => {
      const vb = b.attrs[i][1];
      if (va === vb) return;
      if (QUIET(k) && !ctx.visual(k)) { out.ignored.push({ path, attr: k }); return; }
      const pa = k === 'style' ? styleTokens(va) : tokenize(va), pb = k === 'style' ? styleTokens(vb) : tokenize(vb);
      if (k !== 'style' || skeleton(pa) !== skeleton(pb)) {
        const why = k === 'style' && unitlessZero(va, vb) ? 'unit-zero' : ctx.svg && skeleton(pa) === skeleton(pb) ? `svg-attr:${k}` : `attr:${k}`;
        out.struct.push({ path, why });
        return;
      }
      pa.forEach((x, j) => {
        if (isNum(x) && x.v !== pb[j].v) {
          out.num.push({ path, where: `attr:${k}`, index: j, a: x.v, b: pb[j].v, ...(k === 'style' && isContinuousStyleSite(pa, j) ? { continuous: true } : {}) });
        }
      });
    });
  }
  const inner = { ...ctx, svg: ctx.svg || isSvg(a) };
  a.children?.forEach((c, i) => compare(c, b.children[i], inner, [...path, i], out));
  return out;
}

// React writes a 0 length without its unit ("left:0" next to "left:4px")
function unitlessZero(a, b) {
  const norm = (s) => s.replace(/(^|[:\s(,])0(?=[;\s,)]|$)/g, '$10px');
  return skeleton(tokenize(norm(a))) === skeleton(tokenize(norm(b))) || skeleton(tokenize(norm(a))) === skeleton(tokenize(b)) || skeleton(tokenize(a)) === skeleton(tokenize(norm(b)));
}

// Why an element had to become variants, in words, for UI_NONLINEAR.
function because(why) {
  if (why === 'svg-text') return 'a number in SVG text changes, and CSS counters do not work inside SVG: show it in an HTML element, or use a view with at most 64 values';
  if (why === 'unit-zero') return 'React writes 0 without a unit (e.g. "left:0" but "left:4px"), so the style changes form at 0: avoid exactly 0 (e.g. start at 1) or put the value in a transform';
  if (why?.startsWith('svg-attr:')) return `a number in the SVG attribute "${why.slice(9)}" changes; only numbers in style and HTML text can be bound: move it to style (e.g. a transform)`;
  if (why === 'text') return 'a text changes form, not only a number in it (zero padding, decimals, separators or words)';
  if (why?.startsWith('attr:')) return `the attribute "${why.slice(5)}" changes`;
  return 'it changes in a way that is not affine';
}

const siteKey = (s) => `${pathKey(s.path)}|${s.where}|${s.index}`;

function render(bundle, props, cache, classes) {
  const key = JSON.stringify(props);
  let t = cache.get(key);
  if (!t) {
    const html = renderWith(bundle, props);
    for (const m of html.matchAll(/\sclass="([^"]*)"/g)) for (const c of m[1].split(/\s+/)) if (c) classes.add(c);
    t = parseHtml(html);
    cache.set(key, t);
  }
  return t;
}

function minimalRegions(paths) {
  const sorted = [...new Map(paths.map((p) => [pathKey(p), p])).values()].sort((a, b) => a.length - b.length);
  const out = [];
  for (const p of sorted) if (!out.some((q) => isPrefix(q, p))) out.push(p);
  return out;
}

// Fit value = alpha * v + beta through the samples; null unless every sample lies on it.
function fitAffine(points) {
  const [p0, p1] = points;
  if (p1.v === p0.v) return null;
  const alpha = (p1.y - p0.y) / (p1.v - p0.v);
  const beta = p0.y - alpha * p0.v;
  const ok = points.every((p) => Math.abs(alpha * p.v + beta - p.y) < 1e-9);
  return ok ? { alpha: Number(alpha.toFixed(9)), beta: Number(beta.toFixed(9)) } : null;
}

// Values to probe a view with: around the base, plus both ends of its range.
function probes(base, range) {
  const vals = [base + 1, base + 2, base - 1, base - 2, range.lo, range.hi, Math.round((range.lo + range.hi) / 2)];
  return [...new Set(vals.filter((x) => x >= range.lo && x <= range.hi && x !== base))];
}

// views: [{ name, range: { lo, hi } }]; base: { name: value } (the run's first view values);
// samples: view-value objects that must reproduce exactly (the verified run); cssAttrs:
// attribute names the stylesheets select on.
export function inferTemplate(bundle, views, { base, samples = [], cssAttrs = new Set() }) {
  const cache = new Map();
  const classes = new Set();
  const draw = (props) => render(bundle, props, cache, classes);
  // a quiet attribute is visual when a stylesheet or a (Tailwind variant) class names it
  const seenVisual = new Map();
  const visual = (name) => {
    const key = `${name}|${classes.size}`;
    if (!seenVisual.has(key)) seenVisual.set(key, cssAttrs.has(name) || [...classes].some((c) => c.includes(name) || (/^(data|aria)-/.test(name) && c.includes(`${name.slice(0, 5)}[${name.slice(5)}`))));
    return seenVisual.get(key);
  };
  const ctx = { visual, svg: false };
  const cmp = (a, b) => compare(a, b, ctx);
  const R0 = draw(base);
  // a region inside inline SVG is lifted to the <svg> element (variant wrappers are HTML), and
  // one inside an element whose rendering depends on its direct children or text (a <select>'s
  // options, a <textarea>'s value, table rows) to that element: no wrapper goes inside them
  const whole = (n) => n?.type === 'el' && KEEP_WHOLE.has(n.tag.toLowerCase());
  const lift = (p) => { for (let k = 0; k < p.length; k++) if (whole(nodeAt(R0, p.slice(0, k + 1)))) return p.slice(0, k + 1); return p; };
  const numeric = new Map(); // view -> Map(siteKey -> { site, points })
  const regions = new Map(); // view -> [paths]
  const ignored = [];
  for (const v of views) {
    const sites = new Map();
    const structs = [];
    const vals = probes(base[v.name], v.range);
    for (const x of vals) {
      const d = cmp(R0, draw({ ...base, [v.name]: x }));
      structs.push(...d.struct);
      ignored.push(...d.ignored.map((s) => ({ ...s, view: v.name })));
      for (const s of d.num) {
        const k = siteKey(s);
        if (!sites.has(k)) sites.set(k, { site: s, points: [{ v: base[v.name], y: s.a }] });
        sites.get(k).points.push({ v: x, y: s.b });
      }
    }
    // a site whose number is not affine in the view turns its element into a variant region
    for (const [k, { site, points }] of [...sites]) {
      if (points.length < 3 || !fitAffine(points)) { structs.push({ path: site.path, why: 'nonaffine' }); sites.delete(k); }
    }
    if (structs.length) {
      const size = v.range.hi - v.range.lo + 1;
      if (size > MAX_DISCRETE) {
        const seen = samples.map((s) => s[v.name]);
        const run = seen.length ? ` The run itself shows only ${Math.min(...seen)}..${Math.max(...seen)}, but view ranges are derived from the Wasm code for every possible state (an edited init can reach any of them), so the view function itself must bound the value (e.g. a comparison chain or x % n).` : '';
        throw new UiError('UI_NONLINEAR', `the UI depends on view "${v.name}" in a way that cannot be bound (element ${pathKey(structs[0].path)}: ${because(structs[0].why)}), and "${v.name}" can take ${size} values (${v.range.lo}..${v.range.hi}; more than ${MAX_DISCRETE}).${run}`, { view: v.name, path: structs[0].path, range: v.range, why: structs[0].why });
      }
      // a discrete view: every value of its range is rendered, so no changed element is missed
      for (let x = v.range.lo; x <= v.range.hi; x++) {
        if (x === base[v.name] || vals.includes(x)) continue;
        const d = cmp(R0, draw({ ...base, [v.name]: x }));
        structs.push(...d.struct, ...d.num);
        ignored.push(...d.ignored.map((s) => ({ ...s, view: v.name })));
      }
      regions.set(v.name, minimalRegions(structs.map((s) => lift(s.path))));
    }
    numeric.set(v.name, sites);
  }

  // group discrete views whose regions overlap (they need joint variants)
  const discrete = [...regions.keys()];
  const parent = new Map(discrete.map((v) => [v, v]));
  const find = (v) => (parent.get(v) === v ? v : find(parent.get(v)));
  for (const a of discrete) for (const b of discrete) {
    if (a < b && regions.get(a).some((p) => regions.get(b).some((q) => isPrefix(p, q) || isPrefix(q, p)))) parent.set(find(a), find(b));
  }
  const groups = new Map();
  for (const v of discrete) { const r = find(v); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(v); }
  const range = Object.fromEntries(views.map((v) => [v.name, v.range]));
  const size = (v) => range[v].hi - range[v].lo + 1;
  const combosOf = (names) => {
    let combos = [{}];
    for (const v of names) {
      const next = [];
      for (const c of combos) for (let k = range[v].lo; k <= range[v].hi; k++) next.push({ ...c, [v]: k });
      combos = next;
      if (combos.length > MAX_COMBINATIONS) {
        throw new UiError('UI_TOO_MANY_VARIANTS', `views ${names.join(', ')} change the same element and together take more than ${MAX_COMBINATIONS} combinations; narrow their ranges or let them affect different elements`, { views: names });
      }
    }
    return combos;
  };
  const regionOf = (props, p) => nodeAt(draw(props), p);
  const bind = (node, site, view, fit) => {
    node.binds ??= [];
    node.binds.push({ where: site.where, index: site.index, view, ...(site.continuous ? { continuous: true } : {}), ...fit });
  };

  // Inside a switch, the other views are probed again in every variant: a number or an
  // element can exist for some values of the switching views only (a conditional subtree),
  // so probing around the base render alone would miss it. A view whose numbers there are
  // affine is bound per variant; one that changes the structure (or a number non-affinely)
  // joins the switch and is enumerated with it. Returns that view, or null when done.
  function bindVariants(sw) {
    const found = [];
    const inside = (variantNode, other) => compare(variantNode, other, { ...ctx, svg: sw.svg });
    for (const variant of sw.variants) {
      for (const v of views) {
        if (sw.views.includes(v.name)) continue;
        const b0 = variant.props[v.name];
        const ends = [v.range.lo, v.range.hi].filter((x) => x !== b0);
        const differs = (x) => { const d = inside(variant.node, regionOf({ ...variant.props, [v.name]: x }, sw.path)); ignored.push(...d.ignored.map((s) => ({ ...s, view: v.name }))); return d.struct.length || d.num.length; };
        if (!ends.some(differs)) continue;
        const pts = new Map();
        for (const x of probes(b0, v.range)) {
          const d = inside(variant.node, regionOf({ ...variant.props, [v.name]: x }, sw.path));
          ignored.push(...d.ignored.map((s) => ({ ...s, view: v.name })));
          if (d.struct.length) return { view: v.name, why: d.struct[0].why };
          for (const s of d.num) {
            const k = siteKey(s);
            if (!pts.has(k)) pts.set(k, { site: s, points: [{ v: b0, y: s.a }] });
            pts.get(k).points.push({ v: x, y: s.b });
          }
        }
        for (const { site, points } of pts.values()) {
          const fit = points.length >= 3 && fitAffine(points);
          if (!fit) return { view: v.name, why: 'nonaffine' };
          found.push([variant, site, v.name, fit]);
        }
      }
    }
    for (const [variant, site, view, fit] of found) bind(nodeAt(variant.node, site.path), site, view, fit);
    return null;
  }

  const switches = []; // { views, path, variants: [{ combo, props, node }] }
  for (const members of groups.values()) {
    for (const p of minimalRegions(members.flatMap((v) => regions.get(v)))) {
      // only the views that actually change this element are enumerated for it
      const sw = { views: members.filter((v) => regions.get(v).some((q) => isPrefix(q, p) || isPrefix(p, q))), path: p };
      // whether the region lies inside inline SVG (only the <svg> element itself can, after lifting)
      sw.svg = p.some((_, k) => k < p.length - 1 && isSvg(nodeAt(R0, p.slice(0, k + 1))));
      for (;;) {
        sw.variants = combosOf(sw.views).map((combo) => {
          const props = { ...base, ...combo };
          const node = regionOf(props, p);
          if (!node) throw new UiError('UI_NONLINEAR', `element ${pathKey(p)} does not exist for view values ${JSON.stringify(combo)}: the views ${sw.views.join(', ')} change the structure around it; let one view decide whether the whole block is shown`, { views: sw.views, path: p });
          return { combo, props, node: structuredClone(node) };
        });
        const more = bindVariants(sw);
        if (!more) break;
        if (size(more.view) > MAX_DISCRETE) {
          throw new UiError('UI_NONLINEAR', `view "${more.view}" changes element ${pathKey(p)} when ${sw.views.join(', ')} take other values (${because(more.why)}), and "${more.view}" can take ${size(more.view)} values (more than ${MAX_DISCRETE}). Make that part depend on "${more.view}" linearly in every case (e.g. keep the element and hide it with a style), or narrow "${more.view}" in its Wasm view function.`, { view: more.view, path: p, why: more.why });
        }
        sw.views = [...sw.views, more.view];
      }
      switches.push(sw);
    }
  }
  const inSwitch = (p) => switches.find((s) => isPrefix(s.path, p));

  // numeric bindings outside switches go on the base tree (inside, bindVariants did them)
  let template = structuredClone(R0);
  for (const v of views) {
    for (const { site, points } of numeric.get(v.name).values()) {
      if (inSwitch(site.path)) continue;
      if (regions.get(v.name)?.some((p) => isPrefix(p, site.path))) continue;
      bind(nodeAt(template, site.path), site, v.name, fitAffine(points));
    }
  }
  // replace switch regions (deepest first, so paths stay valid)
  const ordered = [...switches].sort((a, b) => b.path.length - a.path.length);
  ordered.forEach((sw, i) => { sw.id = i; });
  for (const sw of ordered) {
    const baseIndex = sw.variants.findIndex((x) => Object.entries(x.combo).every(([k, v]) => base[k] === v));
    const node = { type: 'switch', id: sw.id, views: sw.views, base: baseIndex, variants: sw.variants.map((x) => ({ combo: x.combo, node: x.node })) };
    if (!sw.path.length) Object.assign(template, { type: 'root', children: [node] });
    else nodeAt(template, sw.path.slice(0, -1)).children[sw.path.at(-1)] = node;
  }
  // attributes whose changes were ignored keep their base value in the card; the
  // verification below therefore compares without them (they are not visual)
  const ignoredNames = new Set(ignored.map((x) => x.attr));
  template.ignore = [...ignoredNames];
  // two placements of the same variants: shared parents (smaller), and merged only (the
  // inferred regions); buildUi picks the second when the stylesheet depends on direct children
  const merged = optimizeVariants(template, { share: false });
  const optimized = optimizeVariants(template);
  template = optimized.template;
  const continuousSet = new Set();
  const collectContinuous = (n) => {
    if (n.type === 'switch') { n.variants.forEach((x) => collectContinuous(x.node)); return; }
    for (const b of n.binds ?? []) if (b.continuous) continuousSet.add(b.view);
    n.children?.forEach(collectContinuous);
  };
  collectContinuous(template);
  const info = {
    numeric: views.map((v) => ({ view: v.name, sites: [...numeric.get(v.name).values()].length })),
    continuousViews: views.map((v) => v.name).filter((name) => continuousSet.has(name)),
    discrete: optimized.discrete,
    ignoredAttributes: [...new Set(ignored.map((x) => `${x.attr} (${x.view})`))],
    renders: cache.size,
  };
  // The template must reproduce every state of the verified run exactly, and also view
  // values the run does not show (states an edited initial value could reach): random
  // combinations, both ends of every range, every variant of every switch with random
  // values for the other views, and every value of each wide view (within a budget) with
  // random values for the others. Combinations of wide views remain sampled.
  let seed = 0x9e3779b9;
  const rnd = () => { seed ^= seed << 13; seed >>>= 0; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0; return seed / 4294967296; };
  const random = () => Object.fromEntries(views.map((v) => [v.name, v.range.lo + Math.floor(rnd() * (v.range.hi - v.range.lo + 1))]));
  const extra = [];
  for (let i = 0; i < 64; i++) extra.push(random());
  extra.push(Object.fromEntries(views.map((v) => [v.name, v.range.lo])), Object.fromEntries(views.map((v) => [v.name, v.range.hi])));
  for (const sw of switches) for (const x of sw.variants) extra.push({ ...random(), ...x.combo });
  const wide = views.filter((v) => !regions.has(v.name)).sort((a, b) => (a.range.hi - a.range.lo) - (b.range.hi - b.range.lo));
  let budget = EXHAUSTIVE_BUDGET;
  info.verifiedEachValue = [];
  info.sampledViews = [];
  for (const v of wide) {
    const n = v.range.hi - v.range.lo + 1;
    if (n > budget) { info.sampledViews.push(v.name); continue; }
    budget -= n;
    info.verifiedEachValue.push(v.name);
    for (let x = v.range.lo; x <= v.range.hi; x++) extra.push({ ...random(), [v.name]: x });
  }
  const strip = (n) => n.attrs.filter(([k]) => !ignoredNames.has(k)).map(([k, v]) => [k, k === 'style' ? normalizeLengthZeros(v) : v]);
  for (const s of [...samples, ...extra]) {
    const want = toXhtml(draw(s), { hooks: { attrs: strip } });
    const other = instantiate(merged.template, s, { ignore: ignoredNames, canonicalStyles: true });
    const got = instantiate(template, s, { ignore: ignoredNames, canonicalStyles: true });
    if (got !== other) throw new Error(`internal: the shared and the merged placements of the UI variants differ for ${JSON.stringify(s)}`);
    if (want !== got) {
      let at = 0;
      while (want[at] === got[at]) at++;
      const near = (t) => JSON.stringify(t.slice(Math.max(0, at - 50), at + 50));
      throw new UiError('UI_VERIFY', `the inferred template differs from a direct render for view values ${JSON.stringify(s)}: the component renders ${near(want)} but the template gives ${near(got)}`, { views: s });
    }
    if (cache.size > 4 * EXHAUSTIVE_BUDGET) cache.clear(); // keep memory bounded on long checks
  }
  info.verifiedStates = samples.length;
  info.verifiedRandomStates = extra.length;
  return { template, info, merged: { template: merged.template, discrete: merged.discrete } };
}

// Evaluate a template for concrete view values (JS), the reference the CSS must match.
// ignore: attribute names left out of the output (ignored, non-visual changes).
export function instantiate(template, values, { ignore = new Set(template.ignore ?? []), canonicalStyles = false } = {}) {
  const pick = (sw) => sw.variants.find((x) => (x.combos ?? [x.combo]).some((combo) => Object.entries(combo).every(([k, v]) => values[k] === v)));
  const fill = (node) => {
    if (node.type === 'switch') { const x = pick(node); return x ? fill(x.node) : null; }
    const copy = { ...node, children: node.children?.map(fill).filter(Boolean) };
    if (node.binds) {
      for (const b of node.binds) {
        const val = String(Number((b.alpha * values[b.view] + b.beta).toFixed(9)));
        if (b.where === 'text') { const p = tokenize(copy.value); p[b.index] = val; copy.value = p.join(''); }
        else {
          const name = b.where.slice(5);
          copy.attrs = copy.attrs.map(([k, v]) => { if (k !== name) return [k, v]; const p = k === 'style' ? styleTokens(v) : tokenize(v); p[b.index] = val; return [k, p.join('')]; });
        }
      }
    }
    return copy;
  };
  return toXhtml(fill(template), { hooks: { attrs: (n) => n.attrs.filter(([k]) => !ignore.has(k))
    .map(([k, v]) => [k, canonicalStyles && k === 'style' ? normalizeLengthZeros(v) : v]) } });
}

// SVG definitions (markers, gradients, clip paths...) referenced by url(#id) or href="#id":
// every variant carries its own copy, so each non-base variant gets its own ids (the first
// element with an id in the document would otherwise win, possibly inside a hidden variant).
// The base variant keeps the original ids; CSS rules that use them are repeated per variant.
const DEFS = new Set(['marker', 'lineargradient', 'radialgradient', 'clippath', 'mask', 'pattern', 'filter', 'symbol']);
function ownDefs(node, suffix) {
  const ids = new Map();
  const collect = (n) => {
    if (n.type === 'root') { n.children.forEach(collect); return; }
    if (n.type !== 'el') return;
    const id = n.attrs.find(([k]) => k === 'id')?.[1];
    if (id && DEFS.has(n.tag.toLowerCase())) ids.set(id, `${id}${suffix}`);
    n.children.forEach(collect);
  };
  collect(node);
  if (!ids.size) return { node, ids };
  const ref = (v) => v.replace(/url\(\s*(['"]?)#([^)'"]+)\1\s*\)/g, (m, q, id) => (ids.has(id) ? `url(${q}#${ids.get(id)}${q})` : m));
  const fix = (n) => {
    if (n.type === 'root') return { ...n, children: n.children.map(fix) };
    if (n.type !== 'el') return n;
    const attrs = n.attrs.map(([k, v]) => {
      if (k === 'id' && ids.has(v) && DEFS.has(n.tag.toLowerCase())) return [k, ids.get(v)];
      if ((k === 'href' || k === 'xlink:href') && v.startsWith('#') && ids.has(v.slice(1))) return [k, `#${ids.get(v.slice(1))}`];
      return [k, ref(v)];
    });
    return { ...n, attrs, children: n.children.map(fix) };
  };
  return { node: fix(node), ids };
}

// Serialize the template with CSS bindings. viewVar(name) -> <integer> CSS custom property
// name; optional lerpVar(name) -> <number> CSS custom property name for continuous style sites.
export function templateToXhtml(template, viewVar, { lerpVar = null } = {}) {
  const expr = (b, propName = viewVar(b.view)) => {
    const v = `var(--${propName})`;
    const a = b.alpha === 1 ? v : `${v} * ${b.alpha}`;
    return b.beta === 0 ? a : `${a} + ${b.beta}`;
  };
  const rules = [];
  let variantBytes = 0;
  let interpolatedSites = 0;
  const renamed = []; // { cls, ids: [[from, to]] } per variant whose SVG ids were renamed
  const hooks = {
    attrs(n) {
      // all bindings of one attribute index into the tokens of its original value
      return n.attrs.map(([k, v]) => {
        const binds = (n.binds ?? []).filter((b) => b.where === `attr:${k}`);
        if (!binds.length) return [k, v];
        const p = k === 'style' ? styleTokens(v) : tokenize(v);
        for (const b of binds) {
          const lv = b.continuous ? lerpVar?.(b.view) : null;
          if (lv) interpolatedSites++;
          const unitMatch = typeof p[b.index + 1] === 'string' ? /^[a-z%]+/i.exec(p[b.index + 1]) : null;
          const unit = unitMatch ? unitMatch[0] : '';
          p[b.index] = unit ? `calc((${expr(b, lv || viewVar(b.view))}) * 1${unit})` : `calc(${expr(b, lv || viewVar(b.view))})`;
          if (unit) p[b.index + 1] = p[b.index + 1].slice(unit.length);
        }
        return [k, p.join('')];
      });
    },
    text(n) {
      const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const textBinds = (n.binds ?? []).filter((b) => b.where === 'text');
      if (!textBinds.length) return esc(n.value);
      const p = tokenize(n.value);
      return p.map((x, i) => {
        const b = textBinds.find((t) => t.index === i);
        if (!b) return esc(String(x));
        if (!Number.isInteger(b.alpha) || !Number.isInteger(b.beta)) throw new UiError('UI_NONINTEGER_TEXT', `a number in the text "${n.value}" is not an integer function of view "${b.view}"; text numbers are shown with CSS counters, which need integers`);
        return `<rr-n style="counter-reset:rr-n ${b.alpha === 1 && b.beta === 0 ? `var(--${viewVar(b.view)})` : `calc(${expr(b)})`}"></rr-n>`;
      }).join('');
    },
    switch(sw, inner) {
      const b = Math.max(0, sw.base ?? 0);
      return sw.variants.map((x, i) => {
        const cls = `rr-s${sw.id}-${i}`;
        const queries = (x.combos ?? [x.combo]).map((combo) => Object.entries(combo).map(([k, v]) => `style(--${viewVar(k)}: ${v})`).join(' and '));
        const query = queries.length === 1 ? queries[0] : queries.map((q) => `(${q})`).join(' or ');
        if (i !== b) rules.push(`@container ${query} { .${cls} { display: contents; } .rr-c.rr-s${sw.id}-${b} { display: none; } }`);
        const own = i === b ? { node: x.node, ids: new Map() } : ownDefs(x.node, `-rr${sw.id}-${i}`);
        if (own.ids.size) renamed.push({ cls, ids: [...own.ids] });
        const html = inner(own.node);
        variantBytes += Buffer.byteLength(html);
        return `<rr-case class="rr-c ${cls}${i === b ? ' rr-d' : ''}">${html}</rr-case>`;
      }).join('');
    },
  };
  const markup = toXhtml(template, { hooks });
  const css = `.rr-c { display: none; }\n.rr-c.rr-d { display: contents; }\nrr-n::after { content: counter(rr-n); }\n${rules.join('\n')}\n`;
  return { markup, css, variantBytes, renamed, interpolatedSites };
}
