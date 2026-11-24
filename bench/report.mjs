// Turn bench/results/*.json into the tables of bench/README.md (between the markers).
// Run: node bench/report.mjs
import fs from 'node:fs';
import path from 'node:path';
import { RESULTS, ROOT } from './common.mjs';

const load = (f) => { try { return JSON.parse(fs.readFileSync(path.join(RESULTS, f), 'utf8')); } catch { return null; } };
const kb = (b) => (b == null ? '–' : b >= 1024 * 1024 ? `${(b / 2 ** 20).toFixed(2)} MB` : `${(b / 1024).toFixed(1)} KB`);
const s = (ms) => (ms == null ? '–' : ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`);
const table = (head, rows) => [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n');
const round1 = (x) => Number(x.toFixed(1));
const label = (name) => name.replace(/^card-n(\d+)\.svg$/, 'SVG').replace(/^n\d+\.(.+)\.\w+$/, '$1');
const stepsOf = (name) => Number(/n(\d+)/.exec(name)[1]);
const out = [];

const p = load('pipeline.json');
const env = p?.environment;
if (env) out.push(`測定環境: ${env.cpu}、メモリ ${env.ramGB} GB、${env.os}、Node ${env.node}、${env.ffmpeg?.split(' Copyright')[0]}。ブラウザはヘッドレス（Playwright の Chromium・Firefox・WebKit と、インストール済みの Chrome・Edge）。`, '');

if (p) {
  const Ns = Object.keys(p.n).map(Number);
  const enc = (n, f) => p.n[n].rec.encode[f];
  out.push('### サイズ（閲覧者がダウンロードするバイト数）', '',
    'GitHub は SVG を gzip で配信し、WebP と MP4 は圧縮せずに配信します（実測: [`github.json`](results/github.json)）。太字は転送量の目安で、SVG は gzip -9 のサイズ、WebP と MP4 はファイルサイズです。GitHub が実際に配信した 160 ステップの SVG は、gzip で 8,960 B でした。', '',
    table(['ステップ（フレーム数、再生時間）', 'SVG', 'WebP lossless', 'WebP q80', 'MP4 H.264 CRF18', 'MP4 H.264 CRF28', 'MP4 AV1'], Ns.map((n) => [
      `${n}（${p.n[n].frames}、${(p.n[n].durationMs / 1000).toFixed(1)} 秒）`, `**${kb(p.n[n].rr.size.gzip)}**（非圧縮 ${kb(p.n[n].rr.size.raw)}）`,
      ...['webp-lossless', 'webp-q80', 'mp4-h264-crf18', 'mp4-h264-crf28', 'mp4-av1-crf35'].map((f) => `**${kb(enc(n, f).size.raw)}**`),
    ])), '');
  const n0 = Ns[Ns.length - 1];
  out.push(`画質（ソースのフレームに対する SSIM / PSNR、${n0} ステップ、等倍。全画面の値なので、背景が広いほど高く出ます）: SVG はベクターで、拡大しても再描画されます（2倍の画面での画質比較はしていません）。` +
    ['webp-lossless', 'webp-q80', 'mp4-h264-crf18', 'mp4-h264-crf28', 'mp4-av1-crf35'].map((f) => `${f} ${enc(n0, f).ssim} / ${enc(n0, f).psnr === 'inf' ? '∞' : `${enc(n0, f).psnr.toFixed(1)} dB`}`).join('、') +
    '。H.264 は yuv420p の色の間引きで、文字の色の縁が PSNR 35 dB 付近で頭打ちになります。', '');
  if (p.hidpi) {
    const h = p.hidpi;
    out.push(`2倍の画面: 録画を2倍の解像度で作るとサイズが増えます（${h.n} ステップ）: ` +
      Object.entries(h.encode).map(([f, e]) => `${f} ${kb(e.size.raw)}（等倍 ${kb(enc(h.n, f).size.raw)}）`).join('、') + '。', '');
  }
  out.push('### ビルド時間（3回の中央値）', '',
    'README Runtime（RR）は `readme-runtime build`（CLI の起動、AssemblyScript のコンパイル、バンドル、UIの推定、Wasm との照合を含む）。録画（Rec）は全フレームの描画（ブラウザの起動を含む）とエンコードで、初回とロジックの変更には RR と同じ AssemblyScript のコンパイルを加えています。録画のスタイル変更とロジック変更のエンコード時間は、元の版のエンコード時間の中央値で代用しています（推計）。録画のフレームキャッシュは、表示内容が同じフレームを前の版から再利用します。「変更なし（キャッシュ）」は、RR が CLI の起動を含み、録画はプロセス内のハッシュ計算だけです。同じ条件で全体を再実行すると、ビルド時間は最大 2 割ほど変わります。', '',
    table(['ステップ', 'RR 初回', 'RR 変更なし（キャッシュ）', 'RR 変更なし（キャッシュなし）', 'RR スタイル変更', 'RR ロジック変更', 'RR check（CI）', 'Rec 初回（コンパイル込み、MP4 〜 WebP lossless）', 'Rec 変更なし（キャッシュ）', 'Rec スタイル変更', 'Rec ロジック変更（フレームキャッシュあり / なし）'], Ns.map((n) => {
      const rr = p.n[n].rr, rec = p.n[n].rec;
      const w = enc(n, 'webp-lossless').ms, m = enc(n, 'mp4-h264-crf18').ms;
      return [n, s(rr.coldMs), s(rr.noopCachedMs), s(rr.noopForcedMs), s(rr.styleEditMs), s(rr.logicEditMs), s(rr.checkMs),
        `${s(rec.ascMs + rec.framesColdMs + m)} 〜 ${s(rec.ascMs + rec.framesColdMs + w)}`, s(rec.noopCachedMs), `${s(rec.styleFramesMs + m)} 〜 ${s(rec.styleFramesMs + w)}`,
        `${s(rec.ascMs + rec.logicFramesCachedMs + m)}（${rec.logicFramesReused} フレーム再利用） / ${s(rec.ascMs + rec.logicFramesUncachedMs + m)}`];
    })), '',
    '録画の時間は MP4（エンコードが最速）〜 WebP lossless（最遅）の幅です。RR の `check` は、カードがソースと一致することを CI で確かめる標準の機能です。今回の録画パイプラインには同等の確認を実装していません。再描画して比べれば実装はできますが、エンコーダーの出力が環境をまたいで同じバイトになるかは確かめていません。', '');
}

const g = load('git.json');
if (g) {
  out.push(`### リポジトリの増え方（最初の版と、アクセントカラーだけを変えた ${g.revisions - 1} 回の変更をコミット、git gc 後の pack サイズ）`, '',
    'レイアウトやロジックの変更、依存の更新、Git LFS、浅い clone は試していません。', '',
    table(['ステップ', 'README Runtime（SVG＋ロック＋wasm）', 'WebP lossless', 'WebP q80', 'MP4 H.264 CRF18'], Object.entries(g.n).map(([n, r]) => [n,
      ...['svg', 'webp-lossless', 'webp-q80', 'mp4-h264-crf18'].map((k) => `${r[k].afterKiB} KiB（1回あたり +${r[k].perRevisionKiB} KiB）`)])), '');
}

