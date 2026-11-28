// Bundle a demo entry (TSX importing the project's real components) and render it to static
// markup. Every render runs in a fresh VM context with deterministic Math.random and Date, so
// module state (id counters, random ids) cannot make two renders of the same props differ.
// Time zone and default locale are fixed too (UTC, en-US): a card built on a developer's
// machine must be byte-identical to the one CI regenerates.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
process.env.TZ = 'UTC';
export const LOCALE = 'en-US';
const RENDER_TIMEOUT_MS = 20000;

export class UiError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

// Modules that only make sense inside a framework runtime: fail with a precise message.
const FRAMEWORK_ONLY = /^(next\/(font|image|navigation|router|link|headers|dynamic)|next$)/;

export async function bundleEntry(entry, { tsconfig, cwd = process.cwd() } = {}) {
  const esbuild = await import('esbuild');
  const reactDir = path.dirname(require.resolve('react/package.json'));
  const reactDomDir = path.dirname(require.resolve('react-dom/package.json'));
  const abs = path.resolve(cwd, entry);
  const stub = `import Demo from ${JSON.stringify(abs)};
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server.browser';
globalThis.__rrRender = (props) => renderToStaticMarkup(createElement(Demo, props));`;
  let result;
  try {
    result = await esbuild.build({
      stdin: { contents: stub, resolveDir: path.dirname(abs), sourcefile: 'readme-runtime-entry.jsx', loader: 'jsx' },
      // the metafile's paths are relative to this; the inputs below are relative to cwd (the
      // config's directory, which need not be the process's: build --config sub/x.json)
      absWorkingDir: path.resolve(cwd),
      bundle: true,
      write: false,
      format: 'iife',
      platform: 'browser',
      target: 'es2022',
      jsx: 'automatic',
      tsconfig: tsconfig ? path.resolve(cwd, tsconfig) : undefined,
      metafile: true,
      logLevel: 'silent',
      define: { 'process.env.NODE_ENV': '"production"' },
      alias: { react: reactDir, 'react-dom': reactDomDir },
      loader: { '.css': 'empty', '.svg': 'text', '.png': 'empty', '.jpg': 'empty', '.woff2': 'empty' },
      plugins: [{
        name: 'readme-runtime-framework-guard',
        setup(b) {
          b.onResolve({ filter: FRAMEWORK_ONLY }, (args) => ({
            errors: [{ text: `"${args.path}" (imported by ${path.relative(cwd, args.importer) || args.importer}) only works inside the framework runtime; import the component without it, or pass the value it provides as a prop from the demo entry` }],
          }));
        },
      }],
    });
  } catch (e) {
    const first = e.errors?.[0];
    const loc = first?.location ? `${first.location.file}:${first.location.line}:${first.location.column}` : '';
    const dep = missingDependency(first?.text ?? '', cwd);
    if (dep) throw new UiError('DEPS_NOT_INSTALLED', `cannot bundle ${entry}: "${dep}" is a dependency of the project but is not installed (${loc}); install the project's dependencies (npm ci) before build or check`, { file: first?.location?.file, line: first?.location?.line });
    throw new UiError('UI_BUNDLE', `cannot bundle ${entry}: ${first?.text ?? e.message}${loc ? ` (${loc})` : ''}`, { file: first?.location?.file, line: first?.location?.line });
  }
  const code = result.outputFiles[0].text;
  const inputs = Object.keys(result.metafile.inputs)
    .filter((f) => !f.includes('node_modules') && !f.startsWith('<'))
    .map((f) => path.relative(cwd, path.resolve(cwd, f)).replace(/\\/g, '/'))
    .sort();
  return { code, inputs, script: new vm.Script(code, { filename: 'readme-runtime-ui.js' }) };
}

// "Could not resolve X" where X is declared in a package.json at or above cwd
function missingDependency(text, cwd) {
  const spec = /Could not resolve "([^"]+)"/.exec(text)?.[1];
  if (!spec || spec.startsWith('.') || path.isAbsolute(spec)) return null;
  const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
  for (let d = path.resolve(cwd); ; d = path.dirname(d)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(d, 'package.json'), 'utf8'));
      if ({ ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies }[name]) return name;
    } catch { /* no package.json here */ }
    if (path.dirname(d) === d) return null;
  }
}

