// Connection layer between the GUI and README Runtime (Issue #3), served under /api by the Vite
// dev server (vite.config.ts). It reuses the runtime as it is: src/generate.js for previews,
// src/project.js build() and check() for saving and checking. Nothing here re-implements them.
//
// A local developer tool, not a service:
//   - the dev server listens on 127.0.0.1 only; requests must also name a loopback Host
//     (DNS rebinding) and, for POST, come from the same origin with a JSON body (CSRF);
//   - the client sends a card name and the settings below, never a path or a command;
//     files are the ones readme-runtime.json names, inside the repository;
//   - `build` runs the card's own build command, as the CLI does: use it on code you trust.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { API_VERSION, FEATURES, PERF_SOURCES } from '../src/api/capabilities.ts';
import { toConfigCard } from '../src/api/fields.ts';
import type { BuildCardResult, Capabilities, CardConfig, CardSettings, CliError, ProjectConfig } from '../src/api/types.ts';

type Next = (err?: unknown) => void;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Runtime = { generate: any; project: any; errors: any; perf: any; version: any; css: any; machine: any };

const MAX_BODY = 64 * 1024;
const MAX_PREVIEWS = 24;
const LOOPBACK = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;

export interface ApiOptions {
  /** The repository root: readme-runtime.json and src/ of README Runtime. */
  root: string;
}

