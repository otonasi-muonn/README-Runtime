#!/usr/bin/env node
// README Runtime CLI. Every command is non-interactive; --json prints one JSON object
// (schemaVersion 1) on stdout, including failures ({ ok: false, error: { code, message, hint } }).
import fs from 'node:fs';
import path from 'node:path';
import { generate, DEFAULTS } from '../src/generate.js';
import { build, check, CONFIG_FILE, ConfigError } from '../src/project.js';
import { parseModule } from '../src/wasm/reader.js';
import { listExports, compileStep } from '../src/compiler/program.js';
import { TOOL_VERSION } from '../src/version.js';
import { MAX_STEPS } from '../src/runtime/machine.js';
import { initProject, initUiCard } from '../src/init.js';
import { describeError } from '../src/errors.js';

const HELP = `README Runtime ${TOOL_VERSION} - run your WebAssembly inside your README

Usage:
  readme-runtime analyze [dir] [--no-render]
                                   what in this project can become a live card (measured)
  readme-runtime init --ui <file.tsx>[#Export] [--name demo] [--css a.css,b.css]
                                   scaffold a UI card around one of your components
  readme-runtime init [--wasm <file.wasm>] [--export <name>] [--init <n>]
                                   create ${CONFIG_FILE} and a check-only GitHub workflow
  readme-runtime build [names...] [--force]
                                   rebuild changed .wasm (build commands) and cards
  readme-runtime check             CI: fail if a committed card is stale (never writes)
  readme-runtime render <file.wasm> --init <n> [-o card.svg] [options]
  readme-runtime inspect <file.wasm>
                                   list exports and whether each can run in CSS

Render options:
  --export <name>      exported (i32) -> i32 step function   (default: ${DEFAULTS.export})
  --init <n>           initial state x0                       (required)
  --steps <n>          maximum steps, 1..${MAX_STEPS}                  (default: ${DEFAULTS.steps})
  --halt <n> | --halt-export <name>   stop condition
  --title <text>  --step-ms <n>  --hold <n>  --bits <n>

Common options:
  --json               machine-readable output (one JSON object on stdout)
  --config <file>      config path (default: ${CONFIG_FILE})
  -h, --help           show this help
  -v, --version        show the version
`;

const BOOLEAN = new Set(['json', 'force', 'no-render', 'help', 'version']);

function parseArgs(argv) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h') flags.help = true;
    else if (a === '-v') flags.version = true;
    else if (a.startsWith('--') && BOOLEAN.has(a.slice(2))) flags[a.slice(2)] = true;
    else if (a === '-o' || a.startsWith('--')) {
      const key = a === '-o' ? 'out' : a.slice(2);
      const v = argv[i + 1];
      if (v === undefined || (v.startsWith('-') && !/^-\d/.test(v))) throw new ConfigError(`option ${a} needs a value`);
      flags[key] = v;
      i++;
    } else pos.push(a);
  }
  return { pos, flags };
}

const int = (flags, key) => {
  if (flags[key] === undefined) return undefined;
  if (!/^-?\d+$/.test(flags[key])) throw new ConfigError(`--${key} must be an integer, got "${flags[key]}"`);
  return Number(flags[key]);
};

function detectStyles(root) {
  const out = [];
  const rec = (rel, depth) => {
    if (depth > 6) return;
    for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      if (e.name.startsWith('.') || ['node_modules', 'dist', 'build', 'out', '.next', 'readme-runtime'].includes(e.name)) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) rec(r, depth + 1);
      else if (e.name.endsWith('.css') && /@import\s+["']tailwindcss|@tailwind\b|@theme\b/.test(fs.readFileSync(path.join(root, r), 'utf8'))) out.push(r);
    }
  };
  rec('', 0);
  return out;
}

