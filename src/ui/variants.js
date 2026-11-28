// Factor already inferred variants, without interpreting CSS or changing the set of view
// combinations. Equality includes numeric bindings: identical base markup alone is not
// enough when two variants depend on different views or use different affine functions.
const key = (node) => JSON.stringify(node);
const shell = ({ children, ...node }) => key(node);
const fragment = (children) => ({ type: 'root', children });

// Elements whose rendering depends on their direct children or their text, not only on the
// boxes inside them: a form control's value, a <select>'s options, raw-text elements, table
// rows, media sources, and foreign content (SVG, MathML) where an HTML wrapper does not render.
// A variant wrapper cannot go inside them, so they stay whole in each variant.
export const KEEP_WHOLE = new Set([
  'svg', 'math', 'textarea', 'select', 'optgroup', 'option', 'datalist', 'title', 'style', 'script',
  'template', 'noscript', 'iframe', 'object', 'picture', 'video', 'audio',
  'table', 'caption', 'colgroup', 'col', 'thead', 'tbody', 'tfoot', 'tr',
]);

// A shared parent moves the variant wrappers <rr-case> down between its children. Only plain
// containers whose children are laid out as ordinary boxes may be that parent (not, e.g., a
// <details> whose <summary>, a <fieldset> whose <legend>, or an <ol> whose numbering depends on
// its direct children, nor an element whose direction is computed from its text with dir).
// Whether the project's stylesheet depends on direct children is decided by buildUi, which
// falls back to { share: false } (variants at the inferred regions, only merged).
const SHELL = new Set([
  'div', 'span', 'section', 'article', 'aside', 'header', 'footer', 'main', 'nav', 'p', 'ul', 'li',
  'a', 'button', 'label', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'em', 'b', 'i', 'u', 's',
  'small', 'mark', 'figure', 'figcaption', 'blockquote',
]);
const plainShell = (n) => n.type === 'root'
  || (n.type === 'el' && SHELL.has(n.tag.toLowerCase()) && !n.attrs.some(([k]) => k.toLowerCase() === 'dir'));

// ids a subtree defines, and the #ids it refers to (url(#id), href="#id")
const kids = (n) => (n.type === 'switch' ? n.variants.map((v) => v.node) : n.children ?? []);
function idsIn(n, out = new Set()) {
  if (n.type === 'el') { const id = n.attrs.find(([k]) => k === 'id')?.[1]; if (id) out.add(id); }
  kids(n).forEach((c) => idsIn(c, out));
  return out;
}
function refsOf(attrs, out) {
  for (const [k, v] of attrs ?? []) {
    for (const m of String(v).matchAll(/url\(\s*['"]?#([^)'"\s]+)/g)) out.add(m[1]);
    if (/^(?:xlink:)?href$/i.test(k) && String(v).startsWith('#')) out.add(String(v).slice(1));
  }
  return out;
}
function refsIn(n, out = new Set()) {
  if (n.type === 'el') refsOf(n.attrs, out);
  kids(n).forEach((c) => refsIn(c, out));
  return out;
}

// share: also move the parts that variants have in common (a parent, leading and trailing
// children) out of them; without it, equal variants are only merged.
export function optimizeVariants(template, { share = true } = {}) {
  const factor = (sw) => {
    const variants = sw.variants;
    const nodes = variants.map((v) => v.node);
    const keys = nodes.map(key);
    if (keys.every((k) => k === keys[0])) return nodes[sw.base ?? 0];

    const first = nodes[0];
    const canShareShell = share && plainShell(first)
      && nodes.every((n) => shell(n) === shell(first));
    if (canShareShell) {
      const lists = nodes.map((n) => n.children);
      const shortest = Math.min(...lists.map((list) => list.length));
      const sameAt = (get) => lists.every((list) => key(get(list)) === key(get(lists[0])));
      let prefix = 0, suffix = 0;
      while (prefix < shortest && sameAt((list) => list[prefix])) prefix++;
      while (suffix < shortest - prefix && sameAt((list) => list[list.length - 1 - suffix])) suffix++;
      const middle = lists.map((list) => list.slice(prefix, list.length - suffix));
      const childSwitch = (children) => factor({ ...sw, variants: variants.map((v, i) => ({ ...v, node: children[i] })) });
      // Each variant renames the definitions it owns (ownDefs in infer.js), so an id defined in
      // a changing part must only be referred to from inside that same part: a shared part, or
      // another part that becomes its own switch, would point at the base variant's element.
      const shared = refsOf(first.attrs, new Set());
      for (const c of [...lists[0].slice(0, prefix), ...lists[0].slice(lists[0].length - suffix)]) refsIn(c, shared);
      const separable = (parts) => parts.every((part, i) => {
        const defined = new Set(part.flatMap((n) => [...idsIn(n)]));
        if (!defined.size) return true;
        const outside = new Set(shared);
        parts.forEach((other, j) => { if (j !== i) other.forEach((n) => refsIn(n, outside)); });
        return ![...defined].some((id) => outside.has(id));
      });
      let changed;
      const columns = middle[0].map((_, i) => middle.map((list) => list[i]));
      if (middle.every((list) => list.length === middle[0].length) && separable(columns)) {
        changed = columns.map((column) => childSwitch(column));
      } else if ((first.type === 'el' || prefix || suffix) && separable([middle.flat()])) {
        changed = [childSwitch(middle.map(fragment))];
      }
      // A fragment with varying lengths and no common ends is already minimal. Do not
      // try to factor that fragment into itself indefinitely.
      if (changed) return { ...first, children: [...lists[0].slice(0, prefix), ...changed, ...(suffix ? lists[0].slice(-suffix) : [])] };
    }

    const distinct = new Map();
    let base = 0;
    variants.forEach((v, i) => {
      if (!distinct.has(keys[i])) distinct.set(keys[i], { ...v, combos: [] });
      const group = distinct.get(keys[i]);
      group.combos.push(...(v.combos ?? [v.combo]));
      if (i === sw.base) base = [...distinct.keys()].indexOf(keys[i]);
    });
    return { ...sw, base, variants: [...distinct.values()] };
  };
  const walk = (node) => node.type === 'switch' ? factor(node)
    : node.children ? { ...node, children: node.children.map(walk) } : node;
  const optimized = walk(template);
  const discrete = [];
  let nextId = 0;
  const index = (node, path = []) => {
    if (node.type === 'switch') {
      node.id = nextId++;
      discrete.push({ views: node.views, path: path.join('.'), variants: node.variants.length,
        combinations: node.variants.reduce((n, v) => n + (v.combos?.length ?? 1), 0) });
      node.variants.forEach((v) => index(v.node, path));
    } else node.children?.forEach((c, i) => index(c, [...path, i]));
  };
  index(optimized);
  return { template: optimized, discrete };
}
