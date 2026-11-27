// Mock of the connection API (Issue #3 is not there yet). It reads the repository's own
// readme-runtime.json and committed SVGs, and answers with CLI output captured at d11668f
// (src/mocks/cli/). It never generates an SVG and never writes a file:
//   - preview shows the committed SVG and says so (reflectsSettings: false);
//   - option errors use the CLI's own messages (src/generate.js), so the error screens show
//     what the real CLI prints;
//   - the Collatz card replays its step() in JS, so a too-large initial value fails with the
//     same RANGE_STATE error the CLI gives (try 77671);
//   - perf is derived like src/perf.js from the settings and the committed file's size;
//   - ?mockCheck=fail makes `check` return a captured failure.
import projectConfig from '../../../readme-runtime.json';
import cached from '../mocks/cli/build-cached.json';
import checkOk from '../mocks/cli/check-ok.json';
import checkFail from '../mocks/cli/check-fail.json';
import { toConfigCard } from './fields';
import type {
  BuildCardResult, CardConfig, CardSettings, CheckOutput, CliError, PerfReport, PerfWarning,
  PreviewResponse, ProjectConfig, ProjectInfo, RunEnd, RuntimeApi, SaveResponse,
} from './types';

const svgUrls = import.meta.glob('../../../readme-runtime/*.svg', { query: '?url', import: 'default', eager: true }) as Record<string, string>;
const svgUrlFor = (out: string) => svgUrls[`../../../${out}`] ?? '';

const config = projectConfig as ProjectConfig;
const cachedCards = (cached as { cards: BuildCardResult[] }).cards;
const TOOL_VERSION = (cached as { version: string }).version;

// src/errors.js HINTS for the codes the mock can produce
const HINTS: Record<string, string> = {
  OPTION_INVALID: 'Adjust the option named in the message (see `readme-runtime --help`).',
  RANGE_STATE: 'A state value exceeds ±999,999. Use a smaller "init", fewer "steps", a halt condition, or scale the state down.',
};
const fail = (code: string, message: string): { ok: false; error: CliError } => ({ ok: false, error: { code, message, hint: HINTS[code] ?? '', details: {} } });

const LIMIT = 999_999;
const isInt = (v: unknown, lo: number, hi: number) => Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi;

/** The option checks of src/generate.js, with its messages. */
function optionError(s: CardSettings): string | null {
  if (!Number.isInteger(s.init)) return '"init" (the initial state) must be an integer';
  if (Math.abs(s.init) > LIMIT) return `"init" ${s.init} is outside the range CSS can represent exactly in every browser (|x| <= 999,999)`;
  if (!isInt(s.steps, 1, 400)) return '"steps" must be an integer between 1 and 400 (WebKit stops resolving styles beyond ~510 nested elements)';
  if (!isInt(s.stepMs, 16, 10000)) return '"stepMs" must be an integer between 16 and 10000';
  if (!isInt(s.hold, 0, 1000)) return '"hold" must be an integer between 0 and 1000';
  if (s.loops !== 'auto' && s.loops !== 'infinite' && !isInt(s.loops, 1, 1000)) return '"loops" must be "auto" (play for about a minute), "infinite" or an integer between 1 and 1000: how many times the run plays before the card stays on its last step';
  if (s.altInits.length > 16 || !s.altInits.every((x) => isInt(x, -LIMIT, LIMIT)) || new Set([s.init, ...s.altInits]).size !== s.altInits.length + 1) {
    return '"altInits" must list up to 16 other initial values (integers, |x| <= 999,999, none equal to "init" or repeated); the card shows them for the URL fragments #x<value>';
  }
  return null;
}

/** examples/collatz/collatz.c step(), run like src/runtime/reference.js (state range and halt). */
function collatzRun(init: number, steps: number, halt: number | undefined): { end: RunEnd; value: number } {
  let x = init;
  if (halt !== undefined && x === halt) return { end: { kind: 'halt', at: 0 }, value: x };
  for (let k = 1; k <= steps; k++) {
    x = x % 2 === 0 ? Math.trunc(x / 2) : 3 * x + 1;
    if (Math.abs(x) > LIMIT) return { end: { kind: 'range', at: k }, value: x };
    if (halt !== undefined && x === halt) return { end: { kind: 'halt', at: k }, value: x };
  }
  return { end: { kind: 'steps', at: steps }, value: x };
}
const rangeMessage = (at: number, value: number) =>
  `step ${at}: state ${value} is outside the CSS-exact range (|x| <= 999,999). Chromium keeps only 6 significant digits of computed custom properties, so this value cannot be shown faithfully. Use a smaller "init", fewer "steps", or a halt condition.`;

