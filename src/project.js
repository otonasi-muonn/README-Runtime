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
// invalidates every cached card, without relying on a manually bumped version.
let generatorHashCache;
export function generatorHash() {
  if (generatorHashCache) return generatorHashCache;
  const files = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js')) files.push(p);
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

// Minimal glob: '*' within a path segment, '**' across segments.
export function expandInputs(dir, patterns) {
  const files = new Set();
  for (const pat of patterns) {
    const norm = pat.replace(/\\/g, '/');
    if (!/[*?]/.test(norm)) {
      const p = path.join(dir, norm);
      if (!fs.existsSync(p)) throw new ConfigError(`build input "${pat}" does not exist`);
      files.add(path.relative(dir, p).replace(/\\/g, '/'));
      continue;
    }
    const re = new RegExp(`^${norm.split('/').map((seg) => (seg === '**' ? '(?:.*/)?' : seg.replace(/[.+^${}()|[\]]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]') + '/')).join('').replace(/\/$/, '')}$`);
    const walk = (d) => {
      for (const e of fs.readdirSync(path.join(dir, d), { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name === '.git') continue;
        const rel = d ? `${d}/${e.name}` : e.name;
        if (e.isDirectory()) walk(rel);
        else if (re.test(rel)) files.add(rel);
      }
    };
    walk('');
  }
  return [...files].sort();
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

export function inputsHash(dir, build) {
  const files = expandInputs(dir, build.inputs);
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
    return { version: 1, cards: l.cards ?? {} };
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
      const inp = inputsHash(cfg.dir, card.build);
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
      const inp = inputsHash(cfg.dir, card.build);
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
    if (committed !== r.svg) { fail(`${card.out} is out of date or was edited by hand; run "readme-runtime build" and commit`); continue; }
    log(`${card.name}: ok · ${card.out} matches a fresh, Wasm-verified build`);
  }
  return problems;
}
