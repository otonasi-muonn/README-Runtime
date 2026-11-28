<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { parseIntList } from '../api/fields';
import { useSessionContext } from '../composables/useSession';
import type { CardSettings } from '../api/types';

const s = useSessionContext();

// altInits is edited as text ("97, 871") and parsed on every change
const altText = ref('');
watch(() => [s.selected, s.draft?.altInits.join(', ')], () => {
  const list = s.draft?.altInits ?? [];
  if (parseIntList(altText.value).join() !== list.join()) altText.value = list.join(', ');
}, { immediate: true });
function onAltInput() {
  if (s.draft) s.draft.altInits = parseIntList(altText.value);
}

const loopMode = computed({
  get: () => (typeof s.draft?.loops === 'number' ? 'count' : s.draft?.loops ?? 'auto'),
  set: (m: string) => {
    if (!s.draft) return;
    s.draft.loops = m === 'count' ? (typeof s.draft.loops === 'number' ? s.draft.loops : 3) : (m as 'auto' | 'infinite');
  },
});
const loopCount = computed({
  get: () => (typeof s.draft?.loops === 'number' ? s.draft.loops : 3),
  set: (v: number) => { if (s.draft) s.draft.loops = v; },
});

const c = computed(() => s.card?.config);
// a field that differs from the saved settings gets a marker
const savedSettings = computed(() => (c.value ? s.settingsOf(c.value) : null));
// features this runtime does not have yet: shown disabled, with the reason it reports
const unavailable = computed(() => (s.capabilities?.features ?? []).filter((x) => !x.available));
const changed = (k: keyof CardSettings) => !!s.draft && !!savedSettings.value && JSON.stringify(s.draft[k]) !== JSON.stringify(savedSettings.value[k]);
</script>

<template>
  <form v-if="s.draft && c" class="form" @submit.prevent="s.runPreview()">
    <h2 class="section-title">設定</h2>

    <div class="group">
      <label class="field" :class="{ changed: changed('title') }">
        <span class="label">タイトル</span>
        <input v-model="s.draft.title" type="text" />
      </label>
    </div>

    <div class="group">
      <label v-for="f in s.fields" :key="f.key" class="field" :class="{ invalid: s.errors[f.key], changed: changed(f.key) }">
        <span class="label">{{ f.label }}<small v-if="f.unit">{{ f.unit }}</small></span>
        <input v-model.number="s.draft[f.key]" type="number" :min="f.min" :max="f.max" step="1" />
        <span v-if="s.errors[f.key]" class="error">{{ s.errors[f.key] }}</span>
        <span class="help">{{ f.help }}</span>
      </label>
    </div>

    <div class="group">
      <label class="field" :class="{ invalid: s.errors.altInits, changed: changed('altInits') }">
        <span class="label">ほかの初期値<small>{{ s.limits.altInits.maxItems }}個まで</small></span>
        <input v-model="altText" type="text" placeholder="例: 97, 871" @input="onAltInput" />
        <span v-if="s.errors.altInits" class="error">{{ s.errors.altInits }}</span>
        <span class="help">README で <code>card.svg?x97#x97</code> と書くと、同じ SVG がこの値から計算します。</span>
      </label>

      <fieldset class="field" :class="{ invalid: s.errors.loops, changed: changed('loops') }">
        <legend class="label">ループ</legend>
        <div class="seg" role="radiogroup">
          <label :class="{ on: loopMode === 'auto' }"><input v-model="loopMode" type="radio" value="auto" />自動</label>
          <label :class="{ on: loopMode === 'infinite' }"><input v-model="loopMode" type="radio" value="infinite" />無限</label>
          <label :class="{ on: loopMode === 'count' }"><input v-model="loopMode" type="radio" value="count" />回数</label>
        </div>
        <input v-if="loopMode === 'count'" v-model.number="loopCount" class="count" type="number" :min="s.limits.loops.count.min" :max="s.limits.loops.count.max" aria-label="ループ回数" />
        <span v-if="s.errors.loops" class="error">{{ s.errors.loops }}</span>
        <span class="help">自動は約1分で止まり、その後は CPU を使いません。ページの最初に見えるカードは無限が向いています。</span>
      </fieldset>
    </div>

    <div v-if="unavailable.length" class="group upcoming">
      <p class="label">今後の機能（このバージョンでは使えません）</p>
      <ul>
        <li v-for="x in unavailable" :key="x.key" aria-disabled="true">
          <span class="name">{{ x.label }}</span>
          <span class="why">{{ x.reason }}<template v-if="x.issue">（#{{ x.issue }}）</template></span>
        </li>
      </ul>
    </div>

    <details class="readonly">
      <summary>ほかの設定（変更できません）</summary>
      <dl>
        <dt>Wasm</dt><dd><code>{{ c.wasm }}</code></dd>
        <dt>export</dt><dd><code>{{ c.export ?? 'step' }}</code></dd>
        <template v-if="c.halt !== undefined"><dt>停止値</dt><dd><code>{{ c.halt }}</code></dd></template>
        <template v-if="c.haltExport"><dt>停止判定</dt><dd><code>{{ c.haltExport }}</code></dd></template>
        <template v-if="!c.ui"><dt>ビット数</dt><dd>{{ c.bits ?? 20 }}</dd></template>
        <template v-if="c.build"><dt>ビルド</dt><dd><code>{{ c.build.command }}</code></dd></template>
        <template v-if="c.ui">
          <dt>UI</dt><dd><code>{{ c.ui.entry }}</code></dd>
          <dt>views</dt><dd><code>{{ Object.entries(c.ui.views).map(([k, v]) => `${k} ← ${v}`).join(', ') }}</code></dd>
        </template>
        <dt>出力先</dt><dd><code>{{ c.out ?? `readme-runtime/${c.name}.svg` }}</code></dd>
      </dl>
    </details>
  </form>