const pb = load('playback.json');
if (pb) {
  const rows = [];
  for (const [engine, e] of Object.entries(pb.engines)) {
    if (e.error && !Object.keys(e.artifacts ?? {}).length) { rows.push([engine, '–', '–', `起動できず: ${e.error}`, '', '', '']); continue; }
    for (const [name, a] of Object.entries(e.artifacts)) {
      const tr = a.trace;
      const rate = a.match?.rate;
      // three samples (~0.8 s) on the same frame outside the hold: playback has stopped
      const N = stepsOf(name);
      const stuck = (a.match?.samples ?? []).some((x, i, all) => i >= 2 && x[1] < N && all[i - 1][1] === x[1] && all[i - 2][1] === x[1]);
      // a screenshot lands up to ~1 frame late, so a rate from a few pairs is only good to ±25%
      const ok = a.error ? `計測失敗（${a.error}）` : !a.plays ? '× 再生されない' : stuck ? '× 止まる（ループ後に再生されない）' : rate == null ? '？（保持中のみ観測）'
        : rate > 0.75 && rate < 1.25 && a.match.maxDistance < 6 ? `○（${rate}）` : `△（速度 ${rate}）`;
      const measured = a.cpu && a.baseline;
      const delta = a.cpuDelta ?? (measured ? round1(a.cpu.cpuPercent - a.baseline.cpuPercent) : null);
      rows.push([`${engine} ${e.version}`, stepsOf(name), label(name), ok,
        delta == null ? '未測定' : `${delta.toFixed(1)} %`, measured ? `+${a.cpu.workingSetMB - a.baseline.workingSetMB} MB` : '未測定',
        tr ? `style ${tr.msPerSecond.style ?? 0}${tr.styleUpdates?.perSecond ? `（${tr.styleUpdates.perSecond} 回/秒 × ${tr.styleUpdates.meanMs} ms）` : ''}、paint ${tr.msPerSecond.paint ?? 0}、raster ${tr.msPerSecond.raster ?? 0}、video ${tr.msPerSecond.videoDecode ?? (/mp4/.test(name) ? '未観測' : 0)}` : '–']);
    }
  }
  out.push(`### 再生（ヘッドレス、表示中の約 ${pb.windowMs / 1000} 秒間、各1回の計測）`, '',
    'CPU はブラウザのプロセス全体の CPU 時間（1コア＝100%）から、前後に測った空ページの平均を引いた値です（負の値もそのまま表示）。CPU の採取（Windows の CIM 問い合わせ）には約 1 秒以上かかるため、数ポイントの差は区別できません。メモリはワーキングセットの増分で、共有ページを重複して数えます。「サンプル」は、約 4 秒間に撮った 14 枚の画面が、それぞれソースのどれかのフレームと一致し、平均して 150 ms に1ステップ進むことを表します。途中のステップが飛んでも平均が合えば ○ になり、色の正しさの確認でもありません（画素単位の正しさは `test/browser/ui.js` で確認）。ループの正しさは次の表です。Chromium の列は、トレースから求めた1秒あたりの処理時間（ms、同じスレッドで重なる区間は1回だけ数える）です。', '',
    table(['ブラウザ', 'ステップ', '形式', 'サンプルの一致と平均速度', 'CPU', 'メモリ', 'Chromium のトレース（ms/秒）'], rows), '');
  const lp = load('loop.json');
  if (lp) {
    const kinds = Object.keys(Object.values(lp.engines)[0].artifacts);
    out.push(`ループ（${lp.steps} ステップ、約 ${(lp.durationMs / 1000).toFixed(0)} 秒を1周以上見て、2周目に入っても進むか）:`, '',
      table(['', ...kinds], Object.entries(lp.engines).map(([e, v]) => [`${e} ${v.version}`, ...kinds.map((k) => (!v.artifacts[k].plays ? '再生されない' : v.artifacts[k].loops ? 'ループする' : '**1周で止まる**'))])), '');
  }
}

