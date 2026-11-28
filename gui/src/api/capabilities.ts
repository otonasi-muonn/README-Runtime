// The parts of the capabilities that do not depend on a runtime build: the features this GUI knows
// about and where perf figures come from. The connection API (server/runtimeApi.ts) adds the
// ranges and defaults it reads from the runtime; the mock uses the GUI's own table (fields.ts).
import type { Capabilities } from './types';

/** The connection API version this GUI is written for. */
export const API_VERSION = 1;

/**
 * Features the runtime does not have yet. Each is an open issue whose settings are not decided, so
 * the GUI shows them disabled with the reason instead of inventing keys for them (#2 review).
 * When a runtime version adds one, it reports it with available: true and the keys it accepts.
 */
export const FEATURES: Capabilities['features'] = [
  { key: 'design', label: 'デザイン設定（配色・枠・余白）', available: false, issue: 1, reason: '設定キーがまだありません' },
  { key: 'interpolation', label: '滑らかな補間', available: false, issue: 4, reason: '方式を検証中です' },
  { key: 'multiState', label: '複数の状態', available: false, issue: 6, reason: '状態の型（ABI）を検討中です' },
  { key: 'layout', label: 'カードの寸法・縦横比', available: false, issue: 11, reason: '設定の形が決まっていません' },
  { key: 'binding', label: '明示的なバインディング', available: false, issue: 12, reason: '設計中です' },
];

/** src/perf.js perfReport(): counts from the settings, sizes and element counts from the SVG. */
export const PERF_SOURCES: Capabilities['perf'] = {
  sources: {
    updatesPerSecond: 'settings',
    loopSeconds: 'settings',
    loops: 'settings',
    activeSeconds: 'settings',
    steps: 'settings',
    displayElements: 'file',
    containerRules: 'file',
    bytes: 'file',
    gzipBytes: 'file',
  },
  notMeasured: ['閲覧者の CPU 使用率', 'メモリ', '描画のフレームレート'],
};
