// UI cards: the project's own component, rendered statically and bound to view values.
import { bundleEntry, renderWith, UiError } from './bundle.js';
import { inferTemplate, templateToXhtml } from './infer.js';
import { classCandidates, compileUiCss } from './style.js';
import { lerpProp } from '../runtime/machine.js';

export { UiError };

// The root element's inline size. When the root itself has variants (a view changes its
// children), every variant counts: the card must hold the largest.
export function rootSize(template) {
  const first = template.children?.find((c) => c.type === 'el' || c.type === 'switch');
  const roots = first?.type === 'switch' ? first.variants.map((x) => x.node) : first ? [first] : [];
  const px = (el, prop) => Number(new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*(\\d+(?:\\.\\d+)?)px`).exec(el.attrs?.find(([k]) => k === 'style')?.[1] ?? '')?.[1]);
  const max = (prop) => (roots.length ? Math.max(...roots.map((el) => px(el, prop))) : NaN);
  return { width: max('width'), height: max('height') };
}

// The root elements of all variants (the elements a switch wraps), and those plus their
// siblings (whose positions the wrappers and hidden copies change).
function switchedElements(template) {
  const roots = [];
  const near = [];
  const elements = (n) => n.type === 'root' ? n.children.flatMap(elements) : n.type === 'el' ? [n] : [];
  const walk = (n) => {
    if (n.type === 'switch') { for (const x of n.variants) { roots.push(...elements(x.node)); walk(x.node); } return; }
    if (n.children?.some((c) => c.type === 'switch')) {
      near.push(...n.children.filter((c) => c.type === 'el'));
      if (n.type === 'el') near.push(n); // an empty fragment still has a wrapper: :empty differs
    }
    n.children?.forEach(walk);
  };
  walk(template);
  return { roots, near: [...roots, ...near] };
}

// A selector split into compounds and the combinators between them (outside () and []).
function compounds(selector) {
  const s = selector.replace(/^:(?:where|is)\((.*)\)$/, '$1');
  const parts = [];
  const combs = [];
  let cur = '';
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '(' || ch === '[') depth++;
    if (ch === ')' || ch === ']') depth--;
    if (depth === 0 && /[\s>+~]/.test(ch)) {
      let comb = ' ';
      while (i < s.length && /[\s>+~]/.test(s[i])) { if (!/\s/.test(s[i])) comb = s[i]; i++; }
      i--;
      if (cur) { parts.push(cur); combs.push(comb); cur = ''; }
      continue;
    }
    cur += ch;
  }
  if (cur) parts.push(cur);
  return { parts, combs: combs.slice(0, parts.length - 1) };
}

// Whether a compound (tag and classes; pseudo-classes and attributes ignored) can match el.
function compoundMatches(compound, el) {
  const tag = /^[a-zA-Z][\w-]*/.exec(compound)?.[0];
  const classes = [...compound.replace(/\([^)]*\)/g, '').matchAll(/\.((?:\\.|[\w-])+)/g)].map((m) => m[1].replace(/\\(.)/g, '$1'));
  const own = new Set((el.attrs.find(([k]) => k === 'class')?.[1] ?? '').split(/\s+/));
  return (!tag || tag.toLowerCase() === el.tag.toLowerCase()) && classes.every((c) => own.has(c));
}

// Whether a child/sibling/structural selector can be affected by the variant wrappers: the
// compound after ">" is a switched element; a compound beside "+"/"~" or carrying a
// structural pseudo-class is a switched element or one of its siblings.
function structuralHit(selector, { roots, near }) {
  const { parts, combs } = compounds(selector);
  const any = (compound, els) => els.some((el) => compoundMatches(compound, el));
  return parts.some((p, k) =>
    (combs[k - 1] === '>' && any(p, roots))
    || ((combs[k - 1] === '+' || combs[k - 1] === '~' || combs[k] === '+' || combs[k] === '~') && any(p, near))
    || (/:(?:nth-|first-child|last-child|only-child|first-of-type|last-of-type|empty)/.test(p) && any(p, near)));
}

// CSS rules that refer to an SVG id renamed in a variant (url(#id) or #id), repeated with
// the new id and scoped to that variant.
function scopedIdRules(css, renamed) {
  if (!renamed.length) return '';
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const out = [];
  for (const m of css.matchAll(/(?<=^|[{};])\s*([^{};@]+)\{([^{}]*)\}/g)) {
    for (const { cls, ids } of renamed) {
      let sel = m[1].trim();
      let body = m[2];
      let hit = false;
      for (const [from, to] of ids) {
        const inSel = new RegExp(`#${esc(from)}(?![\\w-])`, 'g');
        const inUrl = new RegExp(`url\\(\\s*(['"]?)#${esc(from)}\\1\\s*\\)`, 'g');
        if (inSel.test(sel) || inUrl.test(body)) hit = true;
        sel = sel.replace(inSel, `#${to}`);
        body = body.replace(inUrl, `url($1#${to}$1)`);
      }
      if (hit) out.push(`${sel.split(',').map((x) => `.${cls} ${x.trim()}`).join(', ')} {${body}}`);
    }
  }
  return out.length ? `${out.join('\n')}\n` : '';
}

