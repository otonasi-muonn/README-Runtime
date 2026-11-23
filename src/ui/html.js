// Minimal HTML parser / XHTML serializer for React's static markup, so it can be placed in
// an SVG <foreignObject> (which is XML).
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export class HtmlError extends Error {}

export function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return ENT[e.toLowerCase()] ?? m;
  });
}
const escText = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (s) => escText(s).replace(/"/g, '&quot;');

// -> { type: 'root', children } ; element: { type: 'el', tag, attrs: [[name, value]], children }
export function parseHtml(html) {
  const root = { type: 'root', children: [] };
  const stack = [root];
  let i = 0;
  const top = () => stack[stack.length - 1];
  while (i < html.length) {
    if (html.startsWith('<!--', i)) {
      const end = html.indexOf('-->', i + 4);
      if (end < 0) throw new HtmlError('unterminated comment');
      i = end + 3;
      continue;
    }
    if (html.startsWith('</', i)) {
      const end = html.indexOf('>', i);
      const tag = html.slice(i + 2, end).trim();
      let j = stack.length - 1;
      while (j > 0 && stack[j].tag !== tag) j--;
      if (j === 0) throw new HtmlError(`unexpected </${tag}>`);
      stack.length = j;
      i = end + 1;
      continue;
    }
    if (html[i] === '<' && /[a-zA-Z]/.test(html[i + 1] ?? '')) {
      const m = /^<([a-zA-Z][\w:.-]*)/.exec(html.slice(i, i + 200));
      const tag = m[1];
      let j = i + m[0].length;
      const attrs = [];
      for (;;) {
        while (/\s/.test(html[j])) j++;
        if (html[j] === '>' || html.startsWith('/>', j)) break;
        const am = /^([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/.exec(html.slice(j, j + 100000));
        if (!am) throw new HtmlError(`bad attribute in <${tag}>`);
        attrs.push([am[1], decodeEntities(am[2] ?? am[3] ?? am[4] ?? '')]);
        j += am[0].length;
      }
      const selfClose = html.startsWith('/>', j);
      i = j + (selfClose ? 2 : 1);
      const el = { type: 'el', tag, attrs, children: [] };
      top().children.push(el);
      if (!selfClose && !VOID.has(tag.toLowerCase())) stack.push(el);
      continue;
    }
    const next = html.indexOf('<', i + 1);
    const end = next < 0 ? html.length : next;
    const text = decodeEntities(html.slice(i, end));
    if (text) top().children.push({ type: 'text', value: text });
    i = end;
  }
  return root;
}

// Serialize as XHTML. Elements named svg get the SVG namespace (inline SVG inside HTML);
// `rewrite(node, attrs)` may return replacement attributes, `textOf(node)` replacement markup.
export function toXhtml(node, { root = true, hooks = {} } = {}) {
  const out = [];
  const walk = (n, ns) => {
    if (n.type === 'root') { n.children.forEach((c) => walk(c, ns)); return; }
    if (n.type === 'text') { out.push(hooks.text ? hooks.text(n) : escText(n.value)); return; }
    if (n.type === 'raw') { out.push(n.markup); return; }
    if (n.type === 'switch') { out.push(hooks.switch(n, (c) => { const sub = []; const save = out.length; walk(c, ns); sub.push(...out.splice(save)); return sub.join(''); })); return; }
    let attrs = hooks.attrs ? hooks.attrs(n) : n.attrs;
    let childNs = ns;
    if (n.tag === 'svg' && ns !== 'svg') {
      childNs = 'svg';
      if (!attrs.some(([k]) => k === 'xmlns')) attrs = [['xmlns', 'http://www.w3.org/2000/svg'], ...attrs];
    }
    const a = attrs.map(([k, v]) => ` ${k}="${escAttr(String(v))}"`).join('');
    if (!n.children.length && (VOID.has(n.tag.toLowerCase()) || childNs === 'svg')) out.push(`<${n.tag}${a}/>`);
    else {
      out.push(`<${n.tag}${a}>`);
      n.children.forEach((c) => walk(c, childNs));
      out.push(`</${n.tag}>`);
    }
  };
  walk(node, 'html');
  return out.join('');
}
