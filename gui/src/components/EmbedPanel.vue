<script setup lang="ts">
import { computed, ref } from 'vue';
import { toConfigCard } from '../api/fields';
import { labelFor } from '../api/labels';
import { useSessionContext } from '../composables/useSession';

const s = useSessionContext();

// The Markdown is for the saved card: that is the file README.md will point at.
const out = computed(() => s.card?.lastBuild?.out ?? s.card?.config.out ?? (s.card ? `readme-runtime/${s.card.name}.svg` : ''));
const embed = computed(() => s.card?.lastBuild?.embed ?? (out.value ? [`![${s.card!.name}](${out.value})`] : []));
const pending = computed(() => (s.card && s.draft && s.unsaved ? JSON.stringify(toConfigCard(s.card.config, s.draft), null, 2) : ''));

const copied = ref<string | null>(null);
async function copy(text: string, key: string) {
  try {
    await navigator.clipboard.writeText(text);
    copied.value = key;
    setTimeout(() => { if (copied.value === key) copied.value = null; }, 1500);
  } catch {
    copied.value = 'failed';
  }
}
</script>

<template>
  <section v-if="s.card" class="embed">
    <h3 class="section-title">README に貼る</h3>
    <p class="path">出力ファイル: <code>{{ out }}</code></p>
    <ul class="lines">
      <li v-for="(line, i) in embed" :key="line">
        <code>{{ line }}</code>
        <button type="button" @click="copy(line, `l${i}`)">{{ copied === `l${i}` ? 'コピーしました' : 'コピー' }}</button>
      </li>
    </ul>
    <button v-if="embed.length > 1" type="button" @click="copy(embed.join('\n\n'), 'all')">{{ copied === 'all' ? 'コピーしました' : 'すべてコピー' }}</button>
    <p v-if="copied === 'failed'" class="err">クリップボードに書き込めませんでした。テキストを選択してコピーしてください。</p>
    <p class="note">保存済みのカードを指します。ファイル名は変わらないので、再生成しても README の書き換えは不要です。同じ SVG を2回以上貼るときは、行ごとのクエリ（<code>?x97</code>）も残してください。</p>

    <details v-if="pending" class="pending">
      <summary>保存すると readme-runtime.json に書かれる内容</summary>
      <pre>{{ pending }}</pre>
    </details>

    <h3 class="section-title">check（CI と同じ検査）</h3>
    <div class="check">
      <button type="button" :disabled="s.checkState.status === 'running'" @click="s.runCheck()">{{ s.checkState.status === 'running' ? '実行中…' : 'check を実行' }}</button>
      <span class="note">ファイルは書き換えません。</span>
    </div>
    <template v-if="s.checkState.status === 'done' && s.checkState.output">
      <p v-if="'error' in s.checkState.output" class="err">{{ labelFor(s.checkState.output.error.code) }}: {{ s.checkState.output.error.message }}</p>
      <p v-else-if="s.checkState.output.ok" class="ok">すべてのカードが、ソースから作り直した結果と一致しました。</p>
      <ul v-else class="problems">
        <li v-for="p in s.checkState.output.problems" :key="p.card + p.code">
          <strong>{{ p.card }}</strong>: {{ labelFor(p.code) }} <code>{{ p.code }}</code>
          <div class="msg">{{ p.message }}</div>
          <div v-if="p.hint" class="note">対処: {{ p.hint }}</div>
        </li>
      </ul>
    </template>
  </section>
</template>

<style scoped>
.embed { display: flex; flex-direction: column; gap: 8px; font-size: 12px; }
.section-title { padding: 0; }
.section-title:not(:first-child) { padding-top: 12px; }
.path { margin: 0; color: var(--muted); }
.path code { color: var(--text); }
.lines { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.lines li { display: flex; gap: 8px; align-items: center; justify-content: space-between; border: 1px solid var(--border); border-radius: var(--radius); padding: 6px 6px 6px 10px; background: var(--input-bg); }
.lines code { overflow-wrap: anywhere; font-size: 11px; }
.lines button { flex: none; }
.embed > button { align-self: flex-start; }
.note { margin: 0; font-size: 11px; color: var(--faint); }
.err { margin: 0; color: var(--danger); }
.ok { margin: 0; color: var(--ok); }
.pending summary { cursor: pointer; font-size: 11px; color: var(--muted); }
.pending pre { font-family: var(--mono); font-size: 11px; background: var(--input-bg); border: 1px solid var(--border); border-radius: var(--radius); padding: 8px; overflow: auto; }
.check { display: flex; gap: 10px; align-items: center; }
.problems { margin: 0; padding-left: 16px; }
.problems .msg { font-family: var(--mono); font-size: 11px; color: var(--muted); overflow-wrap: anywhere; }
</style>
