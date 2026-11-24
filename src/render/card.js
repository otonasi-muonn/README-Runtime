// SVG card: the visible face of the CSS machine.
// Everything that depends on the program's values is driven by CSS custom properties that
// the browser computes at view time; the markup only holds layout.
import { N, V, toCss, signBit, absV, STORED_LIMIT } from '../compiler/css.js';
import { declarations, levelStyle } from '../runtime/machine.js';

export const TEMPLATE_VERSION = 1;

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const r4 = (x) => Number(x.toFixed(4));

// Layout constants (exported for the pixel-level browser tests).
export function layout(machine, opts = {}) {
  const W = 800, H = 300;
  const steps = machine.steps;
  const bits = opts.bits ?? 20;
  const tr = { x: 320, y: 86, w: 456, h: 147 };
  const rows = bits + 1; // + sign row
  const rh = tr.h / rows;
  const cw = tr.w / (steps + 1);
  return {
    W, H, bits, rows, rh, cw, tr,
    digits: { x: 40, y: 78, w: 30, h: 52, n: 7 },
    leds: { x: 40, y: 150, size: 5, pitch: 7, groupGap: 5 },
    step: { x: 40, y: 188 },
    ledX: (j) => 40 + (31 - j) * 7 + Math.floor((31 - j) / 8) * 5,
  };
}

function digitStrip(id, w, h, cls) {
  let s = `<g id="${id}" class="${cls}" text-anchor="middle">`;
  for (let i = 0; i < 10; i++) s += `<text x="${r4(w / 2)}" y="${r4(i * h + h * 0.78)}">${i}</text>`;
  return s + '</g>';
}

