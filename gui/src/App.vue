<script setup lang="ts">
import { onMounted, provide } from 'vue';
import CardList from './components/CardList.vue';
import EmbedPanel from './components/EmbedPanel.vue';
import PreviewPane from './components/PreviewPane.vue';
import ResultPanel from './components/ResultPanel.vue';
import SettingsForm from './components/SettingsForm.vue';
import { SessionKey, useSession } from './composables/useSession';

const s = useSession();
provide(SessionKey, s);
onMounted(() => s.load());
</script>

<template>
  <header class="top">
    <h1>README Runtime <span>カードの調整とプレビュー</span></h1>
    <span v-if="s.project?.mode === 'mock'" class="badge" title="生成と保存は行いません。表示は保存済みの SVG と、記録した CLI の出力です。">モック</span>
    <span v-if="s.project" class="version">readme-runtime {{ s.project.toolVersion }}</span>
  </header>
  <p v-if="s.loadError" class="load-error">読み込めませんでした: {{ s.loadError }}</p>
  <main v-else-if="s.project" class="layout">
    <aside class="side"><CardList /></aside>
    <div class="settings panel"><SettingsForm /></div>
    <div class="output">
      <div class="panel"><PreviewPane /></div>
      <div class="panel"><ResultPanel /></div>
      <div class="panel"><EmbedPanel /></div>
    </div>
  </main>
  <p v-else class="loading">読み込み中…</p>
</template>

<style scoped>
.top { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px; padding: 12px 20px; border-bottom: 1px solid var(--border); background: var(--panel); }
h1 { margin: 0; font-size: 16px; }
h1 span { font-weight: 400; color: var(--muted); margin-left: 6px; font-size: 13px; }
.badge { font-size: 11px; font-weight: 700; color: var(--warn); border: 1px solid var(--warn); border-radius: 99px; padding: 1px 8px; cursor: help; white-space: nowrap; }
.version { margin-left: auto; font-size: 12px; color: var(--muted); font-family: var(--mono); }
.layout { display: grid; grid-template-columns: 170px minmax(280px, 340px) minmax(0, 1fr); gap: 16px; padding: 16px 20px; align-items: start; }
.output { display: flex; flex-direction: column; gap: 16px; min-width: 0; }
.panel { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 14px 16px; }
.settings { position: sticky; top: 16px; }
.load-error, .loading { padding: 20px; }
.load-error { color: var(--danger); }
@media (max-width: 900px) {
  .layout { grid-template-columns: 1fr; }
  .settings { position: static; }
}
</style>