// Selectors of the stylesheet that depend on direct children, siblings or descendants' presence
// (>, +, ~, structural pseudo-classes, :has()) and can match around switched elements.
function structuralSelectors(css, switched) {
  return [...new Set([...css.matchAll(/(?<=^|[{};])\s*([^{};@]+)\{/g)]
    .flatMap((m) => m[1].split(',').map((s) => s.trim()))
    .filter((s) => /:(?:nth-|first-child|last-child|only-child|first-of-type|last-of-type|empty|has\()|[^\s(,][ ]*[>+~][ ]*[^\s=]/.test(s))
    .filter((s) => /:has\(/.test(s) || structuralHit(s, switched)))];
}

// ui: { entry, tsconfig?, css?, views, width?, height?, credit? }  (paths relative to cwd)
export async function buildUi(ui, machine, verification, { cwd = process.cwd(), interpolate = null } = {}) {
  const bundle = await bundleEntry(ui.entry, { tsconfig: ui.tsconfig, cwd });
  const views = Object.keys(machine.viewProps).map((name) => ({ name, range: machine.viewRanges[name] }));
  const samples = verification.viewSamples;
  if (!samples.length) throw new UiError('UI_NO_STATES', 'the run shows no state, so there is nothing to render');
  // attribute names the stylesheets select on ([data-state], [aria-pressed], ...): a change
  // of such an attribute is visual even though data-*/aria-* usually are not
  const pre = await compileUiCss(ui.css ?? [], classCandidates([renderWith(bundle, samples[0])]), { cwd });
  const cssAttrs = new Set([...pre.css.matchAll(/(?:\[|\battr\()\s*([a-zA-Z_][\w:.-]*)/g)].map((m) => m[1].toLowerCase()));
  const inferred = inferTemplate(bundle, views, { base: samples[0], samples, cssAttrs });
  const { info } = inferred;
  const continuousSet = new Set(info.continuousViews);
  const activeViews = !interpolate ? [] : (interpolate.views ?? info.continuousViews).filter((v) => continuousSet.has(v));
  const activeSet = new Set(activeViews);
  const place = async (template) => {
    const out = templateToXhtml(
      template,
      (v) => machine.viewProps[v],
      { lerpVar: activeSet.size ? (v) => (activeSet.has(v) ? lerpProp(v) : null) : null },
    );
    const style = await compileUiCss(ui.css ?? [], classCandidates([out.markup]), { cwd });
    return { template, ...out, style, structural: structuralSelectors(style.css, switchedElements(template)) };
  };
  // Shared parents put the variant wrappers between a parent and its children. When the
  // stylesheet selects on direct children or siblings (li + li, > li, :empty, :has(), Tailwind
  // space-y-*) around a switched element, or paints with url(#id) (each variant renames its
  // own definitions), or the markup has its own <style>, the variants stay at the inferred
  // regions instead (only merged), where these selectors see the same structure as before.
  let placed = await place(inferred.template);
  let sharedParents = { used: inferred.template !== inferred.merged.template && JSON.stringify(inferred.merged.discrete) !== JSON.stringify(info.discrete) };
  if (sharedParents.used) {
    const why = placed.structural.length ? `selectors on direct children or siblings: ${placed.structural.slice(0, 3).join(' | ')}`
      : /url\(\s*['"]?#/.test(placed.style.css) ? 'the stylesheet paints with url(#id)'
        : /<style[\s>]/i.test(placed.markup) ? 'the markup has its own <style>' : null;
    if (why) {
      placed = await place(inferred.merged.template);
      info.discrete = inferred.merged.discrete;
      sharedParents = { used: false, reason: why };
    }
  }
  const { template, markup, css: switchCss, variantBytes, renamed, interpolatedSites, style, structural } = placed;
  const bindingCss = switchCss + scopedIdRules(style.css, renamed);
  const size = rootSize(template);
  const width = ui.width ?? size.width;
  const height = ui.height ?? size.height;
  if (!Number.isFinite(width) || !Number.isFinite(height)) {
    throw new UiError('UI_SIZE', 'cannot tell the size of the UI: give its root element an inline width and height in px, or set "ui.width" and "ui.height"');
  }
  const tsconfig = ui.tsconfig ? [ui.tsconfig.split('\\').join('/')] : [];
  const inputs = [...new Set([...bundle.inputs.filter((f) => !f.endsWith('readme-runtime-entry.jsx')), ...style.inputs, ...tsconfig])].sort();
  // A variant region at the root means a full copy of the UI per combination of view values,
  // usually because a component renders null for some values and so changes the root's
  // child list. Say how to keep the variants small.
  const warnings = info.discrete.filter((d) => d.path.split('.').length <= 1 && d.variants > 1).map((d) => ({
    code: 'UI_WHOLE_VARIANTS',
    message: `the whole UI has ${d.variants} distinct variants for ${d.combinations} combinations of ${d.views.join(', ')}: its root attributes or structure differ. Keep the root stable and localize changing parts to share more of the UI`,
  }));
  if (interpolate?.views) {
    const discreteOnly = interpolate.views.filter((v) => !continuousSet.has(v));
    if (discreteOnly.length) {
      warnings.push({
        code: 'UI_INTERPOLATE_DISCRETE_ONLY',
        message: `view${discreteOnly.length > 1 ? 's' : ''} ${discreteOnly.map((v) => `"${v}"`).join(', ')} ha${discreteOnly.length > 1 ? 've' : 's'} no continuous style bindings (only discrete text numbers, integer-only style properties, or switched markup), so ${discreteOnly.length > 1 ? 'they stay' : 'it stays'} discrete`,
      });
    }
  } else if (interpolate && !activeViews.length) {
    warnings.push({
      code: 'UI_INTERPOLATE_DISCRETE_ONLY',
      message: 'interpolate is enabled, but no view drives a continuous CSS style property (only discrete text numbers, integer-only style properties, or switched markup were found); sub-step animation was omitted so the card does not repaint between steps',
    });
  }
  // Variants are wrapped in <rr-case> elements and the hidden copies stay in the document, so
  // child/sibling selectors (li + li, :nth-child, :last-child, space-y-*) can match differently
  // around switched elements. Not detected per element: say that the card needs a look.
  if (structural.length) {
    warnings.push({
      code: 'UI_STRUCTURAL_CSS',
      message: `the stylesheet uses child/sibling selectors (e.g. ${structural.slice(0, 3).join(' | ')}); elements with variants are wrapped and their hidden copies stay in the document, so such selectors can style them differently than in the app. Compare the card with the app, or keep switched elements out of such lists`,
    });
  }
  return {
    markup, bindingCss, css: style.css, width, height, inputs, interpolatedViews: activeViews,
    // how much of the UI markup is precomputed per value (variants) rather than bound
    info: {
      ...info,
      ...(interpolate ? { interpolation: { active: activeViews.length > 0, easing: interpolate.easing, views: activeViews, sites: interpolatedSites } } : {}),
      fontFallbacks: style.fontFallbacks,
      inputs,
      markupBytes: Buffer.byteLength(markup),
      variantBytes,
      sharedParents,
      variantShare: Number((variantBytes / Math.max(1, Buffer.byteLength(markup))).toFixed(2)),
      elements: (markup.match(/<[a-zA-Z][\w:.-]*(?=[\s/>])/g) ?? []).length,
      cssBytes: Buffer.byteLength(style.css),
      bindingCssBytes: Buffer.byteLength(bindingCss),
      ...(warnings.length ? { warnings } : {}),
    },
  };
}
