// What a demo costs the repository over time: commit successive design revisions (an accent
// colour change each) of each artifact into a scratch repository and measure the packed size
// after git gc. README Runtime commits the SVG, the lock and the .wasm; a recording commits
// the media file. Writes bench/results/git.json. Run: node bench/githistory.mjs
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { WORK, run, writeJson, environment } from './common.mjs';
import { renderFrames, encode, FORMATS } from './record.mjs';
import { makeProject, rrBuild, edit } from './project.mjs';

const N_LIST = (process.env.BENCH_GIT_STEPS ?? '160,320').split(',').map(Number);
const REVISIONS = Number(process.env.BENCH_REVISIONS ?? 8);
const KINDS = { svg: null, 'webp-lossless': 'webp', 'webp-q80': 'webp', 'mp4-h264-crf18': 'mp4' };

const git = (repo, ...args) => run('git', ['-C', repo, ...args]).stdout;
function initRepo(repo) {
  fs.rmSync(repo, { recursive: true, force: true });
  fs.mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.email', 'bench@example.invalid');
  git(repo, 'config', 'user.name', 'bench');
  git(repo, 'config', 'core.autocrlf', 'false');
}
function packKiB(repo) {
  git(repo, 'gc', '--aggressive', '--prune=now', '-q');
  return Number(/size-pack: (\d+)/.exec(git(repo, 'count-objects', '-v'))[1]);
}

const results = { environment: environment(), revisions: REVISIONS, n: {} };
const browser = await chromium.launch();
for (const N of N_LIST) {
  const dir = path.join(WORK, `git-n${N}`);
  makeProject(dir, N);
  const repos = Object.fromEntries(Object.keys(KINDS).map((k) => [k, path.join(WORK, `git-n${N}-${k}`)]));
  for (const repo of Object.values(repos)) initRepo(repo);
  const series = Object.fromEntries(Object.keys(KINDS).map((k) => [k, []]));
  const frames = path.join(WORK, `git-n${N}-frames`);
  for (let v = 0; v < REVISIONS; v++) {
    edit(dir, 'style', v);
    rrBuild(dir);
    // README Runtime: the files a project commits for the card
    const rr = repos.svg;
    fs.mkdirSync(path.join(rr, 'readme-runtime'), { recursive: true });
    fs.copyFileSync(path.join(dir, 'readme-runtime/mockcraft.svg'), path.join(rr, 'readme-runtime/mockcraft.svg'));
    fs.copyFileSync(path.join(dir, 'readme-runtime.lock.json'), path.join(rr, 'readme-runtime.lock.json'));
    fs.copyFileSync(path.join(dir, 'mc/logic.wasm'), path.join(rr, 'logic.wasm'));
    // recordings: the media file
    await renderFrames(dir, N, { out: frames, browser });
    for (const [k, ext] of Object.entries(KINDS)) {
      if (!ext) continue;
      encode(frames, path.join(repos[k], `demo.${ext}`), k);
    }
    for (const [k, repo] of Object.entries(repos)) {
      git(repo, 'add', '-A');
      git(repo, 'commit', '-q', '-m', `revision ${v}`);
      series[k].push(packKiB(repo));
    }
    console.log(`N=${N} revision ${v}`, JSON.stringify(Object.fromEntries(Object.entries(series).map(([k, s]) => [k, s.at(-1)]))));
  }
  results.n[N] = Object.fromEntries(Object.entries(series).map(([k, s]) => [k, {
    packKiB: s, firstKiB: s[0], afterKiB: s.at(-1), perRevisionKiB: Number(((s.at(-1) - s[0]) / (s.length - 1)).toFixed(1)),
  }]));
  writeJson('git.json', results);
}
await browser.close();
writeJson('git.json', results);
