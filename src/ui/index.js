// UI cards: the project's own component, rendered statically and bound to view values.
import { bundleEntry, UiError } from './bundle.js';
import { inferTemplate, templateToXhtml } from './infer.js';
import { classCandidates, compileUiCss } from './style.js';

export { UiError };

function rootSize(template) {
  const first = template.children?.find((c) => c.type === 'el');
  const style = first?.attrs.find(([k]) => k === 'style')?.[1] ?? '';
  const px = (prop) => Number(new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*(\\d+(?:\\.\\d+)?)px`).exec(style)?.[1]);
  return { width: px('width'), height: px('height') };
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
  return {
    markup, bindingCss, css: style.css, width, height, inputs,
    info: { ...info, fontFallbacks: style.fontFallbacks, inputs, markupBytes: markup.length },
  };
}
