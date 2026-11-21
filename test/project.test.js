// Config-driven builds in a temporary project (src/project.js): build-command caching,
// differential rebuilds, the read-only `check`, line-ending independence and input globs.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import { build, check, expandInputs, inputsHash, ConfigError, CONFIG_FILE, LOCK_FILE } from '../src/project.js';
import { TOOL_VERSION } from '../src/version.js';
import { buildModule, I32, op, c, get } from './helpers/wasm-builder.js';

const CARD = 'readme-runtime/inc.svg';
const WASM = 'out/step.wasm';
const NODE = `"${process.execPath}"`;
const helperUrl = url.pathToFileURL(path.join(path.dirname(url.fileURLToPath(import.meta.url)), 'helpers', 'wasm-builder.js')).href;

// step(x) = x + k
const addModule = (k) => buildModule({ funcs: [{ name: 'step', params: [I32], results: [I32], body: [get(0), c(k), op.add] }] });

// The project's language-agnostic build command (`node build.mjs [source] [out]`): the source is
// a text file holding the constant k, the output is step(x) = x + k. Every run appends the
// source path to builds.txt, so tests can see exactly which commands ran.
const BUILD_MJS = `import fs from 'node:fs';
import path from 'node:path';
import { buildModule, I32, op, c, get } from ${JSON.stringify(helperUrl)};
const [src = 'src/step.c', out = 'out/step.wasm'] = process.argv.slice(2);
fs.appendFileSync('builds.txt', src + '\\n');
const k = Number(/-?\\d+/.exec(fs.readFileSync(src, 'utf8'))[0]);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, buildModule({ funcs: [{ name: 'step', params: [I32], results: [I32], body: [get(0), c(k), op.add] }] }));
`;

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'readme-runtime-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
  return dir;
}

function writeFile(dir, rel, content) {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

// Every file and directory below dir, with a content hash and mtime: equal snapshots before and
// after an operation prove that it wrote nothing.
function snapshot(dir) {
  const out = {};
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { out[`${r}/`] = 'dir'; walk(r); continue; }
      const abs = path.join(dir, r);
      out[r] = `${crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex')} ${fs.statSync(abs).mtimeMs}`;
    }
  };
  walk('');
  return out;
}

// A project with one card "inc": `node build.mjs` turns src/step.c into out/step.wasm, and the
// card starts at 0 and halts at 10.
function open(dir) {
  const config = path.join(dir, CONFIG_FILE);
  const lines = [];
  const log = (s) => lines.push(s);
  const p = {
    dir,
    lines,
    base: { name: 'inc', title: 'Increment', wasm: WASM, build: { command: `${NODE} build.mjs`, inputs: ['src/*.c'] }, export: 'step', init: 0, steps: 20, halt: 10 },
    file: (rel) => path.join(dir, rel),
    text: (rel) => fs.readFileSync(path.join(dir, rel), 'utf8'),
    write: (rel, content) => writeFile(dir, rel, content),
    configure: (...cards) => writeFile(dir, CONFIG_FILE, `${JSON.stringify({ cards }, null, 2)}\n`),
    builds: () => (fs.existsSync(path.join(dir, 'builds.txt')) ? p.text('builds.txt').split('\n').filter(Boolean) : []),
    build: (opts = {}) => build(config, { log, ...opts }),
    check: () => check(config, { log }),
  };
  return p;
}

function create(dir) {
  const p = open(dir);
  p.write('build.mjs', BUILD_MJS);
  p.write('src/step.c', '// step(x) = x + k\n1\n');
  p.configure(p.base);
  return p;
}

// A new project, nothing built yet.
const freshProject = (t) => create(tempDir(t));

// A copy of a project built once per file (its build command ran once, builds.txt has one line).
// Spawning the build command is the slow part of these tests, so most start from this state.
const templateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'readme-runtime-test-'));
after(() => fs.rmSync(templateDir, { recursive: true, force: true, maxRetries: 5 }));
let templateBuilt;
async function builtProject(t) {
  templateBuilt ??= create(templateDir).build();
  await templateBuilt;
  const dir = tempDir(t);
  fs.cpSync(templateDir, dir, { recursive: true });
  return open(dir);
}

