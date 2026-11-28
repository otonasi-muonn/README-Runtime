<script setup lang="ts">
import { computed } from 'vue';
import { END_LABELS, FIX_LABELS, labelFor } from '../api/labels';
import PerfBars from './PerfBars.vue';
import PerfTimeline from './PerfTimeline.vue';
import type { PerfReport } from '../api/types';
import { useSessionContext } from '../composables/useSession';

const s = useSessionContext();
const result = computed(() => s.preview?.card ?? null);
const kb = (n: number) => `${(n / 1024).toFixed(1)} KB`;
const fixText = (fix: Record<string, unknown>) => Object.entries(fix).map(([k, v]) => FIX_LABELS[k]?.(v) ?? `${k}: ${JSON.stringify(v)}`).join('、');
// where each figure comes from, as the connected runtime reports it (none is measured in a browser)
const tag = (k: keyof PerfReport) => ({ settings: '設定から', file: 'ファイルから' })[s.capabilities?.perf.sources[k] ?? 'settings'] ?? '';
const notMeasured = computed(() => (s.capabilities?.perf.notMeasured ?? ['閲覧者の CPU 使用率', 'メモリ']).join('・'));
const fromFile = computed(() => s.preview?.source === 'preview' && !s.preview.reflectsSettings);
const source = computed(() => (s.preview?.source === 'saved' ? '保存済みの SVG' : `プレビュー #${s.preview?.generation}`));
</script>

<template>
  <section class="results">
    <div v-if="s.attempt?.status === 'error' && s.attempt.error" class="box error" role="alert">
      <p class="head">{{ s.attempt.kind === 'save' ? '保存できませんでした' : 'プレビューを生成できませんでした' }}</p>
      <p class="title">{{ labelFor(s.attempt.error.code) }} <code class="code">{{ s.attempt.error.code }}</code></p>
      <p class="msg">{{ s.attempt.error.message }}</p>
      <p v-if="s.attempt.error.hint" class="hint"><strong>対処</strong> {{ s.attempt.error.hint }}</p>
      <p v-if="s.preview" class="keep">直前に成功した{{ source }}を表示したままです。下の結果もそのときのものです。</p>
    </div>
    <div v-else-if="s.attempt?.status === 'ok'" class="box ok">
      {{ s.attempt.kind === 'save' ? (s.project?.mode === 'mock' ? '✓ 保存しました（モック: ファイルには書き込んでいません）' : `✓ 保存しました（readme-runtime.json を更新し、build で ${s.card?.lastBuild?.out ?? 'SVG'} を${s.card?.lastBuild?.card === 'unchanged' ? '作り直しました（内容は同じ）' : '書き出しました'}）`) : '✓ プレビューを生成しました' }}
    </div>

    <template v-if="result">
      <h3 class="section-title">{{ source }}の結果</h3>
      <p v-if="result.end" class="end">{{ END_LABELS[result.end.kind]?.(result.end.at) ?? result.end.kind }}</p>
      <p v-if="result.summary" class="summary">{{ result.summary }}</p>

      <template v-if="result.warnings?.length">
        <h3 class="section-title">警告</h3>
        <div class="warnings">
          <div v-for="w in result.warnings" :key="w.code" class="box warn">
            <p class="title">{{ labelFor(w.code) }} <code class="code">{{ w.code }}</code></p>
            <p class="msg">{{ w.message }}</p>
            <button type="button" @click="s.applyFix(w.fix)">→ {{ fixText(w.fix) }}</button>
          </div>
        </div>
      </template>

      <h3 class="section-title">再生の流れ（ページを開いてから）</h3>
      <PerfTimeline v-if="s.preview" :perf="result.perf" :end="result.end" :step-ms="s.preview.settings.stepMs" :hold="s.preview.settings.hold" />

      <h3 class="section-title">閲覧者への負荷の目安</h3>
      <PerfBars :perf="result.perf" />
      <dl class="perf">
        <div><dt>状態の更新頻度<span v-if="tag('updatesPerSecond')" class="tag">{{ tag('updatesPerSecond') }}</span></dt><dd>{{ result.perf.updatesPerSecond }} 回/秒</dd><p>1ステップの時間から計算した値です。画面の描画 FPS ではありません。</p></div>
        <div><dt>1周の長さ<span v-if="tag('loopSeconds')" class="tag">{{ tag('loopSeconds') }}</span></dt><dd>{{ result.perf.loopSeconds }} 秒</dd><p>保持の時間を含みます。</p></div>
        <div><dt>再生回数<span v-if="tag('loops')" class="tag">{{ tag('loops') }}</span></dt><dd>{{ result.perf.loops === 'infinite' ? '止まらない' : `${result.perf.loops} 回` }}</dd></div>
        <div><dt>再生が続く時間<span v-if="tag('activeSeconds')" class="tag">{{ tag('activeSeconds') }}</span></dt><dd>{{ result.perf.activeSeconds === null ? '表示中ずっと' : `約 ${result.perf.activeSeconds} 秒` }}</dd><p>ページを開いてから数えます。止まった後は CPU を使いません。</p></div>
        <div><dt>表示部分の要素数<span v-if="tag('displayElements')" class="tag">{{ tag('displayElements') }}</span></dt><dd>{{ result.perf.displayElements }}</dd><p>毎ステップ描き直す量の目安です。<template v-if="fromFile">モック: 保存済みの SVG の値。</template></p></div>
        <div><dt>@container ルール数<span v-if="tag('containerRules')" class="tag">{{ tag('containerRules') }}</span></dt><dd>{{ result.perf.containerRules }}</dd><p>切り替える部分の数です。毎ステップ評価されます。</p></div>
        <div><dt>ファイルサイズ<span v-if="tag('bytes')" class="tag">{{ tag('bytes') }}</span></dt><dd>{{ kb(result.perf.bytes) }}<small>gzip {{ kb(result.perf.gzipBytes) }}</small></dd><p v-if="fromFile">モック: 保存済みの SVG の値。</p></div>
      </dl>
      <p class="cpu">{{ notMeasured }}は、この画面でも API でも計測していません。手元の1台での実測は <code>bench/README.md</code> にあります。</p>
    </template>
  </section>
