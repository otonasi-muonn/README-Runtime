# README Runtime と録画（アニメーションWebP・MP4）の比較

README に動くデモを載せるとき、README Runtime のSVGカードと、同じUIを録画したアニメーションWebP・MP4のどちらを選ぶべきかを実測します。目的は README Runtime が勝つ条件と負ける条件を特定することです。

## 条件

- **同じUI**: mockcraft カード（UIdesign の実コンポーネント、[`examples/mockcraft`](../examples/mockcraft)）。録画は、同じWasmで各状態を計算し、同じReactコンポーネントと同じCSSをヘッドレスChromiumのページに描画してスクリーンショットします（アプリを録画するのと同じ方法、[`record.mjs`](record.mjs)）。カードの枠（タイトル・STEP表示）は同じ配置のHTMLです。
- **同じ状態遷移と再生時間**: 1ステップ150ms、最後に12ステップ保持してループ。40・80・160・320ステップ（53〜333フレーム、8〜50秒）。録画は1ステップ1フレームです。
- **画質**: SVGはベクターで、どの倍率でも正確です。録画は WebP lossless（ソースと完全一致）、WebP lossy q80、MP4 H.264 CRF18・CRF28（yuv420p）、MP4 AV1（SVT-AV1 CRF35）。ソースフレームに対するSSIM・PSNRを実測します。
- **ビルド**: README Runtime は `readme-runtime build`（AssemblyScriptのコンパイル、バンドル、UIの推定、Wasmとの照合）。録画は全フレームの描画とffmpegでのエンコード。キャッシュは、README Runtime がロックファイル、録画が入力のハッシュとフレームのキャッシュ（表示内容が同じフレームを再利用）です。各値は3回の中央値です。

## 再現

```sh
npm ci                       # Playwright のブラウザも必要: npx playwright install chromium firefox webkit
node bench/pipeline.mjs      # ビルド時間・サイズ・画質（ffmpeg 7以上がPATHに必要）
node bench/playback.mjs      # 各ブラウザでの再生の正しさ・CPU・メモリ・Chromiumのトレース
node bench/githistory.mjs    # リポジトリの増え方
node bench/nesting.mjs       # 400ステップを超える深いネスト
node bench/github.mjs        # GitHubでの配信とREADMEでの表示可否
node bench/report.mjs        # 下の表を生成
```

`BENCH_STEPS=40,80`（ステップ数）、`BENCH_REPEAT=1`（繰り返し回数）で短縮できます。生成物は `bench/.work/`（gitignore）、数値は [`bench/results/`](results) に残ります。

## 結果

<!-- results:begin -->
<!-- results:end -->
