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

export const MAX_DISCRETE = 64; // values of one discrete view
export const MAX_COMBINATIONS = 512; // variants of one group of interacting views

const NUM = /-?\d+(?:\.\d+)?/g;
function tokenize(s) {
  const parts = [];
  let last = 0;
  for (const m of s.matchAll(NUM)) {
    let start = m.index, text = m[0];
    // a "-" glued to a letter or digit is a hyphen, not a sign
    if (text[0] === '-' && start > 0 && /[\w)]/.test(s[start - 1])) { start++; text = text.slice(1); }
    if (start > last) parts.push(s.slice(last, start));
    parts.push(Number(text));
    last = start + text.length;
  }
  if (last < s.length) parts.push(s.slice(last));
  return parts;
}
const skeleton = (parts) => parts.map((p) => (typeof p === 'number' ? '#' : p)).join('');

const nodeAt = (tree, path) => path.reduce((n, i) => n.children[i], tree);
const pathKey = (p) => p.join('.');
const isPrefix = (a, b) => a.length <= b.length && a.every((x, i) => x === b[i]);

// Visual attributes whose non-numeric change must be reproduced; others (data-*, aria-*,
// ids, keys) are ignored when they change.
const NON_VISUAL = (name) => /^(data-|aria-)/.test(name) || ['id', 'title', 'tabindex', 'role', 'key', 'name', 'for', 'type'].includes(name);

// Compare two trees: numeric sites { path, where, index, a, b } and structural sites { path }.
function compare(a, b, path = [], out = { num: [], struct: [], ignored: [] }) {
  // a different node: the parent element is the region; a different child list: this element
  if (a.type !== b.type || (a.type === 'el' && a.tag !== b.tag)) { out.struct.push({ path: path.slice(0, -1) }); return out; }
  if (a.children && a.children.length !== b.children.length) { out.struct.push({ path }); return out; }
  if (a.type === 'text') {
    if (a.value !== b.value) {
      const pa = tokenize(a.value), pb = tokenize(b.value);
      if (skeleton(pa) !== skeleton(pb)) out.struct.push({ path: path.slice(0, -1) });
      else pa.forEach((x, i) => { if (typeof x === 'number' && x !== pb[i]) out.num.push({ path, where: 'text', index: i, a: x, b: pb[i] }); });
    }
    return out;
  }
  if (a.type === 'el') {
    const names = a.attrs.map(([k]) => k).join(' ');
    if (names !== b.attrs.map(([k]) => k).join(' ')) { out.struct.push({ path }); return out; }
    a.attrs.forEach(([k, va], i) => {
      const vb = b.attrs[i][1];
      if (va === vb) return;
      if (NON_VISUAL(k)) { out.ignored.push({ path, attr: k }); return; }
      const pa = tokenize(va), pb = tokenize(vb);
      if (k !== 'style' || skeleton(pa) !== skeleton(pb)) { out.struct.push({ path }); return; }
      pa.forEach((x, j) => { if (typeof x === 'number' && x !== pb[j]) out.num.push({ path, where: `attr:${k}`, index: j, a: x, b: pb[j] }); });
    });
  }
  a.children.forEach((c, i) => compare(c, b.children[i], [...path, i], out));
  return out;
}

const siteKey = (s) => `${pathKey(s.path)}|${s.where}|${s.index}`;

