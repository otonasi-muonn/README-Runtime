<script setup lang="ts">
// Saved settings and their last build, next to the last successful preview. The draft is not
// compared: a comparison is only meaningful between two results that exist.
import { computed } from 'vue';
import { settingsFromConfig } from '../api/fields';
import { END_LABELS, labelFor } from '../api/labels';
import type { BuildCardResult, CardSettings, Loops, PerfReport } from '../api/types';
import { useSessionContext } from '../composables/useSession';
import PerfTimeline from './PerfTimeline.vue';

const s = useSessionContext();
const saved = computed(() => (s.card ? { settings: settingsFromConfig(s.card.config), card: s.card.lastBuild } : null));
const preview = computed(() => (s.preview?.source === 'preview' ? { settings: s.preview.settings, card: s.preview.card } : null));

const loopsText = (l: Loops | number | 'infinite') => (l === 'auto' ? '自動' : l === 'infinite' ? '無限' : `${l} 回`);
const SETTING_ROWS: { key: keyof CardSettings; label: string; fmt?: (v: never) => string }[] = [
  { key: 'title', label: 'タイトル' },
  { key: 'init', label: '初期値' },
  { key: 'altInits', label: 'ほかの初期値', fmt: (v: number[]) => (v.length ? v.join(', ') : 'なし') },
  { key: 'steps', label: 'ステップ数' },
  { key: 'stepMs', label: '1ステップの時間', fmt: (v: number) => `${v} ms` },
  { key: 'hold', label: '終了時の保持' },
  { key: 'loops', label: 'ループ', fmt: (v: Loops) => loopsText(v) },
];
const settingRows = computed(() => {
  if (!saved.value || !preview.value) return [];
  return SETTING_ROWS.map((r) => {
    const fmt = (v: unknown) => (r.fmt ? (r.fmt as (x: unknown) => string)(v) : String(v));
    const a = saved.value!.settings[r.key], b = preview.value!.settings[r.key];
    return { label: r.label, a: fmt(a), b: fmt(b), changed: JSON.stringify(a) !== JSON.stringify(b) };
  });
});

const kb = (n: number) => `${(n / 1024).toFixed(1)} KB`;
type PerfRow = { label: string; get: (p: PerfReport, c: BuildCardResult) => number | null; fmt: (v: number | null) => string; lowerIsLighter: boolean | null };
const PERF_ROWS: PerfRow[] = [
  { label: '状態の更新頻度', get: (p) => p.updatesPerSecond, fmt: (v) => `${v} 回/秒`, lowerIsLighter: true },
  { label: '1周の長さ', get: (p) => p.loopSeconds, fmt: (v) => `${v} 秒`, lowerIsLighter: null },
  { label: '再生が続く時間', get: (p) => p.activeSeconds, fmt: (v) => (v === null ? '表示中ずっと' : `約 ${v} 秒`), lowerIsLighter: true },
  { label: '表示部分の要素数', get: (p) => p.displayElements, fmt: (v) => String(v), lowerIsLighter: true },
  { label: 'ファイルサイズ（gzip）', get: (p) => p.gzipBytes, fmt: (v) => kb(v ?? 0), lowerIsLighter: true },
];
const perfRows = computed(() => {
  const a = saved.value?.card, b = preview.value?.card;
  if (!a || !b) return [];
  return PERF_ROWS.map((r) => {
    const x = r.get(a.perf, a), y = r.get(b.perf, b);
    // null (keeps playing) counts as the heaviest
    const n = (v: number | null) => (v === null ? Infinity : v);
    const dir = n(x) === n(y) || r.lowerIsLighter === null ? 0 : (n(y) < n(x)) === r.lowerIsLighter ? -1 : 1;
    return { label: r.label, a: r.fmt(x), b: r.fmt(y), dir };
  });
});
const endText = (c: BuildCardResult | null | undefined) => (c?.end ? END_LABELS[c.end.kind]?.(c.end.at) ?? c.end.kind : '—');

const warningDiff = computed(() => {
  const a = new Set((saved.value?.card?.warnings ?? []).map((w) => w.code));
  const b = new Set((preview.value?.card?.warnings ?? []).map((w) => w.code));
  return {
    added: [...b].filter((c) => !a.has(c)),
    removed: [...a].filter((c) => !b.has(c)),
    kept: [...b].filter((c) => a.has(c)),
  };
});
</script>