/** src/perf.js perfReport(), with the size and element counts of the committed file. */
function perf(s: CardSettings, base: PerfReport): { report: PerfReport; warnings: PerfWarning[] } {
  const loopMs = (s.steps + s.hold + 1) * s.stepMs;
  const loops = s.loops === 'auto' ? Math.max(1, Math.ceil(60000 / loopMs)) : s.loops;
  const report: PerfReport = {
    updatesPerSecond: Number((1000 / s.stepMs).toFixed(1)),
    loopSeconds: Number((loopMs / 1000).toFixed(1)),
    loops,
    activeSeconds: loops === 'infinite' ? null : Number(((loopMs / 1000) * loops).toFixed(1)),
    steps: s.steps,
    displayElements: base.displayElements,
    containerRules: base.containerRules,
    bytes: base.bytes,
    gzipBytes: base.gzipBytes,
  };
  const warnings: PerfWarning[] = [];
  const large = report.displayElements > 600 || report.containerRules > 120;
  const slower = Math.max(s.stepMs, large ? 200 : 150);
  if (s.stepMs < 100) warnings.push({ code: 'PERF_FAST_CLOCK', message: `the card updates ${report.updatesPerSecond} times per second (stepMs ${s.stepMs}); every update restyles and repaints the display, so viewers' CPU use grows with the rate`, fix: { stepMs: slower } });
  if (loops === 'infinite') warnings.push({ code: 'PERF_ENDLESS', message: 'loops is "infinite": the card keeps updating for as long as the page is open and the card is on screen (WebKit also while it is scrolled out of view); "auto" plays for about a minute and then rests on the last step, which costs nothing', fix: { loops: 'auto' } });
  if (s.steps > 240) warnings.push({ code: 'PERF_LONG_RUN', message: `${s.steps} steps: the first render computes every step and the file grows with each one (${(report.gzipBytes / 1024).toFixed(1)} kB gzip); a shorter run or a halt condition keeps both small`, fix: { steps: 240 } });
  if (large) warnings.push({ code: 'PERF_LARGE_DISPLAY', message: `the display has ${report.displayElements} elements and ${report.containerRules} @container rules, restyled on every step; show a smaller part of the UI, or fewer switched (discrete) props`, fix: { stepMs: slower } });
  return { report, warnings };
}

const outOf = (c: CardConfig) => c.out ?? `readme-runtime/${c.name}.svg`;
const embedFor = (c: CardConfig, s: CardSettings) => {
  const out = outOf(c);
  return [`![${c.name}](${out})`, ...s.altInits.map((x) => `![${c.name} from ${x}](${out}?x${x}#x${x})`)];
};

/** What `build` would report for these settings, or the error it would stop with. */
function simulate(c: CardConfig, s: CardSettings, reason: string): BuildCardResult | { ok: false; error: CliError } {
  const optErr = optionError(s);
  if (optErr) return fail('OPTION_INVALID', optErr);
  const base = cachedCards.find((x) => x.name === c.name);
  if (!base) return fail('OPTION_INVALID', `no captured build for "${c.name}" in the mock`);
  let end: RunEnd = { kind: 'steps', at: s.steps };
  if (c.name === 'collatz') {
    for (const [i, init] of [s.init, ...s.altInits].entries()) {
      const r = collatzRun(init, s.steps, c.halt);
      if (r.end.kind === 'range') return fail('RANGE_STATE', `${i ? `altInits ${init}: ` : ''}${rangeMessage(r.end.at, r.value)}`);
      if (i === 0) end = r.end;
    }
  }
  const p = perf(s, base.perf);
  const endText = end.kind === 'halt' ? `halts at step ${end.at}` : `${end.at} steps`;
  return {
    name: c.name,
    build: c.build ? 'cached' : 'none',
    card: 'written',
    out: outOf(c),
    summary: `${(p.report.bytes / 1024).toFixed(1)} kB, ${endText} (mock: size of the committed file)`,
    reason,
    steps: end.at,
    end,
    perf: p.report,
    ...(p.warnings.length ? { warnings: p.warnings } : {}),
    embed: embedFor(c, s),
  };
}

const delay = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('aborted', 'AbortError')); });
});

export function createMockApi(): RuntimeApi {
  // "saved" settings live only in memory: the mock never writes readme-runtime.json
  const saved = new Map(config.cards.map((c) => [c.name, structuredClone(c)]));
  let generation = 0;
  return {
    async getProject(): Promise<ProjectInfo> {
      await delay(150);
      return {
        mode: 'mock',
        toolVersion: TOOL_VERSION,
        cards: [...saved.values()].map((c) => ({
          name: c.name,
          kind: c.ui ? 'ui' : 'trace',
          config: structuredClone(c),
          svgUrl: svgUrlFor(outOf(c)),
          lastBuild: cachedCards.find((x) => x.name === c.name) ?? null,
        })),
      };
    },
    async preview(name, settings, signal): Promise<PreviewResponse> {
      await delay(700, signal);
      const c = saved.get(name);
      if (!c) return fail('CONFIG_INVALID', `no card named "${name}"`);
      const r = simulate(c, settings, 'preview');
      if ('ok' in r) return r;
      return { ok: true, generation: ++generation, svgUrl: svgUrlFor(outOf(c)), svgAltInits: [...(config.cards.find((x) => x.name === name)?.altInits ?? [])], card: r, reflectsSettings: false };
    },
    async save(name, settings): Promise<SaveResponse> {
      await delay(900);
      const c = saved.get(name);
      if (!c) return fail('CONFIG_INVALID', `no card named "${name}"`);
      const r = simulate(c, settings, 'options changed');
      if ('ok' in r) return r;
      const next = toConfigCard(c, settings);
      saved.set(name, next);
      return { ok: true, config: structuredClone(next), card: r, written: false };
    },
    async check(): Promise<CheckOutput> {
      await delay(600);
      const failing = new URLSearchParams(location.search).get('mockCheck') === 'fail';
      return structuredClone((failing ? checkFail : checkOk) as CheckOutput);
    },
  };
}