export function renderCard(machine, meta, opts = {}) {
  const L = layout(machine, opts);
  const { W, H, tr, rh, cw, bits } = L;
  const out = machine.out;
  const steps = machine.steps;

  // ---------------------------------------------------------------- registered properties
  const extra = ['rdv', 'rx0'];
  let css = '';
  for (const [name, inherits] of machine.props) css += `@property --${name}{syntax:'<integer>';inherits:${inherits};initial-value:0}\n`;
  for (const name of extra) css += `@property --${name}{syntax:'<integer>';inherits:true;initial-value:0}\n`;

  // ---------------------------------------------------------------- machine
  const rootDefs = machine.root.filter((d) => !d.literal);
  css += `.R{\n${declarations(rootDefs, ' ')}\n}\n`;
  // The step clock is the only animation. It runs on .C, which wraps the display (.D) at the
  // innermost level: a tick restyles the display only, never the levels that compute the run,
  // and on a frame where the step does not change .C's style comes out the same, so nothing
  // inside it is restyled. Any other animated element in an <img> SVG makes the browser
  // re-rasterize the whole image every frame (a pulsing dot cost ~20% of a CPU core on a
  // static card), and "reduce motion" stops the clock, i.e. everything (this rule comes
  // after .C's, which it overrides).
  css += `.C{animation:rrclk ${(machine.T + 1) * meta.stepMs}ms steps(${machine.T + 1},jump-none) infinite}\n`;
  css += `@keyframes rrclk{from{--rt:0}to{--rt:${machine.T}}}\n`;
  css += `@media (prefers-reduced-motion:reduce){.C{animation:none;--rt:${machine.T}}}\n`;
  css += `.A{\n${declarations(machine.level.A, ' ')}\n}\n`;
  css += `.B{\n${declarations(machine.level.B, ' ')}\n}\n`;

  // ---------------------------------------------------------------- theme
  css += `
svg{--bg:#0d1117;--panel:#161b22;--line:#30363d;--fg:#e6edf3;--mut:#7d8590;--acc:#3fb950;--blue:#58a6ff;--red:#f85149;--led:#3fb950}
@media (prefers-color-scheme:light){svg{--bg:#ffffff;--panel:#f6f8fa;--line:#d0d7de;--fg:#1f2328;--mut:#656d76;--acc:#1a7f37;--blue:#0969da;--red:#cf222e;--led:#1a7f37}}
text{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;fill:var(--fg)}
.mono,.dg text{font-family:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,"Liberation Mono",monospace}
.bg{fill:var(--bg);stroke:var(--line)}.pn{fill:var(--panel);stroke:var(--line)}
.mut{fill:var(--mut)}.lbl{font-size:11px;letter-spacing:.08em;fill:var(--mut);font-weight:600}
.big text{font-size:44px;font-weight:600}.sm text{font-size:15px;font-weight:600}
.live{fill:var(--acc)}
`;
  // trace columns
  css += `.col{transform:translateX(calc(var(--rk) * ${r4(cw)}px))}\n`;
  for (let b = 0; b < bits; b++) {
    const hue = Math.round(150 - (b / Math.max(1, bits - 1)) * 150 + 360) % 360;
    css += `.j${b}{fill:hsl(${hue} 70% 55%);opacity:calc(${toCss(cellBit(b))} * var(--ra))}\n`;
  }
  css += `.js{fill:var(--red);opacity:calc(${toCss(signBit(V('rx')))} * var(--ra))}\n`;
  css += `.jo{fill:#d29922;opacity:calc(clamp(0, max(var(--rx) - ${2 ** bits - 1}, -1 * var(--rx) - ${2 ** bits}), 1) * var(--ra))}\n`;
  css += `.jm{fill:var(--mut);opacity:var(--ra)}\n`;
  // display (innermost level)
  css += `.D{\n${declarations(machine.select, ' ')}\n --rdv:${toCss(absV(V(out.c)))}}\n`;
  // the trace columns are not restyled by the clock: a cover hides the steps not reached yet
  css += `.tm{transform:translateX(calc((var(--rsx) + 1) * ${r4(cw)}px))}\n`;
  css += `.hl{transform:translateX(calc(var(--${out.s}) * ${r4(cw)}px))}\n`;
  for (let d = 0; d < L.digits.n; d++) {
    const p = 10 ** d;
    css += `.d${d} use{transform:translateY(calc(${toCss(digitOf('rdv', d))} * ${-L.digits.h}px))}\n`;
    if (d > 0) css += `.d${d}{opacity:clamp(0, var(--rdv) - ${p - 1}, 1)}\n`;
  }
  css += `.neg{opacity:${toCss(signBit(V(out.c)))};transform:translateX(calc((${L.digits.n - 1} - ${digitCount('rdv', L.digits.n)}) * ${L.digits.w}px))}\n`;
  css += `.num{opacity:calc(1 - min(1, round(down, var(--${out.f}) / 2)))}\n`;
  const ok = `(1 - min(1, round(down, var(--${out.f}) / 2)))`;
  for (let j = 0; j < 32; j++) css += `.L${j}{opacity:calc(.18 + .82 * ${toCss(cellBit(j, out.c))} * ${ok})}\n`;
  for (let d = 0; d < 3; d++) {
    css += `.s${d} use{transform:translateY(calc(${toCss(digitOf('rsx', d))} * -20px))}\n`;
    css += `.q${d} use{transform:translateY(calc(${toCss(digitOf(out.q, d))} * -20px))}\n`;
    if (d > 0) {
      css += `.s${d}{opacity:clamp(0, var(--rsx) - ${10 ** d - 1}, 1)}\n`;
      css += `.q${d}{opacity:clamp(0, var(--${out.q}) - ${10 ** d - 1}, 1)}\n`;
    }
  }
  // status: f = halted + 2*range + 4*trap (of the step being shown)
  const F = `var(--${out.f})`;
  css += `.st-run{opacity:calc((1 - min(1, ${F})) * (1 - clamp(0, var(--rsx) - ${steps - 1}, 1)))}\n`;
  css += `.st-end{opacity:calc((1 - min(1, ${F})) * clamp(0, var(--rsx) - ${steps - 1}, 1))}\n`;
  css += `.st-halt{opacity:mod(${F}, 2)}\n`;
  css += `.st-range{opacity:mod(round(down, ${F} / 2), 2)}\n`;
  css += `.st-trap{opacity:round(down, ${F} / 4)}\n`;
  css += `.st-err{opacity:min(1, round(down, ${F} / 2))}\n`;
  css += `.tot-q{opacity:mod(${F}, 2)}.tot-n{opacity:calc(1 - mod(${F}, 2))}\n`;
  const inRange = `clamp(0, ${STORED_LIMIT + 1} - var(--rx0), 1)`;
  for (let d = 0; d < L.digits.n; d++) {
    css += `.x0 .z${d} use{transform:translateY(calc(${toCss(digitOf('rx0', d))} * -20px))}\n`;
    css += d > 0 ? `.x0 .z${d}{opacity:calc(clamp(0, var(--rx0) - ${10 ** d - 1}, 1) * ${inRange})}\n` : `.x0 .z0{opacity:${inRange}}\n`;
  }
  css += `.x0{--rx0:${toCss(absV(V(machine.initProp)))}}.x0 .zn{opacity:calc(${toCss(signBit(V(machine.initProp)))} * ${inRange});transform:translateX(calc((${L.digits.n - 1} - ${digitCount('rx0', L.digits.n)}) * 10px))}\n`;
  css += `.x0 .zr{opacity:calc(1 - ${inRange})}\n`;

  // ---------------------------------------------------------------- defs
  let defs = '';
  defs += `<clipPath id="cb"><rect width="${L.digits.w}" height="${L.digits.h}"/></clipPath>`;
  defs += `<clipPath id="cs"><rect width="11" height="20"/></clipPath>`;
  defs += digitStrip('db', L.digits.w, L.digits.h, 'big');
  defs += digitStrip('ds', 11, 20, 'sm');
  let col = '<g id="col">';
  for (let b = 0; b < bits; b++) {
    const y = tr.y + (bits - b) * rh; // row 0 (top) is the sign row
    col += `<rect class="j${b}" x="${tr.x}" y="${r4(y)}" width="${r4(Math.max(0.8, cw - (cw > 3 ? 1 : 0)))}" height="${r4(rh - 1)}"/>`;
  }
  col += `<rect class="js" x="${tr.x}" y="${tr.y}" width="${r4(Math.max(0.8, cw - (cw > 3 ? 1 : 0)))}" height="${r4(rh - 1)}"/>`;
  // a value the rows cannot show (only possible when bits < 20) is marked, never truncated silently
  col += `<rect class="jo" x="${tr.x}" y="${tr.y}" width="${r4(Math.max(0.8, cw - (cw > 3 ? 1 : 0)))}" height="${r4(rh - 1)}"/>`;
  col += `<rect class="jm" x="${tr.x}" y="${tr.y + tr.h + 1}" width="${r4(Math.max(0.8, cw - (cw > 3 ? 1 : 0)))}" height="3"/>`;
  col += '</g>';
  defs += col;
  defs += `<clipPath id="tmc"><rect x="${tr.x}" y="${tr.y - 1}" width="${tr.w + 1}" height="${tr.h + 5}"/></clipPath>`;

  // ---------------------------------------------------------------- static chrome
  const title = esc(meta.title);
  const sig = `${esc(meta.exportName)}(i32) → i32`;
  let body = '';
  body += `<rect class="bg" x=".5" y=".5" width="${W - 1}" height="${H - 1}" rx="10"/>`;
  body += `<text x="20" y="29" font-size="15" font-weight="600">${title}</text>`;
  body += `<text x="${Math.round(20 + Math.min(320, meta.title.length * 8.6) + 14)}" y="29" class="mono mut" font-size="12">${esc(meta.wasmName)} · ${sig}</text>`;
  body += `<circle class="live pulse" cx="${W - 132}" cy="25" r="4"/><text x="${W - 122}" y="29" class="lbl" font-size="11">LIVE · CSS RUNTIME</text>`;
  body += `<line x1="0" y1="44" x2="${W}" y2="44" stroke="var(--line)"/>`;
  body += `<text x="40" y="70" class="lbl">STATE</text>`;
  body += `<text x="${tr.x}" y="70" class="lbl">TRACE · ONE COLUMN PER step() CALL · BITS OF THE STATE</text>`;
  body += `<rect class="pn" x="${tr.x - 6}" y="${tr.y - 6}" width="${tr.w + 12}" height="${tr.h + 12}" rx="6"/>`;
  body += `<text x="${tr.x}" y="${tr.y + tr.h + 22}" class="mono mut" font-size="11">0</text>`;
  body += `<text x="${tr.x + tr.w}" y="${tr.y + tr.h + 22}" class="mono mut" font-size="11" text-anchor="end">${steps}</text>`;
  body += `<text x="${tr.x + tr.w / 2}" y="${tr.y + tr.h + 22}" class="mut" font-size="11" text-anchor="middle">step →</text>`;
  body += `<line x1="0" y1="${H - 40}" x2="${W}" y2="${H - 40}" stroke="var(--line)"/>`;
  const snippet = meta.cssSnippet.length > 112 ? `${meta.cssSnippet.slice(0, 111)}…` : meta.cssSnippet;
  body += `<text x="20" y="${H - 15}" class="mono mut" font-size="11">${esc(snippet)}</text>`;

  // ---------------------------------------------------------------- display (innermost)
  let disp = '<g class="C"><g class="D">';
  disp += `<g clip-path="url(#tmc)"><rect class="tm" x="${tr.x}" y="${tr.y - 1}" width="${tr.w + 1}" height="${tr.h + 5}" style="fill:var(--panel)"/></g>`;
  const dg = L.digits;
  disp += '<g class="num">';
  disp += `<text class="neg mono" x="${dg.x - 2}" y="${dg.y + dg.h * 0.74}" font-size="40" font-weight="600">−</text>`;
  for (let d = 0; d < dg.n; d++) {
    const x = dg.x + 22 + (dg.n - 1 - d) * dg.w;
    disp += `<g class="dg d${d}" transform="translate(${x} ${dg.y})" clip-path="url(#cb)"><use href="#db"/></g>`;
  }
  disp += '</g>';
  disp += `<text class="st-range" x="${dg.x}" y="${dg.y + 34}" font-size="22" font-weight="600" style="fill:var(--red)">OUT OF RANGE</text>`;
  disp += `<text class="st-trap" x="${dg.x}" y="${dg.y + 34}" font-size="22" font-weight="600" style="fill:var(--red)">TRAP</text>`;
  for (let j = 0; j < 32; j++) {
    disp += `<rect class="L${j}" x="${L.ledX(j)}" y="${L.leds.y}" width="${L.leds.size}" height="${L.leds.size + 4}" rx="1" style="fill:var(--led)"/>`;
  }
  disp += `<text x="40" y="${L.leds.y + 26}" class="mono mut" font-size="10">i32 register · bit 31 … 0</text>`;
  // step counter
  const sy = L.step.y;
  disp += `<text x="40" y="${sy + 15}" class="lbl">STEP</text>`;
  for (let d = 0; d < 3; d++) disp += `<g class="dg sm s${d}" transform="translate(${84 + (2 - d) * 10} ${sy})" clip-path="url(#cs)"><use href="#ds"/></g>`;
  disp += `<text x="122" y="${sy + 15}" class="mono mut" font-size="15">/</text>`;
  disp += `<g class="tot-q">`;
  for (let d = 0; d < 3; d++) disp += `<g class="dg sm q${d}" transform="translate(${136 + (2 - d) * 10} ${sy})" clip-path="url(#cs)"><use href="#ds"/></g>`;
  disp += `</g><text class="tot-n mono mut" x="136" y="${sy + 15}" font-size="15">${steps}</text>`;
  // status
  const stx = 190;
  disp += `<g class="st-run"><circle class="pulse" cx="${stx}" cy="${sy + 10}" r="7" style="fill:var(--acc);fill-opacity:.35"/><circle cx="${stx}" cy="${sy + 10}" r="4" style="fill:var(--acc)"/><text x="${stx + 10}" y="${sy + 15}" class="lbl" style="fill:var(--acc)">RUNNING</text></g>`;
  disp += `<g class="st-end"><circle cx="${stx}" cy="${sy + 10}" r="4" style="fill:var(--mut)"/><text x="${stx + 10}" y="${sy + 15}" class="lbl">END</text></g>`;
  disp += `<g class="st-halt"><circle cx="${stx}" cy="${sy + 10}" r="4" style="fill:var(--blue)"/><text x="${stx + 10}" y="${sy + 15}" class="lbl" style="fill:var(--blue)">HALTED</text></g>`;
  disp += `<g class="st-err"><circle cx="${stx}" cy="${sy + 10}" r="4" style="fill:var(--red)"/><text x="${stx + 10}" y="${sy + 15}" class="lbl" style="fill:var(--red)">STOPPED</text></g>`;
  // highlight of the current trace column
  disp += `<rect class="hl" x="${r4(tr.x - 1)}" y="${tr.y - 3}" width="${r4(Math.max(2, cw + 1))}" height="${tr.h + 3}" rx="1" fill="none" stroke="var(--fg)" stroke-opacity=".55"/>`; // ends above the marker row
  disp += '</g></g>';

  // x0 label (lives in the root level, reads the init value directly)
  let x0 = `<g class="x0"><text x="40" y="${sy + 45}" class="lbl">INPUT x₀</text>`;
  x0 += `<text class="zn mono" x="104" y="${sy + 46}" font-size="15" font-weight="600">−</text>`;
  for (let d = 0; d < dg.n; d++) x0 += `<g class="dg sm z${d}" transform="translate(${114 + (dg.n - 1 - d) * 10} ${sy + 31})" clip-path="url(#cs)"><use href="#ds"/></g>`;
  x0 += `<text class="zr" x="114" y="${sy + 45}" font-size="11" style="fill:var(--red)">out of range</text>`;
  x0 += `<text x="${196}" y="${sy + 45}" class="mut" font-size="11">← the only input</text></g>`;

  // ---------------------------------------------------------------- nested levels
  let levels = `<g class="R" style="--${machine.initProp}:${machine.init}"><use href="#col" class="col"/>${x0}`;
  let close = '</g>';
  for (let k = 1; k <= steps; k++) {
    levels += `\n<g class="${k % 2 === 1 ? 'A' : 'B'}" style="${levelStyle(k)}"><use href="#col" class="col"/>`;
    close += '</g>';
  }
  levels += disp + close;

  // XML comments may not contain a double hyphen, so no user-provided text goes in here
  // (file and export names appear in <title>/<desc>/<text>, escaped).
  const header = `<!-- README Runtime ${meta.toolVersion} - generated card, wasm sha256:${meta.wasmSha256.slice(0, 16)}.
     Every number on this card is computed by CSS when it is displayed: the rules .A and .B are the
     exported step function compiled to CSS math, applied once per nested g element (the run is unrolled
     into ${steps} levels when the card is built; no value is stored). The only input is the custom
     property ${machine.initProp} in the style attribute of g.R: change it and the browser recomputes the run;
     a value that CSS cannot compute exactly shows OUT OF RANGE. Regenerate with: readme-runtime build -->`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="rrt rrd">
${header}
<title id="rrt">${title} — README Runtime</title>
<desc id="rrd">${esc(meta.wasmName)} ${esc(meta.exportName)}() runs live in CSS: starting from the initial value in the SVG (${machine.init} as generated), the browser computes up to ${steps} steps and animates them.</desc>
<style><![CDATA[
${css}]]></style>
<defs>${defs}</defs>
${body}
${levels}
</svg>
`;
}

function cellBit(j, name = 'rx') {
  const x = V(name);
  if (j === 0) return { k: 'f', fn: 'mod', args: [x, N(2)] };
  return { k: 'f', fn: 'mod', args: [{ k: 'f', fn: 'round', mode: 'down', args: [{ k: '/', a: x, b: N(2 ** j) }] }, N(2)] };
}

function digitOf(name, d) {
  const x = V(name);
  if (d === 0) return { k: 'f', fn: 'mod', args: [x, N(10)] };
  return { k: 'f', fn: 'mod', args: [{ k: 'f', fn: 'round', mode: 'down', args: [{ k: '/', a: x, b: N(10 ** d) }] }, N(10)] };
}

// Number of decimal digits of the non-negative value in --name (1..n), as CSS text.
function digitCount(name, n) {
  let s = '1';
  for (let d = 1; d < n; d++) s += ` + clamp(0, var(--${name}) - ${10 ** d - 1}, 1)`;
  return `(${s})`;
}