<template>
  <section class="compare">
    <p v-if="!preview" class="empty">
      プレビューを生成すると、保存済みの設定と比べられます。
    </p>
    <template v-else>
      <p class="lead">
        保存済み と <strong>プレビュー #{{ s.preview?.generation }}</strong> の比較
        <span v-if="!s.previewIsCurrent" class="stale">（編集中の設定ではなく、最後に成功したプレビューと比べています）</span>
      </p>

      <h3 class="section-title">設定</h3>
      <table class="diff">
        <thead><tr><th /><th>保存済み</th><th>プレビュー</th></tr></thead>
        <tbody>
          <tr v-for="r in settingRows" :key="r.label" :class="{ changed: r.changed }">
            <th>{{ r.label }}</th><td>{{ r.a }}</td><td>{{ r.b }}</td>
          </tr>
        </tbody>
      </table>
      <p v-if="!settingRows.some((r) => r.changed)" class="note">設定は同じです。</p>

      <h3 class="section-title">結果と負荷の目安</h3>
      <table class="diff">
        <thead><tr><th /><th>保存済み</th><th>プレビュー</th></tr></thead>
        <tbody>
          <tr><th>実行</th><td>{{ endText(saved?.card) }}</td><td>{{ endText(preview.card) }}</td></tr>
          <tr v-for="r in perfRows" :key="r.label" :class="{ lighter: r.dir < 0, heavier: r.dir > 0 }">
            <th>{{ r.label }}</th><td>{{ r.a }}</td><td>{{ r.b }}<span v-if="r.dir" class="arrow">{{ r.dir < 0 ? '↓' : '↑' }}</span></td>
          </tr>
        </tbody>
      </table>
      <p class="note">↓ は閲覧者の負荷が軽くなる向き、↑ は重くなる向きです。<template v-if="!s.preview?.reflectsSettings">モックでは、要素数とファイルサイズは両方とも保存済みの SVG の値です。</template></p>

      <h3 class="section-title">警告</h3>
      <ul class="warnings">
        <li v-for="c in warningDiff.added" :key="`a${c}`" class="added">＋ {{ labelFor(c) }} <code>{{ c }}</code></li>
        <li v-for="c in warningDiff.removed" :key="`r${c}`" class="removed">− {{ labelFor(c) }} <code>{{ c }}</code></li>
        <li v-for="c in warningDiff.kept" :key="`k${c}`" class="kept">＝ {{ labelFor(c) }} <code>{{ c }}</code></li>
        <li v-if="!warningDiff.added.length && !warningDiff.removed.length && !warningDiff.kept.length" class="kept">どちらも警告はありません。</li>
      </ul>

      <h3 class="section-title">再生の流れ</h3>
      <div class="timelines">
        <div v-if="saved?.card">
          <p class="tl-label">保存済み</p>
          <PerfTimeline :perf="saved.card.perf" :end="saved.card.end" :step-ms="saved.settings.stepMs" :hold="saved.settings.hold" />
        </div>
        <div v-if="preview.card">
          <p class="tl-label">プレビュー #{{ s.preview?.generation }}</p>
          <PerfTimeline :perf="preview.card.perf" :end="preview.card.end" :step-ms="preview.settings.stepMs" :hold="preview.settings.hold" />
        </div>
      </div>
      <p class="note">時間の目盛りは、それぞれの長さに合わせています。</p>
    </template>
  </section>
</template>

<style scoped>
.compare { display: flex; flex-direction: column; gap: 8px; font-size: 12px; }
.empty { margin: 0; color: var(--muted); }
.lead { margin: 0; }
.stale { color: var(--warn); font-size: 11px; }
.section-title { padding: 10px 0 0; }
.diff { width: 100%; border-collapse: collapse; border: 1px solid var(--border); border-radius: var(--radius); }
.diff th, .diff td { text-align: left; padding: 5px 8px; border-bottom: 1px solid var(--border); vertical-align: top; overflow-wrap: anywhere; }
.diff thead th { font-size: 10px; font-weight: 600; color: var(--faint); text-transform: uppercase; letter-spacing: 0.05em; }
.diff tbody th { font-weight: 400; color: var(--muted); white-space: nowrap; }
.diff td { font-size: 12px; font-variant-numeric: tabular-nums; }
.diff tr.changed td:last-child { color: var(--accent); background: var(--accent-soft); }
.diff tr.changed td:nth-child(2) { color: var(--faint); text-decoration: line-through; }
.diff tr.lighter td:last-child { color: var(--ok); }
.diff tr.heavier td:last-child { color: var(--warn); }
.arrow { margin-left: 4px; }
.note { margin: 0; font-size: 11px; color: var(--faint); }
.warnings { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.warnings code { font-size: 10px; color: var(--faint); }
.added { color: var(--warn); }
.removed { color: var(--ok); }
.kept { color: var(--muted); }
.timelines { display: flex; flex-direction: column; gap: 10px; }
.tl-label { margin: 0 0 2px; font-size: 11px; color: var(--muted); }
</style>