</template>

<style scoped>
.form { display: flex; flex-direction: column; }
.group { display: flex; flex-direction: column; gap: 10px; padding: 4px 12px 14px; border-bottom: 1px solid var(--border); }
.group:first-of-type { padding-top: 0; }
.field { position: relative; display: flex; flex-direction: column; gap: 4px; border: 0; padding: 0; margin: 0; min-width: 0; }
.label { display: flex; justify-content: space-between; gap: 6px; font-size: 11px; font-weight: 500; color: var(--muted); padding: 0; }
.label small { color: var(--faint); font-size: 10px; }
.changed > .label::after { content: ''; width: 5px; height: 5px; border-radius: 50%; background: var(--accent); position: absolute; left: -9px; top: 7px; }
/* Help shows over the fields below, never between them: if it pushed them down, leaving a field
   with a click below it would move the target away between mousedown and mouseup. It does not
   take clicks either. */
.help {
  display: none; position: absolute; top: calc(100% + 4px); left: 0; right: 0; z-index: 5; pointer-events: none;
  padding: 6px 8px; font-size: 11px; color: var(--muted); line-height: 1.45;
  background: var(--panel-2); border: 1px solid var(--border-strong); border-radius: var(--radius); box-shadow: 0 6px 18px rgba(0, 0, 0, 0.4);
}
.field:focus-within .help { display: block; }
.invalid input { border-color: var(--danger); }
.error { font-size: 11px; color: var(--danger); }
.seg { display: grid; grid-template-columns: repeat(3, 1fr); border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; background: var(--input-bg); }
.seg label { display: flex; justify-content: center; align-items: center; padding: 5px 0; font-size: 12px; cursor: pointer; color: var(--muted); }
.seg label + label { border-left: 1px solid var(--border); }
.seg label.on { background: var(--accent-soft); color: var(--accent); font-weight: 600; }
.seg input { position: absolute; opacity: 0; pointer-events: none; }
.seg label:focus-within { box-shadow: inset 0 0 0 2px var(--accent); }
.count { margin-top: 2px; }
.upcoming { padding-top: 12px; }
.upcoming ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.upcoming li { display: flex; flex-direction: column; padding: 6px 8px; border: 1px dashed var(--border); border-radius: var(--radius); opacity: 0.7; cursor: not-allowed; }
.upcoming .name { font-size: 12px; color: var(--muted); }
.upcoming .why { font-size: 11px; color: var(--faint); }
.readonly { margin: 12px; font-size: 11px; color: var(--muted); }
.readonly summary { cursor: pointer; }
.readonly dl { display: grid; grid-template-columns: max-content 1fr; gap: 4px 10px; margin: 8px 0 0; }
.readonly dt { color: var(--faint); }
.readonly dd { margin: 0; overflow-wrap: anywhere; color: var(--text); }
</style>
