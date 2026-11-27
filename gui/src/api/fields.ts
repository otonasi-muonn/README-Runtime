// The settings the GUI edits: ranges and defaults as in src/generate.js (d11668f). The CLI stays
// the authority: these checks only catch mistakes before a preview is requested. When #3 returns
// field information from the runtime itself, this table is what it replaces.
import type { CardConfig, CardSettings, Loops } from './types';

export const DEFAULTS = { steps: 120, stepMs: 150, hold: 12, loops: 'auto' as Loops, altInits: [] as number[] };
export const STATE_LIMIT = 999_999;
export const MAX_ALT_INITS = 16;

export interface IntField {
  key: 'init' | 'steps' | 'stepMs' | 'hold';
  label: string;
  min: number;
  max: number;
  unit?: string;
  help: string;
}

export const INT_FIELDS: IntField[] = [
  { key: 'init', label: '初期値', min: -STATE_LIMIT, max: STATE_LIMIT, help: '最初の状態 x₀。範囲内でも、計算の途中で ±999,999 を超えると生成できません。' },
  { key: 'steps', label: 'ステップ数', min: 1, max: 400, help: '状態を進める最大の回数。停止条件があれば、その前に止まります。' },
  { key: 'stepMs', label: '1ステップの時間', min: 16, max: 10000, unit: 'ms', help: '短いほど速く進み、閲覧者の負荷も増えます。' },
  { key: 'hold', label: '終了時の保持', min: 0, max: 1000, unit: 'ステップ分', help: '最後の状態を見せておく長さ（hold × 1ステップの時間）。' },
];

export const LOOP_COUNT = { min: 1, max: 1000 };

const isInt = (v: unknown, lo: number, hi: number): v is number => Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi;

export type FieldErrors = Partial<Record<keyof CardSettings, string>>;

export function validate(s: CardSettings): FieldErrors {
  const e: FieldErrors = {};
  for (const f of INT_FIELDS) {
    if (!isInt(s[f.key], f.min, f.max)) e[f.key] = `${f.min.toLocaleString('ja-JP')}〜${f.max.toLocaleString('ja-JP')} の整数で指定してください`;
  }
  if (s.loops !== 'auto' && s.loops !== 'infinite' && !isInt(s.loops, LOOP_COUNT.min, LOOP_COUNT.max)) {
    e.loops = `回数は ${LOOP_COUNT.min}〜${LOOP_COUNT.max} の整数で指定してください`;
  }
  if (s.altInits.length > MAX_ALT_INITS) e.altInits = `${MAX_ALT_INITS}個までです`;
  else if (!s.altInits.every((x) => isInt(x, -STATE_LIMIT, STATE_LIMIT))) e.altInits = '±999,999 以内の整数で指定してください';
  else if (new Set([s.init, ...s.altInits]).size !== s.altInits.length + 1) e.altInits = '初期値と同じ値や、重複した値は使えません';
  return e;
}

export function settingsFromConfig(c: CardConfig): CardSettings {
  return {
    title: c.title ?? c.name,
    init: c.init,
    altInits: [...(c.altInits ?? DEFAULTS.altInits)],
    steps: c.steps ?? DEFAULTS.steps,
    stepMs: c.stepMs ?? DEFAULTS.stepMs,
    hold: c.hold ?? DEFAULTS.hold,
    loops: c.loops ?? DEFAULTS.loops,
  };
}

/**
 * The card as it would be saved. A key that was absent stays absent while it equals its default,
 * so saving unchanged settings leaves readme-runtime.json byte-for-byte as it was.
 */
export function toConfigCard(original: CardConfig, s: CardSettings): CardConfig {
  const next: CardConfig = { ...original };
  const put = <K extends keyof CardConfig>(key: K, value: CardConfig[K], fallback: CardConfig[K]) => {
    if (key in original || JSON.stringify(value) !== JSON.stringify(fallback)) next[key] = value;
  };
  put('title', s.title, original.name);
  next.init = s.init;
  put('altInits', s.altInits, DEFAULTS.altInits);
  put('steps', s.steps, DEFAULTS.steps);
  put('stepMs', s.stepMs, DEFAULTS.stepMs);
  put('hold', s.hold, DEFAULTS.hold);
  put('loops', s.loops, DEFAULTS.loops);
  return next;
}

export const sameSettings = (a: CardSettings | null | undefined, b: CardSettings | null | undefined) =>
  !!a && !!b && JSON.stringify(a) === JSON.stringify(b);

/** "27, 97" -> [27, 97]; NaN for an entry that is not an integer, so validate() reports it. */
export function parseIntList(text: string): number[] {
  return text.split(/[\s,、]+/).filter(Boolean).map((t) => (/^-?\d+$/.test(t) ? Number(t) : Number.NaN));
}
