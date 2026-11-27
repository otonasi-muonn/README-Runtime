// Screen state. Three versions of a card's settings are kept apart (Issue #2, review 2026-11-27):
//   draft   - what the form shows, edited freely;
//   preview - the last settings that generated successfully, with their result and image;
//   saved   - what readme-runtime.json holds.
// A failed preview keeps the last successful one on screen. Each preview request gets a number;
// a response that is not for the latest request is dropped, and a new request aborts the old one.
import { computed, inject, reactive, ref, type InjectionKey } from 'vue';
import { api } from '../api/client';
import { sameSettings, settingsFromConfig, validate } from '../api/fields';
import type { BuildCardResult, CardSettings, CardSummary, CheckOutput, CliError, PerfWarning, ProjectInfo } from '../api/types';

export interface PreviewState {
  settings: CardSettings;
  svgUrl: string;
  svgAltInits: number[];
  generation: number;
  card: BuildCardResult | null;
  reflectsSettings: boolean;
  source: 'saved' | 'preview';
}

export interface Attempt {
  kind: 'preview' | 'save';
  status: 'running' | 'ok' | 'error';
  error?: CliError;
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

export function useSession() {
  const project = ref<ProjectInfo | null>(null);
  const loadError = ref<string | null>(null);
  const selected = ref<string | null>(null);
  const drafts = reactive<Record<string, CardSettings>>({});
  const previews = reactive<Record<string, PreviewState>>({});
  const attempts = reactive<Record<string, Attempt>>({});
  const replays = reactive<Record<string, number>>({});
  const checkState = ref<{ status: 'idle' | 'running' | 'done'; output?: CheckOutput }>({ status: 'idle' });
  const seq: Record<string, number> = {};
  const controllers: Record<string, AbortController> = {};

  const card = computed<CardSummary | null>(() => project.value?.cards.find((c) => c.name === selected.value) ?? null);
  const saved = computed(() => (card.value ? settingsFromConfig(card.value.config) : null));
  const draft = computed(() => (selected.value ? drafts[selected.value] : null));
  const preview = computed(() => (selected.value ? previews[selected.value] : null));
  const attempt = computed(() => (selected.value ? attempts[selected.value] : null));
  const errors = computed(() => (draft.value ? validate(draft.value) : {}));
  const valid = computed(() => Object.keys(errors.value).length === 0);
  const previewIsCurrent = computed(() => sameSettings(draft.value, preview.value?.settings));
  const unsaved = computed(() => !sameSettings(draft.value, saved.value));
  const busy = computed(() => attempt.value?.status === 'running');
  /** Only settings that were previewed successfully can be saved. */
  const canSave = computed(() => valid.value && unsaved.value && previewIsCurrent.value && preview.value?.source === 'preview' && !busy.value);

  function initCard(c: CardSummary) {
    const s = settingsFromConfig(c.config);
    drafts[c.name] = clone(s);
    previews[c.name] = { settings: s, svgUrl: c.svgUrl, svgAltInits: [...(c.config.altInits ?? [])], generation: 0, card: c.lastBuild, reflectsSettings: true, source: 'saved' };
    replays[c.name] = 0;
  }

  async function load() {
    try {
      project.value = await api.getProject();
      for (const c of project.value.cards) initCard(c);
      selected.value = project.value.cards[0]?.name ?? null;
    } catch (e) {
      loadError.value = e instanceof Error ? e.message : String(e);
    }
  }

  async function runPreview() {
    const name = selected.value;
    if (!name || !valid.value) return;
    controllers[name]?.abort();
    const ctrl = (controllers[name] = new AbortController());
    const n = (seq[name] = (seq[name] ?? 0) + 1);
    const settings = clone(drafts[name]);
    attempts[name] = { kind: 'preview', status: 'running' };
    try {
      const r = await api.preview(name, settings, ctrl.signal);
      if (seq[name] !== n) return;
      if (r.ok) {
        previews[name] = { settings, svgUrl: r.svgUrl, svgAltInits: r.svgAltInits, generation: r.generation, card: r.card, reflectsSettings: r.reflectsSettings, source: 'preview' };
        attempts[name] = { kind: 'preview', status: 'ok' };
      } else {
        attempts[name] = { kind: 'preview', status: 'error', error: r.error };
      }
    } catch (e) {
      if ((e as Error).name === 'AbortError' || seq[name] !== n) return;
      attempts[name] = { kind: 'preview', status: 'error', error: { code: 'GUI_REQUEST', message: (e as Error).message, hint: '', details: {} } };
    }
  }

  async function save() {
    const name = selected.value;
    const c = card.value;
    if (!name || !c || !canSave.value) return;
    const settings = clone(drafts[name]);
    attempts[name] = { kind: 'save', status: 'running' };
    try {
      const r = await api.save(name, settings);
      if (!r.ok) { attempts[name] = { kind: 'save', status: 'error', error: r.error }; return; }
      c.config = r.config;
      c.lastBuild = r.card;
      // the saved file changed: a new URL so the browser does not show the old image
      c.svgUrl = `${c.svgUrl.split('?')[0]}?r=${Date.now()}`;
      previews[name] = { ...previews[name], card: r.card };
      attempts[name] = { kind: 'save', status: 'ok' };
      checkState.value = { status: 'idle' };
    } catch (e) {
      attempts[name] = { kind: 'save', status: 'error', error: { code: 'GUI_REQUEST', message: (e as Error).message, hint: '', details: {} } };
    }
  }

  async function runCheck() {
    checkState.value = { status: 'running' };
    checkState.value = { status: 'done', output: await api.check() };
  }

  function applyFix(fix: PerfWarning['fix']) {
    if (selected.value) Object.assign(drafts[selected.value], fix);
  }

  function resetDraft() {
    if (selected.value && saved.value) drafts[selected.value] = clone(saved.value);
  }

  function replay() {
    if (selected.value) replays[selected.value]++;
  }

  // reactive() unwraps the refs, so components read session.draft rather than session.draft.value
  return reactive({
    project, loadError, selected, drafts, card, saved, draft, preview, attempt, errors, valid, previewIsCurrent, unsaved, busy, canSave,
    replays, checkState, load, runPreview, save, runCheck, applyFix, resetDraft, replay,
  });
}

export type Session = ReturnType<typeof useSession>;
export const SessionKey: InjectionKey<Session> = Symbol('session');

export function useSessionContext(): Session {
  const s = inject(SessionKey);
  if (!s) throw new Error('session not provided');
  return s;
}
