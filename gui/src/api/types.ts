// Types shared by the GUI and the connection layer (Issue #3).
//
// Part 1 mirrors what the CLI prints today (`--json`, schemaVersion 1), as observed at d11668f.
// Part 2 is the GUI's proposal for the connection API; the mock (./mock.ts) implements it so the
// screens can be built before #3 exists. Everything in part 2 is open for discussion with #3.

// ---------------------------------------------------------------- 1. CLI output (schemaVersion 1)

/** `loops` in readme-runtime.json: "auto" ≈ one minute from page load, "infinite", or a count 1..1000. */
export type Loops = 'auto' | 'infinite' | number;

/** `cards[]` of readme-runtime.json. Keys the GUI does not edit are kept as they are. */
export interface CardConfig {
  name: string;
  wasm: string;
  init: number;
  title?: string;
  altInits?: number[];
  steps?: number;
  stepMs?: number;
  hold?: number;
  loops?: Loops;
  bits?: number;
  halt?: number;
  haltExport?: string;
  export?: string;
  out?: string;
  build?: { command: string; inputs: string[] };
  ui?: {
    entry: string;
    views: Record<string, string>;
    css?: string[];
    tsconfig?: string;
    width?: number;
    height?: number;
    credit?: string;
  };
}

export interface ProjectConfig {
  cards: CardConfig[];
}

/** How the run ends. "range" and "trap" stop the card with OUT OF RANGE / TRAP. */
export interface RunEnd {
  kind: 'steps' | 'halt' | 'trap' | 'range';
  at: number;
  message?: string;
}

/** `cards[].perf`: derived from the options and the generated file, not measured in a browser. */
export interface PerfReport {
  /** 1000 / stepMs: how often the state changes. Not a rendering frame rate. */
  updatesPerSecond: number;
  /** One run including hold, in seconds. */
  loopSeconds: number;
  /** "auto" is resolved to a count. */
  loops: number | 'infinite';
  /** How long the card keeps updating; null while it is shown ("infinite"). */
  activeSeconds: number | null;
  steps: number;
  displayElements: number;
  containerRules: number;
  bytes: number;
  gzipBytes: number;
}

/** `cards[].warnings[]`: PERF_* codes, each with a `fix` to merge into the card. */
export interface PerfWarning {
  code: string;
  message: string;
  fix: Partial<Pick<CardConfig, 'stepMs' | 'loops' | 'steps'>>;
}

/** `cards[]` of `build --json`. A cached card has no `steps` / `end` / `ui`. */
export interface BuildCardResult {
  name: string;
  build: 'none' | 'cached' | 'built';
  card: 'cached' | 'unchanged' | 'written';
  out: string;
  summary: string;
  reason: string | null;
  steps?: number;
  end?: RunEnd;
  ui?: { warnings?: { code: string; message: string }[]; [key: string]: unknown } | null;
  perf: PerfReport;
  warnings?: PerfWarning[];
  embed: string[];
}

export interface CliError {
  code: string;
  message: string;
  hint: string;
  details: Record<string, unknown>;
}

export interface CliEnvelope {
  schemaVersion: 1;
  command: string | null;
  version: string;
}

export type BuildOutput =
  | (CliEnvelope & { ok: true; cards: BuildCardResult[] })
  | (CliEnvelope & { ok: false; error: CliError });

export interface CheckProblem {
  card: string;
  code: string;
  message: string;
  hint?: string;
}

export type CheckOutput =
  | (CliEnvelope & { ok: boolean; problems: CheckProblem[]; exitCode: 0 | 1 })
  | (CliEnvelope & { ok: false; error: CliError });

// ---------------------------------------------------------------- 2. connection API (proposal)

/** The settings this GUI edits. Everything else in CardConfig is shown read-only. */
export interface CardSettings {
  title: string;
  init: number;
  altInits: number[];
  steps: number;
  stepMs: number;
  hold: number;
  loops: Loops;
}

export interface CardSummary {
  name: string;
  /** "ui": an existing React UI (ui.entry); "trace": the built-in trace card. */
  kind: 'ui' | 'trace';
  /** As saved in readme-runtime.json. */
  config: CardConfig;
  /** URL of the committed SVG, for an <img>. */
  svgUrl: string;
  /** The last build of the saved settings (perf, warnings, embed). */
  lastBuild: BuildCardResult | null;
}

export interface IntRange {
  min: number;
  max: number;
}

/** What the connected runtime accepts and offers. The GUI builds its form and checks from it. */
export interface Capabilities {
  /** The connection API's version. A GUI that knows a lower version says so instead of guessing. */
  apiVersion: number;
  settings: {
    limits: {
      init: IntRange;
      steps: IntRange;
      stepMs: IntRange;
      hold: IntRange;
      altInits: IntRange & { maxItems: number };
      loops: { count: IntRange };
    };
    defaults: { steps: number; stepMs: number; hold: number; loops: Loops; altInits: number[] };
    /** "runtime": read from the runtime's exported constants (and its option checks); "gui": the GUI's own table. */
    source: 'runtime' | 'gui';
  };
  /** Features of the runtime and whether this version has them; unavailable ones are shown disabled with the reason. */
  features: { key: string; label: string; available: boolean; issue?: number; reason?: string }[];
  perf: {
    /** Where each perf figure comes from: the settings, or the generated file. None is measured in a browser. */
    sources: Record<keyof PerfReport, 'settings' | 'file'>;
    /** What no part of the GUI or API measures. */
    notMeasured: string[];
  };
}

export interface ProjectInfo {
  /** "mock": data from the files below and captured CLI output; nothing is generated or written. */
  mode: 'mock' | 'live';
  toolVersion: string;
  capabilities: Capabilities;
  /** Why the GUI is not in the mode it asked for (e.g. the runtime could not be loaded). */
  notice?: string;
  cards: CardSummary[];
}

export interface PreviewOk {
  ok: true;
  /** Changes with every preview, so the <img> URL changes and the card starts from step 0. */
  generation: number;
  svgUrl: string;
  /** The initial values the previewed SVG itself answers to (#x<value>). */
  svgAltInits: number[];
  card: BuildCardResult;
  /** false: the image is not generated from these settings (the mock shows the committed SVG). */
  reflectsSettings: boolean;
}

export interface Failure {
  ok: false;
  error: CliError;
}

export type PreviewResponse = PreviewOk | Failure;

export interface SaveOk {
  ok: true;
  /** The card as it is (or, in the mock, would be) written to readme-runtime.json. */
  config: CardConfig;
  card: BuildCardResult;
  written: boolean;
}

export type SaveResponse = SaveOk | Failure;

export interface RuntimeApi {
  getProject(): Promise<ProjectInfo>;
  /** Generates a card from the settings without touching readme-runtime.json, the SVG or the lock. */
  preview(name: string, settings: CardSettings, signal?: AbortSignal): Promise<PreviewResponse>;
  /** Writes the settings to readme-runtime.json and runs `build` for that card. */
  save(name: string, settings: CardSettings): Promise<SaveResponse>;
  /** `check --json`: never writes. */
  check(): Promise<CheckOutput>;
}
