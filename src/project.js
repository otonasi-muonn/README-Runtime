// Config-driven builds: run language-agnostic build commands when sources change,
// regenerate cards when anything that affects them changes, and check (read-only) that the
// committed cards are up to date.
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { spawnSync } from 'node:child_process';
import { generate, sha256, DEFAULTS } from './generate.js';
import { TOOL_VERSION } from './version.js';

export const CONFIG_FILE = 'readme-runtime.json';
export const LOCK_FILE = 'readme-runtime.lock.json';
const CARD_KEYS = new Set(['name', 'wasm', 'build', 'export', 'init', 'steps', 'hold', 'stepMs', 'bits', 'halt', 'haltExport', 'title', 'out']);

export class ConfigError extends Error {}

const srcDir = path.dirname(url.fileURLToPath(import.meta.url));

// Hash of the generator's own source: any change to the compiler or the template
// invalidates every cached card, without relying on a manually bumped version. Files that
// only drive the CLI (config, caching, scaffolding) cannot change a card and are left out.
const NOT_GENERATOR = new Set(['project.js', 'init.js']);
let generatorHashCache;
export function generatorHash() {
  if (generatorHashCache) return generatorHashCache;
  const files = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js') && !NOT_GENERATOR.has(path.relative(srcDir, p).replace(/\\/g, '/'))) files.push(p);
    }
  };
  walk(srcDir);
  const h = files.map((f) => `${path.relative(srcDir, f).replace(/\\/g, '/')}:${sha256(normalizeEol(fs.readFileSync(f, 'utf8')))}`).join('\n');
  generatorHashCache = sha256(`${TOOL_VERSION}\n${h}`);
  return generatorHashCache;
}

export const normalizeEol = (s) => s.replace(/\r\n/g, '\n');

export function loadConfig(configPath) {
  const abs = path.resolve(configPath);
  if (!fs.existsSync(abs)) throw new ConfigError(`${configPath} not found. Run "readme-runtime init" to create one.`);
  let raw;
  try { raw = JSON.parse(fs.readFileSync(abs, 'utf8')); } catch (e) { throw new ConfigError(`${configPath}: invalid JSON (${e.message})`); }
  const dir = path.dirname(abs);
  if (!raw || !Array.isArray(raw.cards) || raw.cards.length === 0) throw new ConfigError(`${configPath}: "cards" must be a non-empty array`);
  const names = new Set(), outs = new Set();
  const cards = raw.cards.map((c, i) => {
    const where = `${configPath}: cards[${i}]`;
    for (const k of Object.keys(c)) if (!CARD_KEYS.has(k)) throw new ConfigError(`${where}: unknown key "${k}" (allowed: ${[...CARD_KEYS].join(', ')})`);
    if (typeof c.name !== 'string' || !/^[\w.-]+$/.test(c.name)) throw new ConfigError(`${where}: "name" must be a simple identifier`);
    if (names.has(c.name)) throw new ConfigError(`${where}: duplicate name "${c.name}"`);
    names.add(c.name);
    if (typeof c.wasm !== 'string') throw new ConfigError(`${where}: "wasm" (path to the .wasm file) is required`);
    if (!Number.isInteger(c.init)) throw new ConfigError(`${where}: "init" (initial state, an integer) is required`);
    const out = c.out ?? `readme-runtime/${c.name}.svg`;
    if (outs.has(out)) throw new ConfigError(`${where}: duplicate output "${out}"`);
    outs.add(out);
    if (c.build !== undefined) {
      if (typeof c.build.command !== 'string' || !c.build.command.trim()) throw new ConfigError(`${where}: "build.command" must be a non-empty string`);
      if (!Array.isArray(c.build.inputs) || !c.build.inputs.length) throw new ConfigError(`${where}: "build.inputs" must list the source files (globs allowed) the command reads`);
    }
    return {
      name: c.name,
      wasm: c.wasm,
      build: c.build,
      out,
      options: {
        export: c.export ?? DEFAULTS.export,
        init: c.init,
        steps: c.steps ?? DEFAULTS.steps,
        hold: c.hold ?? DEFAULTS.hold,
        stepMs: c.stepMs ?? DEFAULTS.stepMs,
        bits: c.bits ?? DEFAULTS.bits,
        haltValue: c.halt ?? null,
        haltExport: c.haltExport ?? null,
        title: c.title ?? c.name,
        wasmName: path.basename(c.wasm),
      },
    };
  });
  return { dir, path: abs, cards };
}

