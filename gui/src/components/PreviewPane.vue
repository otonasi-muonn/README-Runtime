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
  { key: 'readme', label: 'README 830', px: 830 },
  { key: 'narrow', label: 'スマホ 360', px: 360 },
] as const;
const bg = ref<(typeof BACKGROUNDS)[number]['key']>('light');
const width = ref<(typeof WIDTHS)[number]['key']>('readme');
const bgColor = computed(() => BACKGROUNDS.find((b) => b.key === bg.value)!.color);
const pagePx = computed(() => WIDTHS.find((w) => w.key === width.value)!.px);

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
      <div class="seg" role="group" aria-label="背景">
        <button v-for="b in BACKGROUNDS" :key="b.key" type="button" :aria-pressed="bg === b.key" @click="bg = b.key">
          <span class="swatch" :style="{ background: b.color }" />{{ b.label }}
        </button>
      </div>
      <div class="seg" role="group" aria-label="表示幅">
        <button v-for="w in WIDTHS" :key="w.key" type="button" :aria-pressed="width === w.key" @click="width = w.key">{{ w.label }}</button>
      </div>
      <label v-if="inits.length > 1" class="start">
        <span>開始値</span>
        <select :value="startFrom ?? inits[0]" @change="startFrom = Number(($event.target as HTMLSelectElement).value)">
          <option v-for="x in inits" :key="x" :value="x">{{ x }}{{ x === inits[0] ? '（初期値）' : '' }}</option>
        </select>
      </label>
      <span class="spacer" />
      <button type="button" class="replay" @click="s.replay()">↻ 最初から再生</button>
    </div>

    <div class="banners">
      <p v-if="!s.previewIsCurrent" class="banner warn">編集中の設定は、まだプレビューに反映されていません。</p>
      <p v-if="s.preview?.source === 'preview' && !s.preview.reflectsSettings" class="banner mock">
        モック: 画像は保存済みの SVG のままです。設定から計算しているのは、右の結果と警告だけです。
      </p>
      <p v-if="reducedMotion" class="banner warn">
        OS の「動きを減らす」設定が有効なため、カードは最後の状態で止まって見えます（README の閲覧者でも同じです）。
      </p>
    </div>

    <div class="canvas">
      <div class="page" :style="{ background: bgColor, width: pagePx ? `${pagePx}px` : 'auto' }" :title="'背景と表示幅は、この画面での見え方だけを変えます。SVG の大きさや配色は変わりません。'">
        <img v-if="src" :key="src" :src="src" :alt="s.preview?.settings.title" :class="{ fit: !!pagePx }" />
      </div>
      <span v-if="s.attempt?.status === 'running'" class="busy">{{ s.attempt.kind === 'save' ? '保存中…' : '生成中…' }}</span>
    </div>

    <p class="caption">
      <span class="src">{{ s.preview?.source === 'saved' ? '保存済みの SVG' : `プレビュー #${s.preview?.generation}` }}</span>
      <code>{{ src.split('/').pop() }}</code>
    </p>
  </section>
</template>

<style scoped>
.preview { grid-area: center; display: flex; flex-direction: column; min-width: 0; min-height: 0; background: var(--canvas); }
.toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 8px 12px; border-bottom: 1px solid var(--border); background: var(--bg); }
.seg { display: inline-flex; border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; }
.seg button { border: 0; border-radius: 0; background: transparent; color: var(--muted); padding: 5px 10px; }
.seg button + button { border-left: 1px solid var(--border); }
.seg button[aria-pressed='true'] { background: var(--accent-soft); color: var(--accent); font-weight: 600; }
.swatch { width: 10px; height: 10px; border-radius: 2px; border: 1px solid var(--border-strong); }
.start { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--muted); }
.start select { width: auto; }
.spacer { flex: 1; }
.banners { display: flex; flex-direction: column; }
.banner { margin: 0; padding: 6px 14px; font-size: 12px; border-bottom: 1px solid var(--border); }
.banner.warn { color: var(--warn); background: var(--warn-soft); }
.banner.mock { color: var(--muted); background: var(--panel); }
.canvas {
  position: relative; flex: 1; overflow: auto; padding: 40px 32px; display: flex; justify-content: center; align-items: flex-start;
  background-image: radial-gradient(var(--border) 1px, transparent 1px); background-size: 16px 16px;
}
.page { max-width: 100%; padding: 24px; border-radius: 8px; box-shadow: 0 0 0 1px var(--border-strong), 0 12px 40px rgba(0, 0, 0, 0.45); }
.page img { display: block; height: auto; }
.page img.fit { width: 100%; }
.busy { position: absolute; top: 12px; right: 14px; font-size: 11px; color: var(--accent); background: var(--panel); border: 1px solid var(--accent); border-radius: 99px; padding: 2px 10px; }
.caption { margin: 0; display: flex; gap: 10px; align-items: center; padding: 5px 12px; font-size: 11px; color: var(--faint); border-top: 1px solid var(--border); background: var(--bg); }
.caption .src { color: var(--muted); }
.caption code { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
