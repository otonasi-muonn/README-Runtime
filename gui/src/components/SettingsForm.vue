<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { INT_FIELDS, LOOP_COUNT, MAX_ALT_INITS, parseIntList } from '../api/fields';
import { useSessionContext } from '../composables/useSession';

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
</script>

<template>
  <form v-if="s.draft && c" class="form" @submit.prevent="s.runPreview()">
    <h2>設定 <span class="card-name">{{ c.name }}</span></h2>

    <label class="field">
      <span class="label">タイトル</span>
      <input v-model="s.draft.title" type="text" />
    </label>

    <label v-for="f in INT_FIELDS" :key="f.key" class="field" :class="{ invalid: s.errors[f.key] }">
      <span class="label">{{ f.label }}<small v-if="f.unit">（{{ f.unit }}）</small></span>
      <input v-model.number="s.draft[f.key]" type="number" :min="f.min" :max="f.max" step="1" />
      <span class="help">{{ f.help }}</span>
      <span v-if="s.errors[f.key]" class="error">{{ s.errors[f.key] }}</span>
    </label>

    <label class="field" :class="{ invalid: s.errors.altInits }">
      <span class="label">ほかの初期値 <small>（{{ MAX_ALT_INITS }}個まで、カンマ区切り）</small></span>
      <input v-model="altText" type="text" placeholder="例: 97, 871" @input="onAltInput" />
      <span class="help">README で <code>card.svg?x97#x97</code> のように指定すると、同じ SVG がこの値から計算します。</span>
      <span v-if="s.errors.altInits" class="error">{{ s.errors.altInits }}</span>
    </label>

    <fieldset class="field" :class="{ invalid: s.errors.loops }">
      <legend class="label">ループ</legend>
      <div class="radios">
        <label><input v-model="loopMode" type="radio" value="auto" /> 自動（約1分で止まる）</label>
        <label><input v-model="loopMode" type="radio" value="infinite" /> 止まらない</label>
        <label>
          <input v-model="loopMode" type="radio" value="count" /> 回数
          <input v-model.number="loopCount" class="count" type="number" :min="LOOP_COUNT.min" :max="LOOP_COUNT.max" :disabled="loopMode !== 'count'" />
        </label>
      </div>
      <span class="help">終わると最後の状態で止まり、CPU を使いません。ページの最初に見えるカードは「止まらない」が向いています。</span>
      <span v-if="s.errors.loops" class="error">{{ s.errors.loops }}</span>
    </fieldset>

    <details class="readonly">
      <summary>ほかの設定（この画面では変更しません）</summary>
      <dl>
        <dt>Wasm</dt><dd><code>{{ c.wasm }}</code>（export: <code>{{ c.export ?? 'step' }}</code>）</dd>
        <template v-if="c.halt !== undefined"><dt>停止値</dt><dd><code>{{ c.halt }}</code></dd></template>
        <template v-if="c.haltExport"><dt>停止判定関数</dt><dd><code>{{ c.haltExport }}</code></dd></template>
        <template v-if="!c.ui"><dt>ビット表示数</dt><dd>{{ c.bits ?? 20 }}</dd></template>
        <template v-if="c.build"><dt>ビルドコマンド</dt><dd><code>{{ c.build.command }}</code></dd></template>
        <template v-if="c.ui">
          <dt>UI</dt><dd><code>{{ c.ui.entry }}</code></dd>
          <dt>views</dt><dd><code>{{ Object.entries(c.ui.views).map(([k, v]) => `${k} ← ${v}`).join(', ') }}</code></dd>
        </template>
        <dt>出力先</dt><dd><code>{{ c.out ?? `readme-runtime/${c.name}.svg` }}</code></dd>
      </dl>
    </details>

    <div class="actions">
      <button type="submit" class="primary" :disabled="!s.valid || s.busy">
        {{ s.attempt?.status === 'running' && s.attempt.kind === 'preview' ? '生成中…' : 'プレビューを生成' }}
      </button>
      <button type="button" :disabled="!s.canSave" @click="s.save()">
        {{ s.attempt?.status === 'running' && s.attempt.kind === 'save' ? '保存中…' : '保存' }}
      </button>
      <button type="button" class="ghost" :disabled="!s.unsaved || s.busy" @click="s.resetDraft()">編集を破棄</button>
    </div>
    <p class="state">
      <template v-if="!s.unsaved">保存済みの設定と同じです。</template>
      <template v-else-if="!s.previewIsCurrent">保存するには、この設定でプレビューを生成してください。</template>
      <template v-else-if="s.preview?.source === 'preview'">プレビューに成功した設定です。保存できます。</template>
    </p>
  </form>
</template>

<style scoped>
.form { display: flex; flex-direction: column; gap: 14px; }
h2 { margin: 0; font-size: 15px; }
.card-name { font-family: var(--mono); font-weight: 500; color: var(--muted); margin-left: 6px; }
.field { display: flex; flex-direction: column; gap: 4px; border: 0; padding: 0; margin: 0; min-width: 0; }
.label { font-size: 13px; font-weight: 600; padding: 0; }
.label small { font-weight: 400; color: var(--muted); }
input[type='text'], input[type='number'] { font: inherit; padding: 6px 8px; border: 1px solid var(--border); border-radius: 6px; background: var(--input-bg); color: inherit; }
.invalid input { border-color: var(--danger); }
.help { font-size: 12px; color: var(--muted); }
.error { font-size: 12px; color: var(--danger); }
.radios { display: flex; flex-wrap: wrap; gap: 6px 14px; font-size: 13px; }
.radios label { display: inline-flex; align-items: center; gap: 4px; }
.count { width: 72px; }
.readonly { font-size: 12px; border: 1px solid var(--border); border-radius: 6px; padding: 6px 10px; }
.readonly summary { cursor: pointer; color: var(--muted); }
.readonly dl { display: grid; grid-template-columns: max-content 1fr; gap: 4px 10px; margin: 8px 0 2px; }
.readonly dt { color: var(--muted); }
.readonly dd { margin: 0; overflow-wrap: anywhere; }
.actions { display: flex; flex-wrap: wrap; gap: 8px; }
.state { margin: 0; font-size: 12px; color: var(--muted); min-height: 1.4em; }
</style>
