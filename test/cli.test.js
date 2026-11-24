// The CLI as an agent uses it: --json everywhere, stable error codes, analyze and init --ui.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const cli = path.join(root, 'bin/readme-runtime.js');
const run = (args, cwd = root) => {
  const r = spawnSync(process.execPath, [cli, ...args, '--json'], { cwd, encoding: 'utf8' });
  let json;
  try { json = JSON.parse(r.stdout); } catch { throw new Error(`not JSON (exit ${r.status}): ${r.stdout}\n${r.stderr}`); }
  return { status: r.status, json };
};

test('inspect --json lists exports with support status', () => {
  const { status, json } = run(['inspect', 'examples/mockcraft/logic.wasm']);
  assert.equal(status, 0);
  assert.equal(json.schemaVersion, 1);
  assert.deepEqual(json.exports.map((x) => [x.name, x.supported]), [['step', true], ['view_dx', true], ['view_dy', true], ['view_on', true], ['view_sel', true], ['view_hits', true]]);
});

test('errors come back as JSON with a stable code and a hint', () => {
  const { status, json } = run(['render', 'examples/collatz/collatz.wasm', '--init', '77671', '-o', path.join(os.tmpdir(), 'rr-x.svg')]);
  assert.equal(status, 2);
  assert.equal(json.ok, false);
  assert.equal(json.error.code, 'RANGE_STATE');
  assert.ok(json.error.hint.length > 10);
  const bad = run(['frobnicate']);
  assert.equal(bad.json.error.code, 'CONFIG_INVALID');
  // user mistakes are not "internal errors"
  assert.equal(run(['init', '--ui', 'src/Nope.tsx']).json.error.code, 'OPTION_INVALID');
  assert.equal(run(['analyze', 'no/such/folder']).json.error.code, 'OPTION_INVALID');
});

test('init pins the CI workflow to the commit README Runtime was installed from', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-init-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
  fs.copyFileSync(path.join(root, 'examples/collatz/collatz.wasm'), path.join(dir, 'c.wasm'));
  const { status, json } = run(['init', '--wasm', 'c.wasm', '--init', '27'], dir);
  assert.equal(status, 0);
  assert.match(json.tool, /^npx --yes github:otonasi-muonn\/README-Runtime(#[0-9a-f]{40})?$/);
  assert.equal(json.pinned, json.tool.includes('#'));
  const wf = fs.readFileSync(path.join(dir, '.github/workflows/readme-runtime.yml'), 'utf8');
  assert.ok(wf.includes(`- run: ${json.tool} check`), wf);
  assert.ok(!wf.includes('#v0.'), 'no version tag: none is published');
  // an install by npm or npx from GitHub records the commit in node_modules/.package-lock.json
  const { installedCommit } = await import('../src/init.js');
  const nm = path.join(dir, 'node_modules');
  fs.mkdirSync(path.join(nm, 'readme-runtime'), { recursive: true });
  const sha = 'dfafe10225cf3fd9a5b0011487af15b5ab1f26a3';
  fs.writeFileSync(path.join(nm, '.package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/readme-runtime': { version: '0.1.0', resolved: `git+ssh://git@github.com/otonasi-muonn/README-Runtime.git#${sha}` } } }));
  assert.equal(installedCommit(path.join(nm, 'readme-runtime')), sha);
  assert.equal(installedCommit(path.join(dir, 'nowhere')), null);
});

test('check --json reports structured problems and never writes', () => {
  const { status, json } = run(['check']);
  assert.equal(status, 0);
  assert.equal(json.ok, true);
  assert.deepEqual(json.problems, []);
});

