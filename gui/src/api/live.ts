// The connection API over HTTP: /api on the same dev server (gui/server/runtimeApi.ts).
import type { CheckOutput, Failure, PreviewResponse, ProjectInfo, RuntimeApi, SaveResponse } from './types';

async function readJson<T>(res: Response): Promise<T> {
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`${res.status} ${res.statusText}: the server did not answer with JSON`);
  }
}

async function post<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
  return readJson<T>(res);
}

export function createLiveApi(): RuntimeApi {
  return {
    async getProject(): Promise<ProjectInfo> {
      const res = await fetch('/api/project');
      const r = await readJson<(ProjectInfo & { ok: true }) | Failure>(res);
      if (!r.ok) throw new Error(`${r.error.message}${r.error.hint ? ` — ${r.error.hint}` : ''}`);
      const { ok: _ok, ...project } = r;
      return project;
    },
    preview: (name, settings, signal) => post<PreviewResponse>('/api/preview', { name, settings }, signal),
    save: (name, settings) => post<SaveResponse>('/api/save', { name, settings }),
    check: () => post<CheckOutput>('/api/check', {}),
  };
}
