// Shared helpers for the README Runtime vs recording benchmark (bench/README.md).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import url from 'node:url';
import crypto from 'node:crypto';
import { spawnSync, execFileSync } from 'node:child_process';

export const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
// projects, frames, media (git-ignored) and the measured numbers; both can be redirected so
// a re-run does not overwrite the published results
export const WORK = path.resolve(process.env.BENCH_WORK ?? path.join(ROOT, 'bench', '.work'));
export const RESULTS = path.resolve(process.env.BENCH_RESULTS ?? path.join(ROOT, 'bench', 'results'));
export const STEPS = (process.env.BENCH_STEPS ?? '40,80,160,320').split(',').map(Number);
export const REPEAT = Number(process.env.BENCH_REPEAT ?? 3);
export const STEP_MS = 150; // the mockcraft card
export const HOLD = 12; // README Runtime's default hold (frames showing the last state)
export const INIT = 1536;
export const VIEWS = { dx: 'view_dx', dy: 'view_dy', on: 'view_on', sel: 'view_sel', hits: 'view_hits' };
export const CARD = { W: 760, H: 446, uiX: 24, uiY: 60, uiW: 712, uiH: 330 }; // uiLayout of the card

export const sha = (x) => crypto.createHash('sha256').update(x).digest('hex');
export const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
export const round = (x, d = 0) => (x == null ? null : Number(x.toFixed(d)));

export function sizes(buf) {
  return {
    raw: buf.length,
    gzip: zlib.gzipSync(buf, { level: 9 }).length,
    brotli: zlib.brotliCompressSync(buf, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } }).length,
  };
}

export function run(cmd, args, opts = {}) {
  const t0 = performance.now();
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 1 << 28, ...opts });
  const ms = performance.now() - t0;
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} exited ${r.status}: ${(r.stderr || r.stdout || '').slice(-1500)}`);
  return { ms, stdout: r.stdout, stderr: r.stderr };
}
export const ffmpeg = (args) => run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);

export function writeJson(name, data) {
  fs.mkdirSync(RESULTS, { recursive: true });
  fs.writeFileSync(path.join(RESULTS, name), `${JSON.stringify(data, null, 1)}\n`);
}
export const readJson = (name) => JSON.parse(fs.readFileSync(path.join(RESULTS, name), 'utf8'));

export function environment() {
  const first = (cmd, args) => { try { return execFileSync(cmd, args, { encoding: 'utf8' }).split('\n')[0].trim(); } catch { return null; } };
  return {
    date: new Date().toISOString(),
    os: `${os.type()} ${os.release()} ${os.arch()}`,
    cpu: `${os.cpus()[0].model} (${os.cpus().length} threads)`,
    ramGB: round(os.totalmem() / 2 ** 30, 1),
    node: process.version,
    ffmpeg: first('ffmpeg', ['-hide_banner', '-version']),
    git: first('git', ['--version']),
  };
}

// CPU time and working set of a process and all its descendants (Windows: CIM; elsewhere
// /proc is not implemented here, so the caller reports "not measured").
export function processTree(rootPid) {
  if (process.platform !== 'win32') return null;
  const ps = 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,KernelModeTime,UserModeTime,WorkingSetSize | ConvertTo-Json -Compress';
  const all = JSON.parse(execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', maxBuffer: 1 << 26 }));
  const children = new Map();
  for (const p of all) { if (!children.has(p.ParentProcessId)) children.set(p.ParentProcessId, []); children.get(p.ParentProcessId).push(p); }
  const byPid = new Map(all.map((p) => [p.ProcessId, p]));
  const out = [];
  const stack = [rootPid];
  const seen = new Set();
  while (stack.length) {
    const pid = stack.pop();
    if (seen.has(pid)) continue;
    seen.add(pid);
    const p = byPid.get(pid);
    if (p) out.push({ pid, name: p.Name, cpuMs: (Number(p.KernelModeTime) + Number(p.UserModeTime)) / 1e4, ws: Number(p.WorkingSetSize) });
    for (const c of children.get(pid) ?? []) stack.push(c.ProcessId);
  }
  return out;
}
export function treeTotals(tree) {
  if (!tree) return null;
  return { cpuMs: tree.reduce((s, p) => s + p.cpuMs, 0), ws: tree.reduce((s, p) => s + p.ws, 0), processes: tree.length };
}
