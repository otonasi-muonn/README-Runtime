// `readme-runtime analyze`: what in a project can become a live README card.
// Facts first (files, exports, toolchains), then a real attempt: each component is bundled
// and rendered statically with no props, so "reusable" is measured, not guessed.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { parseModule } from './wasm/reader.js';
import { listExports, probeStep } from './compiler/program.js';
import { describeError, CodedError } from './errors.js';
import { CONFIG_FILE } from './project.js';

const SKIP = new Set(['node_modules', '.git', '.next', 'dist', 'build', 'out', 'coverage', '.turbo', '.vercel', 'readme-runtime']);

function walk(dir, exts, limit = 2000) {
  const out = [];
  const rec = (rel) => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      if (out.length >= limit) return;
      if (e.isDirectory()) { if (!SKIP.has(e.name) && !e.name.startsWith('.')) rec(rel ? `${rel}/${e.name}` : e.name); }
      else if (exts.some((x) => e.name.endsWith(x)) && !/\.(test|spec|stories)\./.test(e.name)) out.push(rel ? `${rel}/${e.name}` : e.name);
    }
  };
  rec('');
  return out.sort();
}

// The tsconfig whose compilerOptions (paths, jsx) apply to the app's sources. A "solution"
// tsconfig.json (Vite's template) only lists references; the app's options are in
// tsconfig.app.json.
export function detectTsconfig(root) {
  const app = fs.existsSync(path.join(root, 'tsconfig.app.json')) ? 'tsconfig.app.json' : null;
  if (!fs.existsSync(path.join(root, 'tsconfig.json'))) return app;
  const main = readJson(path.join(root, 'tsconfig.json'));
  return app && Array.isArray(main?.references) && !main?.compilerOptions?.paths ? app : 'tsconfig.json';
}

const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, '').replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '').replace(/,(\s*[}\]])/g, '$1')); } catch { return null; } };