test('the first build runs the command and writes the card and lock; a second build does nothing', async (t) => {
  const p = freshProject(t);
  const [first] = await p.build();
  assert.deepEqual([first.build, first.card], ['built', 'written']);
  assert.equal(p.builds().length, 1);
  assert.ok(p.text(CARD).includes('<svg'));
  const lock = JSON.parse(p.text(LOCK_FILE));
  assert.equal(lock.tool, TOOL_VERSION);
  assert.equal(lock.cards.inc.wasm, crypto.createHash('sha256').update(fs.readFileSync(p.file(WASM))).digest('hex'));
  assert.equal(lock.cards.inc.inputs, inputsHash(p.dir, p.base.build).hash);

  const before = snapshot(p.dir);
  const [second] = await p.build();
  assert.deepEqual([second.build, second.card], ['cached', 'cached']);
  assert.equal(p.builds().length, 1, 'the build command did not run again');
  assert.deepEqual(snapshot(p.dir), before, 'every file is byte-identical and untouched');
});

test('editing a build input reruns the command; a byte-identical .wasm leaves the card untouched', async (t) => {
  const p = await builtProject(t);
  const card = snapshot(p.dir)[CARD];

  p.write('src/step.c', '// step(x) = x + k, same constant, new comment\n1\n');
  const [same] = await p.build();
  assert.deepEqual([same.build, same.card], ['built', 'cached']);
  assert.equal(p.builds().length, 2);
  assert.equal(snapshot(p.dir)[CARD], card, 'card not rewritten');

  p.write('src/step.c', '2\n');
  const [changed] = await p.build();
  assert.deepEqual([changed.build, changed.card], ['built', 'written']);
  assert.equal(p.builds().length, 3);
  assert.notEqual(snapshot(p.dir)[CARD], card);
  assert.deepEqual(await p.check(), []);
});

test('changing build.command reruns the command', async (t) => {
  const p = await builtProject(t);
  p.configure({ ...p.base, build: { ...p.base.build, command: `${NODE} build.mjs src/step.c ${WASM}` } });
  const [r] = await p.build();
  assert.deepEqual([r.build, r.card], ['built', 'cached']);
  assert.equal(p.builds().length, 2);
});

test('changing a card option regenerates the card without running the command', async (t) => {
  const p = await builtProject(t);
  const v1 = snapshot(p.dir)[CARD];

  p.configure({ ...p.base, title: 'Plus one' });
  const [title] = await p.build();
  assert.deepEqual([title.build, title.card], ['cached', 'written']);
  const v2 = snapshot(p.dir)[CARD];
  assert.notEqual(v2, v1);

  p.configure({ ...p.base, title: 'Plus one', init: 3 });
  const [init] = await p.build();
  assert.deepEqual([init.build, init.card], ['cached', 'written']);
  assert.notEqual(snapshot(p.dir)[CARD], v2);

  assert.equal(p.builds().length, 1, 'the build command never ran again');
  assert.deepEqual(await p.check(), []);
});

test('only the card whose sources changed is rebuilt', async (t) => {
  const p = await builtProject(t);
  const other = { ...p.base, name: 'other', title: 'Other', wasm: 'out/other.wasm', build: { command: `${NODE} build.mjs other/step.c out/other.wasm`, inputs: ['other'] } };
  p.write('other/step.c', '3\n');
  p.configure(p.base, other);
  const added = await p.build();
  assert.deepEqual(added.map((r) => [r.name, r.build, r.card]), [['inc', 'cached', 'cached'], ['other', 'built', 'written']]);
  const before = snapshot(p.dir);

  p.write('other/step.c', '2\n');
  const results = await p.build();
  assert.deepEqual(results.map((r) => [r.name, r.build, r.card]), [['inc', 'cached', 'cached'], ['other', 'built', 'written']]);
  assert.deepEqual(p.builds(), ['src/step.c', 'other/step.c', 'other/step.c']);
  const after = snapshot(p.dir);
  assert.equal(after[CARD], before[CARD]);
  assert.notEqual(after['readme-runtime/other.svg'], before['readme-runtime/other.svg']);
});

