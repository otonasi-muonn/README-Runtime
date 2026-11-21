#!/usr/bin/env node
// README Runtime CLI.
import fs from 'node:fs';
import path from 'node:path';
import { generate, DEFAULTS } from '../src/generate.js';
import { build, check, CONFIG_FILE, ConfigError } from '../src/project.js';
import { parseModule } from '../src/wasm/reader.js';
import { listExports, compileStep } from '../src/compiler/program.js';
import { TOOL_VERSION } from '../src/version.js';
import { MAX_STEPS } from '../src/runtime/machine.js';
import { initProject } from '../src/init.js';

const HELP = `README Runtime ${TOOL_VERSION} - run your WebAssembly inside your README

Usage:
  readme-runtime init [--wasm <file.wasm>] [--export <name>] [--init <n>]
                                   create ${CONFIG_FILE} and a check-only GitHub workflow
  readme-runtime build [names...] [--force]
                                   rebuild changed .wasm (build commands) and cards
  readme-runtime check             CI: fail if a committed card is stale (never writes)
  readme-runtime render <file.wasm> --init <n> [-o card.svg] [options]
                                   one-shot render without a config file
  readme-runtime inspect <file.wasm>
                                   list exports and whether each can run in CSS

Render options:
  --export <name>      exported (i32) -> i32 step function   (default: ${DEFAULTS.export})
  --init <n>           initial state x0                       (required)
  --steps <n>          maximum steps, 1..${MAX_STEPS}                  (default: ${DEFAULTS.steps})
  --halt <n>           stop when the state equals n
  --halt-export <name> stop when the exported predicate returns non-zero
  --title <text>       card title
  --step-ms <n>        milliseconds per step                  (default: ${DEFAULTS.stepMs})
  --hold <n>           extra steps to hold the final state    (default: ${DEFAULTS.hold})
  --bits <n>           rows in the trace, 4..20               (default: ${DEFAULTS.bits})

Common options:
  --config <file>      config path (default: ${CONFIG_FILE})
  -h, --help           show this help
  -v, --version        show the version
`;

function parseArgs(argv) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') flags.help = true;
    else if (a === '-v' || a === '--version') flags.version = true;
    else if (a === '--force') flags.force = true;
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

async function main() {
  const { pos, flags } = parseArgs(process.argv.slice(2));
  const cmd = pos.shift();
  if (flags.version) { console.log(TOOL_VERSION); return 0; }
  if (flags.help || !cmd) { console.log(HELP); return cmd || flags.help ? 0 : 1; }
  const configPath = flags.config ?? CONFIG_FILE;

  switch (cmd) {
    case 'build': {
      const results = await build(configPath, { only: pos, force: !!flags.force });
      const written = results.filter((r) => r.card === 'written');
      if (written.length) {
        console.log('\nEmbed in README.md (the file name stays the same on every rebuild):');
        for (const r of written) console.log(`  ![${r.name}](${r.out.replace(/\\/g, '/')})`);
      }
      return 0;
    }
    case 'check': {
      const problems = await check(configPath);
      if (problems.length) {
        console.error(`\nreadme-runtime check: ${problems.length} card(s) need "readme-runtime build" (nothing was modified).`);
        return 1;
      }
      console.log('\nreadme-runtime check: all cards are up to date.');
      return 0;
    }
    case 'render': {
      const file = pos[0];
      if (!file) throw new ConfigError('render needs a .wasm file');
      const init = int(flags, 'init');
      if (init === undefined) throw new ConfigError('render needs --init <n> (the initial state)');
      const wasm = fs.readFileSync(file);
      const opts = {
        export: flags.export ?? DEFAULTS.export,
        init,
        steps: int(flags, 'steps') ?? DEFAULTS.steps,
        hold: int(flags, 'hold') ?? DEFAULTS.hold,
        stepMs: int(flags, 'step-ms') ?? DEFAULTS.stepMs,
        bits: int(flags, 'bits') ?? DEFAULTS.bits,
        haltValue: int(flags, 'halt') ?? null,
        haltExport: flags['halt-export'] ?? null,
        title: flags.title ?? path.basename(file, '.wasm'),
        wasmName: path.basename(file),
      };
      const r = await generate(wasm, opts);
      const out = flags.out ?? `${path.basename(file, '.wasm')}.svg`;
      fs.writeFileSync(out, r.svg);
      const end = r.verification.trace.end;
      console.log(`wrote ${out} (${(r.svg.length / 1024).toFixed(1)} kB): ${end.kind === 'halt' ? `halts at step ${end.at}` : end.kind === 'trap' ? `traps at step ${end.at}` : `${end.at} steps`}, verified against Wasm`);
      return 0;
    }
    case 'inspect': {
      const file = pos[0];
      if (!file) throw new ConfigError('inspect needs a .wasm file');
      const bytes = fs.readFileSync(file);
      const mod = parseModule(bytes);
      const fns = listExports(mod);
      if (!fns.length) console.log('no exported functions');
      for (const f of fns) {
        const sig = `${f.name}(${f.params.join(', ')}) -> ${f.results.join(', ') || 'void'}`;
        let status;
        try {
          compileStep(bytes, { exportName: f.name });
          status = 'OK: can run in CSS as a step function';
        } catch (e) {
          status = `no: ${e.message}`;
        }
        console.log(`${sig.padEnd(32)} ${status}`);
      }
      return 0;
    }
    case 'init': {
      const created = initProject(process.cwd(), {
        wasm: flags.wasm, exportName: flags.export, init: int(flags, 'init'), configPath,
      });
      for (const line of created) console.log(line);
      return 0;
    }
    default:
      throw new ConfigError(`unknown command "${cmd}" (try --help)`);
  }
}

main().then((code) => { process.exitCode = code; }, (e) => {
  const known = e instanceof ConfigError || ['UnsupportedError', 'VerifyError', 'WasmFormatError', 'UnsupportedOpcode'].includes(e?.constructor?.name);
  console.error(`readme-runtime: ${known ? '' : 'error: '}${e.message}`);
  if (!known && process.env.README_RUNTIME_DEBUG) console.error(e.stack);
  process.exitCode = 2;
});