// Exported components as { name, component }: name is what to import ("default" for the
// default export, as in `init --ui file#default`), component the function's own name.
function componentExports(src) {
  const out = new Map();
  const add = (name, component = name) => { if (!out.has(name)) out.set(name, component); };
  for (const m of src.matchAll(/export\s+default\s+(?:async\s+)?function\s*([A-Z]\w*)?\s*\(/g)) add('default', m[1] ?? 'default');
  for (const m of src.matchAll(/export\s+(?:async\s+)?function\s+([A-Z]\w*)/g)) add(m[1]);
  for (const m of src.matchAll(/export\s+const\s+([A-Z]\w*)\s*(?::[^=]+)?=\s*(?:\(|async\s*\(|React\.memo|memo\(|forwardRef|React\.forwardRef)/g)) add(m[1]);
  const d = /export\s+default\s+(?:React\.memo\(|memo\()?([A-Z]\w*)\)?\s*;?\s*$/m.exec(src);
  if (d) add('default', d[1]);
  for (const m of src.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const e = /^\s*([A-Z]\w*)(?:\s+as\s+(\w+))?\s*$/.exec(part);
      if (e) add(e[2] ?? e[1], e[1]);
    }
  }
  return [...out].map(([name, component]) => ({ name, component }));
}

function usage(src) {
  const u = [];
  if (/\buse[A-Z]\w*\s*\(/.test(src)) u.push('hooks');
  if (/\b(window|document|localStorage|sessionStorage|navigator|requestAnimationFrame|ResizeObserver|IntersectionObserver)\b/.test(src)) u.push('browser-api');
  if (/getContext\(|CanvasRenderingContext2D|<canvas\b/.test(src)) u.push('canvas');
  if (/from\s+["']next\//.test(src)) u.push('framework');
  return u;
}

function tool(cmd, args) {
  try {
    const r = spawnSync(cmd, args, { encoding: 'utf8', shell: process.platform === 'win32', timeout: 15000 });
    return r.status === 0 ? (r.stdout || r.stderr).trim().split('\n')[0] : null;
  } catch { return null; }
}

export async function analyzeProject(dir, { render = true, maxComponents = 40 } = {}) {
  const root = path.resolve(dir);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new CodedError('OPTION_INVALID', `${dir} is not a folder`);
  // the package a file belongs to when it is not this one: the nearest folder below root
  // with its own package.json
  const ownerOf = (f) => {
    for (let d = path.dirname(path.join(root, f)); d.length > root.length; d = path.dirname(d)) {
      if (fs.existsSync(path.join(d, 'package.json'))) return path.relative(root, d).replace(/\\/g, '/');
    }
    return null;
  };
  const pkg = readJson(path.join(root, 'package.json'));
  const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
  const tsconfigFile = detectTsconfig(root);
  const tsconfig = tsconfigFile ? readJson(path.join(root, tsconfigFile)) : null;
  const frameworks = ['next', 'react', 'react-dom', 'vue', 'svelte', 'solid-js', 'vite', 'astro'].filter((d) => deps[d]);
  const cssFiles = walk(root, ['.css']);
  const cssEntries = cssFiles.filter((f) => /@import\s+["']tailwindcss|@tailwind\b|@theme\b/.test(fs.readFileSync(path.join(root, f), 'utf8')));
  const depsInstalled = fs.existsSync(path.join(root, 'node_modules'));
  const report = {
    schemaVersion: 1,
    root,
    warnings: pkg && !depsInstalled && Object.keys(deps).length
      ? [{ code: 'DEPS_NOT_INSTALLED', message: "package.json lists dependencies but node_modules is missing: components importing them cannot be rendered until you run npm ci (or the project's package manager)" }]
      : [],
    package: pkg ? { name: pkg.name ?? null, frameworks, typescript: Boolean(deps.typescript || tsconfigFile) } : null,
    tsconfig: tsconfigFile ? { file: tsconfigFile, paths: tsconfig?.compilerOptions?.paths ?? null } : null,
    styling: { tailwind: deps.tailwindcss ? String(deps.tailwindcss).replace(/^[^\d]*/, '') : null, cssEntries, cssFiles: cssFiles.slice(0, 20) },
    components: [],
    wasm: [],
    toolchains: {},
    readmeRuntime: { config: fs.existsSync(path.join(root, CONFIG_FILE)) ? CONFIG_FILE : null },
    summary: {},
    nextSteps: [],
  };

  // components: static facts + a real render attempt with no props
  const allFiles = walk(root, ['.tsx', '.jsx']);
  const subPackages = [...new Set(allFiles.map(ownerOf).filter(Boolean))];
  const files = allFiles.slice(0, maxComponents);
  let bundleEntry, renderWith;
  if (render && files.length && (deps.react || frameworks.length)) ({ bundleEntry, renderWith } = await import('./ui/bundle.js'));
  for (const f of files) {
    const src = fs.readFileSync(path.join(root, f), 'utf8');
    const names = componentExports(src);
    if (!names.length) continue;
    const owner = ownerOf(f);
    const c = { file: f, ...(owner ? { package: owner } : {}), exports: [], uses: usage(src) };
    for (const { name, component } of names) {
      const entry = { name, ...(component !== name ? { component } : {}), renders: null, error: null, markupBytes: null };
      if (bundleEntry && !owner && !c.uses.includes('canvas')) {
        const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-analyze-'));
        try {
          // by absolute path: a relative one cannot cross drives (project on D:, %TEMP% on C:)
          fs.writeFileSync(path.join(stubDir, 'probe.jsx'), `import * as M from ${JSON.stringify(path.join(root, f))};\nexport default function Probe() { const C = M[${JSON.stringify(name)}]; return <C />; }\n`);
          const b = await bundleEntry(path.join(stubDir, 'probe.jsx'), { tsconfig: tsconfigFile ? path.join(root, tsconfigFile) : undefined, cwd: root });
          const html = renderWith(b, {});
          entry.renders = true;
          entry.markupBytes = html.length;
        } catch (e) {
          entry.renders = false;
          const d = describeError(e);
          // speak about the component, not the probe file; project-relative paths only
          let message = d.message.split('\n')[0].replace(/cannot bundle .*?probe\.jsx: /, '')
            .split(root.split(path.sep).join('/')).join('.').split(root).join('.');
          let code = d.code;
          const missing = /Could not resolve "([^"]+)"/.exec(message)?.[1];
          const pkgName = missing && (missing.startsWith('@') ? missing.split('/').slice(0, 2).join('/') : missing.split('/')[0]);
          if (pkgName && deps[pkgName] && !depsInstalled) {
            code = 'DEPS_NOT_INSTALLED';
            message = `"${pkgName}" is a project dependency but node_modules is missing: install the project's dependencies first (npm ci)`;
          }
          entry.error = { code, message: message.slice(0, 300) };
        } finally {
          fs.rmSync(stubDir, { recursive: true, force: true });
        }
      }
      c.exports.push(entry);
    }
    const codes = c.exports.map((x) => x.error?.code).filter(Boolean);
    c.reusable = c.uses.includes('canvas') ? 'no: imperative canvas drawing cannot be rendered to markup'
      : owner ? `unknown: belongs to the package in ${owner}/ (run analyze there)`
        : c.exports.some((x) => x.markupBytes > 0) ? (c.uses.includes('hooks') ? 'yes, with the initial state of its hooks' : 'yes')
          : c.exports.some((x) => x.renders) ? 'renders nothing without props (empty markup): give it props or state in a demo entry'
            : codes.includes('DEPS_NOT_INSTALLED') ? 'unknown until dependencies are installed'
              : codes.includes('UI_RENDER') ? 'needs props: give them in a demo entry'
                : codes.length ? 'no: imports something that only runs inside the framework (see error)'
                  : bundleEntry ? 'unknown' : 'unknown: no React dependency in this package.json';
    report.components.push(c);
  }

  // wasm modules already in the project
  for (const f of walk(root, ['.wasm'], 50)) {
    try {
      const bytes = fs.readFileSync(path.join(root, f));
      const exports = listExports(parseModule(bytes)).map((x) => {
        const sig = `${x.name}(${x.params.join(', ')}) -> ${x.results.join(', ') || 'void'}`;
        const p = probeStep(bytes, x.name);
        const abi = { abi: p.abi, ...(p.state ? { state: p.state } : {}), ...(p.values ? { values: p.values } : {}) };
        if (p.supported) return { name: x.name, signature: sig, supported: true, ...abi };
        const d = describeError(p.error);
        return { name: x.name, signature: sig, supported: false, ...(p.abi ? abi : {}), error: { code: d.code, message: d.message } };
      });
      report.wasm.push({ file: f, exports });
    } catch (e) {
      report.wasm.push({ file: f, error: describeError(e) });
    }
  }

  report.toolchains = {
    node: process.version,
    assemblyscript: deps.assemblyscript ?? null,
    rustc: tool('rustc', ['--version']),
    rustWasmTarget: (tool('rustup', ['target', 'list', '--installed']) ?? '').includes('wasm32') || null,
    clang: tool('clang', ['--version']),
  };
  if (subPackages.length) {
    report.warnings.push({ code: 'SUBPACKAGES', message: `components here belong to other packages (${subPackages.slice(0, 5).join(', ')}): run analyze inside that folder, where its package.json, node_modules and tsconfig are` });
  }
  const renders = report.components.filter((c) => c.exports.some((x) => x.markupBytes > 0));
  report.summary = {
    componentFiles: report.components.length,
    renderableWithoutProps: renders.length,
    canvasOnly: report.components.filter((c) => c.uses.includes('canvas')).length,
    supportedWasmExports: report.wasm.flatMap((w) => w.exports ?? []).filter((x) => x.supported).length,
  };
  const initUi = (c, x) => `readme-runtime init --ui ${c.file}${x.name === 'default' ? '' : `#${x.name}`} --name demo --json`;
  const pick = renders.find((c) => !c.uses.includes('hooks')) ?? renders[0];
  const withProps = report.components.find((c) => /^(needs props|renders nothing)/.test(c.reusable));
  // init --wasm scaffolds a card of one integer; a state of several values is written by hand
  const wasmPick = report.wasm.find((w) => w.exports?.some((x) => x.supported && x.abi === 'single'));
  const statePick = report.wasm.map((w) => ({ w, x: w.exports?.find((x) => x.supported && x.abi !== 'single') })).find((p) => p.x);
  const warned = (code) => report.warnings.some((w) => w.code === code);
  if (pick) {
    report.nextSteps.push(initUi(pick, pick.exports.find((x) => x.markupBytes > 0)), 'edit the generated logic.ts (state + view_* functions) and demo.tsx (map views to props)');
  } else if (withProps) {
    report.nextSteps.push(initUi(withProps, withProps.exports[0]), 'give the component its props in the generated demo.tsx (computed from the views), and write logic.ts');
  } else if (subPackages.length) {
    report.nextSteps.push(...subPackages.slice(0, 3).map((p) => `cd ${p} && readme-runtime analyze --json`));
    return report;
  } else if (warned('DEPS_NOT_INSTALLED')) {
    report.nextSteps.push("install the project's dependencies (npm ci), then run readme-runtime analyze --json again");
    return report;
  } else if (wasmPick) {
    report.nextSteps.push(`readme-runtime init --wasm ${wasmPick.file} --json`);
  } else if (statePick) {
    const { w, x } = statePick;
    // a state of several values is shown by a UI card: a demo component and the views it reads
    report.nextSteps.push(x.abi === 'globals'
      ? `add a card to readme-runtime.json: ${JSON.stringify({ name: 'demo', wasm: w.file, export: x.name, state: x.state, init: Object.fromEntries(x.state.map((n) => [n, 0])), steps: 120, ui: { entry: 'demo.jsx', views: { v: 'view_v' } } })} (set "init" to the initial state; write demo.jsx, a component whose props are the views, and the view exports it reads, e.g. view_v(): i32)`
      : `${w.file} has step functions of a state of ${x.values} values: add a card to readme-runtime.json with "state" (the value names, in the order of the parameters), "export" (each name -> its step function, e.g. "${x.name}"), "init" (each name -> its initial value) and "ui" (a demo component and the view exports it reads, each taking the state like the step functions)`);
  } else {
    report.nextSteps.push('nothing to reuse here: no React component renders and no .wasm has an (i32) -> i32 export. A card needs one of them (README: "Use it in your project")');
    return report;
  }
  report.nextSteps.push('readme-runtime build --json', 'readme-runtime check --json');
  return report;
}
