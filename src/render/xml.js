// Minimal XML well-formedness check for the generated SVG. A malformed SVG renders as a
// broken image while every other check passes, so the build refuses to write one.
export function checkWellFormed(xml) {
  const stack = [];
  let i = 0;
  let roots = 0;
  const fail = (msg) => { throw new Error(`generated SVG is not well-formed XML: ${msg} (at offset ${i})`); };
  const checkText = (text) => {
    if (text.includes('<')) fail('raw "<" in text');
    const amp = /&(?!(?:[A-Za-z][\w.-]*|#\d+|#x[\da-fA-F]+);)/;
    if (amp.test(text)) fail('unescaped "&"');
  };
  while (i < xml.length) {
    const lt = xml.indexOf('<', i);
    const text = xml.slice(i, lt < 0 ? xml.length : lt);
    if (text.trim() && !stack.length) fail('text outside the root element');
    checkText(text);
    if (lt < 0) break;
    i = lt;
    if (xml.startsWith('<!--', i)) {
      const end = xml.indexOf('-->', i + 4);
      if (end < 0) fail('unterminated comment');
      if (xml.slice(i + 4, end).includes('--') || xml[end - 1] === '-') fail('"--" inside a comment');
      i = end + 3;
    } else if (xml.startsWith('<![CDATA[', i)) {
      const end = xml.indexOf(']]>', i);
      if (end < 0) fail('unterminated CDATA section');
      if (!stack.length) fail('CDATA outside the root element');
      i = end + 3;
    } else if (xml.startsWith('<?', i)) {
      const end = xml.indexOf('?>', i);
      if (end < 0) fail('unterminated processing instruction');
      i = end + 2;
    } else if (xml.startsWith('</', i)) {
      const m = /^<\/([A-Za-z_][\w.:-]*)\s*>/.exec(xml.slice(i, i + 200));
      if (!m) fail('malformed end tag');
      if (stack.pop() !== m[1]) fail(`mismatched end tag </${m[1]}>`);
      i += m[0].length;
    } else {
      const m = /^<([A-Za-z_][\w.:-]*)((?:\s+[A-Za-z_][\w.:-]*\s*=\s*(?:"[^"<]*"|'[^'<]*'))*)\s*(\/?)>/.exec(xml.slice(i, i + 100000));
      if (!m) fail('malformed start tag');
      const attrs = m[2];
      const names = [...attrs.matchAll(/([A-Za-z_][\w.:-]*)\s*=/g)].map((a) => a[1]);
      if (new Set(names).size !== names.length) fail(`duplicate attribute in <${m[1]}>`);
      for (const v of attrs.matchAll(/=\s*(?:"([^"]*)"|'([^']*)')/g)) checkText(v[1] ?? v[2]);
      if (!stack.length) { roots++; if (roots > 1) fail('more than one root element'); }
      if (!m[3]) stack.push(m[1]);
      i += m[0].length;
    }
  }
  if (stack.length) fail(`unclosed <${stack.at(-1)}>`);
  if (roots !== 1) fail('no root element');
  return true;
}