test('--force reruns the command and regenerates the card', async (t) => {
  const p = await builtProject(t);
  const card = snapshot(p.dir)[CARD];
  const [r] = await p.build({ force: true });
  assert.deepEqual([r.build, r.card], ['built', 'unchanged']);
  assert.equal(p.builds().length, 2);
  assert.equal(snapshot(p.dir)[CARD], card, 'identical output is not rewritten');
});

test('check passes when everything is up to date and writes nothing', async (t) => {
  const p = await builtProject(t);
  const before = snapshot(p.dir);
  assert.deepEqual(await p.check(), []);
  assert.match(p.lines.at(-1), /^inc: ok /);
  assert.deepEqual(snapshot(p.dir), before);
});

const STALE = [
  ['the source changed without a rebuild', (p) => p.write('src/step.c', '2\n'), /sources changed since the last build \(src\/step\.c\)/],
  ['the card was edited by hand', (p) => p.write(CARD, `${p.text(CARD)}<!-- edited -->\n`), /readme-runtime\/inc\.svg is out of date or was edited by hand/],
  ['the card is missing', (p) => fs.rmSync(p.file(CARD)), /readme-runtime\/inc\.svg is missing/],
  ['the .wasm differs from the one the card was built from', (p) => p.write(WASM, addModule(5)), /out\/step\.wasm differs from the one the card was built from/],
  ['the .wasm is missing', (p) => fs.rmSync(p.file(WASM)), /out\/step\.wasm is missing/],
  ['the card is missing from the lock', (p) => {
    const lock = JSON.parse(p.text(LOCK_FILE));
    delete lock.cards.inc;
    p.write(LOCK_FILE, `${JSON.stringify(lock, null, 2)}\n`);
  }, /not in readme-runtime\.lock\.json/],
];

for (const [what, mutate, message] of STALE) {
  test(`check fails and writes nothing when ${what}; build repairs it`, async (t) => {
    const p = await builtProject(t);
    mutate(p);
    const before = snapshot(p.dir);
    const problems = await p.check();
    assert.equal(problems.length, 1, problems.join('\n'));
    assert.match(problems[0], message);
    assert.deepEqual(snapshot(p.dir), before);
    await p.build();
    assert.deepEqual(await p.check(), []);
  });
}

test('check names the tool version when a stale card came from another readme-runtime', async (t) => {
  const p = await builtProject(t);
  const lock = JSON.parse(p.text(LOCK_FILE));
  p.write(LOCK_FILE, `${JSON.stringify({ ...lock, tool: '0.0.1-old' }, null, 2)}\n`);
  assert.deepEqual(await p.check(), [], 'another version alone is not a failure');

  p.write(CARD, `${p.text(CARD)}<!-- older output -->\n`);
  const problems = await p.check();
  assert.equal(problems.length, 1);
  assert.ok(problems[0].includes(`generated by readme-runtime 0.0.1-old, this is ${TOOL_VERSION}; run "readme-runtime build"`), problems[0]);
});

test('CRLF and LF checkouts give the same inputs hash, check result and cache hits', async (t) => {
  const p = await builtProject(t);
  const lf = inputsHash(p.dir, p.base.build).hash;
  // A Windows checkout (core.autocrlf=true) of the same commit.
  for (const rel of ['src/step.c', CARD, LOCK_FILE]) p.write(rel, p.text(rel).replace(/\n/g, '\r\n'));
  assert.ok(p.text('src/step.c').includes('\r\n'));
  assert.equal(inputsHash(p.dir, p.base.build).hash, lf);

  const before = snapshot(p.dir);
  assert.deepEqual(await p.check(), []);
  const [r] = await p.build();
  assert.deepEqual([r.build, r.card], ['cached', 'cached']);
  assert.deepEqual(snapshot(p.dir), before, 'nothing rebuilt or rewritten');

  p.write('src/step.c', '// step(x) = x + k\r\n2\r\n');
  assert.notEqual(inputsHash(p.dir, p.base.build).hash, lf, 'a real change still changes the hash');
});

