// `readme-runtime init`: scaffold a config and a check-only CI workflow. Never overwrites.
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_FILE } from './project.js';
import { TOOL_VERSION } from './version.js';
import { parseModule } from './wasm/reader.js';
import { listExports, compileStep } from './compiler/program.js';

export const PACKAGE = `github:otonasi-muonn/README-Runtime#v${TOOL_VERSION}`;

export const WORKFLOW = `# README Runtime: verify that the committed cards match a fresh, Wasm-verified build.
# Check only: this workflow never commits or pushes. If it fails, run
# "npx ${PACKAGE} build" locally and commit the updated files.
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
      # Pinned to the README Runtime version that generated the cards: a newer generator can
      # produce different (equally valid) SVG, so update this together with a rebuild.
      - run: npx --yes ${PACKAGE} check
`;

export const ASC = 'assemblyscript@0.28.20';

// `init --ui <file>[#Export]`: a working UI card skeleton around one of the project's own
// components. It builds and renders as generated; the author (or an agent) then maps view
// values to the component's props and writes the real state logic.
export function initUiCard(cwd, { component, name = 'demo', configPath = CONFIG_FILE, css = [], tsconfig = null }) {
  const [file, exportName = null] = component.split('#');
  if (!fs.existsSync(path.resolve(cwd, file))) throw new Error(`component file ${file} not found`);
  if (!/^[\w.-]+$/.test(name)) throw new Error('--name must be a simple identifier');
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
  write(`${dir}/logic.ts`, `// @ts-nocheck
/* eslint-disable */
// AssemblyScript, not TypeScript: the build command in ${configPath} compiles it to logic.wasm.
// The two lines above keep the project's own type check and linter off this file.
// step() advances the state, view_*() derive what the UI shows. i32 only, values within
// +-999,999. Each view's range is derived from this code for every possible state, so a view
// that switches markup (classes, texts, elements) must be bounded here to at most 64 values.
export function step(s: i32): i32 { return s < 100 ? s + 1 : 0; }
export function view_t(s: i32): i32 { return s; }
`);
  const cfgPath = path.resolve(cwd, configPath);
  const cfg = fs.existsSync(cfgPath) ? JSON.parse(fs.readFileSync(cfgPath, 'utf8')) : { cards: [] };
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
  return {
    created,
    card: name,
    next: ['readme-runtime build --json', `edit ${dir}/logic.ts and ${dir}/demo.tsx`, 'readme-runtime build --json', 'readme-runtime check --json',
      `commit readme-runtime/${name}.svg, ${dir}/ (including logic.wasm: CI checks against it and never builds it), ${configPath} and readme-runtime.lock.json`],
  };
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
  const wf = path.join(cwd, '.github', 'workflows', 'readme-runtime.yml');
  if (fs.existsSync(wf)) lines.push('kept existing .github/workflows/readme-runtime.yml');
  else {
    fs.mkdirSync(path.dirname(wf), { recursive: true });
    fs.writeFileSync(wf, WORKFLOW);
    lines.push('created .github/workflows/readme-runtime.yml (check only, no commits)');
  }
  lines.push('', 'Next:', '  1. edit readme-runtime.json (wasm path, export, init; optional "build": {"command", "inputs"})',
    `  2. npx ${PACKAGE} build`, '  3. add ![demo](readme-runtime/<name>.svg) to README.md and commit');
  return lines;
}
