// SVG card whose body is the project's own UI (static markup + CSS bindings), driven by
// the CSS machine. The machine is the same as for trace cards; only the display differs.
import { declarations } from '../runtime/machine.js';
import { toCss, V, absV } from '../compiler/css.js';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function uiLayout(ui) {
  const pad = 24, head = 44, foot = 44;
  const W = Math.max(560, ui.width + pad * 2);
  return { W, H: head + 16 + ui.height + 12 + foot, pad, head, foot, uiX: Math.round((W - ui.width) / 2), uiY: head + 16 };
}

export function renderUiCard(machine, meta, ui) {
  const L = uiLayout(ui);
  const { W, H } = L;
  const out = machine.out;
  const steps = machine.steps;
  const F = `var(--${out.f})`;

  let css = '';
  for (const [name, inherits] of machine.props) css += `@property --${name}{syntax:'<integer>';inherits:${inherits};initial-value:0}\n`;
  for (const name of ['rsx', 'rok']) css += `@property --${name}{syntax:'<integer>';inherits:true;initial-value:0}\n`;
  // the project's stylesheet first, so the card chrome below wins any overlap
  css += `${ui.css}\n`;
  css += `.R{\n${declarations(machine.root.filter((d) => !d.literal), ' ')}\n animation:rrclk ${(machine.T + 1) * meta.stepMs}ms steps(${machine.T + 1},jump-none) infinite}\n`;
  css += `@keyframes rrclk{from{--rt:0}to{--rt:${machine.T}}}\n`;
  css += `@media (prefers-reduced-motion:reduce){.R{animation:none;--rt:${machine.T}}}\n`;
  css += `.A{\n${declarations(machine.level.A, ' ')}\n}\n.B{\n${declarations(machine.level.B, ' ')}\n}\n`;
  // display: view values for the shown state, the step counter, the health of the run
  css += `.D{\n${declarations(machine.display, ' ')}\n --rsx: var(--${out.s});\n --rok: calc(1 - min(1, max(round(down, ${F} / 2), var(--rvf))));\n}\n`;
  css += `${ui.bindingCss}`;
  css += `
svg{--rr-bg:#0d1117;--rr-line:#30363d;--rr-fg:#e6edf3;--rr-mut:#7d8590;--rr-acc:#3fb950;--rr-blue:#58a6ff;--rr-red:#f85149}
@media (prefers-color-scheme:light){svg{--rr-bg:#ffffff;--rr-line:#d0d7de;--rr-fg:#1f2328;--rr-mut:#656d76;--rr-acc:#1a7f37;--rr-blue:#0969da;--rr-red:#cf222e}}
.rr-t{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;fill:var(--rr-fg)}
.rr-m{font-family:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,"Liberation Mono",monospace;fill:var(--rr-mut)}
.rr-bg{fill:var(--rr-bg);stroke:var(--rr-line)}
.rr-l{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;font-size:11px;letter-spacing:.08em;font-weight:600;fill:var(--rr-mut)}
.rr-pulse{animation:rrpulse 1.2s ease-in-out infinite}@keyframes rrpulse{50%{opacity:.25}}
.rr-sd text{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px;font-weight:600;fill:var(--rr-fg)}
.rr-ui{opacity:calc(.25 + .75 * var(--rok))}
.st-run{opacity:calc((1 - min(1, ${F})) * (1 - clamp(0, var(--rsx) - ${steps - 1}, 1)) * var(--rok))}
.st-end{opacity:calc((1 - min(1, ${F})) * clamp(0, var(--rsx) - ${steps - 1}, 1) * var(--rok))}
.st-halt{opacity:calc(mod(${F}, 2) * var(--rok))}
.st-err{opacity:calc(1 - var(--rok))}
`;
  for (let d = 0; d < 3; d++) {
    css += `.s${d} use{transform:translateY(calc(mod(round(down, var(--rsx) / ${10 ** d}), 10) * -18px))}\n`;
    if (d) css += `.s${d}{opacity:clamp(0, var(--rsx) - ${10 ** d - 1}, 1)}\n`;
  }

  const sy = H - L.foot + 14;
  let disp = '<g class="D">';
  disp += `<foreignObject x="${L.uiX}" y="${L.uiY}" width="${ui.width}" height="${ui.height}">`;
  disp += `<div xmlns="http://www.w3.org/1999/xhtml" class="rr-ui" style="position:relative;width:${ui.width}px;height:${ui.height}px">${ui.markup}</div>`;
  disp += '</foreignObject>';
  disp += `<text x="24" y="${sy + 14}" class="rr-l">STEP</text>`;
  for (let d = 0; d < 3; d++) disp += `<g class="rr-sd s${d}" transform="translate(${64 + (2 - d) * 9} ${sy})" clip-path="url(#rrcs)"><use href="#rrds"/></g>`;
  disp += `<text x="96" y="${sy + 14}" class="rr-m" font-size="13">/ ${steps}</text>`;
  const stx = 150;
  const dot = (cls, color, label, pulse) => `<g class="${cls}">${pulse ? `<circle class="rr-pulse" cx="${stx}" cy="${sy + 9}" r="7" style="fill:${color};fill-opacity:.35"/>` : ''}<circle cx="${stx}" cy="${sy + 9}" r="4" style="fill:${color}"/><text x="${stx + 10}" y="${sy + 14}" class="rr-l" style="fill:${color}">${label}</text></g>`;
  disp += dot('st-run', 'var(--rr-acc)', 'RUNNING', true) + dot('st-end', 'var(--rr-mut)', 'END') + dot('st-halt', 'var(--rr-blue)', 'HALTED') + dot('st-err', 'var(--rr-red)', 'OUT OF RANGE');
  const room = Math.floor((W - 24 - 270) / 6.7);
  const credit = meta.credit.length > room ? `${meta.credit.slice(0, room - 1)}…` : meta.credit;
  disp += `<text x="${W - 24}" y="${sy + 14}" class="rr-m" font-size="11" text-anchor="end">${esc(credit)}</text>`;
  disp += '</g>';

  let defs = '<clipPath id="rrcs"><rect width="9" height="18"/></clipPath><g id="rrds" class="rr-sd" text-anchor="middle">';
  for (let i = 0; i < 10; i++) defs += `<text x="4.5" y="${i * 18 + 14}">${i}</text>`;
  defs += '</g>';

  let body = `<rect class="rr-bg" x=".5" y=".5" width="${W - 1}" height="${H - 1}" rx="10"/>`;
  body += `<text x="20" y="29" class="rr-t" font-size="15" font-weight="600">${esc(meta.title)}</text>`;
  body += `<text x="${Math.round(20 + Math.min(300, meta.title.length * 8.6) + 14)}" y="29" class="rr-m" font-size="12">${esc(meta.wasmName)} · ${esc(meta.exportName)}() + ${machine.display.length ? Object.keys(machine.viewProps).length : 0} views</text>`;
  body += `<circle class="rr-pulse" cx="${W - 132}" cy="25" r="4" style="fill:var(--rr-acc)"/><text x="${W - 122}" y="29" class="rr-l">LIVE · CSS RUNTIME</text>`;
  body += `<line x1="0" y1="44" x2="${W}" y2="44" stroke="var(--rr-line)"/><line x1="0" y1="${H - L.foot}" x2="${W}" y2="${H - L.foot}" stroke="var(--rr-line)"/>`;

  let levels = `<g class="R" style="--${machine.initProp}:${machine.init}">`;
  let close = '</g>';
  for (let k = 1; k <= steps; k++) { levels += `<g class="${k % 2 === 1 ? 'A' : 'B'}">`; close += '</g>'; }
  levels += disp + close;

  const header = `<!-- README Runtime ${meta.toolVersion} - generated card, wasm sha256:${meta.wasmSha256.slice(0, 16)}.
     The UI below is the project's own component markup (rendered once, statically) whose
     view-dependent parts are CSS bindings. The view values are computed by CSS from the live
     state, which the rules .A and .B advance one step per nested g element. The only input is
     the custom property ${machine.initProp} in the style attribute of g.R. Regenerate with: readme-runtime build -->`;
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
