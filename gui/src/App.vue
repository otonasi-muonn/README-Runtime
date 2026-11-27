<script setup lang="ts">
import { onMounted, provide } from 'vue';
import CardList from './components/CardList.vue';
import PreviewPane from './components/PreviewPane.vue';
import SettingsForm from './components/SettingsForm.vue';
import SidePanel from './components/SidePanel.vue';
import TopBar from './components/TopBar.vue';
import { SessionKey, useSession } from './composables/useSession';

const s = useSession();
provide(SessionKey, s);
onMounted(() => s.load());
</script>

<template>
  <p v-if="s.loadError" class="message error">読み込めませんでした: {{ s.loadError }}</p>
  <div v-else-if="s.project" class="app">
    <TopBar />
    <aside class="left">
      <CardList />
      <SettingsForm />
    </aside>
    <PreviewPane />
    <SidePanel />
    <footer class="status">
      <span v-if="s.project.mode === 'mock'" class="mock">● モック（生成・保存はしません）</span>
      <span v-else>● 接続中</span>
      <span v-if="s.card">{{ s.card.name }}</span>
      <span v-if="s.unsaved" class="unsaved">未保存の変更あり</span>
      <span class="grow" />
      <span>readme-runtime {{ s.project.toolVersion }}</span>
    </footer>
  </div>
  <p v-else class="message">読み込み中…</p>
</template>

<style scoped>
.app {
  height: 100%;
  display: grid;
  grid-template-columns: 260px minmax(0, 1fr) 340px;
  grid-template-rows: 48px minmax(0, 1fr) 24px;
  grid-template-areas: 'top top top' 'left center right' 'status status status';
}
.left { grid-area: left; overflow-y: auto; background: var(--panel); border-right: 1px solid var(--border); }
.status { grid-area: status; display: flex; align-items: center; gap: 14px; padding: 0 12px; font-size: 11px; color: var(--muted); background: var(--panel); border-top: 1px solid var(--border); }
.status .mock { color: var(--warn); }
.status .unsaved { color: var(--accent); }
.grow { flex: 1; }
.message { padding: 20px; color: var(--muted); }
.message.error { color: var(--danger); }

/* narrow windows: one column that scrolls */
@media (max-width: 900px) {
  :global(body) { overflow: auto; }
  .app { height: auto; grid-template-columns: 1fr; grid-template-rows: auto; grid-template-areas: 'top' 'center' 'left' 'right' 'status'; }
  .left { border-right: 0; }
  :deep(.top) { height: auto; flex-wrap: wrap; padding: 8px 12px; }
  :deep(.stepper) { order: 3; width: 100%; justify-content: center; }
  :deep(.canvas) { min-height: 280px; padding: 20px 12px; }
  :deep(.side) { border-left: 0; border-top: 1px solid var(--border); }
}
</style>
