// UI cards: the project's own component, rendered statically and bound to view values.
import { bundleEntry, UiError } from './bundle.js';
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

// ui: { entry, tsconfig?, css?, views, width?, height?, credit? }  (paths relative to cwd)
export async function buildUi(ui, machine, verification, { cwd = process.cwd() } = {}) {
  const bundle = await bundleEntry(ui.entry, { tsconfig: ui.tsconfig, cwd });
  const views = Object.keys(machine.viewProps).map((name) => ({ name, range: machine.viewRanges[name] }));
  const samples = verification.viewSamples;
  if (!samples.length) throw new UiError('UI_NO_STATES', 'the run shows no state, so there is nothing to render');
  const { template, info } = inferTemplate(bundle, views, { base: samples[0], samples });
  const { markup, css: bindingCss } = templateToXhtml(template, (v) => machine.viewProps[v]);
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
  return {
    markup, bindingCss, css: style.css, width, height, inputs,
    info: { ...info, fontFallbacks: style.fontFallbacks, inputs, markupBytes: markup.length, ...(warnings.length ? { warnings } : {}) },
  };
}