// The sandbox realm's locale-sensitive built-ins default to LOCALE (and DateTimeFormat to UTC)
// instead of the host's ICU default, which differs between machines.
const LOCALE_SETUP = new vm.Script(`(() => {
  const L = ${JSON.stringify(LOCALE)};
  for (const k of ['DateTimeFormat', 'NumberFormat', 'Collator', 'PluralRules', 'RelativeTimeFormat', 'ListFormat', 'DisplayNames', 'Segmenter']) {
    const C = Intl[k];
    if (!C) continue;
    const W = function (loc, opt) { return new C(loc ?? L, k === 'DateTimeFormat' ? { timeZone: 'UTC', ...opt } : opt); };
    W.prototype = C.prototype;
    W.supportedLocalesOf = C.supportedLocalesOf.bind(C);
    Intl[k] = W;
  }
  const at = (P, m, i) => { const f = P[m]; P[m] = function (...a) { if (a[i] === undefined) a[i] = L; return f.apply(this, a); }; };
  at(Number.prototype, 'toLocaleString', 0); at(BigInt.prototype, 'toLocaleString', 0); at(Array.prototype, 'toLocaleString', 0);
  at(String.prototype, 'localeCompare', 1); at(String.prototype, 'toLocaleUpperCase', 0); at(String.prototype, 'toLocaleLowerCase', 0);
})()`, { filename: 'readme-runtime-locale.js' });
const RENDER = new vm.Script('__rrRender(__rrProps)', { filename: 'readme-runtime-render.js' });

// xorshift-based deterministic PRNG for Math.random inside the sandbox
function seededRandom(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

const FIXED_TIME = Date.UTC(2026, 0, 1);

export function renderWith(bundle, props) {
  const math = Object.create(Math);
  math.random = seededRandom(0x52524d);
  class FixedDate extends Date {
    constructor(...a) { super(...(a.length ? a : [FIXED_TIME])); }
    static now() { return FIXED_TIME; }
    toLocaleString(l, o) { return super.toLocaleString(l ?? LOCALE, { timeZone: 'UTC', ...o }); }
    toLocaleDateString(l, o) { return super.toLocaleDateString(l ?? LOCALE, { timeZone: 'UTC', ...o }); }
    toLocaleTimeString(l, o) { return super.toLocaleTimeString(l ?? LOCALE, { timeZone: 'UTC', ...o }); }
  }
  const sandbox = {
    Math: math, Date: FixedDate, TextEncoder, TextDecoder, console: { log() {}, warn() {}, error() {}, info() {}, debug() {} },
    queueMicrotask, setTimeout: () => 0, clearTimeout() {}, MessageChannel: class { constructor() { this.port1 = {}; this.port2 = { postMessage() {} }; } },
  };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  const ctx = vm.createContext(sandbox);
  try {
    LOCALE_SETUP.runInContext(ctx);
    bundle.script.runInContext(ctx, { timeout: RENDER_TIMEOUT_MS });
    ctx.__rrProps = { ...props };
    return RENDER.runInContext(ctx, { timeout: RENDER_TIMEOUT_MS });
  } catch (e) {
    if (e?.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') throw new UiError('UI_RENDER', `rendering with ${JSON.stringify(props)} did not finish within ${RENDER_TIMEOUT_MS / 1000} s (an endless loop for these props?)`);
    throw new UiError('UI_RENDER', `the demo component threw while rendering with ${JSON.stringify(props)}: ${explainReactError(String(e?.message ?? e))}`);
  }
}

// React's production build throws "Minified React error #N; visit ...?args[]=..": say what
// the frequent ones mean, so nobody has to look the number up.
const REACT_ERRORS = {
  130: 'a component is undefined (element type is invalid): check the import, e.g. a default export imported by name or the other way round',
  31: 'an object was rendered as a React child; render one of its fields or map it to elements',
  152: 'a component returned undefined; return null to render nothing',
  301: 'too many re-renders: the component sets state while rendering',
  321: 'invalid hook call: a hook is called outside a component body',
};
export function explainReactError(message) {
  const m = /Minified React error #(\d+);[^?]*\??([^\s]*)/.exec(message);
  if (!m) return message;
  const args = [...m[2].matchAll(/args\[\]=([^&]*)/g)].map((a) => decodeURIComponent(a[1])).filter(Boolean);
  return `${REACT_ERRORS[m[1]] ?? 'see https://react.dev/errors/' + m[1]} (React error #${m[1]}${args.length ? `, ${args.join(', ')}` : ''})`;
}
