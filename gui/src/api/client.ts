// The one place that decides where the GUI's data comes from: the connection API on the dev
// server (live), or the mock when that is not available (or VITE_RUNTIME_API=mock).
//
// The mock is loaded only when it is used: it imports readme-runtime.json and the SVGs as
// modules, and in live mode a save rewrites those files; were they part of the module graph,
// the dev server would hot-reload the screen and drop its state on every save.
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
      return await live.getProject();
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
