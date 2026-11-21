// `readme-runtime init`: scaffold a config and a check-only CI workflow. Never overwrites.
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_FILE } from './project.js';
import { parseModule } from './wasm/reader.js';
import { listExports, compileStep } from './compiler/program.js';

export const WORKFLOW = `# README Runtime: verify that the committed cards match a fresh, Wasm-verified build.
# Check only: this workflow never commits or pushes. If it fails, run
# "npx readme-runtime build" locally and commit the updated files.
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
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      # Pin a tag or commit (github:otonasi-muonn/README-Runtime#<ref>) for fully reproducible checks.
      - run: npx --yes github:otonasi-muonn/README-Runtime check
`;

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
    '  2. npx readme-runtime build', '  3. add ![demo](readme-runtime/<name>.svg) to README.md and commit');
  return lines;
}