export function createRuntimeApi({ root }: ApiOptions) {
  const configPath = path.join(root, 'readme-runtime.json');
  let runtime: Promise<Runtime> | null = null;
  // the runtime is loaded on first use, from the repository itself (not bundled into the config)
  const load = () => (runtime ??= (async () => {
    const at = (p: string) => import(/* @vite-ignore */ pathToFileURL(path.join(root, 'src', p)).href);
    const [generate, project, errors, perf, version, css, machine] = await Promise.all([at('generate.js'), at('project.js'), at('errors.js'), at('perf.js'), at('version.js'), at('compiler/css.js'), at('runtime/machine.js')]);
    return { generate, project, errors, perf, version, css, machine };
  })().catch((e) => { runtime = null; throw e; }));

  // Generation is CPU-bound; one at a time keeps the machine responsive and the order clear.
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = queue.then(fn, fn);
    queue = run.catch(() => {});
    return run;
  };
  let generation = 0;
  const previews = new Map<number, string>();
  let writing = false;

  const readConfigText = () => fs.readFileSync(configPath, 'utf8');
  const readConfig = (): ProjectConfig => JSON.parse(readConfigText());
  const outOf = (c: CardConfig) => c.out ?? `readme-runtime/${c.name}.svg`;
  const inside = (rel: string) => {
    const abs = path.resolve(root, rel);
    if (abs !== root && !abs.startsWith(root + path.sep)) throw coded('CONFIG_INVALID', `${rel} is outside the repository`);
    return abs;
  };
  const embedFor = (c: CardConfig, altInits: number[]) => {
    const out = outOf(c);
    return [`![${c.name}](${out})`, ...altInits.map((x) => `![${c.name} from ${x}](${out}?x${x}#x${x})`)];
  };

  async function describe(e: unknown): Promise<CliError> {
    // the generator's own dependencies (esbuild, react, tailwind) live in the repository root
    if ((e as { code?: string })?.code === 'ERR_MODULE_NOT_FOUND') {
      return { code: 'DEPS_NOT_INSTALLED', message: (e as Error).message, hint: 'Run `npm install` in the README Runtime repository root: the GUI runs its generator from there.', details: {} };
    }
    try {
      const rt = await load();
      const d = rt.errors.describeError(e) as CliError;
      // codes of this layer (BUSY, FORBIDDEN, ...) are kept; the runtime does not know them
      const own = (e as { code?: unknown })?.code;
      return d.code === 'INTERNAL' && typeof own === 'string' && /^[A-Z_]+$/.test(own) ? { ...d, code: own, hint: '' } : d;
    } catch {
      return { code: 'INTERNAL', message: e instanceof Error ? e.message : String(e), hint: '', details: {} };
    }
  }

  /** The card's options as loadConfig() makes them, with the GUI's settings applied. */
  async function optionsFor(name: string, s: CardSettings) {
    const rt = await load();
    const cfg = rt.project.loadConfig(configPath);
    const card = cfg.cards.find((c: { name: string }) => c.name === name);
    if (!card) throw coded('CONFIG_INVALID', `no card named "${name}"`);
    return { rt, card, options: { ...card.options, title: s.title, init: s.init, altInits: s.altInits, steps: s.steps, stepMs: s.stepMs, hold: s.hold, loops: s.loops } };
  }

  /**
   * Ranges and defaults from the runtime's exported constants. stepMs, hold and the loop count are
   * not exported: their bounds are the ones src/generate.js checks (16-10000, 0-1000, 1-1000).
   */
  function capabilities(rt: Runtime): Capabilities {
    const state = rt.css.STORED_LIMIT as number;
    const d = rt.generate.DEFAULTS;
    return {
      apiVersion: API_VERSION,
      settings: {
        limits: {
          init: { min: -state, max: state },
          steps: { min: 1, max: rt.machine.MAX_STEPS as number },
          stepMs: { min: 16, max: 10000 },
          hold: { min: 0, max: 1000 },
          altInits: { min: -state, max: state, maxItems: rt.generate.MAX_ALT_INITS as number },
          loops: { count: { min: 1, max: 1000 } },
        },
        defaults: { steps: d.steps, stepMs: d.stepMs, hold: d.hold, loops: d.loops, altInits: [...d.altInits] },
        source: 'runtime',
      },
      features: FEATURES,
      perf: PERF_SOURCES,
    };
  }

  async function project() {
    const rt = await load();
    const raw = readConfig();
    const cfg = rt.project.loadConfig(configPath);
    return {
      mode: 'live' as const,
      capabilities: capabilities(rt),
      toolVersion: rt.version.TOOL_VERSION as string,
      cards: raw.cards.map((c) => {
        const out = outOf(c);
        const file = inside(out);
        let lastBuild: BuildCardResult | null = null;
        if (fs.existsSync(file)) {
          // what the committed card asks of viewers: from its options and file, as build reports
          // for a cached card (no run end without generating it again)
          const svg = rt.project.normalizeEol(fs.readFileSync(file, 'utf8'));
          const options = cfg.cards.find((x: { name: string }) => x.name === c.name).options;
          const p = rt.perf.perfReport({ ...rt.generate.DEFAULTS, ...options }, svg);
          lastBuild = { name: c.name, build: c.build ? 'cached' : 'none', card: 'cached', out, summary: '', reason: null, perf: p.report, ...(p.warnings.length ? { warnings: p.warnings } : {}), embed: embedFor(c, c.altInits ?? []) };
        }
        return { name: c.name, kind: c.ui ? 'ui' : 'trace', config: c, svgUrl: `/api/svg/${encodeURIComponent(c.name)}`, lastBuild };
      }),
    };
  }

  async function preview(name: string, s: CardSettings) {
    const { rt, card, options } = await optionsFor(name, s);
    const wasm = fs.readFileSync(inside(card.wasm));
    const r = await rt.generate.generate(wasm, options);
    const id = ++generation;
    previews.set(id, r.svg);
    for (const k of previews.keys()) if (previews.size > MAX_PREVIEWS) previews.delete(k);
    const end = r.verification.trace.end;
    const kb = (n: number) => `${(n / 1024).toFixed(1)} kB`;
    const result: BuildCardResult = {
      name,
      build: 'none',
      card: 'written',
      out: card.out,
      summary: `${kb(Buffer.byteLength(r.svg))}, ${end.kind === 'halt' ? `halts at step ${end.at}` : end.kind === 'trap' ? `traps at step ${end.at}` : `${end.at} steps`}, verified against Wasm under ${Object.keys(r.verification.models).length} browser arithmetic models (preview, not saved)`,
      reason: 'preview',
      steps: r.verification.endAt,
      end,
      ui: r.ui,
      perf: r.perf.report,
      ...(r.perf.warnings.length ? { warnings: r.perf.warnings } : {}),
      embed: embedFor(card as unknown as CardConfig, s.altInits),
    };
    return { ok: true, generation: id, svgUrl: `/api/preview/${id}.svg`, svgAltInits: s.altInits, card: result, reflectsSettings: true };
  }

  async function save(name: string, s: CardSettings) {
    if (writing) throw coded('BUSY', 'another save is running');
    writing = true;
    const before = readConfigText();
    try {
      const rt = await load();
      const raw = JSON.parse(before) as ProjectConfig;
      const i = raw.cards.findIndex((c) => c.name === name);
      if (i < 0) throw coded('CONFIG_INVALID', `no card named "${name}"`);
      raw.cards[i] = toConfigCard(raw.cards[i], s, capabilities(rt).settings.defaults);
      const text = formatConfig(raw);
      if (text !== before) writeAtomic(configPath, text);
      try {
        const [card] = await rt.project.build(configPath, { only: [name], quiet: true, log: () => {} });
        return { ok: true, config: raw.cards[i], card, written: true };
      } catch (e) {
        // the build did not finish: put the settings back as they were
        if (text !== before) writeAtomic(configPath, before);
        throw e;
      }
    } finally {
      writing = false;
    }
  }

  async function check() {
    const rt = await load();
    const problems: { card: string; code: string; message: string; hint?: string }[] = [];
    await rt.project.check(configPath, { log: () => {}, report: (p: { card: string; code: string; message: string }) => problems.push({ ...p, hint: rt.errors.describeError({ code: p.code }).hint }) });
    return { schemaVersion: 1, command: 'check', version: rt.version.TOOL_VERSION, ok: problems.length === 0, problems, exitCode: problems.length ? 1 : 0 };
  }

  function sendSvg(res: ServerResponse, svg: string) {
    // as GitHub serves images: no scripts, no external loads
    res.writeHead(200, {
      'Content-Type': 'image/svg+xml; charset=utf-8',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(svg);
  }

  return async function handle(req: IncomingMessage, res: ServerResponse, next: Next) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (!url.pathname.startsWith('/api/')) return next();
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    const failWith = async (status: number, e: unknown) => send(status, { ok: false, error: await describe(e) });
    try {
      if (!LOOPBACK.test(req.headers.host ?? '')) return send(403, { ok: false, error: { code: 'FORBIDDEN', message: 'only loopback hosts are served', hint: '', details: {} } });
      if (req.method === 'POST') {
        const origin = req.headers.origin;
        if (origin && new URL(origin).host !== req.headers.host) return send(403, { ok: false, error: { code: 'FORBIDDEN', message: 'cross-origin request', hint: '', details: {} } });
        if (!(req.headers['content-type'] ?? '').startsWith('application/json')) return send(415, { ok: false, error: { code: 'FORBIDDEN', message: 'send JSON', hint: '', details: {} } });
      }

      if (req.method === 'GET' && url.pathname === '/api/project') return send(200, { ok: true, ...(await project()) });
      if (req.method === 'GET' && url.pathname.startsWith('/api/svg/')) {
        const name = decodeURIComponent(url.pathname.slice('/api/svg/'.length));
        const c = readConfig().cards.find((x) => x.name === name);
        const file = c && inside(outOf(c));
        if (!file || !fs.existsSync(file)) return send(404, { ok: false, error: { code: 'CHECK_CARD_MISSING', message: `no SVG for "${name}"`, hint: '', details: {} } });
        return sendSvg(res, fs.readFileSync(file, 'utf8'));
      }
      const pm = req.method === 'GET' && /^\/api\/preview\/(\d+)\.svg$/.exec(url.pathname);
      if (pm) {
        const svg = previews.get(Number(pm[1]));
        return svg ? sendSvg(res, svg) : send(404, { ok: false, error: { code: 'PREVIEW_GONE', message: 'this preview is no longer kept; generate it again', hint: '', details: {} } });
      }

      if (req.method === 'POST' && ['/api/preview', '/api/save', '/api/check'].includes(url.pathname)) {
        const body = await readJson(req);
        if (url.pathname === '/api/check') return send(200, await serial(check));
        const { name, settings } = parseRequest(body);
        if (url.pathname === '/api/preview') {
          // a request the client gave up on while it waited is not generated
          let gone = false;
          res.on('close', () => { if (!res.writableEnded) gone = true; });
          const r = await serial(async () => (gone ? null : preview(name, settings)));
          return r ? send(200, r) : undefined;
        }
        return send(200, await serial(() => save(name, settings)));
      }
      return send(404, { ok: false, error: { code: 'NOT_FOUND', message: `${req.method} ${url.pathname}`, hint: '', details: {} } });
    } catch (e) {
      const status = (e as { status?: number }).status ?? 200;
      return failWith(status, e);
    }
  };
}

