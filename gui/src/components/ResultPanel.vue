<script setup lang="ts">
import { computed } from 'vue';
import { END_LABELS, FIX_LABELS, labelFor } from '../api/labels';
import { useSessionContext } from '../composables/useSession';

const s = useSessionContext();
const result = computed(() => s.preview?.card ?? null);
const kb = (n: number) => `${(n / 1024).toFixed(1)} KB`;
const fixText = (fix: Record<string, unknown>) => Object.entries(fix).map(([k, v]) => FIX_LABELS[k]?.(v) ?? `${k}: ${JSON.stringify(v)}`).join('、');
const fromFile = computed(() => s.preview?.source === 'preview' && !s.preview.reflectsSettings);
</script>

<template>
  <section class="results">
    <div v-if="s.attempt?.status === 'error' && s.attempt.error" class="box error" role="alert">
      <p class="head">
        {{ s.attempt.kind === 'save' ? '保存できませんでした' : 'プレビューを生成できませんでした' }}:
        {{ labelFor(s.attempt.error.code) }} <code>{{ s.attempt.error.code }}</code>
      </p>
      <p class="msg">{{ s.attempt.error.message }}</p>
      <p v-if="s.attempt.error.hint" class="hint">対処: {{ s.attempt.error.hint }}</p>
      <p v-if="s.preview" class="keep">直前に成功した{{ s.preview.source === 'saved' ? '保存済みの SVG' : `プレビュー #${s.preview.generation}` }}を表示したままにしています。</p>
    </div>
    <div v-else-if="s.attempt?.status === 'ok'" class="box ok">
      {{ s.attempt.kind === 'save' ? (s.project?.mode === 'mock' ? '保存しました（モック: ファイルには書き込んでいません）。' : '保存しました。') : 'プレビューを生成しました。' }}
    </div>

    <template v-if="result">
      <h3>{{ s.preview?.source === 'saved' ? '保存済みの SVG の結果' : `プレビュー #${s.preview?.generation} の結果` }}</h3>
      <p v-if="result.end" class="end">{{ END_LABELS[result.end.kind]?.(result.end.at) ?? result.end.kind }}<span v-if="result.summary" class="summary"> · {{ result.summary }}</span></p>

      <div v-if="result.warnings?.length" class="warnings">
        <h3>警告</h3>
        <div v-for="w in result.warnings" :key="w.code" class="box warn">
          <p class="head">{{ labelFor(w.code) }} <code>{{ w.code }}</code></p>
          <p class="msg">{{ w.message }}</p>
          <button type="button" @click="s.applyFix(w.fix)">{{ fixText(w.fix) }}</button>
        </div>
      </div>

      <h3>閲覧者への負荷の目安</h3>
      <table class="perf">
        <tbody>
          <tr><th>状態の更新頻度</th><td>{{ result.perf.updatesPerSecond }} 回/秒</td><td class="note">1ステップの時間から計算した値です。画面の描画 FPS ではありません。</td></tr>
          <tr><th>1周の長さ</th><td>{{ result.perf.loopSeconds }} 秒</td><td class="note">保持の時間を含みます。</td></tr>
          <tr><th>再生回数</th><td>{{ result.perf.loops === 'infinite' ? '止まらない' : `${result.perf.loops} 回` }}</td><td class="note"></td></tr>
          <tr><th>再生が続く時間</th><td>{{ result.perf.activeSeconds === null ? '表示中ずっと' : `約 ${result.perf.activeSeconds} 秒` }}</td><td class="note">ページを開いてから数えます。止まった後は CPU を使いません。</td></tr>
          <tr><th>表示部分の要素数</th><td>{{ result.perf.displayElements }}</td><td class="note">毎ステップ描き直す量の目安です。<template v-if="fromFile">（モック: 保存済みの SVG の値）</template></td></tr>
          <tr><th>@container ルール数</th><td>{{ result.perf.containerRules }}</td><td class="note">切り替える部分の数です。毎ステップ評価されます。</td></tr>
          <tr><th>ファイルサイズ</th><td>{{ kb(result.perf.bytes) }}（gzip {{ kb(result.perf.gzipBytes) }}）</td><td class="note"><template v-if="fromFile">モック: 保存済みの SVG の値</template></td></tr>
        </tbody>
      </table>
      <p class="cpu">閲覧者の CPU 使用率とメモリは、この画面では計測していません。手元の1台での実測は <code>bench/README.md</code> にあります。</p>
    </template>
  </section>
</template>

<style scoped>
.results { display: flex; flex-direction: column; gap: 10px; font-size: 13px; }
h3 { margin: 6px 0 0; font-size: 13px; }
.box { border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; }
.box p { margin: 0 0 4px; }
.box .head { font-weight: 600; }
.box .msg { font-family: var(--mono); font-size: 12px; overflow-wrap: anywhere; }
.box .hint, .box .keep { font-size: 12px; color: var(--muted); }
.box.error { border-color: var(--danger); background: var(--danger-soft); }
.box.ok { border-color: var(--ok); background: var(--ok-soft); }
.box.warn { border-color: var(--warn); background: var(--warn-soft); }
.box.warn button { margin-top: 4px; font-size: 12px; }
.warnings { display: flex; flex-direction: column; gap: 8px; }
.end { margin: 0; }
.summary { color: var(--muted); font-size: 12px; }
.perf { border-collapse: collapse; width: 100%; }
.perf th, .perf td { text-align: left; padding: 5px 8px; border-bottom: 1px solid var(--border); vertical-align: top; }
.perf th { font-weight: 500; white-space: nowrap; color: var(--muted); }
.perf td:nth-child(2) { white-space: nowrap; font-variant-numeric: tabular-nums; }
.perf .note { font-size: 12px; color: var(--muted); }
@media (max-width: 640px) {
  .perf tr { display: grid; grid-template-columns: auto 1fr; border-bottom: 1px solid var(--border); }
  .perf th, .perf td { border-bottom: 0; }
  .perf .note { grid-column: 1 / -1; padding-top: 0; }
  .perf .note:empty { display: none; }
}
.cpu { margin: 0; font-size: 12px; color: var(--muted); }
</style>
