// The settings the GUI edits. Ranges and defaults come from the connected runtime
// (Capabilities.settings); the table below is the fallback when none is connected (the mock),
// with the values of src/generate.js at d11668f. The runtime stays the authority: these checks
// only catch mistakes before a preview is requested.
import type { Capabilities, CardConfig, CardSettings, Loops } from './types';

export type Limits = Capabilities['settings']['limits'];
export type Defaults = Capabilities['settings']['defaults'];

const STATE_LIMIT = 999_999;
export const FALLBACK_SETTINGS: Capabilities['settings'] = {
  limits: {
    init: { min: -STATE_LIMIT, max: STATE_LIMIT },
    steps: { min: 1, max: 400 },
    stepMs: { min: 16, max: 10000 },
    hold: { min: 0, max: 1000 },
    altInits: { min: -STATE_LIMIT, max: STATE_LIMIT, maxItems: 16 },
    loops: { count: { min: 1, max: 1000 } },
  },
  defaults: { steps: 120, stepMs: 150, hold: 12, loops: 'auto' as Loops, altInits: [] },
  source: 'gui',
};

type IntKey = 'init' | 'steps' | 'stepMs' | 'hold';
export interface IntField {
  key: IntKey;
  label: string;
  min: number;
  max: number;
  unit?: string;
  help: string;
}

const n = (v: number) => v.toLocaleString('ja-JP');
const TEXT: Record<IntKey, { label: string; unit?: string; help: (l: Limits) => string }> = {
  init: { label: '初期値', help: (l) => `最初の状態 x₀。範囲内でも、計算の途中で ±${n(l.init.max)} を超えると生成できません。` },
  steps: { label: 'ステップ数', help: () => '状態を進める最大の回数。停止条件があれば、その前に止まります。' },
  stepMs: { label: '1ステップの時間', unit: 'ms', help: () => '短いほど速く進み、閲覧者の負荷も増えます。' },
  hold: { label: '終了時の保持', unit: 'ステップ分', help: () => '最後の状態を見せておく長さ（hold × 1ステップの時間）。' },
};

/** The number fields with the ranges the runtime accepts. */
export const intFields = (l: Limits): IntField[] =>
  (['init', 'steps', 'stepMs', 'hold'] as const).map((key) => ({ key, label: TEXT[key].label, unit: TEXT[key].unit, help: TEXT[key].help(l), ...l[key] }));

const isInt = (v: unknown, lo: number, hi: number): v is number => Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi;

export type FieldErrors = Partial<Record<keyof CardSettings, string>>;

export function validate(s: CardSettings, l: Limits = FALLBACK_SETTINGS.limits): FieldErrors {
  const e: FieldErrors = {};
  for (const f of intFields(l)) {
    if (!isInt(s[f.key], f.min, f.max)) e[f.key] = `${n(f.min)}〜${n(f.max)} の整数で指定してください`;
  }
  const c = l.loops.count;
  if (s.loops !== 'auto' && s.loops !== 'infinite' && !isInt(s.loops, c.min, c.max)) e.loops = `回数は ${n(c.min)}〜${n(c.max)} の整数で指定してください`;
  const a = l.altInits;
  if (s.altInits.length > a.maxItems) e.altInits = `${a.maxItems}個までです`;
  else if (!s.altInits.every((x) => isInt(x, a.min, a.max))) e.altInits = `${n(a.min)}〜${n(a.max)} の整数で指定してください`;
  else if (new Set([s.init, ...s.altInits]).size !== s.altInits.length + 1) e.altInits = '初期値と同じ値や、重複した値は使えません';
  return e;
}

export function settingsFromConfig(c: CardConfig, d: Defaults = FALLBACK_SETTINGS.defaults): CardSettings {
  return {
    title: c.title ?? c.name,
    init: c.init,
    altInits: [...(c.altInits ?? d.altInits)],
    steps: c.steps ?? d.steps,
    stepMs: c.stepMs ?? d.stepMs,
    hold: c.hold ?? d.hold,
    loops: c.loops ?? d.loops,
  };
}

/**
 * The card as it would be saved. A key that was absent stays absent while it equals its default,
 * so saving unchanged settings leaves readme-runtime.json byte-for-byte as it was.
 */
export function toConfigCard(original: CardConfig, s: CardSettings, d: Defaults = FALLBACK_SETTINGS.defaults): CardConfig {
  const next: CardConfig = { ...original };
  const put = <K extends keyof CardConfig>(key: K, value: CardConfig[K], fallback: CardConfig[K]) => {
    if (key in original || JSON.stringify(value) !== JSON.stringify(fallback)) next[key] = value;
  };
  put('title', s.title, original.name);
  next.init = s.init;
  put('altInits', s.altInits, d.altInits);
  put('steps', s.steps, d.steps);
  put('stepMs', s.stepMs, d.stepMs);
  put('hold', s.hold, d.hold);
  put('loops', s.loops, d.loops);
  return next;
}

export const sameSettings = (a: CardSettings | null | undefined, b: CardSettings | null | undefined) =>
  !!a && !!b && JSON.stringify(a) === JSON.stringify(b);

/** "27, 97" -> [27, 97]; NaN for an entry that is not an integer, so validate() reports it. */
export function parseIntList(text: string): number[] {
  return text.split(/[\s,、]+/).filter(Boolean).map((t) => (/^-?\d+$/.test(t) ? Number(t) : Number.NaN));
}
