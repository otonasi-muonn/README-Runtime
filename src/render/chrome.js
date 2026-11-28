// The card's outer chrome, shared by trace cards and UI cards: theme tokens, frame, header
// (title, module info, LIVE badge) and the footer rule. It holds no computation: everything
// here is static markup and CSS, so it can change without touching the machine or the views.
// Nothing here is animated: any animated element in an <img> SVG makes the browser
// re-rasterize the whole image on every frame.
import { fitText, textWidth } from './text.js';

export const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export const SANS = '-apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans",Helvetica,Arial,sans-serif';
export const MONO = 'ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,"Liberation Mono",monospace';

// Sizes of the chrome, in SVG units.
export const CHROME = { head: 48, foot: 44, radius: 12, padX: 20 };

// Theme tokens (GitHub's dark and light palettes). --rr-tl is the lightness of the trace bit
// colours: bright cells on a dark panel, darker ones on a light panel.
export function themeCss() {
  return `svg{--rr-bg:#0d1117;--rr-panel:#161b22;--rr-line:#30363d;--rr-fg:#e6edf3;--rr-mut:#8b949e;--rr-acc:#3fb950;--rr-blue:#58a6ff;--rr-red:#f85149;--rr-amber:#d29922;--rr-tl:55%}
@media (prefers-color-scheme:light){svg{--rr-bg:#ffffff;--rr-panel:#f6f8fa;--rr-line:#d0d7de;--rr-fg:#1f2328;--rr-mut:#59636e;--rr-acc:#1a7f37;--rr-blue:#0969da;--rr-red:#cf222e;--rr-amber:#bf8700;--rr-tl:40%}}
.rr-t{font-family:${SANS};fill:var(--rr-fg)}
.rr-m{font-family:${MONO};fill:var(--rr-mut)}
.rr-l{font-family:${SANS};font-size:11px;letter-spacing:.08em;font-weight:600;fill:var(--rr-mut)}
.rr-bg{fill:var(--rr-bg);stroke:var(--rr-line)}
.rr-pn{fill:var(--rr-panel);stroke:var(--rr-line)}
.rr-rule{stroke:var(--rr-line)}
.rr-badge rect{fill:var(--rr-acc);fill-opacity:.12;stroke:var(--rr-acc);stroke-opacity:.45}
.rr-badge circle{fill:var(--rr-acc)}
.rr-badge text{fill:var(--rr-acc)}
`;
}

// width of an uppercase .rr-l label (11 px, letter-spacing .08em)
const labelWidth = (s) => textWidth(s, 11) * 1.08 + s.length * 0.88;

const BADGE_TEXT = 'LIVE · CSS RUNTIME';

// The LIVE badge, right-aligned at x = right. Returns its markup and its left edge.
function badge(right) {
  const tw = Math.ceil(labelWidth(BADGE_TEXT));
  const w = 10 + 6 + 7 + tw + 10;
  const x = right - w;
  const markup = `<g class="rr-badge"><rect x="${x + 0.5}" y="13.5" width="${w - 1}" height="21" rx="10.5"/>`
    + `<circle cx="${x + 13}" cy="24" r="3.5"/><text x="${x + 23}" y="28" class="rr-l">${BADGE_TEXT}</text></g>`;
  return { markup, left: x };
}

// Frame and header. info is the muted monospace text after the title (module · export).
// The title gets up to titleMax px; the info is shortened to what is left before the badge.
export function frameAndHeader({ W, H, title, info, titleMax = 320 }) {
  const { head, radius, padX } = CHROME;
  const b = badge(W - 14);
  const shownTitle = fitText(title, titleMax, 15);
  const infoX = Math.round(padX + Math.min(titleMax, textWidth(shownTitle, 15)) + 14);
  const shownInfo = fitText(info, Math.max(0, b.left - 14 - infoX), 12, { mono: true });
  let s = `<rect class="rr-bg" x=".5" y=".5" width="${W - 1}" height="${H - 1}" rx="${radius}"/>`;
  s += `<text x="${padX}" y="30" class="rr-t" font-size="15" font-weight="600">${esc(shownTitle)}</text>`;
  if (shownInfo && shownInfo !== '…') s += `<text x="${infoX}" y="30" class="rr-m" font-size="12">${esc(shownInfo)}</text>`;
  s += b.markup;
  s += `<line class="rr-rule" x1="0" y1="${head}" x2="${W}" y2="${head}"/>`;
  return s;
}

// The rule above the footer.
export function footerRule({ W, y }) {
  return `<line class="rr-rule" x1="0" y1="${y}" x2="${W}" y2="${y}"/>`;
}