async function run(cmd, pos, flags, log) {
  const configPath = flags.config ?? CONFIG_FILE;
  switch (cmd) {
    case 'analyze': {
      const { analyzeProject } = await import('../src/analyze.js');
      const report = await analyzeProject(pos[0] ?? '.', { render: !flags['no-render'] });
      if (!flags.json) {
        log(`project: ${report.package?.name ?? '(no package.json)'}  frameworks: ${report.package?.frameworks.join(', ') || '-'}  tailwind: ${report.styling.tailwind ?? '-'}`);
        for (const c of report.components) log(`  ${c.file.padEnd(52)} ${c.reusable}${c.exports.some((x) => x.error) ? `  (${c.exports.find((x) => x.error).error.code}: ${c.exports.find((x) => x.error).error.message.slice(0, 80)})` : ''}`);
        for (const w of report.wasm) log(`  ${w.file}: ${(w.exports ?? []).map((x) => `${x.name}${x.supported ? '' : ' (unsupported)'}`).join(', ')}`);
        log(`next: ${report.nextSteps.join('  ->  ')}`);
      }
      return { ok: true, ...report };
    }
    case 'init': {
      if (flags.ui) {
        const css = flags.css ? flags.css.split(',') : detectStyles(process.cwd());
        const tsconfig = flags.tsconfig ?? (fs.existsSync('tsconfig.json') ? 'tsconfig.json' : null);
        const r = initUiCard(process.cwd(), { component: flags.ui, name: flags.name ?? 'demo', configPath, css, tsconfig });
        for (const c of r.created) log(`${c.status.padEnd(12)} ${c.file}`);
        log(`next: ${r.next.join('  ->  ')}`);
        return { ok: true, ...r };
      }
      const lines = initProject(process.cwd(), { wasm: flags.wasm, exportName: flags.export, init: int(flags, 'init'), configPath });
      for (const line of lines) log(line);
      return { ok: true, created: lines.filter((l) => /^(created|kept)/.test(l)) };
    }
    case 'build': {
      const results = await build(configPath, { only: pos, force: !!flags.force, log, quiet: !!flags.json });
      const written = results.filter((r) => r.card === 'written');
      if (written.length) {
        log('\nEmbed in README.md (the file name stays the same on every rebuild):');
        for (const r of written) log(`  ![${r.name}](${r.out.replace(/\\/g, '/')})`);
      }
      return { ok: true, cards: results };
    }
    case 'check': {
      const problems = [];
      await check(configPath, { log, report: (p) => problems.push({ ...p, hint: describeError({ code: p.code }).hint }) });
      if (problems.length) log(`\nreadme-runtime check: ${problems.length} card(s) need "readme-runtime build" (nothing was modified).`);
      else log('\nreadme-runtime check: all cards are up to date.');
      return { ok: problems.length === 0, problems, exitCode: problems.length ? 1 : 0 };
    }
    case 'render': {
      const file = pos[0];
      if (!file) throw new ConfigError('render needs a .wasm file');
      const init = int(flags, 'init');
      if (init === undefined) throw new ConfigError('render needs --init <n> (the initial state)');
      const wasm = fs.readFileSync(file);
      const r = await generate(wasm, {
        export: flags.export ?? DEFAULTS.export, init,
        steps: int(flags, 'steps') ?? DEFAULTS.steps, hold: int(flags, 'hold') ?? DEFAULTS.hold,
        stepMs: int(flags, 'step-ms') ?? DEFAULTS.stepMs, bits: int(flags, 'bits') ?? DEFAULTS.bits,
        haltValue: int(flags, 'halt') ?? null, haltExport: flags['halt-export'] ?? null,
        title: flags.title ?? path.basename(file, '.wasm'), wasmName: path.basename(file),
      });
      const out = flags.out ?? `${path.basename(file, '.wasm')}.svg`;
      fs.writeFileSync(out, r.svg);
      const end = r.verification.trace.end;
      log(`wrote ${out} (${(r.svg.length / 1024).toFixed(1)} kB): ${end.kind === 'halt' ? `halts at step ${end.at}` : end.kind === 'trap' ? `traps at step ${end.at}` : `${end.at} steps`}, verified against Wasm`);
      return { ok: true, out, bytes: r.svg.length, end };
    }
    case 'inspect': {
      const file = pos[0];
      if (!file) throw new ConfigError('inspect needs a .wasm file');
      const bytes = fs.readFileSync(file);
      const exports = listExports(parseModule(bytes)).map((f) => {
        const signature = `${f.name}(${f.params.join(', ')}) -> ${f.results.join(', ') || 'void'}`;
        try {
          compileStep(bytes, { exportName: f.name });
          return { name: f.name, signature, supported: true };
        } catch (e) {
          return { name: f.name, signature, supported: false, error: describeError(e) };
        }
      });
      if (!exports.length) log('no exported functions');
      for (const x of exports) log(`${x.signature.padEnd(32)} ${x.supported ? 'OK: can run in CSS as a step function' : `no: ${x.error.message}`}`);
      return { ok: true, file, exports };
    }
    default:
      throw new ConfigError(`unknown command "${cmd}" (try --help)`);
  }
}

async function main() {
  let flags = {};
  let cmd;
  try {
    const parsed = parseArgs(process.argv.slice(2));
    flags = parsed.flags;
    cmd = parsed.pos.shift();
    if (flags.version) { console.log(flags.json ? JSON.stringify({ schemaVersion: 1, ok: true, version: TOOL_VERSION }) : TOOL_VERSION); return 0; }
    if (flags.help || !cmd) { console.log(HELP); return cmd || flags.help ? 0 : 1; }
    const logs = [];
    const log = flags.json ? (s) => logs.push(s) : (s) => console.log(s);
    const result = await run(cmd, parsed.pos, flags, log);
    if (flags.json) process.stdout.write(`${JSON.stringify({ schemaVersion: 1, command: cmd, version: TOOL_VERSION, ...result }, null, 2)}\n`);
    return result.exitCode ?? 0;
  } catch (e) {
    const d = describeError(e);
    if (flags.json) process.stdout.write(`${JSON.stringify({ schemaVersion: 1, command: cmd ?? null, version: TOOL_VERSION, ok: false, error: d }, null, 2)}\n`);
    else {
      console.error(`readme-runtime: [${d.code}] ${d.message}`);
      if (d.hint) console.error(`hint: ${d.hint}`);
      if (d.code === 'INTERNAL' && process.env.README_RUNTIME_DEBUG) console.error(e.stack);
    }
    return 2;
  }
}

main().then((code) => { process.exitCode = code; });
