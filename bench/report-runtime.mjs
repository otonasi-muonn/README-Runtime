// Turn bench/results/{clock,policy,readme}.json into the runtime tables of bench/README.md
// (between <!-- runtime:begin --> and <!-- runtime:end -->). Run: node bench/report-runtime.mjs
import fs from 'node:fs';
import path from 'node:path';
import { RESULTS, ROOT } from './common.mjs';

const load = (f) => { try { return JSON.parse(fs.readFileSync(path.join(RESULTS, f), 'utf8')); } catch { return null; } };
const table = (head, rows) => [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n');
const kb = (b) => `${(b / 1024).toFixed(1)} KB`;
// median [min–max] (n)
const st = (x, unit = '', d = 1) => (x ? `${x.median.toFixed(d)}${unit}（${x.min.toFixed(d)}〜${x.max.toFixed(d)}）` : '–');
const out = [];

const c = load('clock.json');
if (c) {
  const Ns = [...new Set(Object.keys(c.cards).map((k) => Number(k.split('-')[1])))].sort((a, b) => a - b);
  const engines = [...new Set(Object.keys(c.summary).map((k) => k.split('-')[0]))];
  const env = c.environment;
  out.push('### CSS ランタイムの改善: 時計と状態計算の分離', '',
    `条件: mockcraft カード、1ステップ 150 ms、保持 12 ステップ、ヘッドレス、${env.cpu}、${env.os}。改善前は \`${c.base}\`、改善後は \`${c.head}\` の生成器で同じプロジェクトから作ったカードです。再生の計測は改善前と改善後を交互に行い、各カード ${c.repeat} 回（160 ステップは ${c.mainRepeat} 回）。値は中央値（最小〜最大）です。CPU はブラウザのプロセス全体の CPU 時間（1コア＝100%）から空ページを引いた値、メモリはワーキングセットの増分です。CPU の数値はこの1台での計測で、保証値ではありません。`, '');
  const rows = [];
  for (const N of Ns) for (const e of engines) {
    const b = c.summary[`${e}-${N}-before`], a = c.summary[`${e}-${N}-after`];
    if (!b || !a) continue;
    const cut = b.cpuDelta && a.cpuDelta ? `${Math.round((1 - a.cpuDelta.median / b.cpuDelta.median) * 100)}%` : '–';
    rows.push([N, e, st(b.cpuDelta, ' %'), st(a.cpuDelta, ' %'), `**${cut}**`, `${st(b.memDeltaMB, ' MB', 0)} → ${st(a.memDeltaMB, ' MB', 0)}`,
      e === 'chromium' ? `${st(b.styleMsPerS, '', 0)} → ${st(a.styleMsPerS, '', 1)}` : '–',
      `${st(b.firstRenderMs, ' ms', 0)} → ${st(a.firstRenderMs, ' ms', 0)}`,
      `${b.plays && a.plays ? '' : '再生されない '}${st(a.rate, '', 2)}`]);
  }
  out.push(table(['ステップ', 'エンジン', 'CPU 改善前', 'CPU 改善後', '削減', 'メモリ増（前 → 後）', 'Chromium の style（ms/秒）', '初回描画（前 → 後）', '改善後の進み方（1 = 150 ms に1ステップ）'], rows), '');
  out.push('サイズとビルド時間（1回のビルド）:', '',
    table(['ステップ', 'gzip（前 → 後）', '非圧縮（前 → 後）', 'ビルド（前 → 後）'], Ns.map((N) => {
      const b = c.cards[`before-${N}`], a = c.cards[`after-${N}`];
      return [N, `${kb(b.gzip)} → **${kb(a.gzip)}**`, `${kb(b.raw)} → ${kb(a.raw)}`, `${(b.buildMs / 1000).toFixed(1)} s → ${(a.buildMs / 1000).toFixed(1)} s`];
    })), '');
}

// the improved card next to the recordings, measured in one session (bench/playback.mjs with
// BENCH_RESULTS=bench/results/same-session): the Phase 3 recordings' numbers are a day older
const ss = load('same-session/playback.json');
if (ss) {
  const formats = [...new Set(Object.values(ss.engines).flatMap((e) => Object.keys(e.artifacts)))];
  const name = (f) => f.replace(/^card-n\d+\.svg$/, 'README Runtime（改善後）').replace(/^n\d+\.(.+)\.\w+$/, '$1');
  out.push('### 改善後のカードと録画（同じセッションで、各1回）', '',
    `${ss.windowMs / 1000} 秒間の CPU（空ページとの差）とメモリの増分。160 ステップ、1ステップ 150 ms。`, '',
    table(['形式', ...Object.entries(ss.engines).map(([e, v]) => `${e} ${v.version}`)], formats.map((f) => [name(f), ...Object.values(ss.engines).map((e) => {
      const a = e.artifacts[f];
      return !a ? '–' : a.error ? `計測失敗（${a.error}）` : !a.plays ? '再生されない' : `${a.cpuDelta} % / +${a.cpu.workingSetMB - a.baseline.workingSetMB} MB`;
    })])), '');
}

const p = load('policy.json');
if (p) {
  const engines = Object.keys(p.engines);
  const late = (r) => (r ? `${r.moving ? '動いている' : '止まっている'}（ステップ ${r.frames.join('→')}）` : '–');
  out.push(`### 有限回の再生と無限ループ（${p.steps} ステップ、1周 ${(p.runMs / 1000).toFixed(1)} 秒）`, '',
    '「後から見る」: カードを長いページの下に置き、12 秒後（1周が終わった後）にスクロールして見たときの状態です。ブラウザが画面外のカードの時計を進めているなら、1回だけ再生するカードは見る前に終わっています。', '',
    table(['', ...engines.map((e) => `${e} ${p.engines[e].version}`)], [
      ['1回再生: 最初から表示', ...engines.map((e) => late(p.engines[e].reachedLate['once-inView']))],
      ['1回再生: 後から見る', ...engines.map((e) => late(p.engines[e].reachedLate['once-below']))],
      ['無限ループ: 後から見る', ...engines.map((e) => late(p.engines[e].reachedLate['endless-below']))],
    ]), '',
    'CPU（空ページとの差、6 秒間、各1回）:', '',
    table(['', ...engines], ['three', 'endless'].flatMap((v) => ['inView', 'below'].map((w) => {
      const label = `${v === 'three' ? '3回再生' : '無限ループ'}・${w === 'inView' ? '表示中' : '画面外'}`;
      return [label, ...engines.map((e) => { const r = p.engines[e].cpu[`${v}-${w}`]; return r ? `再生中 ${r.early} % → ${r.afterRunsAtS} 秒後 ${r.afterRuns} %` : '–'; })];
    }))), '');
  const longest = Math.max(0, ...engines.map((e) => p.engines[e].longView?.length ?? 0));
  if (longest) {
    out.push('長時間の表示（無限ループのカードを表示し続け、30 秒ごとに CPU と、表示前からのメモリの増分）:', '',
      table(['経過', ...engines], Array.from({ length: longest }, (_, i) => [`${(i + 1) * 30} 秒`, ...engines.map((e) => {
        const x = p.engines[e].longView?.[i];
        return x ? `${x.cpu} % / +${x.memDeltaMB} MB` : '–';
      })])), '');
  }
}

const lv = load('longview.json');
if (lv) {
  for (const [engine, e] of Object.entries(lv.engines)) {
    const names = Object.keys(e.artifacts);
    const label = { 'svg-endless': 'SVG（改善後、無限ループ）', 'svg-three-runs': 'SVG（改善後、3回再生）', 'svg-before-runtime-change': 'SVG（改善前、無限ループ）', 'webp-lossless': 'WebP lossless（ループ）' };
    out.push(`長時間の表示（${engine} ${e.version}、40 ステップのカードを ${lv.seconds} 秒表示し続け、30 秒ごとに CPU と、表示前からのメモリの増分。各1回）:`, '',
      table(['経過', ...names.map((n) => label[n] ?? n)], e.artifacts[names[0]].samples.map((_, i) => [`${(i + 1) * 30} 秒`, ...names.map((n) => {
        const x = e.artifacts[n].samples[i];
        return `${x.cpu} % / +${x.memDeltaMB} MB`;
      })])), '');
  }
}

// the README's own cards looping forever, minutes in view (bench/longview.mjs with
// BENCH_LONGVIEW_SET=readme BENCH_TAG=-readme)
for (const lr of ['longview-readme.json', 'longview-readme-webkit15.json', 'longview-readme-images-webkit15.json'].map(load).filter(Boolean)) {
  const engines = Object.keys(lr.engines);
  const names = [...new Set(engines.flatMap((e) => Object.keys(lr.engines[e].artifacts)))];
  const label = { mockcraft: 'mockcraft（無限ループ）', 'readme-images': 'README の画像3枚（無限ループ）' };
  for (const name of names) {
    const rows = Math.max(...engines.map((e) => lr.engines[e].artifacts[name]?.samples.length ?? 0));
    out.push(`長時間の表示: ${label[name] ?? name}、${lr.seconds / 60} 分（30 秒ごとの CPU / 表示前からのワーキングセットの増分 / プライベートメモリの増分、各1回）:`, '',
      table(['経過', ...engines.map((e) => `${e} ${lr.engines[e].version}`)], Array.from({ length: rows }, (_, i) => [`${((i + 1) * 30 / 60).toFixed(1)} 分`, ...engines.map((e) => {
        const x = lr.engines[e].artifacts[name]?.samples[i];
        const mb = (v) => `${v >= 0 ? '+' : ''}${v} MB`;
        return x ? `${x.cpu} % / ${mb(x.memDeltaMB)} / ${mb(x.privDeltaMB)}` : '–';
      })])), '');
  }
}

// the live README on github.com: does the mockcraft card move (bench/github-playback.mjs)
const scenes = [['first', '初回'], ['sameTabLater', '同じタブで90秒後'], ['reload', '再読み込み'], ['newTab', '別タブ'], ['awayAndBack', '移動して戻る'], ['freshProfile', '新しいコンテキスト']];
const modeName = { os: 'OS の設定（この機械は動きを減らす）', 'no-preference': '動きを減らさない（強制）', reduce: '動きを減らす（強制）' };
for (const [file, title] of [['github-playback-before.json', '修正前（有限回の再生）'], ['github-playback-after.json', '修正後（無限ループ）']]) {
  const g = load(file);
  if (!g) continue;
  const cell = (x) => (!x ? '–' : x.moving ? `動く（${x.steps.slice(0, 3).join('→')}）` : `**静止**（${x.steps[0]}）`);
  out.push(`### GitHub の README での mockcraft カード: ${title}`, '',
    `${g.url} を開き、カードの UI 部分を参照フレームと比べて表示中のステップを読みました（${g.environment.date.slice(0, 10)}、各1回）。${g.runs[0]?.served ? `配信された SVG の時計: \`${g.runs[0].served.clock}\`。` : ''}`, '',
    table(['エンジン', 'モード', ...scenes.map(([, n]) => n)], g.runs.map((r) => [`${r.engine} ${r.version}`, r.engine === 'webkit' && r.mode === 'os' ? '既定（Windows の Playwright WebKit は OS の設定を反映しない）' : modeName[r.mode] ?? r.mode, ...scenes.map(([k]) => cell(r[k]))])), '');
}

const r = load('readme.json');
if (r) {
  const engines = Object.keys(r.engines);
  const refs = Object.keys(r.pages);
  out.push(`### README 全体（GitHub が描画した README.md、${r.repeat} 回の中央値）`, '',
    '「先頭」は幅 1280・高さ 800 の画面で README の先頭を表示した状態、「全部」はすべてのカードが画面に入る高さの画面です。初回描画は、ページを開いてからすべての画像の decode と 2 フレームまでの時間です。', '',
    table(['README（コミット）', 'カード', ...engines.flatMap((e) => [`${e}: 先頭`, `${e}: 全部`, `${e}: 初回描画`])], refs.map((ref) => [
      `\`${r.pages[ref].sha.slice(0, 7)}\``, r.pages[ref].images.length,
      ...engines.flatMap((e) => {
        const t = r.engines[e][`${ref}-top`], a = r.engines[e][`${ref}-all`];
        return [t ? `${t.cpuDeltaMedian} %` : '–', a ? `${a.cpuDeltaMedian} %` : '–', t ? `${t.firstPaintMsMedian} ms` : '–'];
      }),
    ])), '');
}

const file = path.join(ROOT, 'bench/README.md');
const doc = fs.readFileSync(file, 'utf8');
const [a, b] = ['<!-- runtime:begin -->', '<!-- runtime:end -->'];
if (!doc.includes(a)) throw new Error(`bench/README.md has no ${a} marker`);
fs.writeFileSync(file, `${doc.slice(0, doc.indexOf(a) + a.length)}\n\n${out.join('\n')}\n${doc.slice(doc.indexOf(b))}`);
console.log(out.join('\n'));
