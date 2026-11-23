// `readme-runtime analyze`: what in a project can become a live README card.
// Facts first (files, exports, toolchains), then a real attempt: each component is bundled
// and rendered statically with no props, so "reusable" is measured, not guessed.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { parseModule } from './wasm/reader.js';
import { listExports, compileStep } from './compiler/program.js';
import { describeError } from './errors.js';
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

const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, '').replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '').replace(/,(\s*[}\]])/g, '$1')); } catch { return null; } };

function componentExports(src) {
  const names = new Set();
  for (const m of src.matchAll(/export\s+(?:default\s+)?function\s+([A-Z]\w*)/g)) names.add(m[1]);
  for (const m of src.matchAll(/export\s+const\s+([A-Z]\w*)\s*(?::[^=]+)?=\s*(?:\(|React\.memo|memo\(|forwardRef|React\.forwardRef)/g)) names.add(m[1]);
  if (/export\s+default\s+function\s*\(/.test(src)) names.add('default');
  return [...names];
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
  const pkg = readJson(path.join(root, 'package.json'));
  const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
  const tsconfigFile = fs.existsSync(path.join(root, 'tsconfig.json')) ? 'tsconfig.json' : null;
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
  const files = walk(root, ['.tsx', '.jsx']).slice(0, maxComponents);
  let bundleEntry, renderWith;
  if (render && files.length && (deps.react || frameworks.length)) ({ bundleEntry, renderWith } = await import('./ui/bundle.js'));
  for (const f of files) {
    const src = fs.readFileSync(path.join(root, f), 'utf8');
    const names = componentExports(src);
    if (!names.length) continue;
    const c = { file: f, exports: [], uses: usage(src) };
    for (const name of names) {
      const entry = { name, renders: null, error: null, markupBytes: null };
      if (bundleEntry && !c.uses.includes('canvas')) {
        const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-analyze-'));
        try {
          const rel = path.relative(stubDir, path.join(root, f)).replace(/\\/g, '/');
          fs.writeFileSync(path.join(stubDir, 'probe.jsx'), `import * as M from ${JSON.stringify(rel.startsWith('.') ? rel : `./${rel}`)};\nexport default function Probe() { const C = M[${JSON.stringify(name)}]; return <C />; }\n`);
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
      : c.exports.some((x) => x.renders) ? (c.uses.includes('hooks') ? 'yes, with the initial state of its hooks' : 'yes')
        : codes.includes('DEPS_NOT_INSTALLED') ? 'unknown until dependencies are installed'
          : codes.includes('UI_RENDER') ? 'needs props: give them in a demo entry'
            : codes.length ? 'no: imports something that only runs inside the framework (see error)' : 'unknown';
    report.components.push(c);
  }

  // wasm modules already in the project
  for (const f of walk(root, ['.wasm'], 50)) {
    try {
      const bytes = fs.readFileSync(path.join(root, f));
      const exports = listExports(parseModule(bytes)).map((x) => {
        const sig = `${x.name}(${x.params.join(', ')}) -> ${x.results.join(', ') || 'void'}`;
        try { compileStep(bytes, { exportName: x.name }); return { name: x.name, signature: sig, supported: true }; } catch (e) { const d = describeError(e); return { name: x.name, signature: sig, supported: false, error: { code: d.code, message: d.message } }; }
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
  const renders = report.components.filter((c) => c.exports.some((x) => x.renders));
  report.summary = {
    componentFiles: report.components.length,
    renderableWithoutProps: renders.length,
    canvasOnly: report.components.filter((c) => c.uses.includes('canvas')).length,
    supportedWasmExports: report.wasm.flatMap((w) => w.exports ?? []).filter((x) => x.supported).length,
  };
  const pick = renders.find((c) => !c.uses.includes('hooks')) ?? renders[0];
  if (pick) {
    const exp = pick.exports.find((x) => x.renders).name;
    report.nextSteps.push(`readme-runtime init --ui ${pick.file}${exp === 'default' ? '' : `#${exp}`} --name demo --json`);
  }
  report.nextSteps.push('edit the generated logic.ts (state + view_* functions) and demo.tsx (map views to props)', 'readme-runtime build --json', 'readme-runtime check --json');
  return report;
}
