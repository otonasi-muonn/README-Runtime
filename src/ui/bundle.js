// Bundle a demo entry (TSX importing the project's real components) and render it to static
// markup. Every render runs in a fresh VM context with deterministic Math.random and Date, so
// module state (id counters, random ids) cannot make two renders of the same props differ.
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

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
    throw new UiError('UI_BUNDLE', `cannot bundle ${entry}: ${first?.text ?? e.message}${loc ? ` (${loc})` : ''}`, { file: first?.location?.file, line: first?.location?.line });
  }
  const code = result.outputFiles[0].text;
  const inputs = Object.keys(result.metafile.inputs)
    .filter((f) => !f.includes('node_modules') && !f.startsWith('<'))
    .map((f) => path.relative(cwd, path.resolve(cwd, f)).replace(/\\/g, '/'))
    .sort();
  return { code, inputs, script: new vm.Script(code, { filename: 'readme-runtime-ui.js' }) };
}

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
  }
  const sandbox = {
    Math: math, Date: FixedDate, TextEncoder, TextDecoder, console: { log() {}, warn() {}, error() {}, info() {}, debug() {} },
    queueMicrotask, setTimeout: () => 0, clearTimeout() {}, MessageChannel: class { constructor() { this.port1 = {}; this.port2 = { postMessage() {} }; } },
  };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  const ctx = vm.createContext(sandbox);
  bundle.script.runInContext(ctx);
  try {
    return ctx.__rrRender({ ...props });
  } catch (e) {
    throw new UiError('UI_RENDER', `the demo component threw while rendering with ${JSON.stringify(props)}: ${e.message}`);
  }
}