function render(bundle, props, cache) {
  const key = JSON.stringify(props);
  let t = cache.get(key);
  if (!t) { t = parseHtml(renderWith(bundle, props)); cache.set(key, t); }
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
// samples: view-value objects that must reproduce exactly (the verified run).
export function inferTemplate(bundle, views, { base, samples = [] }) {
  const cache = new Map();
  const R0 = render(bundle, base, cache);
  const numeric = new Map(); // view -> Map(siteKey -> { site, points })
  const regions = new Map(); // view -> [paths]
  const ignored = [];
  for (const v of views) {
    const sites = new Map();
    const structs = [];
    const vals = probes(base[v.name], v.range);
    for (const x of vals) {
      const d = compare(R0, render(bundle, { ...base, [v.name]: x }, cache));
      structs.push(...d.struct.map((s) => s.path));
      ignored.push(...d.ignored.map((s) => ({ ...s, view: v.name })));
      for (const s of d.num) {
        const k = siteKey(s);
        if (!sites.has(k)) sites.set(k, { site: s, points: [{ v: base[v.name], y: s.a }] });
        sites.get(k).points.push({ v: x, y: s.b });
      }
    }
    // a site whose number is not affine in the view turns its element into a variant region
    for (const [k, { site, points }] of [...sites]) {
      if (points.length < 3 || !fitAffine(points)) { structs.push(site.path); sites.delete(k); }
    }
    if (structs.length) {
      const size = v.range.hi - v.range.lo + 1;
      if (size > MAX_DISCRETE) {
        throw new UiError('UI_NONLINEAR', `the UI depends on view "${v.name}" in a way that is not affine (element ${pathKey(structs[0])}), and "${v.name}" can take ${size} values (more than ${MAX_DISCRETE}). Make the markup depend on it linearly (numbers in style/text), or reduce its range in the Wasm view function.`, { view: v.name, path: structs[0] });
      }
      // a discrete view: every value of its range is rendered, so no changed element is missed
      for (let x = v.range.lo; x <= v.range.hi; x++) {
        if (x === base[v.name] || vals.includes(x)) continue;
        const d = compare(R0, render(bundle, { ...base, [v.name]: x }, cache));
        structs.push(...d.struct.map((s) => s.path), ...d.num.map((s) => s.path));
      }
      regions.set(v.name, minimalRegions(structs));
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
  const switches = []; // { views, combos, regionPath, variants: [tree] }
  for (const members of groups.values()) {
    const paths = minimalRegions(members.flatMap((v) => regions.get(v)));
    for (const p of paths) {
      // only the views that actually change this element are enumerated for it
      const relevant = members.filter((v) => regions.get(v).some((q) => isPrefix(q, p) || isPrefix(p, q)));
      let combos = [{}];
      for (const v of relevant) {
        const next = [];
        for (const c of combos) for (let k = range[v].lo; k <= range[v].hi; k++) next.push({ ...c, [v]: k });
        combos = next;
        if (combos.length > MAX_COMBINATIONS) {
          throw new UiError('UI_TOO_MANY_VARIANTS', `views ${relevant.join(', ')} change the same element and together take more than ${MAX_COMBINATIONS} combinations; narrow their ranges or let them affect different elements`, { views: relevant });
        }
      }
      const variants = combos.map((c) => {
        const tree = render(bundle, { ...base, ...c }, cache);
        return { combo: c, node: structuredClone(nodeAt(tree, p)), props: { ...base, ...c } };
      });
      switches.push({ views: relevant, group: members, path: p, variants });
    }
  }
  const inSwitch = (p) => switches.find((s) => isPrefix(s.path, p));

  // numeric bindings outside switches go on the base tree; inside a switch they are
  // re-derived per variant (the variant's own render, probed again)
  const template = structuredClone(R0);
  const bind = (node, site, view, fit) => {
    node.binds ??= [];
    node.binds.push({ where: site.where, index: site.index, view, ...fit });
  };
  for (const v of views) {
    for (const { site, points } of numeric.get(v.name).values()) {
      if (inSwitch(site.path)) continue;
      if (regions.get(v.name)?.some((p) => isPrefix(p, site.path))) continue;
      bind(nodeAt(template, site.path), site, v.name, fitAffine(points));
    }
  }
  for (const sw of switches) {
    for (const variant of sw.variants) {
      for (const v of views) {
        if (sw.views.includes(v.name)) continue;
        if (![...numeric.get(v.name).values()].some(({ site }) => isPrefix(sw.path, site.path))) continue;
        const b0 = variant.props[v.name];
        const pts = new Map();
        const own = nodeAt(render(bundle, variant.props, cache), sw.path);
        for (const x of probes(b0, v.range)) {
          const other = nodeAt(render(bundle, { ...variant.props, [v.name]: x }, cache), sw.path);
          const d = compare(own, other);
          if (d.struct.length) throw new UiError('UI_NONLINEAR', `view "${v.name}" changes the structure of an element that also depends on ${sw.views.join(', ')}; handle "${v.name}" as discrete by narrowing its range`, { view: v.name });
          for (const s of d.num) {
            const k = siteKey(s);
            if (!pts.has(k)) pts.set(k, { site: s, points: [{ v: b0, y: s.a }] });
            pts.get(k).points.push({ v: x, y: s.b });
          }
        }
        for (const { site, points } of pts.values()) {
          const fit = fitAffine(points);
          if (!fit) throw new UiError('UI_NONLINEAR', `view "${v.name}" is not affine inside the variants of ${sw.views.join(', ')}`, { view: v.name });
          bind(nodeAt(variant.node, site.path), site, v.name, fit);
        }
      }
    }
  }
  // replace switch regions (deepest first, so paths stay valid)
  const ordered = [...switches].sort((a, b) => b.path.length - a.path.length);
  ordered.forEach((sw, i) => { sw.id = i; });
  for (const sw of ordered) {
    const node = { type: 'switch', id: sw.id, views: sw.views, variants: sw.variants.map((x) => ({ combo: x.combo, node: x.node })) };
    if (!sw.path.length) Object.assign(template, { type: 'root', children: [node] });
    else nodeAt(template, sw.path.slice(0, -1)).children[sw.path.at(-1)] = node;
  }
  const info = {
    numeric: views.map((v) => ({ view: v.name, sites: [...numeric.get(v.name).values()].length })),
    discrete: switches.map((s) => ({ views: s.views, path: pathKey(s.path), variants: s.variants.length })),
    ignoredAttributes: [...new Set(ignored.map((x) => `${x.attr} (${x.view})`))],
    renders: cache.size,
  };
  // The template must reproduce every state of the verified run exactly, and also random
  // combinations of view values within their ranges (states an edited initial value could
  // reach), so the bindings are checked beyond the probes they were inferred from.
  let seed = 0x9e3779b9;
  const rnd = () => { seed ^= seed << 13; seed >>>= 0; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0; return seed / 4294967296; };
  const extra = [];
  for (let i = 0; i < 24; i++) extra.push(Object.fromEntries(views.map((v) => [v.name, v.range.lo + Math.floor(rnd() * (v.range.hi - v.range.lo + 1))])));
  extra.push(Object.fromEntries(views.map((v) => [v.name, v.range.lo])), Object.fromEntries(views.map((v) => [v.name, v.range.hi])));
  for (const s of [...samples, ...extra]) {
    const want = toXhtml(render(bundle, s, cache), { hooks: { attrs: stripIgnored } });
    const got = instantiate(template, s);
    if (want !== got) {
      const at = [...want].findIndex((ch, i) => ch !== got[i]);
      throw new UiError('UI_VERIFY', `the inferred template differs from a direct render for view values ${JSON.stringify(s)} near "${want.slice(Math.max(0, at - 40), at + 40)}"`, { views: s });
    }
  }
  info.verifiedStates = samples.length;
  info.verifiedRandomStates = extra.length;
  return { template, info };
}

function stripIgnored(n) {
  return n.attrs.filter(([k]) => !NON_VISUAL(k) || k === 'role');
}

// Evaluate a template for concrete view values (JS), the reference the CSS must match.
export function instantiate(template, values) {
  const pick = (sw) => sw.variants.find((x) => Object.entries(x.combo).every(([k, v]) => values[k] === v));
  const fill = (node) => {
    if (node.type === 'switch') { const x = pick(node); return x ? fill(x.node) : null; }
    const copy = { ...node, children: node.children?.map(fill).filter(Boolean) };
    if (node.binds) {
      for (const b of node.binds) {
        const val = Number((b.alpha * values[b.view] + b.beta).toFixed(9));
        if (b.where === 'text') { const p = tokenize(copy.value); p[b.index] = val; copy.value = p.join(''); }
        else {
          const name = b.where.slice(5);
          copy.attrs = copy.attrs.map(([k, v]) => { if (k !== name) return [k, v]; const p = tokenize(v); p[b.index] = val; return [k, p.join('')]; });
        }
      }
    }
    return copy;
  };
  return toXhtml(fill(template), { hooks: { attrs: stripIgnored } });
}

// Serialize the template with CSS bindings. viewVar(name) -> CSS custom property name.
export function templateToXhtml(template, viewVar) {
  const expr = (b) => {
    const v = `var(--${viewVar(b.view)})`;
    const a = b.alpha === 1 ? v : `${v} * ${b.alpha}`;
    return b.beta === 0 ? a : `${a} + ${b.beta}`;
  };
  const rules = [];
  const hooks = {
    attrs(n) {
      // all bindings of one attribute index into the tokens of its original value
      return stripIgnored(n).map(([k, v]) => {
        const binds = (n.binds ?? []).filter((b) => b.where === `attr:${k}`);
        if (!binds.length) return [k, v];
        const p = tokenize(v);
        for (const b of binds) {
          const unitMatch = typeof p[b.index + 1] === 'string' ? /^[a-z%]+/i.exec(p[b.index + 1]) : null;
          const unit = unitMatch ? unitMatch[0] : '';
          p[b.index] = unit ? `calc((${expr(b)}) * 1${unit})` : `calc(${expr(b)})`;
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
        return `<span class="rr-n" style="counter-reset:rr-n ${b.alpha === 1 && b.beta === 0 ? `var(--${viewVar(b.view)})` : `calc(${expr(b)})`}"></span>`;
      }).join('');
    },
    switch(sw, inner) {
      return sw.variants.map((x, i) => {
        const cls = `rr-s${sw.id}-${i}`;
        rules.push(`@container ${Object.entries(x.combo).map(([k, v]) => `style(--${viewVar(k)}: ${v})`).join(' and ')} { .${cls} { display: contents; } }`);
        return `<rr-case class="rr-c ${cls}">${inner(x.node)}</rr-case>`;
      }).join('');
    },
  };
  const markup = toXhtml(template, { hooks });
  const css = `.rr-c { display: none; }\n.rr-n::after { content: counter(rr-n); }\n${rules.join('\n')}\n`;
  return { markup, css };
}