</template>

<style scoped>
.results { display: flex; flex-direction: column; gap: 8px; }
.section-title { padding: 10px 0 0; }
.box { border: 1px solid var(--border); border-left-width: 3px; border-radius: var(--radius); padding: 9px 11px; font-size: 12px; }
.box p { margin: 0 0 4px; }
.box p:last-child { margin-bottom: 0; }
.box .head { font-size: 11px; color: var(--muted); }
.box .title { font-weight: 600; }
.code { font-size: 10px; color: var(--muted); }
.box .msg { font-family: var(--mono); font-size: 11px; color: var(--muted); overflow-wrap: anywhere; line-height: 1.5; }
.box .hint { font-size: 11px; }
.box .hint strong { color: var(--muted); font-weight: 600; margin-right: 4px; }
.box .keep { font-size: 11px; color: var(--faint); }
.box.error { border-color: var(--danger); background: var(--danger-soft); }
.box.error .head { color: var(--danger); }
.box.ok { border-color: var(--ok); background: var(--ok-soft); color: var(--ok); }
.box.warn { border-color: var(--warn); background: var(--warn-soft); }
.box.warn .title { color: var(--warn); }
.box.warn button { margin-top: 6px; }
.warnings { display: flex; flex-direction: column; gap: 8px; }
.end { margin: 0; font-weight: 600; }
.summary { margin: 0; font-size: 11px; color: var(--faint); }
.perf { margin: 0; display: flex; flex-direction: column; border: 1px solid var(--border); border-radius: var(--radius); }
.perf > div { display: grid; grid-template-columns: 1fr auto; gap: 2px 10px; padding: 7px 10px; }
.perf > div + div { border-top: 1px solid var(--border); }
.perf dt { color: var(--muted); font-size: 12px; }
.perf .tag { margin-left: 6px; font-size: 10px; color: var(--faint); border: 1px solid var(--border); border-radius: 3px; padding: 0 4px; }
.perf dd { margin: 0; font-family: var(--mono); font-size: 12px; text-align: right; font-variant-numeric: tabular-nums; }
.perf dd small { display: block; color: var(--faint); font-size: 10px; }
.perf p { grid-column: 1 / -1; margin: 0; font-size: 11px; color: var(--faint); }
.cpu { margin: 4px 0 0; font-size: 11px; color: var(--faint); }
</style>
