// SVG card whose body is the project's own UI (static markup + CSS bindings), driven by
// the CSS machine. The machine is the same as for trace cards; only the display differs.
import { altInitAnchors, altInitCss, altInitId, clockAnimation, declarations, interpAnimation, levelClass, levelStyle, rootStyle } from '../runtime/machine.js';
import { CHROME, esc, footerRule, frameAndHeader, themeCss } from './chrome.js';

export function uiLayout(ui) {
  const pad = 24, { head, foot } = CHROME;
  const W = Math.max(560, ui.width + pad * 2);
  return { W, H: head + 16 + ui.height + 12 + foot, pad, head, foot, uiX: Math.round((W - ui.width) / 2), uiY: head + 16 };
}

export function renderUiCard(machine, meta, ui) {
  const L = uiLayout(ui);
  const { W, H } = L;
  const out = machine.out;
  const steps = machine.steps;
  const interp = machine.interpolation ?? null;
  const F = `var(--${out.f})`;

  let css = '';
  for (const [name, inherits] of machine.props) css += `@property --${name}{syntax:'<integer>';inherits:${inherits};initial-value:0}\n`;
  if (interp) {
    for (const [name, inherits] of interp.intProps) css += `@property --${name}{syntax:'<integer>';inherits:${inherits};initial-value:0}\n`;
    for (const [name, inherits] of interp.numProps) css += `@property --${name}{syntax:'<number>';inherits:${inherits};initial-value:0}\n`;
  }
  for (const name of ['rok']) css += `@property --${name}{syntax:'<integer>';inherits:true;initial-value:0}\n`;
  // the project's stylesheet first, so the card chrome below wins any overlap
  css += `${ui.css}\n`;
  css += `.R{\n${declarations(machine.root.filter((d) => !d.literal), ' ')}\n}\n`;
  css += altInitCss(machine, meta.altInits);
  // the step clock runs on .C around the display (and when sub-step interpolation is enabled,
  // one local 0..1 <number> clock runs on .rr-ui); "reduce motion" comes after both rules so
  // its equal-specificity selectors stop all motion cleanly alongside any UI stylesheet rules
  css += `.C{animation:${clockAnimation(machine, meta)}}\n`;
  css += `@keyframes rrclk{from{--rt:0}to{--rt:${machine.T}}}\n`;
  if (interp) {
    css += `.rr-ui{animation:${interpAnimation(machine, meta, interp)}!important;\n${declarations(interp.uiDefs, ' ')}\n}\n`;
    css += `@keyframes rrf{from{--rf:0}to{--rf:1}}\n`;
  }
  css += `@media (prefers-reduced-motion:reduce){.C{animation:none;--rt:${machine.T}}${interp ? '.rr-ui{animation:none!important;transition:none!important;--rf:0}' : ''}.rr-ui *,.rr-ui *::before,.rr-ui *::after{animation:none!important;transition:none!important}}\n`;
  css += `.A{\n${declarations(machine.level.A, ' ')}\n}\n.B{\n${declarations(machine.level.B, ' ')}\n}\n`;
  if (machine.level.T) css += `.T{\n${declarations(machine.level.T, ' ')}\n}\n`;
  // display: view values for the shown state, the step counter, the health of the run
  css += `.D{\n${declarations([...machine.select, ...machine.display, ...(interp ? interp.dDefs : [])], ' ')}\n --rok: calc(1 - min(1, max(round(down, ${F} / 2), var(--rvf))));\n}\n`;
  css += `${ui.bindingCss}`;
  css += themeCss();
  css += `.rr-sd text{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px;font-weight:600;fill:var(--rr-fg)}
.rr-ui{opacity:calc(.25 + .75 * var(--rok));background:transparent}
.rr-prog{fill:var(--rr-acc);transform:scaleX(calc(var(--rsx) / ${steps}))}
.st-run{opacity:calc((1 - min(1, ${F})) * (1 - clamp(0, var(--rsx) - ${steps - 1}, 1)) * var(--rok))}
.st-end{opacity:calc((1 - min(1, ${F})) * clamp(0, var(--rsx) - ${steps - 1}, 1) * var(--rok))}
.st-halt{opacity:calc(mod(${F}, 2) * var(--rok))}
.st-err{opacity:calc(1 - var(--rok))}
`;
  const stepDigits = steps >= 1000 ? String(steps).length : 3;
  for (let d = 0; d < stepDigits; d++) {
    css += `.s${d} use{transform:translateY(calc(mod(round(down, var(--rsx) / ${10 ** d}), 10) * -18px))}\n`;
    if (d) css += `.s${d}{opacity:clamp(0, var(--rsx) - ${10 ** d - 1}, 1)}\n`;
  }

  const sy = H - L.foot + 14;
  let disp = '<g class="C"><g class="D">';
  disp += `<rect class="rr-prog" x="0" y="${H - L.foot - 1}" width="${W}" height="2"/>`;
  disp += `<foreignObject x="${L.uiX}" y="${L.uiY}" width="${ui.width}" height="${ui.height}">`;
  // Firefox re-matches @container style() rules (the variant switches) only when the change
  // does not come from an animation alone; a size container whose width follows the step
  // makes it re-evaluate them on every step. It is an extra outer element: the UI wrapper
  // (which receives the project's html/body rules) keeps its fixed px size.
  disp += `<div xmlns="http://www.w3.org/1999/xhtml" class="rr-q" style="width:calc(${ui.width}px + mod(var(--rsx), 64) * .25px);height:${ui.height}px;container-type:inline-size">`;
  disp += `<div class="rr-ui" style="position:relative;width:${ui.width}px;height:${ui.height}px">${ui.markup}</div></div>`;
  disp += '</foreignObject>';
  disp += `<text x="24" y="${sy + 14}" class="rr-l">STEP</text>`;
  for (let d = 0; d < stepDigits; d++) disp += `<g class="rr-sd s${d}" transform="translate(${64 + (stepDigits - 1 - d) * 9} ${sy})" clip-path="url(#rrcs)"><use href="#rrds"/></g>`;
  const slashX = stepDigits > 3 ? 64 + stepDigits * 9 + 5 : 96;
  disp += `<text x="${slashX}" y="${sy + 14}" class="rr-m" font-size="13">/ ${steps}</text>`;
  const stx = stepDigits > 3 ? 168 : 150;
  const dot = (cls, color, label, pulse) => `<g class="${cls}">${pulse ? `<circle class="rr-pulse" cx="${stx}" cy="${sy + 9}" r="7" style="fill:${color};fill-opacity:.35"/>` : ''}<circle cx="${stx}" cy="${sy + 9}" r="4" style="fill:${color}"/><text x="${stx + 10}" y="${sy + 14}" class="rr-l" style="fill:${color}">${label}</text></g>`;
  disp += dot('st-run', 'var(--rr-acc)', 'RUNNING', true) + dot('st-end', 'var(--rr-mut)', 'END') + dot('st-halt', 'var(--rr-blue)', 'HALTED') + dot('st-err', 'var(--rr-red)', 'OUT OF RANGE');
  const room = Math.floor((W - 24 - 270) / 6.7);
  const credit = meta.credit.length > room ? `${meta.credit.slice(0, room - 1)}…` : meta.credit;
  disp += `<text x="${W - 24}" y="${sy + 14}" class="rr-m" font-size="11" text-anchor="end">${esc(credit)}</text>`;
  disp += '</g></g>';

  let defs = '<clipPath id="rrcs"><rect width="9" height="18"/></clipPath><g id="rrds" class="rr-sd" text-anchor="middle">';
  for (let i = 0; i < 10; i++) defs += `<text x="4.5" y="${i * 18 + 14}">${i}</text>`;
  defs += '</g>';

  // the header line: title, then the module and views, before the LIVE badge
  const info = `${meta.wasmName} · ${meta.exportName}() + ${machine.display.length ? Object.keys(machine.viewProps).length : 0} views`;
  let body = frameAndHeader({ W, H, title: meta.title, info, titleMax: 300 });
  body += footerRule({ W, y: H - L.foot });

  let levels = `${altInitAnchors(meta.altInits)}<g class="R" style="${rootStyle(machine)}">`;
  let close = '</g>';
  for (let b = 1; b <= machine.blocks; b++) { levels += `<g class="${levelClass(b, machine)}" style="${levelStyle(b, machine)}">`; close += '</g>'; }
  levels += disp + close;

  const stepNote = machine.stride > 1 ? `${machine.stride} steps per nested g element (${steps} steps across ${machine.blocks} levels)` : 'one step per nested g element';
  const header = `<!-- README Runtime ${meta.toolVersion} - generated card, wasm sha256:${meta.wasmSha256.slice(0, 16)}.
     The UI below is the project's own component markup (rendered once, statically) whose
     view-dependent parts are CSS bindings. The view values are computed by CSS from the live
     state, which the rules .A and .B advance ${stepNote}. The only input is
     the custom property ${machine.initProps.join(', ')} in the style attribute of g.R.${meta.altInits?.length ? ` The URL fragments ${meta.altInits.map((x) => `#${altInitId(x)}`).join(' ')}
     start the same run from those values instead.` : ''} Regenerate with: readme-runtime build -->`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="rrt rrd">
${header}
<title id="rrt">${esc(meta.title)} — README Runtime</title>
<desc id="rrd">${esc(meta.title)}: the project's UI driven live by ${esc(meta.wasmName)} computed in CSS.</desc>
<style><![CDATA[
${css}]]></style>
<defs>${defs}</defs>
${body}
${levels}
</svg>
`;
}
