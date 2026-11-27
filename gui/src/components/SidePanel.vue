<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import ComparePanel from './ComparePanel.vue';
import EmbedPanel from './EmbedPanel.vue';
import ResultPanel from './ResultPanel.vue';
import { useSessionContext } from '../composables/useSession';

const s = useSessionContext();
const tab = ref<'result' | 'compare' | 'readme'>('result');
// a new outcome (an error, or a warning to act on) is shown where it can be read
watch(() => s.attempt?.status, (st) => { if (st === 'error' || (st === 'ok' && tab.value === 'readme')) tab.value = 'result'; });
const warnings = computed(() => s.preview?.card?.warnings?.length ?? 0);
const hasError = computed(() => s.attempt?.status === 'error');
</script>

<template>
  <aside class="side" aria-label="結果と README">
    <div class="tabs" role="tablist">
      <button type="button" role="tab" :aria-selected="tab === 'result'" @click="tab = 'result'">
        結果
        <span v-if="hasError" class="count error">!</span>
        <span v-else-if="warnings" class="count warn">{{ warnings }}</span>
      </button>
      <button type="button" role="tab" :aria-selected="tab === 'compare'" :disabled="s.preview?.source !== 'preview'" title="プレビューを生成すると比べられます" @click="tab = 'compare'">比較</button>
      <button type="button" role="tab" :aria-selected="tab === 'readme'" @click="tab = 'readme'">README</button>
    </div>
    <div class="body">
      <ResultPanel v-if="tab === 'result'" />
      <ComparePanel v-else-if="tab === 'compare'" />
      <EmbedPanel v-else />
    </div>
  </aside>
</template>

<style scoped>
.side { grid-area: right; display: flex; flex-direction: column; min-height: 0; background: var(--panel); border-left: 1px solid var(--border); }
.tabs { display: flex; border-bottom: 1px solid var(--border); padding: 0 6px; flex: none; }
.tabs button { border: 0; border-radius: 0; background: transparent; color: var(--muted); padding: 11px 10px 9px; border-bottom: 2px solid transparent; font-weight: 600; }
.tabs button:hover:not(:disabled) { background: transparent; color: var(--text); }
.tabs button[aria-selected='true'] { color: var(--text); border-bottom-color: var(--accent); }
.count { font-size: 10px; min-width: 16px; height: 16px; padding: 0 4px; border-radius: 8px; display: inline-grid; place-items: center; }
.count.warn { background: var(--warn-soft); color: var(--warn); }
.count.error { background: var(--danger-soft); color: var(--danger); }
.body { flex: 1; overflow: auto; padding: 12px; }
</style>