// Build inputs are paths relative to the config directory; a directory means every file below
// it. Globs: '*' and '?' match within one path segment, '**' matches zero or more directories
// ('src/**' is every file below src). Walks skip node_modules and .git and do not follow
// symlinked directories. An entry that matches no file is an error, never silently ignored.
export function expandInputs(dir, patterns) {
  const files = new Set();
  for (const pat of patterns) {
    if (typeof pat !== 'string' || !pat.trim()) throw new ConfigError(`build inputs must be paths or globs, got ${JSON.stringify(pat)}`);
    const segs = pat.replace(/\\/g, '/').split('/').filter((s) => s !== '' && s !== '.');
    const g = segs.findIndex((s) => /[*?]/.test(s));
    const isGlob = g >= 0;
    // Walk only below the literal prefix ("src" for "src/**/*.c").
    const base = path.join(dir, ...(isGlob ? segs.slice(0, g) : segs));
    const st = statOrNull(base);
    if (!st && !isGlob) throw new ConfigError(`build input "${pat}" does not exist`);
    const found = [];
    if (st?.isDirectory()) {
      const rest = isGlob ? segs.slice(g) : ['**'];
      const re = globRegExp(rest);
      const deep = rest.includes('**');
      const walk = (rel, depth) => {
        for (const e of fs.readdirSync(path.join(base, rel), { withFileTypes: true })) {
          if (e.name === 'node_modules' || e.name === '.git') continue;
          const r = rel ? `${rel}/${e.name}` : e.name;
          const abs = path.join(base, r);
          if (e.isDirectory()) { if (deep || depth + 1 < rest.length) walk(r, depth + 1); }
          else if (re.test(r) && (e.isFile() || statOrNull(abs)?.isFile())) found.push(abs);
        }
      };
      walk('', 0);
    } else if (st && !isGlob) {
      found.push(base);
    }
    if (!found.length) throw new ConfigError(`build input "${pat}" matches no files`);
    for (const f of found) files.add(path.relative(dir, f).replace(/\\/g, '/'));
  }
  return [...files].sort();
}

// Glob segments -> RegExp over '/'-separated relative paths. A trailing '**' matches every file
// below; '**' elsewhere matches zero or more directories.
function globRegExp(segs) {
  const src = segs.map((s, i) => {
    const last = i === segs.length - 1;
    if (s === '**') return last ? '.+' : '(?:[^/]+/)*';
    return s.replace(/[.+^${}()|[\]]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]') + (last ? '' : '/');
  });
  return new RegExp(`^${src.join('')}$`);
}

// Like fs.existsSync, any failure means "not there" (the caller reports a missing input).
function statOrNull(p) {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}

// CRLF -> LF so that a Windows checkout (core.autocrlf) and a Linux CI checkout of the same
// commit produce the same hash. Applied to raw bytes; it is only a hash input transform.
function eolNormalizedBytes(buf) {
  const out = Buffer.allocUnsafe(buf.length);
  let n = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0d && buf[i + 1] === 0x0a) continue;
    out[n++] = buf[i];
  }
  return out.subarray(0, n);
}

// The card's own outputs and the lock are never inputs: a pattern such as "examples/collatz"
// or "**" would otherwise include the .wasm the command writes (or the lock) and never settle.
export function inputsHash(dir, build, outputs = []) {
  const excluded = new Set([LOCK_FILE, ...outputs.map((o) => path.relative(dir, path.resolve(dir, o)).replace(/\\/g, '/'))]);
  const files = expandInputs(dir, build.inputs).filter((f) => !excluded.has(f));
  if (!files.length) throw new ConfigError(`build inputs ${JSON.stringify(build.inputs)} contain only the card's own outputs`);
  const parts = [`command:${build.command}`];
  for (const f of files) parts.push(`${f}:${sha256(eolNormalizedBytes(fs.readFileSync(path.join(dir, f))))}`);
  return { hash: sha256(parts.join('\n')), files };
}

export function renderKey(card, wasmHash) {
  return sha256(JSON.stringify({ wasm: wasmHash, options: card.options, generator: generatorHash() }));
}

export function readLock(dir) {
  const p = path.join(dir, LOCK_FILE);
  if (!fs.existsSync(p)) return { version: 1, cards: {} };
  try {
    const l = JSON.parse(fs.readFileSync(p, 'utf8'));
    // `tool` is only read back for messages; writeLock always records the running version.
    return { version: 1, tool: typeof l.tool === 'string' ? l.tool : undefined, cards: l.cards ?? {} };
  } catch {
    return { version: 1, cards: {} };
  }
}

function writeLock(dir, lock) {
  const ordered = { version: 1, tool: TOOL_VERSION, cards: lock.cards };
  const text = `${JSON.stringify(ordered, null, 2)}\n`;
  const p = path.join(dir, LOCK_FILE);
  if (!fs.existsSync(p) || normalizeEol(fs.readFileSync(p, 'utf8')) !== text) fs.writeFileSync(p, text);
}

const kb = (n) => `${(n / 1024).toFixed(1)} kB`;

