<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useSessionContext } from '../composables/useSession';

const s = useSessionContext();

// Background and width only change how this page shows the image. They do not change the SVG:
// its size is fixed at generation (#11), and its own colors do not follow a dark page (the
// light/dark switch of GitHub is not prefers-color-scheme inside the image).
const BACKGROUNDS = [
  { key: 'light', label: 'ライト', color: '#ffffff' },
  { key: 'dark', label: 'ダーク', color: '#0d1117' },
] as const;
const WIDTHS = [
  { key: 'natural', label: '原寸', px: null },
  { key: 'readme', label: 'README 幅（830px）', px: 830 },
  { key: 'narrow', label: 'スマホ幅（360px）', px: 360 },
] as const;
const bg = ref<(typeof BACKGROUNDS)[number]['key']>('light');
const width = ref<(typeof WIDTHS)[number]['key']>('readme');
const bgColor = computed(() => BACKGROUNDS.find((b) => b.key === bg.value)!.color);
const maxWidth = computed(() => WIDTHS.find((w) => w.key === width.value)!.px);

// Which initial value the image starts from: the card's own, or one of the values the
// previewed SVG answers to (#x<value>). The query differs per value as well: WebKit shares one
// document between images of the same URL.
const startFrom = ref<number | null>(null);
watch(() => [s.selected, s.preview?.generation], () => { startFrom.value = null; });
const inits = computed(() => (s.preview ? [s.preview.settings.init, ...s.preview.svgAltInits.filter((x) => x !== s.preview!.settings.init)] : []));

const src = computed(() => {
  const p = s.preview;
  if (!p || !p.svgUrl || !s.selected) return '';
  const params = new URLSearchParams({ v: `${p.generation}-${s.replays[s.selected] ?? 0}` });
  const alt = startFrom.value !== null && startFrom.value !== p.settings.init ? startFrom.value : null;
  if (alt !== null) params.set('seed', String(alt));
  return `${p.svgUrl}${p.svgUrl.includes('?') ? '&' : '?'}${params}${alt !== null ? `#x${alt}` : ''}`;
});

// The card follows the viewer's reduce-motion setting: it shows its last step, still.
const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
const reducedMotion = ref(mq.matches);
const onChange = () => { reducedMotion.value = mq.matches; };
mq.addEventListener('change', onChange);
onBeforeUnmount(() => mq.removeEventListener('change', onChange));
</script>

<template>
  <section class="preview">
    <div class="toolbar">
      <div class="group" role="group" aria-label="背景">
        <button v-for="b in BACKGROUNDS" :key="b.key" type="button" class="seg" :aria-pressed="bg === b.key" @click="bg = b.key">{{ b.label }}</button>
      </div>
      <div class="group" role="group" aria-label="表示幅">
        <button v-for="w in WIDTHS" :key="w.key" type="button" class="seg" :aria-pressed="width === w.key" @click="width = w.key">{{ w.label }}</button>
      </div>
      <label v-if="inits.length > 1" class="start">
        開始値
        <select :value="startFrom ?? inits[0]" @change="startFrom = Number(($event.target as HTMLSelectElement).value)">
          <option v-for="x in inits" :key="x" :value="x">{{ x }}{{ x === inits[0] ? '（初期値）' : '' }}</option>
        </select>
      </label>
      <button type="button" class="replay" @click="s.replay()">最初から再生</button>
    </div>

    <div class="stage" :style="{ background: bgColor }">
      <img v-if="src" :key="src" :src="src" :alt="s.preview?.settings.title" :style="{ maxWidth: maxWidth ? `${maxWidth}px` : 'none', width: maxWidth ? '100%' : 'auto' }" />
      <span v-if="s.attempt?.status === 'running'" class="overlay">{{ s.attempt.kind === 'save' ? '保存中…' : '生成中…' }}</span>
    </div>

    <ul class="notes">
      <li v-if="s.preview?.source === 'saved'">保存済みの SVG を表示しています。</li>
      <li v-else-if="s.preview">プレビュー #{{ s.preview.generation }} を表示しています。</li>
      <li v-if="!s.previewIsCurrent" class="warn">編集中の設定は、まだプレビューに反映されていません。</li>
      <li v-if="s.preview?.source === 'preview' && !s.preview.reflectsSettings" class="warn">
        モック: 画像は保存済みの SVG のままで、設定は画像に反映されていません。結果と警告だけが設定から計算されています。
      </li>
      <li v-if="reducedMotion" class="warn">
        OS の「動きを減らす」設定が有効なため、カードは最後の状態で止まって表示されます（README の閲覧者でも同じです）。
      </li>
      <li>背景と表示幅は、この画面での見え方だけを変えます。SVG の大きさや配色は変わりません。</li>
    </ul>
  </section>
</template>

<style scoped>
.preview { display: flex; flex-direction: column; gap: 10px; }
.toolbar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.group { display: inline-flex; border: 1px solid var(--border); border-radius: 6px; overflow: hidden; }
.seg { border: 0; border-radius: 0; background: transparent; padding: 5px 10px; font-size: 12px; }
.seg + .seg { border-left: 1px solid var(--border); }
.seg[aria-pressed='true'] { background: var(--accent-soft); color: var(--accent); font-weight: 600; }
.start { font-size: 12px; display: inline-flex; gap: 6px; align-items: center; }
.start select { font: inherit; padding: 4px; border-radius: 6px; border: 1px solid var(--border); background: var(--input-bg); color: inherit; }
.replay { margin-left: auto; font-size: 12px; }
.stage { position: relative; border: 1px solid var(--border); border-radius: 8px; padding: 24px; min-height: 200px; display: flex; justify-content: center; align-items: flex-start; overflow: auto; }
.stage img { display: block; height: auto; }
.overlay { position: absolute; top: 8px; right: 10px; font-size: 12px; background: var(--panel); border: 1px solid var(--border); border-radius: 99px; padding: 2px 10px; }
.notes { margin: 0; padding-left: 18px; font-size: 12px; color: var(--muted); display: flex; flex-direction: column; gap: 2px; }
.notes .warn { color: var(--warn); }
</style>