test('analyze + init --ui + build: a fresh React project gets a working UI card', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-cli-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'demo-app', dependencies: { react: '19.3.1' } }));
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src/Badge.jsx'), 'export function Badge({ label = "hi" }) { return <span className="badge" style={{ padding: 4 }}>{label}</span>; }\n');
  fs.writeFileSync(path.join(dir, 'src/Chart.jsx'), 'export function Chart() { const c = document.createElement("canvas"); c.getContext("2d"); return null; }\n');
  const a = run(['analyze'], dir);
  assert.equal(a.status, 0);
  const badge = a.json.components.find((c) => c.file === 'src/Badge.jsx');
  assert.equal(badge.reusable, 'yes');
  assert.match(a.json.components.find((c) => c.file === 'src/Chart.jsx').reusable, /^no: imperative canvas/);
  assert.ok(a.json.nextSteps[0].includes('init --ui src/Badge.jsx#Badge'));
  const i = run(['init', '--ui', 'src/Badge.jsx#Badge', '--name', 'badge'], dir);
  assert.equal(i.status, 0);
  assert.ok(fs.existsSync(path.join(dir, 'readme-runtime/demo/badge/logic.ts')));
  // the check-only CI workflow comes with the first card, pinned like the tool it reports
  assert.ok(fs.readFileSync(path.join(dir, '.github/workflows/readme-runtime.yml'), 'utf8').includes(`- run: ${i.json.tool} check`));
  // the scaffold's build command downloads AssemblyScript with npx; use the local copy here
  const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'readme-runtime.json'), 'utf8'));
  cfg.cards[0].build.command = cfg.cards[0].build.command.replace(/^npx --yes -p \S+ asc/, `node ${JSON.stringify(path.join(root, 'node_modules/assemblyscript/bin/asc.js'))}`);
  fs.writeFileSync(path.join(dir, 'readme-runtime.json'), JSON.stringify(cfg));
  const b = run(['build'], dir);
  assert.equal(b.status, 0, JSON.stringify(b.json.error));
  assert.equal(b.json.cards[0].card, 'written');
  assert.equal(b.json.cards[0].reason, 'first build');
  const again = run(['build'], dir);
  assert.deepEqual([again.json.cards[0].build, again.json.cards[0].card], ['cached', 'cached']);
  // the scaffolded AssemblyScript file opts out of the project's own type check and lint
  // (eslint-disable first: ESLint only disables rules from that comment on)
  assert.match(fs.readFileSync(path.join(dir, 'readme-runtime/demo/badge/logic.ts'), 'utf8'), /^\/\* eslint-disable \*\/\n\/\/ @ts-nocheck\n/);
});

test('analyze: default exports, empty renders, readable React errors, sub-packages', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-cli-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'app', dependencies: { react: '19.3.1' } }));
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src/Page.jsx'), 'export default function Page() { return <main className="page">hello</main>; }\n');
  fs.writeFileSync(path.join(dir, 'src/Toast.jsx'), 'export function Toast({ msg }) { return msg ? <p>{msg}</p> : null; }\n');
  fs.writeFileSync(path.join(dir, 'src/Broken.jsx'), 'const parts = {};\nexport function Broken() { const Nope = parts.Nope; return <Nope />; }\n');
  fs.mkdirSync(path.join(dir, 'apps/web/src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'apps/web/package.json'), JSON.stringify({ name: 'web', dependencies: { react: '19.3.1' } }));
  fs.writeFileSync(path.join(dir, 'apps/web/src/Card.jsx'), 'export function Card() { return <div>card</div>; }\n');
  const { status, json } = run(['analyze'], dir);
  assert.equal(status, 0);
  const by = (f) => json.components.find((c) => c.file === f);
  assert.deepEqual(by('src/Page.jsx').exports.map((x) => [x.name, x.component, x.renders]), [['default', 'Page', true]]);
  assert.equal(by('src/Page.jsx').reusable, 'yes');
  assert.match(by('src/Toast.jsx').reusable, /^renders nothing/);
  assert.match(by('src/Broken.jsx').exports[0].error.message, /component is undefined.*React error #130/);
  assert.match(by('apps/web/src/Card.jsx').reusable, /package in apps\/web/);
  assert.ok(json.warnings.some((w) => w.code === 'SUBPACKAGES' && w.message.includes('apps/web')));
  assert.equal(json.nextSteps[0], 'readme-runtime init --ui src/Page.jsx --name demo --json');
});
