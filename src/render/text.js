// Rough text widths for placing and shortening the card header (SVG text has no layout).
// East Asian wide characters take about 1em; others about 0.57em in the card's UI font (the
// 8.6 px at 15 px the headers always used); monospace about 0.6em.
const WIDE = /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]|[\u{20000}-\u{3FFFD}]/u;

export function textWidth(s, size, { mono = false } = {}) {
  let w = 0;
  for (const ch of String(s)) w += WIDE.test(ch) ? size : mono ? size * 0.6 : (size * 8.6) / 15;
  return w;
}

// s, shortened with "…" to fit in maxWidth
export function fitText(s, maxWidth, size, opts) {
  if (textWidth(s, size, opts) <= maxWidth) return s;
  let out = '';
  for (const ch of String(s)) {
    if (textWidth(`${out}${ch}…`, size, opts) > maxWidth) break;
    out += ch;
  }
  return `${out}…`;
}
