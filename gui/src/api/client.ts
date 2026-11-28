// The one place that decides where the GUI's data comes from: the connection API on the dev
// server (live), or the mock when that is not available (or VITE_RUNTIME_API=mock).
//
// The mock is loaded only when it is used: it imports readme-runtime.json and the SVGs as
// modules, and in live mode a save rewrites those files; were they part of the module graph,
// the dev server would hot-reload the screen and drop its state on every save.
import { API_VERSION, FEATURES, PERF_SOURCES } from './capabilities';
import { FALLBACK_SETTINGS } from './fields';
import { createLiveApi } from './live';
import type { ProjectInfo, RuntimeApi } from './types';

const live = createLiveApi();
let mock: Promise<RuntimeApi> | null = null;
const loadMock = () => (mock ??= import('./mock').then((m) => m.createMockApi()));
let impl: RuntimeApi = live;

export const api: RuntimeApi = {
  async getProject(): Promise<ProjectInfo> {
    if (import.meta.env.VITE_RUNTIME_API === 'mock') {
      impl = await loadMock();
      return impl.getProject();
    }
    try {
      impl = live;
      const p = await live.getProject();
      // an API without capabilities, or a newer one, still works with what this GUI knows
      if (!p.capabilities) {
        return { ...p, capabilities: { apiVersion: 0, settings: FALLBACK_SETTINGS, features: FEATURES, perf: PERF_SOURCES }, notice: '接続先が設定の範囲を返さないため、GUI 側の表で確認しています。' };
      }
      if (p.capabilities.apiVersion > API_VERSION) {
        return { ...p, notice: `接続先の API（v${p.capabilities.apiVersion}）は、この GUI（v${API_VERSION}）より新しい版です。知らない機能は表示しません。` };
      }
      return p;
    } catch (e) {
      impl = await loadMock();
      const p = await impl.getProject();
      return { ...p, notice: `README Runtime に接続できないため、モックで表示しています: ${(e as Error).message}` };
    }
  },
  preview: (...a) => impl.preview(...a),
  save: (...a) => impl.save(...a),
  check: () => impl.check(),
};
