// React serializes numeric CSS lengths as px except at zero. Canonicalize only a whole
// zero value of an unambiguous length property; unitless numbers, custom properties,
// shorthands, function arguments and percentages keep their original grammar.
const PX_LENGTHS = new Set([
  'left', 'right', 'top', 'bottom', 'width', 'height',
  'min-width', 'max-width', 'min-height', 'max-height',
  'inset-block-start', 'inset-block-end', 'inset-inline-start', 'inset-inline-end',
  'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'margin-block-start', 'margin-block-end', 'margin-inline-start', 'margin-inline-end',
  'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'padding-block-start', 'padding-block-end', 'padding-inline-start', 'padding-inline-end',
  'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width',
  'border-top-left-radius', 'border-top-right-radius', 'border-bottom-left-radius', 'border-bottom-right-radius',
  'font-size', 'letter-spacing', 'word-spacing', 'text-indent',
  'outline-width', 'outline-offset', 'column-width', 'column-gap', 'row-gap',
  'flex-basis', 'perspective',
]);

export function normalizeLengthZeros(style) {
  if (!/:\s*0(?:\s*[;!]|\s*$)/.test(style)) return style;
  const pieces = [];
  let start = 0, depth = 0, quote = '';
  const declaration = (s) => s.replace(/^(\s*)([\w-]+)(\s*:\s*)0(\s*(?:!important\s*)?)$/i,
    (match, space, prop, colon, end) => PX_LENGTHS.has(prop.toLowerCase()) ? `${space}${prop}${colon}0px${end}` : match);
  for (let i = 0; i < style.length; i++) {
    const ch = style[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === ';' && depth === 0) {
      pieces.push(declaration(style.slice(start, i)));
      start = i + 1;
    }
  }
  pieces.push(declaration(style.slice(start)));
  return pieces.join(';');
}