// Build every selected card. Returns a list of { name, build, card, summary } entries.
export async function build(configPath, { only = [], force = false, log = console.log } = {}) {
  const cfg = loadConfig(configPath);
  const lock = readLock(cfg.dir);
  const selected = only.length ? cfg.cards.filter((c) => only.includes(c.name)) : cfg.cards;
  for (const n of only) if (!cfg.cards.some((c) => c.name === n)) throw new ConfigError(`no card named "${n}"`);
  const results = [];
  for (const card of selected) {
    const prev = lock.cards[card.name] ?? {};
    const entry = { ...prev };
    const wasmPath = path.join(cfg.dir, card.wasm);
    let buildState = 'none';
    if (card.build) {
      const inp = inputsHash(cfg.dir, card.build, [card.wasm, card.out]);
      const wasmOk = fs.existsSync(wasmPath) && prev.wasm === sha256(fs.readFileSync(wasmPath));
      if (!force && prev.inputs === inp.hash && wasmOk) {
        buildState = 'cached';
      } else {
        log(`${card.name}: build  $ ${card.build.command}`);
        const r = spawnSync(card.build.command, { shell: true, cwd: cfg.dir, stdio: 'inherit' });
        if (r.status !== 0) throw new Error(`${card.name}: build command failed (exit ${r.status ?? r.signal})`);
        if (!fs.existsSync(wasmPath)) throw new Error(`${card.name}: build command did not produce ${card.wasm}`);
        buildState = 'built';
      }
      entry.inputs = inp.hash;
    }
    if (!fs.existsSync(wasmPath)) throw new Error(`${card.name}: ${card.wasm} not found${card.build ? '' : ' (add a "build" command or build it yourself)'}`);
    const wasm = fs.readFileSync(wasmPath);
    entry.wasm = sha256(wasm);
    const key = renderKey(card, entry.wasm);
    const outPath = path.join(cfg.dir, card.out);
    const outOk = fs.existsSync(outPath) && prev.out === sha256(normalizeEol(fs.readFileSync(outPath, 'utf8')));
    let cardState;
    let summary = '';
    if (!force && prev.render === key && outOk) {
      cardState = 'cached';
    } else {
      const r = await generate(wasm, card.options);
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      const old = fs.existsSync(outPath) ? normalizeEol(fs.readFileSync(outPath, 'utf8')) : null;
      if (old !== r.svg) fs.writeFileSync(outPath, r.svg);
      cardState = old === r.svg ? 'unchanged' : 'written';
      entry.out = sha256(r.svg);
      const end = r.verification.trace.end;
      summary = `${kb(r.svg.length)}, ${end.kind === 'halt' ? `halts at step ${end.at}` : end.kind === 'trap' ? `traps at step ${end.at}` : `${end.at} steps`}, verified against Wasm under ${Object.keys(r.verification.models).length} browser arithmetic models`;
    }
    entry.render = key;
    lock.cards[card.name] = entry;
    results.push({ name: card.name, build: buildState, card: cardState, out: card.out, summary });
    log(`${card.name}: wasm ${buildState === 'none' ? 'prebuilt' : buildState === 'cached' ? 'up to date (sources unchanged)' : 'rebuilt'} · card ${cardState === 'cached' ? 'up to date' : cardState === 'unchanged' ? 'regenerated (identical)' : `written ${card.out}`}${summary ? ` · ${summary}` : ''}`);
  }
  // keep entries of cards not selected; drop entries of cards removed from the config
  for (const name of Object.keys(lock.cards)) if (!cfg.cards.some((c) => c.name === name)) delete lock.cards[name];
  writeLock(cfg.dir, lock);
  return results;
}

// Read-only verification for CI. Never runs build commands, never writes.
export async function check(configPath, { log = console.log } = {}) {
  const cfg = loadConfig(configPath);
  const lock = readLock(cfg.dir);
  const problems = [];
  for (const card of cfg.cards) {
    const prev = lock.cards[card.name];
    const fail = (msg) => { problems.push(`${card.name}: ${msg}`); log(`${card.name}: FAIL ${msg}`); };
    if (!prev) { fail(`not in ${LOCK_FILE}; run "readme-runtime build" and commit the result`); continue; }
    if (card.build) {
      const inp = inputsHash(cfg.dir, card.build, [card.wasm, card.out]);
      if (inp.hash !== prev.inputs) { fail(`sources changed since the last build (${inp.files.join(', ')}); run "readme-runtime build" and commit`); continue; }
    }
    const wasmPath = path.join(cfg.dir, card.wasm);
    if (!fs.existsSync(wasmPath)) { fail(`${card.wasm} is missing`); continue; }
    const wasm = fs.readFileSync(wasmPath);
    if (sha256(wasm) !== prev.wasm) { fail(`${card.wasm} differs from the one the card was built from; run "readme-runtime build"`); continue; }
    const outPath = path.join(cfg.dir, card.out);
    if (!fs.existsSync(outPath)) { fail(`${card.out} is missing; run "readme-runtime build" and commit it`); continue; }
    let r;
    try { r = await generate(wasm, card.options); } catch (e) { fail(`regeneration failed: ${e.message}`); continue; }
    const committed = normalizeEol(fs.readFileSync(outPath, 'utf8'));
    if (committed !== r.svg) {
      const why = lock.tool && lock.tool !== TOOL_VERSION
        ? `differs from a fresh build: it was generated by readme-runtime ${lock.tool}, this is ${TOOL_VERSION}`
        : 'is out of date or was edited by hand';
      fail(`${card.out} ${why}; run "readme-runtime build" and commit`);
      continue;
    }
    log(`${card.name}: ok · ${card.out} matches a fresh, Wasm-verified build`);
  }
  return problems;
}
