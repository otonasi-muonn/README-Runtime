// `readme-runtime init`: scaffold a config and a check-only CI workflow. Never overwrites.
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { spawnSync } from 'node:child_process';
import { CONFIG_FILE } from './project.js';
import { parseModule } from './wasm/reader.js';
import { listExports, compileStep } from './compiler/program.js';
import { CodedError } from './errors.js';
import { ARCHIVE_COMMIT } from './commit.js';

// README Runtime is installed from GitHub's archive of a commit (npm 10's git specs such as
// github:owner/repo#ref fail under npx: "GitFetcher requires an Arborist constructor").
export const REPOSITORY_URL = 'https://github.com/otonasi-muonn/README-Runtime';
export const archiveSpec = (ref) => `${REPOSITORY_URL}/archive/${ref}.tar.gz`;
const pkgRoot = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');

// The commit this copy of README Runtime comes from, so that CI runs exactly the generator
// that built the cards (a newer one may write different, equally valid SVG). In order: GitHub's
// archive carries it (src/commit.js); npm and npx record where a package came from
// (node_modules/.package-lock.json); a git checkout knows it when its sources are unmodified.
// null when none of them tells.
export function installedCommit(root = pkgRoot, archived = ARCHIVE_COMMIT) {
  if (/^[0-9a-f]{40}$/.test(archived)) return archived;
  try {
    const lock = JSON.parse(fs.readFileSync(path.join(root, '..', '.package-lock.json'), 'utf8'));
    const key = path.relative(path.resolve(root, '..', '..'), root).split(path.sep).join('/');
    const m = /README-Runtime(?:\.git)?(?:#|\/tar\.gz\/|\/archive\/)([0-9a-f]{40})(?:\.tar\.gz)?$/i.exec(lock.packages?.[key]?.resolved ?? '');
    if (m) return m[1].toLowerCase();
  } catch { /* not an npm install */ }
  if (!fs.existsSync(path.join(root, '.git'))) return null;
  const git = (...args) => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  const head = git('rev-parse', 'HEAD');
  const dirty = git('status', '--porcelain', '--', 'src', 'bin', 'package.json');
  return head.status === 0 && dirty.status === 0 && !dirty.stdout.trim() ? head.stdout.trim() : null;
}
// The npx package spec of this version: pinned to its commit when known, else the default
// branch.
export function toolSpec(root = pkgRoot) {
  const sha = installedCommit(root);
  return { spec: archiveSpec(sha ?? 'HEAD'), pinned: !!sha };
}

export const workflow = (spec) => `# README Runtime: verify that the committed cards match a fresh, Wasm-verified build.
# Check only: this workflow never commits or pushes. If it fails, run
# "npx --yes ${spec} build" locally and commit the updated files.
name: README Runtime
on:
  push:
  pull_request:
permissions:
  contents: read
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with:
          node-version: 22
      # UI cards bundle the project's own components during check: install its dependencies.
      - if: hashFiles('package-lock.json') != ''
        run: npm ci --ignore-scripts
      - if: hashFiles('pnpm-lock.yaml') != ''
        run: corepack enable && pnpm install --frozen-lockfile --ignore-scripts
      - if: hashFiles('yarn.lock') != ''
        run: corepack enable && yarn install --immutable
      - if: hashFiles('package.json') != '' && hashFiles('package-lock.json', 'pnpm-lock.yaml', 'yarn.lock') == ''
        run: npm install --ignore-scripts --no-audit --no-fund
      # Pinned to the README Runtime commit that generated the cards: a newer generator can
      # produce different (equally valid) SVG, so update this together with a rebuild.
      - run: npx --yes ${spec} check
`;

export const ASC = 'assemblyscript@0.28.20';

// `init --ui <file>[#Export]`: a working UI card skeleton around one of the project's own
// components. It builds and renders as generated; the author (or an agent) then maps view
// values to the component's props and writes the real state logic.
export function initUiCard(cwd, { component, name = 'demo', configPath = CONFIG_FILE, css = [], tsconfig = null }) {
  const [file, exportName = null] = component.split('#');
  if (!fs.existsSync(path.resolve(cwd, file))) throw new CodedError('OPTION_INVALID', `component file ${file} not found`);
  if (!/^[\w.-]+$/.test(name)) throw new CodedError('OPTION_INVALID', '--name must be a simple identifier (letters, digits, ".", "-", "_")');
  const dir = `readme-runtime/demo/${name}`;
  const created = [];
  const write = (rel, text) => {
    const p = path.resolve(cwd, rel);
    if (fs.existsSync(p)) { created.push({ file: rel, status: 'kept' }); return; }
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
    created.push({ file: rel, status: 'created' });
  };
  const rel = path.relative(path.resolve(cwd, dir), path.resolve(cwd, file)).replace(/\\/g, '/').replace(/\.(tsx|jsx|ts|js)$/, '');
  const imp = exportName && exportName !== 'default' ? `import { ${exportName} as Component } from "${rel}";` : `import Component from "${rel}";`;
  write(`${dir}/demo.tsx`, `// README Runtime demo for ${file}${exportName ? `#${exportName}` : ''}.
// Props are view values computed in CSS from logic.wasm (see logic.ts). Map them to the
// component's own props; numbers used in styles/text may be any a*view + b, anything else
// (classes, texts, elements) needs a view with at most 64 values.
${imp}

export default function Demo({ t }: { t: number }) {
  return (
    <div style={{ position: "relative", width: 640, height: 320, overflow: "hidden" }}>
      <div style={{ position: "absolute", left: 16 + t * 4, top: 16 }}>
        <Component />
      </div>
    </div>
  );
}
`);
  write(`${dir}/logic.ts`, `/* eslint-disable */
// @ts-nocheck
// AssemblyScript, not TypeScript: the build command in ${configPath} compiles it to logic.wasm.
// The two lines above keep the project's own type check and linter off this file.
// step() advances the state, view_*() derive what the UI shows. i32 only, values within
// +-999,999. Each view's range is derived from this code for every possible state, so a view
// that switches markup (classes, texts, elements) must be bounded here to at most 64 values.
export function step(s: i32): i32 { return s < 100 ? s + 1 : 0; }
export function view_t(s: i32): i32 { return s; }
`);
  const cfgPath = path.resolve(cwd, configPath);
  let cfg = { cards: [] };
  if (fs.existsSync(cfgPath)) {
    try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch (e) { throw new CodedError('CONFIG_INVALID', `${configPath} is not valid JSON: ${e.message}`); }
    if (!Array.isArray(cfg?.cards)) throw new CodedError('CONFIG_INVALID', `${configPath} needs a "cards" array`);
  }
  if (cfg.cards.some((c) => c.name === name)) {
    created.push({ file: configPath, status: `kept (card "${name}" exists)` });
  } else {
    cfg.cards.push({
      name,
      title: `${path.basename(file).replace(/\.\w+$/, '')} · live`,
      wasm: `${dir}/logic.wasm`,
      build: { command: `npx --yes -p ${ASC} asc ${dir}/logic.ts -O3 --runtime stub --noAssert -o ${dir}/logic.wasm`, inputs: [`${dir}/logic.ts`] },
      export: 'step',
      init: 0,
      steps: 100,
      ui: { entry: `${dir}/demo.tsx`, ...(tsconfig ? { tsconfig } : {}), ...(css.length ? { css } : {}), views: { t: 'view_t' } },
    });
    fs.writeFileSync(cfgPath, `${JSON.stringify(cfg, null, 2)}\n`);
    created.push({ file: configPath, status: 'card added' });
  }
  // the check-only CI workflow (installs the project's dependencies first), unless one exists
  const wf = ensureWorkflow(cwd);
  created.push({ file: WORKFLOW_FILE, status: wf.status });
  return {
    created,
    card: name,
    tool: `npx --yes ${wf.tool.spec}`,
    pinned: wf.tool.pinned,
    next: ['readme-runtime build --json', `edit ${dir}/logic.ts and ${dir}/demo.tsx`, 'readme-runtime build --json', 'readme-runtime check --json',
      `commit readme-runtime/${name}.svg, ${dir}/ (including logic.wasm: CI checks against it and never builds it), ${configPath}, readme-runtime.lock.json and ${WORKFLOW_FILE}`],
  };
}

export const WORKFLOW_FILE = '.github/workflows/readme-runtime.yml';
function ensureWorkflow(cwd) {
  const tool = toolSpec();
  const wf = path.join(cwd, WORKFLOW_FILE);
  if (fs.existsSync(wf)) return { tool, status: 'kept' };
  fs.mkdirSync(path.dirname(wf), { recursive: true });
  fs.writeFileSync(wf, workflow(tool.spec));
  return { tool, status: `created (check only, no commits; runs ${tool.spec})` };
}

export function initProject(cwd, { wasm, exportName, init, configPath = CONFIG_FILE }) {
  const lines = [];
  const cfgPath = path.resolve(cwd, configPath);
  if (fs.existsSync(cfgPath)) {
    lines.push(`kept existing ${configPath}`);
  } else {
    let exp = exportName;
    let name = 'step';
    if (wasm) {
      const bytes = fs.readFileSync(path.resolve(cwd, wasm));
      const fns = listExports(parseModule(bytes));
      if (!exp) {
        const ok = fns.find((f) => { try { compileStep(bytes, { exportName: f.name }); return true; } catch { return false; } });
        exp = ok?.name;
        if (!exp) throw new Error(`${wasm}: no exported (i32) -> i32 function can run in CSS (try "readme-runtime inspect ${wasm}")`);
      }
      name = path.basename(wasm, '.wasm').replace(/[^\w.-]/g, '-');
    }
    const card = {
      name,
      wasm: (wasm ?? 'path/to/your.wasm').replace(/\\/g, '/'),
      export: exp ?? 'step',
      init: init ?? 1,
      steps: 120,
      title: name,
    };
    fs.writeFileSync(cfgPath, `${JSON.stringify({ cards: [card] }, null, 2)}\n`);
    lines.push(`created ${configPath}`);
  }
  const { tool, status } = ensureWorkflow(cwd);
  lines.push(`${status === 'kept' ? 'kept existing' : 'created'} ${WORKFLOW_FILE}${status === 'kept' ? '' : status.slice('created'.length)}`);
  if (!tool.pinned) lines.push(`warning: could not tell which commit this README Runtime comes from, so the workflow runs the repository's default branch; pin it (${archiveSpec('<commit>')}) to the version you build with`);
  lines.push('', 'Next (use this exact version locally too, so CI regenerates the same cards):', '  1. edit readme-runtime.json (wasm path, export, init; optional "build": {"command", "inputs"})',
    `  2. npx --yes ${tool.spec} build`, '  3. add ![demo](readme-runtime/<name>.svg) to README.md and commit');
  return { lines, tool };
}
