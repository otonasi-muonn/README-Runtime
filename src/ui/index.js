// UI cards: the project's own component, rendered statically and bound to view values.
import { bundleEntry, renderWith, UiError } from './bundle.js';
import { inferTemplate, templateToXhtml } from './infer.js';
import { classCandidates, compileUiCss } from './style.js';

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

// The root elements of all variants (the elements a switch wraps).
function switchedElements(template) {
  const out = [];
  const walk = (n) => {
    if (n.type === 'switch') { for (const x of n.variants) { if (x.node.type === 'el') out.push(x.node); walk(x.node); } return; }
    n.children?.forEach(walk);
  };
  walk(template);
  return out;
}

// Whether a child/sibling selector can select a switched element itself: its last compound
// (after the last combinator) matches the element's tag and classes. A compound without tag
// or class (":not(:last-child)") matches anything.
function mayMatch(selector, el) {
  const s = selector.replace(/^:(?:where|is)\((.*)\)$/, '$1');
  const last = s.split(/\s*[>+~\s]\s*(?![^(]*\))/).filter(Boolean).at(-1) ?? '';
  const tag = /^[a-zA-Z][\w-]*/.exec(last)?.[0];
  const classes = [...last.replace(/\([^)]*\)/g, '').matchAll(/\.((?:\\.|[\w-])+)/g)].map((m) => m[1].replace(/\\(.)/g, '$1'));
  const own = new Set((el.attrs.find(([k]) => k === 'class')?.[1] ?? '').split(/\s+/));
  return (!tag || tag.toLowerCase() === el.tag.toLowerCase()) && classes.every((c) => own.has(c));
}

// ui: { entry, tsconfig?, css?, views, width?, height?, credit? }  (paths relative to cwd)
export async function buildUi(ui, machine, verification, { cwd = process.cwd() } = {}) {
  const bundle = await bundleEntry(ui.entry, { tsconfig: ui.tsconfig, cwd });
  const views = Object.keys(machine.viewProps).map((name) => ({ name, range: machine.viewRanges[name] }));
  const samples = verification.viewSamples;
  if (!samples.length) throw new UiError('UI_NO_STATES', 'the run shows no state, so there is nothing to render');
  // attribute names the stylesheets select on ([data-state], [aria-pressed], ...): a change
  // of such an attribute is visual even though data-*/aria-* usually are not
  const pre = await compileUiCss(ui.css ?? [], classCandidates([renderWith(bundle, samples[0])]), { cwd });
  const cssAttrs = new Set([...pre.css.matchAll(/\[\s*([a-zA-Z_][\w:.-]*)/g)].map((m) => m[1].toLowerCase()));
  const { template, info } = inferTemplate(bundle, views, { base: samples[0], samples, cssAttrs });
  const { markup, css: bindingCss, variantBytes } = templateToXhtml(template, (v) => machine.viewProps[v]);
  const style = await compileUiCss(ui.css ?? [], classCandidates([markup]), { cwd });
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
    message: `the whole UI is copied for each of ${d.variants} combinations of ${d.views.join(', ')}: an element appears or disappears directly under the root. Wrap each part that comes and goes (e.g. a component that renders null) in its own element, so only that element varies`,
  }));
  // Variants are wrapped in <rr-case> elements and the hidden copies stay in the document, so
  // child/sibling selectors (li + li, :nth-child, :last-child, space-y-*) can match differently
  // around switched elements. Not detected per element: say that the card needs a look.
  const roots = switchedElements(template);
  const structural = [...new Set([...style.css.matchAll(/(?<=^|[{};])\s*([^{};@]+)\{/g)]
    .flatMap((m) => m[1].split(',').map((s) => s.trim()))
    .filter((s) => /:(?:nth-|first-child|last-child|only-child|first-of-type|last-of-type)|[^\s(,][ ]*[>+~][ ]*[^\s=]/.test(s))
    .filter((s) => roots.some((el) => mayMatch(s, el))))];
  if (structural.length) {
    warnings.push({
      code: 'UI_STRUCTURAL_CSS',
      message: `the stylesheet uses child/sibling selectors (e.g. ${structural.slice(0, 3).join(' | ')}); elements with variants are wrapped and their hidden copies stay in the document, so such selectors can style them differently than in the app. Compare the card with the app, or keep switched elements out of such lists`,
    });
  }
  return {
    markup, bindingCss, css: style.css, width, height, inputs,
    // how much of the UI markup is precomputed per value (variants) rather than bound
    info: { ...info, fontFallbacks: style.fontFallbacks, inputs, markupBytes: markup.length, variantBytes, variantShare: Number((variantBytes / Math.max(1, markup.length)).toFixed(2)), ...(warnings.length ? { warnings } : {}) },
  };
}
