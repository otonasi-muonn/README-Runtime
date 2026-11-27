<script setup lang="ts">
import { sameSettings, settingsFromConfig } from '../api/fields';
import { useSessionContext } from '../composables/useSession';

const s = useSessionContext();
const edited = (name: string) => {
  const c = s.project?.cards.find((x) => x.name === name);
  return !!c && !sameSettings(s.drafts[name], settingsFromConfig(c.config));
};
</script>

<template>
  <nav class="cards" aria-label="カード">
    <h2>カード</h2>
    <button
      v-for="c in s.project?.cards ?? []" :key="c.name" type="button" class="card"
      :aria-current="s.selected === c.name" @click="s.selected = c.name"
    >
      <span class="name">{{ c.name }}</span>
      <span class="kind">{{ c.kind === 'ui' ? '既存 UI' : 'トレース' }}</span>
      <span v-if="edited(c.name)" class="dot" title="未保存の変更があります">●</span>
    </button>
  </nav>
</template>

<style scoped>
.cards { display: flex; flex-direction: column; gap: 4px; }
h2 { margin: 0 0 6px; font-size: 12px; color: var(--muted); font-weight: 600; }
.card { display: flex; align-items: center; gap: 6px; text-align: left; border: 1px solid transparent; background: transparent; padding: 7px 9px; }
.card[aria-current='true'] { background: var(--accent-soft); border-color: var(--accent); }
.name { font-family: var(--mono); font-size: 13px; flex: 1; overflow-wrap: anywhere; }
.kind { font-size: 11px; color: var(--muted); }
.dot { color: var(--warn); font-size: 10px; }
</style>
