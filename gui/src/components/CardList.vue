<script setup lang="ts">
import { sameSettings } from '../api/fields';
import { useSessionContext } from '../composables/useSession';

const s = useSessionContext();
const edited = (name: string) => {
  const c = s.project?.cards.find((x) => x.name === name);
  return !!c && !sameSettings(s.drafts[name], s.settingsOf(c.config));
};
</script>

<template>
  <nav class="cards" aria-label="カード">
    <h2 class="section-title">カード</h2>
    <button
      v-for="c in s.project?.cards ?? []" :key="c.name" type="button" class="card"
      :aria-current="s.selected === c.name" @click="s.selected = c.name"
    >
      <span class="icon" aria-hidden="true">{{ c.kind === 'ui' ? '▣' : '▤' }}</span>
      <span class="name">{{ c.name }}</span>
      <span v-if="edited(c.name)" class="dot" title="未保存の変更があります">●</span>
      <span class="kind">{{ c.kind === 'ui' ? 'UI' : 'trace' }}</span>
    </button>
  </nav>
</template>

<style scoped>
.cards { display: flex; flex-direction: column; padding-bottom: 8px; border-bottom: 1px solid var(--border); }
.card { justify-content: flex-start; gap: 8px; border: 0; border-radius: 0; background: transparent; padding: 6px 12px; border-left: 2px solid transparent; }
.card:hover:not(:disabled) { background: var(--hover); }
.card[aria-current='true'] { background: var(--accent-soft); border-left-color: var(--accent); }
.icon { color: var(--faint); font-size: 12px; }
.card[aria-current='true'] .icon { color: var(--accent); }
.name { font-family: var(--mono); font-size: 12px; flex: 1; text-align: left; overflow-wrap: anywhere; }
.dot { color: var(--accent); font-size: 8px; }
.kind { font-size: 10px; color: var(--faint); font-family: var(--mono); }
</style>
