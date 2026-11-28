// The project's own stylesheets, compiled for exactly the classes the rendered UI uses.
// Tailwind 4 entry files (@import "tailwindcss", @theme, ...) go through Tailwind's compiler;
// plain CSS passes through unchanged.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { UiError } from './bundle.js';

export function classCandidates(markups) {
  const set = new Set();
  for (const m of markups) {
    for (const match of m.matchAll(/\sclass="([^"]*)"/g)) for (const c of match[1].split(/\s+/)) if (c) set.add(c);
  }
  return [...set].sort();
}

// Tailwind 3 (@tailwind base/components/utilities + tailwind.config): compiled with the
// project's own tailwindcss 3 and postcss, for exactly the classes the UI uses. Tailwind 4
// would accept the file too, but without the v3 theme it silently drops colours and spacing.
async function tailwind3(css, abs, f, candidates, { cwd, deps }) {
  const req = createRequire(path.join(cwd, 'package.json'));
  let version, tailwind, postcss, loadConfig;
  try {
    version = req('tailwindcss/package.json').version;
    tailwind = req('tailwindcss');
    postcss = req('postcss');
    loadConfig = req('tailwindcss/loadConfig');
  } catch {
    throw new UiError('UI_CSS', `${f} uses Tailwind 3 directives (@tailwind base/components/utilities): install the project's dependencies (tailwindcss 3 and postcss) so README Runtime can compile it with the project's own Tailwind`);
  }
  if (!version.startsWith('3.')) throw new UiError('UI_CSS', `${f} uses @tailwind base/components (Tailwind 3 syntax) but the project has tailwindcss ${version}`);
  const configFile = ['ts', 'js', 'cjs', 'mjs'].map((x) => path.join(cwd, `tailwind.config.${x}`)).find((p) => fs.existsSync(p));
  if (configFile) deps.add(configFile);
  try {
    const config = configFile ? loadConfig(configFile) : {};
    const content = [{ raw: `<div class="${candidates.join(' ')}"></div>`, extension: 'html' }];
    return (await postcss([tailwind({ ...config, content })]).process(css, { from: abs })).css;
  } catch (e) {
    throw new UiError('UI_CSS', `Tailwind ${version} could not compile ${f}: ${e.message}`);
  }
}

// Properties of an html/body rule that lay out the page itself (and would move or resize the
// UI if applied to its wrapper) are dropped; everything else is handed down to the UI, which
// includes text, colours, custom properties and resets such as box-sizing that * inherits.
const PAGE_LAYOUT = /^(display|place-|align-|justify-|min-|max-|height$|width$|block-size|inline-size|margin|padding|overflow|position|inset|top$|left$|right$|bottom$|grid|flex|gap$|row-gap|column-gap|float|clear|z-index|transform|translate|scale|rotate|contain|container|zoom|scroll|overscroll|animation|transition)/;

function pageRules(css) {
  // (a lookbehind: consecutive rules share the brace between them)
  return css.replace(/(?<=^|[{};])(\s*)([^{};@]+)\{([^{}]*)\}/g, (m, ws, sel, body) => {
    const sels = sel.split(',').map((s) => s.trim());
    const page = sels.filter((s) => s === 'html' || s === 'body');
    if (!page.length) return m;
    const others = sels.filter((s) => s !== 'html' && s !== 'body');
    const decls = body.split(';').map((d) => d.trim()).filter(Boolean);
    const prop = (d) => d.slice(0, d.indexOf(':')).trim().toLowerCase();
    let out = others.length ? `${others.join(', ')} {${body}}` : '';
    const kept = decls.filter((d) => !PAGE_LAYOUT.test(prop(d)));
    if (kept.length) out += `${out ? '\n' : ''}.rr-ui { ${kept.join('; ')}; }`;
    const size = page.includes('html') && decls.find((d) => prop(d) === 'font-size');
    if (size) out += `${out ? '\n' : ''}svg:root { ${size}; }`;
    return `${ws}${out}`;
  });
}

export async function compileUiCss(files, candidates, { cwd = process.cwd() } = {}) {
  const parts = [];
  const deps = new Set();
  for (const f of files) {
    const abs = path.resolve(cwd, f);
    if (!fs.existsSync(abs)) throw new UiError('UI_CSS', `stylesheet ${f} not found`);
    deps.add(abs);
    const css = fs.readFileSync(abs, 'utf8');
    if (/@tailwind\s+(base|components)\b/.test(css) && !/@import\s+["']tailwindcss/.test(css)) {
      parts.push(await tailwind3(css, abs, f, candidates, { cwd, deps }));
    } else if (/@import\s+["']tailwindcss|@tailwind\b|@theme\b/.test(css)) {
      const { compile } = await import('@tailwindcss/node');
      let compiler;
      // `@import "tailwindcss"` resolves from the project when it has Tailwind installed,
      // otherwise from README Runtime's own copy.
      const customCssResolver = async (id, base) => {
        if (id !== 'tailwindcss' && !id.startsWith('tailwindcss/')) return undefined;
        const spec = id === 'tailwindcss' ? 'tailwindcss/index.css' : id;
        for (const from of [path.join(base, 'noop.js'), import.meta.url]) {
          try { return createRequire(from).resolve(spec); } catch { /* try the next location */ }
        }
        return undefined;
      };
      try {
        compiler = await compile(css, { base: path.dirname(abs), onDependency: (p) => deps.add(p), customCssResolver });
      } catch (e) {
        throw new UiError('UI_CSS', `Tailwind could not compile ${f}: ${e.message}`);
      }
      parts.push(compiler.build(candidates));
    } else {
      parts.push(css);
    }
  }
  // The component expects to live in the project's page: rules written for html/body (base
  // font, text colour, line height) are applied to the wrapper that hosts it instead.
  // (CRLF from a Windows checkout would make the card differ from a build on Linux)
  let css = pageRules(parts.join('\n').replace(/\r\n?/g, '\n')).replace(/(^|[\s,}(])(html|body)(?=\s*[,{:])/g, '$1.rr-ui');
  // Framework-provided font variables (next/font and the like) do not exist in an image:
  // map each undefined --font-* to a system stack instead of letting the declaration fail.
  const used = new Set([...css.matchAll(/var\(--(font-[\w-]+)\)/g)].map((m) => m[1]));
  const fallbacks = [...used].filter((v) => !new RegExp(`--${v}\\s*:`).test(css)).map((v) => {
    const mono = /mono|code|jetbrains|courier/i.test(v);
    const serif = /serif|disp|bricolage|georgia/i.test(v) && !/sans/i.test(v);
    return `--${v}: ${mono ? 'ui-monospace, monospace' : serif ? 'Georgia, serif' : 'system-ui, sans-serif'};`;
  });
  if (fallbacks.length) css += `\n:root { ${fallbacks.join(' ')} }\n`;
  return {
    css,
    fontFallbacks: fallbacks.map((f) => f.split(':')[0]),
    inputs: [...deps].filter((p) => !p.includes('node_modules')).map((p) => path.relative(cwd, p).replace(/\\/g, '/')).sort(),
  };
}