function coded(code: string, message: string, status?: number) {
  return Object.assign(new Error(message), { code, ...(status ? { status } : {}) });
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw coded('FORBIDDEN', 'request too large', 413);
    chunks.push(chunk as Buffer);
  }
  try {
    return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
  } catch {
    throw coded('OPTION_INVALID', 'request body is not valid JSON', 400);
  }
}

/** Only a card name and the settings the GUI edits; types are checked here, ranges by generate(). */
function parseRequest(body: unknown): { name: string; settings: CardSettings } {
  const b = body as { name?: unknown; settings?: Record<string, unknown> };
  if (typeof b?.name !== 'string' || !b.settings || typeof b.settings !== 'object') throw coded('OPTION_INVALID', 'expected { name, settings }', 400);
  const s = b.settings;
  const keys = ['title', 'init', 'altInits', 'steps', 'stepMs', 'hold', 'loops'];
  for (const k of Object.keys(s)) if (!keys.includes(k)) throw coded('OPTION_INVALID', `unknown setting "${k}"`, 400);
  if (typeof s.title !== 'string') throw coded('OPTION_INVALID', '"title" must be a string', 400);
  for (const k of ['init', 'steps', 'stepMs', 'hold']) if (typeof s[k] !== 'number') throw coded('OPTION_INVALID', `"${k}" must be a number`, 400);
  if (!Array.isArray(s.altInits) || !s.altInits.every((x) => typeof x === 'number')) throw coded('OPTION_INVALID', '"altInits" must be a list of numbers', 400);
  if (!(s.loops === 'auto' || s.loops === 'infinite' || typeof s.loops === 'number')) throw coded('OPTION_INVALID', '"loops" must be "auto", "infinite" or a number', 400);
  return { name: b.name, settings: s as unknown as CardSettings };
}

/** readme-runtime.json as the repository keeps it: 2 spaces, arrays of numbers on one line. */
export function formatConfig(raw: unknown): string {
  return `${JSON.stringify(raw, null, 2).replace(/\[\s*(-?\d+(?:,\s*-?\d+)*)\s*\]/g, (_, g: string) => `[${g.split(/,\s*/).join(', ')}]`)}\n`;
}

function writeAtomic(file: string, text: string) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}