const off = load('offscreen.json');
if (off) {
  const cases = [...new Set(Object.values(off.engines).flatMap((e) => Object.keys(e.cases)))];
  out.push(`### 見ていないときの負荷（${off.steps} ステップ、CPU の空ページとの差、各1回）`, '',
    '「動きを減らす」は Chromium と Firefox ではブラウザの設定で切り替えています。Playwright の WebKit（Windows）では、ページ単位の再現が `<img>` の中の SVG に届かないため、確かめられていません。', '',
    table(['', ...Object.entries(off.engines).map(([k, e]) => `${k} ${e.version}`)], cases.map((c) => [c, ...Object.values(off.engines).map((e) => {
      const v = e.cases[c];
      return v == null ? '–' : `${v.cpuPercent.toFixed(1)} %${v.moving == null ? '' : v.moving ? '（動く）' : '（静止）'}`;
    })])), '');
}

const ne = load('nesting.json');
if (ne) {
  const Ns = Object.keys(ne.cards).map(Number);
  const cell = (d) => {
    if (!d) return ['–', '–', '–'];
    if (d.crashed) return [`クラッシュ（${d.crashed.slice(0, 40)}）`, '–', '–'];
    const deep = d.correct.deepest;
    return [deep.ok ? '正しい' : `誤り（${deep.differingPx} px）`, s(deep.firstRenderMs),
      `${d.animation.cpuPercent} %${d.animation.style ? `（style ${d.animation.style.updatesPerS} 回/秒 × ${d.animation.style.meanMs} ms）` : ''}`];
  };
  out.push(`### 深いネスト（1ステップ＝入れ子1段。製品は ${ne.maxSteps} ステップで打ち切り）`, '',
    '「最深の状態」は、時計を最後のステップに固定したカードの UI が、同じ状態を描いたページと一致するか（Chromium は CSS カウンタの字送りのため 150 px まで許容）。「初回描画」は `img.decode()` と 2 フレーム待ちまでの時間で、1 回の計測です。クラッシュは、この UI とこのマシンでの観測です。', '',
    table(['ステップ', 'カード', '生成', ...Object.keys(ne.engines).flatMap((e) => [`${e}: 最深の状態`, `${e}: 初回描画`, `${e}: 再生中の CPU`])],
      Ns.map((n) => [n, `${(ne.cards[n].bytes / 1024).toFixed(0)} KB`, s(ne.cards[n].generateMs), ...Object.values(ne.engines).flatMap((e) => cell(e.depths[n]))])), '');
}

