<script setup lang="ts">
// Each figure of the perf report against the threshold of its PERF_* warning (src/perf.js).
// The bar fills to the threshold line at 2/3 of the track; beyond it the bar turns amber.
import { computed } from 'vue';
import { PERF_LIMITS } from '../api/perfLimits';
import type { PerfReport } from '../api/types';

const props = defineProps<{ perf: PerfReport }>();
const SCALE = 1.5; // the track holds 1.5x the threshold

const rows = computed(() => [
  { key: 'rate', label: '更新頻度', value: props.perf.updatesPerSecond, limit: 1000 / PERF_LIMITS.minStepMs, unit: '回/秒', code: 'PERF_FAST_CLOCK' },
  { key: 'steps', label: 'ステップ数', value: props.perf.steps, limit: PERF_LIMITS.longRun, unit: '', code: 'PERF_LONG_RUN' },
  { key: 'elements', label: '表示部分の要素数', value: props.perf.displayElements, limit: PERF_LIMITS.displayElements, unit: '', code: 'PERF_LARGE_DISPLAY' },
  { key: 'rules', label: '@container ルール数', value: props.perf.containerRules, limit: PERF_LIMITS.containerRules, unit: '', code: 'PERF_LARGE_DISPLAY' },
].map((r) => ({ ...r, over: r.value > r.limit, fill: `${Math.min(1, r.value / r.limit / SCALE) * 100}%` })));
const mark = `${(1 / SCALE) * 100}%`;
</script>

<template>
  <ul class="bars">
    <li v-for="r in rows" :key="r.key" :class="{ over: r.over }">
      <span class="label">{{ r.label }}</span>
      <span class="value">{{ r.value }}<small v-if="r.unit"> {{ r.unit }}</small></span>
      <span class="track" :title="`${r.code} が出る目安: ${r.limit}${r.unit} を超えたとき`">
        <span class="fill" :style="{ width: r.fill }" />
        <span class="mark" :style="{ left: mark }" />
      </span>
      <span class="limit">目安 {{ r.limit }}</span>
    </li>
  </ul>
  <p class="note">縦線は警告が出る目安です（bench/ の1台での経験則で、保証値ではありません）。</p>
</template>

<style scoped>
.bars { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.bars li { display: grid; grid-template-columns: 1fr auto; grid-template-areas: 'label value' 'track track' 'limit limit'; gap: 2px 8px; }
.label { grid-area: label; font-size: 12px; color: var(--muted); }
.value { grid-area: value; font-family: var(--mono); font-size: 12px; font-variant-numeric: tabular-nums; }
.value small { color: var(--faint); font-size: 10px; }
.track { grid-area: track; position: relative; height: 6px; border-radius: 3px; background: var(--input-bg); border: 1px solid var(--border); }
.fill { position: absolute; inset: 0 auto 0 0; border-radius: 3px; background: var(--ok); }
.over .fill { background: var(--warn); }
.over .value { color: var(--warn); }
.mark { position: absolute; top: -3px; bottom: -3px; width: 1px; background: var(--muted); }
.limit { grid-area: limit; justify-self: end; font-size: 10px; color: var(--faint); font-family: var(--mono); }
.note { margin: 6px 0 0; font-size: 11px; color: var(--faint); }
</style>