test('build inputs: a directory, "./", "**" and "**/" expand to the files below, sorted', (t) => {
  const dir = tempDir(t);
  for (const f of ['src/step.c', 'src/notes.txt', 'src/lib/util.c', 'src/lib/deep/util.h', 'src/node_modules/dep/dep.c', 'src/.git/HEAD', 'node_modules/pkg/pkg.c', 'build.mjs']) {
    writeFile(dir, f, f);
  }
  const below = ['src/lib/deep/util.h', 'src/lib/util.c', 'src/notes.txt', 'src/step.c'];
  const cases = {
    'src': below,
    'src/': below,
    './src': below,
    'src/**': below,
    './src/**': below,
    'src\\**': below,
    'src/*.c': ['src/step.c'],
    './src/*.c': ['src/step.c'],
    '.\\src\\*.c': ['src/step.c'],
    './src/step.c': ['src/step.c'],
    'src/**/*.c': ['src/lib/util.c', 'src/step.c'],
    '**/*.c': ['src/lib/util.c', 'src/step.c'],
    'src/*/util.?': ['src/lib/util.c'],
    'src/lib/**/*.h': ['src/lib/deep/util.h'],
  };
  for (const [pattern, expected] of Object.entries(cases)) assert.deepEqual(expandInputs(dir, [pattern]), expected, pattern);
  assert.deepEqual(expandInputs(dir, ['src/step.c', './src/*.c', 'src/lib']), ['src/lib/deep/util.h', 'src/lib/util.c', 'src/step.c'], 'merged and sorted');
});

test('a build input that matches no files is a ConfigError naming it', (t) => {
  const dir = tempDir(t);
  writeFile(dir, 'src/step.c', '1');
  writeFile(dir, 'deps-only/node_modules/dep.c', '1');
  fs.mkdirSync(path.join(dir, 'empty'));
  for (const pattern of ['nope/*.c', 'src/*.rs', 'src/missing.c', 'empty', 'deps-only', 'src/step.c/**', 'src/step.c/x']) {
    assert.throws(() => expandInputs(dir, ['src/step.c', pattern]), (e) => e instanceof ConfigError && e.message.includes(`"${pattern}"`), pattern);
  }
  assert.throws(() => expandInputs(dir, ['']), ConfigError);
});

// Critic finding M3: these spellings used to match nothing (or crash), so check stayed green and
// build skipped after a real source change.
for (const pattern of ['src/**', './src/*.c', 'src', 'src/**/*.c']) {
  test(`build input "${pattern}": a source change fails check and reruns the build`, async (t) => {
    const p = await builtProject(t);
    p.configure({ ...p.base, build: { ...p.base.build, inputs: [pattern] } });
    await p.build();
    assert.deepEqual(await p.check(), []);
    const runs = p.builds().length;

    p.write('src/step.c', '2\n');
    const problems = await p.check();
    assert.equal(problems.length, 1);
    assert.match(problems[0], /sources changed since the last build \(src\/step\.c\)/);
    const [r] = await p.build();
    assert.deepEqual([r.build, r.card], ['built', 'written']);
    assert.equal(p.builds().length, runs + 1);
    assert.deepEqual(await p.check(), []);
  });
}

test('build and check reject a build input that matches nothing, without running the command', async (t) => {
  const p = await builtProject(t);
  p.configure({ ...p.base, build: { ...p.base.build, inputs: ['src/*.c', 'nope/**'] } });
  const before = snapshot(p.dir);
  const named = (e) => e instanceof ConfigError && e.message.includes('"nope/**"');
  await assert.rejects(p.build(), named);
  await assert.rejects(p.check(), named);
  assert.equal(p.builds().length, 1);
  assert.deepEqual(snapshot(p.dir), before);
});

test('a build input directory that also holds the .wasm settles after one build', async (t) => {
  const p = open(tempDir(t));
  p.write('build.mjs', BUILD_MJS);
  p.write('src/step.c', '1\n');
  p.configure({ ...p.base, wasm: 'src/step.wasm', build: { command: `${NODE} build.mjs src/step.c src/step.wasm`, inputs: ['src'] } });
  const [first] = await p.build();
  assert.equal(first.build, 'built');
  const [second] = await p.build();
  assert.deepEqual([second.build, second.card], ['cached', 'cached'], 'the .wasm written into src/ is not an input');
  assert.deepEqual(await p.check(), []);
});