const gh = load('github.json');
if (gh) {
  const kept = (re) => (re.test(gh.markdown.html) ? '残る' : '除去される');
  out.push('### GitHub の README での扱い（実測）', '',
    table(['', 'SVG（README Runtime）', 'アニメーション WebP', 'MP4（コミットしたファイル）'], [
      ['Markdown の変換', `\`<img>\`（${kept(/<img src="demo\.svg"/)}）`, `\`<img>\`（${kept(/<img src="demo\.webp"/)}）`, `\`<video>\` は${kept(/<video/)}。\`![](x.mp4)\` は \`<img>\` になり再生できない`],
      ['配信（raw.githubusercontent.com）', `${gh.contentTypes.svg.contentType}、${gh.contentTypes.svg.contentEncoding ?? '圧縮なし'}`, `${gh.contentTypes.webp.contentType}、${gh.contentTypes.webp.contentEncoding ?? '圧縮なし'}`, `${gh.contentTypes.mp4.contentType}、${gh.contentTypes.mp4.contentEncoding ?? '圧縮なし'}`],
      ['ページの CSP', 'img-src で許可', 'img-src で許可', `media-src は ${gh.csp['media-src'].length} 個のホストのみで、raw.githubusercontent.com を含まない`],
      ['README で自動再生・ループ', 'できる', 'できる', 'できない（web UI でアップロードした user-attachments の動画は再生ボタンつきで表示されると説明されているが、本実験では未検証）'],
    ]), '');
}

const file = path.join(ROOT, 'bench/README.md');
const doc = fs.readFileSync(file, 'utf8');
const [a, b] = ['<!-- results:begin -->', '<!-- results:end -->'];
fs.writeFileSync(file, `${doc.slice(0, doc.indexOf(a) + a.length)}\n\n${out.join('\n')}\n${doc.slice(doc.indexOf(b))}`);
console.log(out.join('\n'));
