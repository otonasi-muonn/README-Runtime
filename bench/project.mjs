// A copy of the mockcraft example as a stand-alone README Runtime project, plus the edits
// the benchmark applies to it.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, INIT, STEP_MS, VIEWS, run } from './common.mjs';

export const CLI = path.join(ROOT, 'bin/readme-runtime.js');
export const ASC = path.join(ROOT, 'node_modules/assemblyscript/bin/asc.js');
export const ASC_ARGS = ['mc/logic.ts', '-O3', '--runtime', 'stub', '--noAssert', '-o', 'mc/logic.wasm'];
export const ACCENTS = ['#ff6a45', '#3b82f6', '#16a34a', '#9333ea', '#eab308', '#0891b2', '#e11d48', '#475569', '#f97316'];

export function makeProject(dir, N) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.cpSync(path.join(ROOT, 'examples/mockcraft'), path.join(dir, 'mc'), { recursive: true });
  fs.rmSync(path.join(dir, 'mc/logic.wasm'));
  const card = {
    name: 'mockcraft', title: 'mockcraft · editor auto-pilot', wasm: 'mc/logic.wasm',
    build: { command: `node "${ASC}" ${ASC_ARGS.join(' ')}`, inputs: ['mc/logic.ts'] },
    export: 'step', init: INIT, steps: N, stepMs: STEP_MS,
    ui: { entry: 'mc/demo.tsx', tsconfig: 'mc/tsconfig.json', css: ['mc/upstream/src/app/globals.css'], views: VIEWS, credit: 'UI reused from UIdesign@2f97712 (unchanged)' },
  };
  fs.writeFileSync(path.join(dir, 'readme-runtime.json'), `${JSON.stringify({ cards: [card] }, null, 2)}\n`);
}

export function rrBuild(dir, extra = []) {
  const r = run(process.execPath, [CLI, 'build', '--json', ...extra], { cwd: dir });
  const j = JSON.parse(r.stdout);
  if (!j.ok) throw new Error(JSON.stringify(j.error));
  return { ms: r.ms, build: j.cards[0].build, card: j.cards[0].card };
}

export const asc = (dir) => run(process.execPath, [ASC, ...ASC_ARGS], { cwd: dir }).ms;

// Edits that make both pipelines redo work: a design token (accent colour k), the state
// logic (grid width 23 - k). k = 0 is the original.
export function edit(dir, kind, k) {
  const file = path.join(dir, kind === 'style' ? 'mc/upstream/src/app/globals.css' : 'mc/logic.ts');
  const s = fs.readFileSync(file, 'utf8');
  const next = kind === 'style'
    ? s.replace(/--color-accent: #[0-9a-f]{6};/, `--color-accent: ${ACCENTS[k % ACCENTS.length]};`)
    : s.replace(/const COLS: i32 = \d+;/, `const COLS: i32 = ${23 - (k % 6)};`);
  if (!/--color-accent: #[0-9a-f]{6};|const COLS: i32 = \d+;/.test(s)) throw new Error(`edit ${kind}: anchor not found`);
  fs.writeFileSync(file, next);
}
