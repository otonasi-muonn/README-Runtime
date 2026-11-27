<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted } from 'vue';
import { useSessionContext } from '../composables/useSession';

const s = useSessionContext();

// Where the selected card is: edited (not previewed yet) -> previewed -> saved.
type Stage = 'edit' | 'preview' | 'saved';
const stage = computed<Stage>(() => {
  if (!s.unsaved) return 'saved';
  if (s.previewIsCurrent && s.preview?.source === 'preview') return 'preview';
  return 'edit';
});
const running = computed(() => (s.attempt?.status === 'running' ? s.attempt.kind : null));
const failed = computed(() => (s.attempt?.status === 'error' ? s.attempt.kind : null));
const order: Stage[] = ['edit', 'preview', 'saved'];
const steps = computed(() => [
  { key: 'edit' as const, label: '編集', sub: stage.value === 'edit' ? (s.valid ? '未プレビューの変更' : '入力に誤りがあります') : '' },
  { key: 'preview' as const, label: 'プレビュー', sub: running.value === 'preview' ? '生成中…' : failed.value === 'preview' ? '失敗' : stage.value === 'preview' ? `#${s.preview?.generation} 保存できます` : '' },
  { key: 'saved' as const, label: '保存済み', sub: running.value === 'save' ? '保存中…' : failed.value === 'save' ? '失敗' : stage.value === 'saved' ? '変更なし' : '' },
]);
const stateOf = (k: Stage) => {
  if ((k === 'preview' && running.value === 'preview') || (k === 'saved' && running.value === 'save')) return 'running';
  if ((k === 'preview' && failed.value === 'preview') || (k === 'saved' && failed.value === 'save')) return 'failed';
  const i = order.indexOf(k), cur = order.indexOf(stage.value);
  return i < cur ? 'done' : i === cur ? 'current' : 'todo';
};

function onKey(e: KeyboardEvent) {
  if (!(e.ctrlKey || e.metaKey)) return;
  if (e.key === 'Enter') { e.preventDefault(); if (s.valid && !s.busy) s.runPreview(); }
  if (e.key.toLowerCase() === 's') { e.preventDefault(); if (s.canSave) s.save(); }
}
onMounted(() => window.addEventListener('keydown', onKey));
onBeforeUnmount(() => window.removeEventListener('keydown', onKey));
</script>

<template>
  <header class="top">
    <div class="brand">
      <span class="logo" aria-hidden="true">▚</span>
      <span class="name">README Runtime</span>
      <span v-if="s.project?.mode === 'mock'" class="badge" title="生成と保存は行いません。表示は保存済みの SVG と、記録した CLI の出力です。">MOCK</span>
      <span v-else-if="s.project?.mode === 'live'" class="badge live" title="README Runtime で実際に生成します。保存すると readme-runtime.json と SVG を書き換えます。">LIVE</span>
    </div>

    <ol v-if="s.card" class="stepper" aria-label="カードの状態">
      <li v-for="(st, i) in steps" :key="st.key" :class="stateOf(st.key)" :aria-current="stateOf(st.key) === 'current' ? 'step' : undefined">
        <span class="dot">{{ stateOf(st.key) === 'done' ? '✓' : stateOf(st.key) === 'failed' ? '!' : i + 1 }}</span>
        <span class="text"><span class="label">{{ st.label }}</span><span v-if="st.sub" class="sub">{{ st.sub }}</span></span>
      </li>
    </ol>

    <div class="actions">
      <button type="button" class="ghost" :disabled="!s.unsaved || s.busy" title="保存済みの設定に戻す" @click="s.resetDraft()">編集を破棄</button>
      <button type="button" class="primary" :disabled="!s.valid || s.busy" @click="s.runPreview()">
        {{ running === 'preview' ? '生成中…' : 'プレビューを生成' }} <kbd>Ctrl+Enter</kbd>
      </button>
      <button type="button" :disabled="!s.canSave" :title="s.canSave ? '' : 'プレビューに成功した設定だけ保存できます'" @click="s.save()">
        {{ running === 'save' ? '保存中…' : '保存' }} <kbd>Ctrl+S</kbd>
      </button>
    </div>
  </header>
</template>

<style scoped>
.top { grid-area: top; display: flex; align-items: center; gap: 16px; padding: 0 12px; height: 48px; background: var(--panel); border-bottom: 1px solid var(--border); }
.brand { display: flex; align-items: center; gap: 8px; min-width: 220px; }
.logo { color: var(--accent); font-size: 16px; }
.name { font-weight: 600; font-size: 13px; }
.badge { font-size: 10px; font-weight: 700; letter-spacing: 0.08em; color: var(--warn); border: 1px solid var(--warn); border-radius: 4px; padding: 0 5px; cursor: help; }
.badge.live { color: var(--ok); border-color: var(--ok); }

.stepper { display: flex; align-items: center; gap: 0; margin: 0 auto; padding: 0; list-style: none; }
.stepper li { display: flex; align-items: center; gap: 8px; padding: 0 6px; color: var(--faint); }
.stepper li + li::before { content: ''; width: 28px; height: 1px; background: var(--border-strong); margin-right: 6px; }
.dot { width: 20px; height: 20px; border-radius: 50%; display: grid; place-items: center; font-size: 11px; font-weight: 700; border: 1px solid var(--border-strong); flex: none; }
.text { display: flex; flex-direction: column; line-height: 1.15; }
.label { font-size: 12px; font-weight: 600; }
.sub { font-size: 10px; }
.done { color: var(--muted); }
.done .dot { background: var(--accent-soft); border-color: var(--accent); color: var(--accent); }
.current { color: var(--text); }
.current .dot { background: var(--accent-strong); border-color: var(--accent-strong); color: #fff; }
.current .sub { color: var(--accent); }
.running { color: var(--text); }
.running .dot { border-color: var(--accent); border-top-color: transparent; animation: spin 0.8s linear infinite; color: transparent; }
.failed { color: var(--danger); }
.failed .dot { background: var(--danger-soft); border-color: var(--danger); }
@keyframes spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .running .dot { animation: none; } }

.actions { display: flex; gap: 6px; }
@media (max-width: 1100px) { .stepper .sub { display: none; } .brand { min-width: 0; } }
</style>
