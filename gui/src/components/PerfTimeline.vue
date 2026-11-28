<script setup lang="ts">
// How the card plays over time, from its settings and perf report: in each run the state moves
// until the run ends (all steps, or a halt / trap / range stop), then the last state stays until
// the run's clock is over (the rest of the steps plus hold). After the last run the card rests.
// Seconds count from page load (browsers keep the clock running while the card is off screen).
//
// Times come from the settings, as src/perf.js computes them ((steps + hold + 1) * stepMs), not
// from perf.loopSeconds: that is rounded to 0.1 s for display and is 0 for the shortest runs.
import { computed } from 'vue';
import type { PerfReport, RunEnd } from '../api/types';

const props = defineProps<{ perf: PerfReport; end?: RunEnd; stepMs: number; hold: number }>();

const loopS = computed(() => ((props.perf.steps + props.hold + 1) * props.stepMs) / 1000);
const moveS = computed(() => Math.min(loopS.value, ((props.end?.at ?? props.perf.steps) * props.stepMs) / 1000));
const infinite = computed(() => props.perf.loops === 'infinite');
const loops = computed(() => (infinite.value ? Infinity : (props.perf.loops as number)));
const activeS = computed(() => loopS.value * loops.value);
// the window shown: a minute for an endless card, otherwise the playing time and a bit of rest
const windowS = computed(() => (infinite.value ? Math.max(60, loopS.value * 2) : Math.max(activeS.value * 1.15, loopS.value * 1.2, 10)));
// runs too short to draw one by one are drawn as one band
const MAX_RUNS = 200;
const dense = computed(() => !(loopS.value > 0) || windowS.value / loopS.value > MAX_RUNS);
const runs = computed(() => {
  if (dense.value) return [];
  const n = Math.min(loops.value, Math.ceil(windowS.value / loopS.value));
  return Array.from({ length: n }, (_, i) => i * loopS.value);
});
const playedS = computed(() => Math.min(activeS.value, windowS.value));
const pct = (s: number) => `${Math.max(0, Math.min(100, (s / windowS.value) * 100))}%`;
const ticks = computed(() => {
  const step = [5, 10, 15, 30, 60, 120, 300].find((t) => windowS.value / t <= 6) ?? 600;
  return Array.from({ length: Math.floor(windowS.value / step) + 1 }, (_, i) => i * step);
});
const secs = (s: number) => (s >= 10 ? s.toFixed(1) : s >= 1 ? s.toFixed(2) : String(Number(s.toFixed(3))));
</script>

<template>
  <figure class="timeline">
    <div class="track" role="img" :aria-label="infinite ? '再生が止まらない' : `約 ${secs(activeS)} 秒で止まる`">
      <span v-if="dense" class="move dense" :style="{ left: '0%', width: pct(playedS) }" />
      <template v-for="t in runs" v-else :key="t">
        <span class="move" :style="{ left: pct(t), width: `calc(${pct(Math.min(moveS, windowS - t))} - 1px)` }" />
        <span v-if="moveS < loopS" class="still" :style="{ left: pct(t + moveS), width: `calc(${pct(Math.min(loopS - moveS, windowS - t - moveS))} - 1px)` }" />
      </template>
      <span v-if="!infinite" class="rest" :style="{ left: pct(activeS), width: pct(windowS - activeS) }" />
    </div>
    <div class="axis">
      <span v-for="t in ticks" :key="t" :style="{ left: pct(t) }">{{ t }}s</span>
    </div>
    <figcaption>
      <span class="key"><i class="move" />状態が動く</span>
      <span v-if="!dense" class="key"><i class="still" />最後の状態で保持</span>
      <span v-if="!infinite" class="key"><i class="rest" />停止（CPU を使わない）</span>
      <span class="what">{{ (infinite ? `1周 ${secs(loopS)} 秒をくり返し、表示中は止まりません` : `${perf.loops} 周（1周 ${secs(loopS)} 秒）、約 ${secs(activeS)} 秒で止まります`) + (dense ? '。1周が短いため、1周ずつは描いていません' : '') }}</span>
    </figcaption>
  </figure>
</template>

<style scoped>
.timeline { margin: 0; display: flex; flex-direction: column; gap: 4px; }
.track { position: relative; height: 18px; border-radius: 4px; background: var(--input-bg); border: 1px solid var(--border); overflow: hidden; }
.track span { position: absolute; top: 2px; bottom: 2px; border-radius: 2px; }
.move { background: var(--accent); }
.move.dense { background: repeating-linear-gradient(90deg, var(--accent) 0 3px, var(--accent-soft) 3px 4px); }
.still { background: var(--accent-soft); box-shadow: inset 0 0 0 1px var(--accent); }
.rest { background: repeating-linear-gradient(135deg, transparent 0 4px, var(--border) 4px 6px); }
.axis { position: relative; height: 14px; font-size: 10px; color: var(--faint); font-family: var(--mono); }
.axis span { position: absolute; transform: translateX(-50%); }
.axis span:first-child { transform: none; }
figcaption { display: flex; flex-wrap: wrap; gap: 4px 10px; font-size: 11px; color: var(--muted); }
.key { display: inline-flex; align-items: center; gap: 4px; }
.key i { width: 10px; height: 8px; border-radius: 2px; display: inline-block; }
.what { flex-basis: 100%; color: var(--text); }
</style>
