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
node bench/offscreen.mjs     # 画面外・「動きを減らす」設定での負荷
node bench/nesting.mjs       # 400ステップを超える深いネスト
node bench/githistory.mjs    # リポジトリの増え方
node bench/github.mjs        # GitHubでの配信とREADMEでの表示可否
node bench/report.mjs        # 下の表を生成
```

`npm run bench` で全部を順に実行します（約2時間）。同時に2つ実行すると、CPU とファイルを取り合って数値が狂います。`BENCH_STEPS=40,80`（ステップ数）、`BENCH_REPEAT=1`（繰り返し回数）で短縮できます。生成物は `bench/.work/`（gitignore）、数値は [`bench/results/`](results) に残ります。

## 結論（測定結果から）

数値はすべて下の「結果」の表から取っています。

| 観点 | README Runtime の SVG | 録画（アニメーション WebP / MP4） |
|---|---|---|
| GitHub の README に置けるか | 置ける（`<img>`、自動再生・ループ） | WebP は置ける。MP4 はリポジトリのファイルでは再生できない（`<video>` は除去され、`application/octet-stream` で配信され、CSP の `media-src` の外） |
| 転送量 | **8.6 KB で一定**（40〜320ステップ、gzip） | ステップ数に比例する。WebP 177 KB〜1.54 MB、MP4 24〜226 KB |
| 2倍の画面 | そのまま鮮明 | 2倍の解像度が要る（160ステップで WebP lossless 1.67 MB、MP4 311 KB） |
| 初回ビルド | 4.4〜5.7 秒（ステップ数にほぼ依存しない） | MP4 2.2〜11.3 秒、WebP lossless 3.0〜17.9 秒（ステップ数に比例）。**80ステップ以下は録画（MP4）が速く、160ステップ以上は README Runtime が速い** |
| デザインの変更 | 2.9〜4.4 秒 | 1.9〜18.8 秒（全フレームを描き直す） |
| CI での一致確認 | `check` 3.0〜4.4 秒で、カードがソースと一致することを確かめられる | 手段がない |
| Git 履歴（変更1回あたり） | **+0.6〜0.7 KiB** | WebP +0.65〜1.5 MB、MP4 +112〜218 KiB |
| 表示中の CPU（1コア＝100%） | **ステップ数に比例して重い**。40ステップで 19〜23%、80で 20〜39%、160で 43〜75%、320で 83〜112% | 0〜14% |
| 表示中のメモリ | Chromium ではステップ数とともに増える（+47〜+201 MB）。Firefox では録画より少ない（+33〜+40 MB） | Chromium で MP4 +28 MB、WebP +70〜+118 MB |
| 画面外・動きを減らす設定 | 画面外では Chromium と Firefox は止まるが、WebKit は止まらない（68%）。「動きを減らす」では静止する（Chromium・Firefox で確認） | 画面外では止まる。「動きを減らす」でも動き続ける。WebKit は MP4 のループを1回で止める |
| ステップ数の上限 | 400。超えると WebKit は 512 段で表示が壊れ、Chromium は 1024 段でクラッシュする。Chromium は 320ステップで更新が 1秒あたり 5.8 回に落ち、約13%のステップを飛ばす | 実質なし（ファイルが大きくなるだけ） |
| 表せる内容 | 整数の状態から計算できる UI（固定小数点、64値以内の切り替え、一次式の数値） | 何でも（Canvas、WebGL、動画、写真、Webフォント、実際の操作） |

**README Runtime を選ぶべきプロジェクト**

- GitHub の README に動くデモを置き、UI やロジックを今後も直していく。カードは変更のたびに数秒で作り直せる。CI の `check` がソースとの一致を保証し、Git 履歴もほとんど増えない。録画では、変更のたびに WebP なら 0.7〜1.5 MB ずつ増える。
- 状態遷移が長い（100ステップ以上）。転送量は 8.6 KB のままで、160ステップ以上ではビルドも録画より速い。
- 2倍の画面での鮮明さ、「動きを減らす」設定への対応、SVG の初期値を書き換えて別の状態を見せることに価値がある。
- 条件: 表示中の CPU を許容できること。CPU は「ステップ数 × 1秒あたりのステップ数」に比例する。Chromium では1ステップの更新ごとに、入れ子1段あたり約 0.47 ms かかる。40〜80ステップを 150 ms 間隔で進めると、1コアの 19〜39%。ステップを減らすか、間隔を長くすると下がる。

**録画を選ぶべき場合**

- 閲覧者の CPU や電池を優先する。録画は表示中 0〜14% だが、README Runtime は 160ステップ以上で 1コアの半分〜1コア分を使う。Safari（WebKit）では画面外でも止まらない。
- 短いデモ（80ステップ以下）で、ビルドの速さを優先する（MP4 2.2〜3.8 秒、README Runtime 4.4 秒）。
- README 以外（ドキュメントサイト、SNS、スライド、Issue のコメント）にも載せる。MP4 は小さく、どこでも再生できる。ただし GitHub の README に置けるのは WebP（または GIF）。
- README Runtime で表せない内容がある。Canvas・WebGL・動画・写真・Webフォント、浮動小数点の物理、400ステップを超える長さ、60fps の滑らかな動き、実際の操作の記録。

この比較の途中で、README Runtime の不具合を1件見つけて修正しました。装飾用の点滅アニメーションのせいで、静止中のカードでも毎フレーム全体を描き直していました（Chromium で 1コアの約 20%）。この点滅は「動きを減らす」設定にも従っていませんでした（134f97e）。

**測っていないこと**: 実機の Safari（macOS/iOS）、スマートフォン、電池の消費（CPU 時間で代用）、GPU を使う通常の画面表示（計測はすべてヘッドレス）、ネットワークの遅延、Web UI でアップロードした動画（user-attachments）、GIF。

**計測の限界**:
- 録画パイプラインは、コンポーネントを直接描画している。実際のアプリの起動や操作の自動化を含まないので、録画側に有利な条件。
- CPU は Windows のプロセス CPU 時間の 8 秒間の差分で、数ポイント揺れる。
- ビルド時間は、全体の再実行どうしで最大 2 割ほど違う。
- Playwright の「動きを減らす」の再現は `<img>` の中の SVG に届かないので、Chromium と Firefox はブラウザの設定で切り替えて測った。WebKit は未確認。

## 結果

<!-- results:begin -->

測定環境: AMD Ryzen 5 PRO 4650G with Radeon Graphics (12 threads)、メモリ 47.4 GB、Windows_NT 10.0.26200 x64、Node v22.21.0、ffmpeg version 9.0.1-full_build-www.gyan.dev。ブラウザはヘッドレス（Playwright の Chromium・Firefox・WebKit と、インストール済みの Chrome・Edge）。

### サイズ（閲覧者がダウンロードするバイト数）

GitHub は SVG を gzip で配信し、WebP と MP4 は圧縮せずに配信します（実測: [`github.json`](results/github.json)）。太字が実際の転送量です。

| ステップ（フレーム数、再生時間） | SVG | WebP lossless | WebP q80 | MP4 H.264 CRF18 | MP4 H.264 CRF28 | MP4 AV1 |
|---|---|---|---|---|---|---|
| 40（53、8.0 秒） | **8.6 KB**（非圧縮 61.5 KB） | **205.4 KB** | **176.6 KB** | **37.0 KB** | **23.8 KB** | **24.1 KB** |
| 80（93、13.9 秒） | **8.6 KB**（非圧縮 62.1 KB） | **404.7 KB** | **345.6 KB** | **63.8 KB** | **39.6 KB** | **38.1 KB** |
| 160（173、25.9 秒） | **8.6 KB**（非圧縮 63.5 KB） | **796.4 KB** | **683.9 KB** | **114.4 KB** | **69.5 KB** | **72.3 KB** |
| 320（333、50.0 秒） | **8.6 KB**（非圧縮 66.1 KB） | **1.54 MB** | **1.31 MB** | **225.8 KB** | **136.2 KB** | **137.7 KB** |

画質（ソースのフレームに対する SSIM / PSNR、320 ステップ、等倍）: SVG はベクターでどの倍率でも正確。webp-lossless 1 / ∞、webp-q80 0.982602 / 35.9 dB、mp4-h264-crf18 0.990004 / 36.4 dB、mp4-h264-crf28 0.987502 / 35.8 dB、mp4-av1-crf35 0.988464 / 36.2 dB。H.264 は yuv420p の色の間引きで、文字の色の縁が PSNR 35 dB 付近で頭打ちになります。

2倍の画面: SVG はそのまま鮮明です。録画を同じ鮮明さにするには2倍の解像度が要ります（160 ステップ）: webp-lossless 1.67 MB（等倍 796.4 KB）、webp-q80 1.45 MB（等倍 683.9 KB）、mp4-h264-crf18 311.1 KB（等倍 114.4 KB）。

### ビルド時間（3回の中央値）

README Runtime（RR）は `readme-runtime build`（CLI の起動、AssemblyScript のコンパイル、バンドル、UIの推定、Wasm との照合を含む）。録画（Rec）は全フレームの描画（ブラウザの起動を含む）とエンコード。ロジックの変更では両方とも同じ AssemblyScript を再コンパイルします。録画のフレームキャッシュは、表示内容が同じフレームを前の版から再利用します。

| ステップ | RR 初回 | RR 変更なし（キャッシュ） | RR 変更なし（キャッシュなし） | RR スタイル変更 | RR ロジック変更 | RR check（CI） | Rec 初回（MP4 〜 WebP lossless） | Rec 変更なし（キャッシュ） | Rec スタイル変更 | Rec ロジック変更（フレームキャッシュあり / なし） |
|---|---|---|---|---|---|---|---|---|---|---|
| 40 | 4.4 s | 180 ms | 4.2 s | 2.9 s | 4.1 s | 3.0 s | 2.2 s 〜 3.0 s | 2 ms | 1.9 s 〜 2.7 s | 2.4 s（22 フレーム再利用） / 3.4 s |
| 80 | 4.4 s | 165 ms | 4.6 s | 3.8 s | 4.5 s | 3.2 s | 3.8 s 〜 5.5 s | 2 ms | 3.2 s 〜 4.9 s | 3.7 s（22 フレーム再利用） / 4.4 s |
| 160 | 4.9 s | 154 ms | 4.7 s | 3.7 s | 4.7 s | 3.6 s | 6.4 s 〜 9.6 s | 2 ms | 6.1 s 〜 9.3 s | 6.8 s（22 フレーム再利用） / 7.0 s |
| 320 | 5.7 s | 154 ms | 5.7 s | 4.4 s | 5.6 s | 4.4 s | 11.3 s 〜 17.9 s | 3 ms | 12.1 s 〜 18.8 s | 12.3 s（22 フレーム再利用） / 12.7 s |

録画の時間は MP4（エンコードが最速）〜 WebP lossless（最遅）の幅です。録画には CI で「生成物がソースと一致するか」を確かめる手段がなく、RR の `check` に当たる列はありません。

### リポジトリの増え方（デザインを 8 回変更してコミット、git gc 後の pack サイズ）

| ステップ | README Runtime（SVG＋ロック＋wasm） | WebP lossless | WebP q80 | MP4 H.264 CRF18 |
|---|---|---|---|---|
| 160 | 15 KiB（1回あたり +0.6 KiB） | 6197 KiB（1回あたり +775.3 KiB） | 5317 KiB（1回あたり +664.6 KiB） | 897 KiB（1回あたり +112.3 KiB） |
| 320 | 16 KiB（1回あたり +0.7 KiB） | 12245 KiB（1回あたり +1531.9 KiB） | 10448 KiB（1回あたり +1306.1 KiB） | 1742 KiB（1回あたり +217.9 KiB） |

### 再生（ヘッドレス、表示中の 8 秒間、空ページとの差）

CPU はブラウザのプロセス全体の CPU 時間（1コア＝100%）、メモリはワーキングセットの増分です。正しさは、表示中のフレームがソースのどれかと一致し、150 ms ごとに1ステップ進むことで判定します。Chromium の列は、トレースから求めた1秒あたりの処理時間（ms）です。

| ブラウザ | ステップ | 形式 | 正しく再生 | CPU | メモリ | Chromium のトレース（ms/秒） |
|---|---|---|---|---|---|---|
| chromium 159.0.8154.6 | 40 | SVG | ○（0.97） | 23.4 % | +47 MB | style 130.9（6.5 回/秒 × 19.3 ms）、paint 4.7、raster 6.6、video 0 |
| chromium 159.0.8154.6 | 40 | webp-lossless | ○（0.98） | 5.6 % | +71 MB | style 0、paint 0、raster 1.8、video 0 |
| chromium 159.0.8154.6 | 40 | webp-q80 | ○（1.01） | 3.7 % | +70 MB | style 0、paint 0、raster 1.8、video 0 |
| chromium 159.0.8154.6 | 40 | mp4-h264-crf18 | ○（0.97） | 3.0 % | +28 MB | style 0、paint 0.1、raster 0、video 0 |
| chromium 159.0.8154.6 | 40 | mp4-av1-crf35 | ○（1.01） | 2.3 % | +37 MB | style 0、paint 0.1、raster 0、video 0 |
| chromium 159.0.8154.6 | 80 | SVG | ○（0.98） | 36.3 % | +71 MB | style 243（6.5 回/秒 × 36.7 ms）、paint 5.8、raster 8.3、video 0 |
| chromium 159.0.8154.6 | 80 | webp-lossless | ○（1.04） | 8.6 % | +115 MB | style 0、paint 0、raster 2.8、video 0 |
| chromium 159.0.8154.6 | 80 | webp-q80 | ○（0.9） | 4.2 % | +114 MB | style 0、paint 0、raster 3.5、video 0 |
| chromium 159.0.8154.6 | 80 | mp4-h264-crf18 | ○（1.03） | 2.1 % | +27 MB | style 0、paint 0、raster 0、video 0 |
| chromium 159.0.8154.6 | 80 | mp4-av1-crf35 | ○（1.02） | 1.8 % | +36 MB | style 0、paint 0、raster 0、video 0 |
| chromium 159.0.8154.6 | 160 | SVG | ○（1.03） | 65.8 % | +127 MB | style 494.7（6.5 回/秒 × 75.7 ms）、paint 6.8、raster 9.1、video 0 |
| chromium 159.0.8154.6 | 160 | webp-lossless | ○（1） | 4.9 % | +115 MB | style 0、paint 0、raster 2.5、video 0 |
| chromium 159.0.8154.6 | 160 | webp-q80 | ○（0.97） | 5.6 % | +114 MB | style 0、paint 0、raster 2.6、video 0 |
| chromium 159.0.8154.6 | 160 | mp4-h264-crf18 | ○（1.03） | 3.2 % | +28 MB | style 0、paint 0、raster 0、video 0 |
| chromium 159.0.8154.6 | 160 | mp4-av1-crf35 | ○（1） | 3.9 % | +37 MB | style 0、paint 0、raster 0、video 0 |
| chromium 159.0.8154.6 | 320 | SVG | ○（1.01） | 111.6 % | +201 MB | style 865.9（5.8 回/秒 × 150.6 ms）、paint 8.5、raster 9.5、video 0 |
| chromium 159.0.8154.6 | 320 | webp-lossless | ○（0.98） | 7.4 % | +117 MB | style 0、paint 0、raster 2.7、video 0 |
| chromium 159.0.8154.6 | 320 | webp-q80 | ○（1.01） | 8.1 % | +118 MB | style 0、paint 0、raster 2.6、video 0 |
| chromium 159.0.8154.6 | 320 | mp4-h264-crf18 | ○（1.01） | 1.1 % | +28 MB | style 0、paint 0、raster 0、video 0 |
| chromium 159.0.8154.6 | 320 | mp4-av1-crf35 | ○（1.01） | 0.9 % | +38 MB | style 0、paint 0、raster 0、video 0 |
| firefox 159.0 | 40 | SVG | ○（1） | 21.5 % | +36 MB | – |
| firefox 159.0 | 40 | webp-lossless | ○（1.02） | 5.3 % | +54 MB | – |
| firefox 159.0 | 40 | webp-q80 | ○（1） | 3.4 % | +54 MB | – |
| firefox 159.0 | 40 | mp4-h264-crf18 | ○（0.97） | 0.0 % | +48 MB | – |
| firefox 159.0 | 40 | mp4-av1-crf35 | ○（0.97） | 6.1 % | +45 MB | – |
| firefox 159.0 | 80 | SVG | ○（1.05） | 20.0 % | +33 MB | – |
| firefox 159.0 | 80 | webp-lossless | ○（0.89） | 0.0 % | +57 MB | – |
| firefox 159.0 | 80 | webp-q80 | ○（0.9） | 2.8 % | +54 MB | – |
| firefox 159.0 | 80 | mp4-h264-crf18 | ○（1.07） | 4.6 % | +45 MB | – |
| firefox 159.0 | 80 | mp4-av1-crf35 | ○（1.06） | 3.0 % | +51 MB | – |
| firefox 159.0 | 160 | SVG | ○（0.99） | 43.0 % | +34 MB | – |
| firefox 159.0 | 160 | webp-lossless | ○（0.97） | 0.6 % | +56 MB | – |
| firefox 159.0 | 160 | webp-q80 | ○（1.04） | 2.3 % | +56 MB | – |
| firefox 159.0 | 160 | mp4-h264-crf18 | ○（0.98） | 3.4 % | +46 MB | – |
| firefox 159.0 | 160 | mp4-av1-crf35 | ○（1.02） | 1.7 % | +44 MB | – |
| firefox 159.0 | 320 | SVG | ○（1.02） | 82.6 % | +40 MB | – |
| firefox 159.0 | 320 | webp-lossless | ○（1.03） | 4.0 % | +59 MB | – |
| firefox 159.0 | 320 | webp-q80 | ○（1.03） | 0.9 % | +57 MB | – |
| firefox 159.0 | 320 | mp4-h264-crf18 | ○（0.99） | 1.1 % | +50 MB | – |
| firefox 159.0 | 320 | mp4-av1-crf35 | ○（0.99） | 2.4 % | +53 MB | – |
| webkit 27.2 | 40 | SVG | ○（1.01） | 21.6 % | +42 MB | – |
| webkit 27.2 | 40 | webp-lossless | ○（1.04） | 6.5 % | +93 MB | – |
| webkit 27.2 | 40 | webp-q80 | ○（1.02） | 12.7 % | +93 MB | – |
| webkit 27.2 | 40 | mp4-h264-crf18 | × 止まる（ループ後に再生されない） | 9.5 % | +72 MB | – |
| webkit 27.2 | 40 | mp4-av1-crf35 | × 再生されない | 未測定 | 未測定 | – |
| webkit 27.2 | 80 | SVG | ○（0.98） | 39.0 % | +59 MB | – |
| webkit 27.2 | 80 | webp-lossless | ○（0.96） | 0.0 % | +37 MB | – |
| webkit 27.2 | 80 | webp-q80 | ○（1.03） | 0.0 % | +32 MB | – |
| webkit 27.2 | 80 | mp4-h264-crf18 | × 止まる（ループ後に再生されない） | 11.9 % | +73 MB | – |
| webkit 27.2 | 80 | mp4-av1-crf35 | × 再生されない | 未測定 | 未測定 | – |
| webkit 27.2 | 160 | SVG | ○（1.05） | 75.2 % | +90 MB | – |
| webkit 27.2 | 160 | webp-lossless | ○（1.01） | 12.8 % | +33 MB | – |
| webkit 27.2 | 160 | webp-q80 | ○（1） | 0.2 % | +33 MB | – |
| webkit 27.2 | 160 | mp4-h264-crf18 | ○（0.97） | 14.1 % | +73 MB | – |
| webkit 27.2 | 160 | mp4-av1-crf35 | × 再生されない | 未測定 | 未測定 | – |
| webkit 27.2 | 320 | SVG | ○（1.01） | 98.4 % | +109 MB | – |
| webkit 27.2 | 320 | webp-lossless | ○（1.03） | 8.8 % | +35 MB | – |
| webkit 27.2 | 320 | webp-q80 | ○（1.01） | 8.4 % | +35 MB | – |
| webkit 27.2 | 320 | mp4-h264-crf18 | ○（1） | 13.0 % | +74 MB | – |
| webkit 27.2 | 320 | mp4-av1-crf35 | × 再生されない | 未測定 | 未測定 | – |
| chrome 157.0.8103.79 | 40 | SVG | ○（0.99） | 18.6 % | +53 MB | style 128.5（6.8 回/秒 × 18.3 ms）、paint 3.9、raster 1、video 0 |
| chrome 157.0.8103.79 | 40 | webp-lossless | ○（1.02） | 0.0 % | +18 MB | style 0、paint 0、raster 0.3、video 0 |
| chrome 157.0.8103.79 | 40 | mp4-h264-crf18 | ○（1） | 0.0 % | +56 MB | style 0、paint 0.1、raster 0、video 3 |
| chrome 157.0.8103.79 | 80 | SVG | ○（0.95） | 29.8 % | +78 MB | style 241（6.5 回/秒 × 36.4 ms）、paint 5、raster 1.1、video 0 |
| chrome 157.0.8103.79 | 80 | webp-lossless | ○（0.88） | 0.0 % | +22 MB | style 0、paint 0、raster 0.4、video 0 |
| chrome 157.0.8103.79 | 80 | mp4-h264-crf18 | ○（1.18） | 0.0 % | +50 MB | style 0、paint 0、raster 0、video 21.3 |
| chrome 157.0.8103.79 | 160 | SVG | ○（1） | 55.9 % | +127 MB | style 482.3（6.5 回/秒 × 73.7 ms）、paint 5.8、raster 1.2、video 0 |
| chrome 157.0.8103.79 | 160 | webp-lossless | ○（0.97） | 0.0 % | +23 MB | style 0、paint 0、raster 0.5、video 0 |
| chrome 157.0.8103.79 | 160 | mp4-h264-crf18 | ○（0.97） | 0.0 % | +50 MB | style 0、paint 0、raster 0、video 2.2 |
| chrome 157.0.8103.79 | 320 | SVG | ○（1.02） | 102.7 % | +168 MB | style 869.2（6 回/秒 × 144.9 ms）、paint 6.8、raster 1、video 0 |
| chrome 157.0.8103.79 | 320 | webp-lossless | ○（1） | 0.0 % | +26 MB | style 0、paint 0、raster 0.5、video 0 |
| chrome 157.0.8103.79 | 320 | mp4-h264-crf18 | ○（0.99） | 0.0 % | +49 MB | style 0、paint 0、raster 0、video 2.7 |
| msedge 158.0.4370.33 | 40 | mp4-h264-crf18 | ○（0.93） | 0.0 % | +76 MB | – |
| msedge 158.0.4370.33 | 80 | mp4-h264-crf18 | ○（1.17） | 2.1 % | +78 MB | – |
| msedge 158.0.4370.33 | 160 | mp4-h264-crf18 | ○（1.02） | 1.4 % | +70 MB | – |
| msedge 158.0.4370.33 | 320 | mp4-h264-crf18 | ○（1.04） | 1.0 % | +72 MB | – |

### 見ていないときの負荷（160 ステップ、CPU の空ページとの差）

|  | chromium 159.0.8154.6 | firefox 159.0 | webkit 27.2 |
|---|---|---|---|
| svg visible | 69.3 %（動く） | 42.1 %（動く） | 75.8 %（動く） |
| svg scrolled out of view | 0.0 % | 0.0 % | 67.9 % |
| webp-lossless visible | 7.4 %（動く） | 3.0 %（動く） | 16.5 %（動く） |
| webp-lossless scrolled out of view | 0.0 % | 2.4 % | 0.0 % |
| mp4-h264-crf18 visible | 1.0 %（動く） | 8.0 %（動く） | 15.8 %（動く） |
| mp4-h264-crf18 scrolled out of view | 0.2 % | 0.0 % | 1.2 % |
| svg reduced motion | 0.0 %（静止） | 0.0 %（静止） | 73.9 %（動く） |
| webp-lossless reduced motion | 4.7 %（動く） | 1.9 %（動く） | 6.0 %（動く） |
| mp4-h264-crf18 reduced motion | 2.4 %（動く） | 6.6 %（動く） | 18.8 %（動く） |

### 深いネスト（1ステップ＝入れ子1段。製品は 400 ステップで打ち切り）

| ステップ | カード | 生成 | chromium: 最深の状態 | chromium: 初回描画 | chromium: 再生中の CPU | firefox: 最深の状態 | firefox: 初回描画 | firefox: 再生中の CPU | webkit: 最深の状態 | webkit: 初回描画 | webkit: 再生中の CPU |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 160 | 63 KB | 3.6 s | 正しい | 84 ms | 81.4 %（style 6.6 回/秒 × 72.7 ms） | 正しい | 128 ms | 50.2 % | 正しい | 138 ms | 73.3 % |
| 320 | 66 KB | 4.3 s | 正しい | 183 ms | 112.5 %（style 5.6 回/秒 × 157.3 ms） | 正しい | 163 ms | 92.9 % | 正しい | 247 ms | 99.9 % |
| 400 | 67 KB | 4.3 s | 正しい | 250 ms | 117.5 %（style 4.8 回/秒 × 180.2 ms） | 正しい | 216 ms | 112.4 % | 正しい | 288 ms | 100.9 % |
| 480 | 68 KB | 5.2 s | 正しい | 224 ms | 120.6 %（style 4.2 回/秒 × 219.4 ms） | 正しい | 240 ms | 112.9 % | 正しい | 357 ms | 100.6 % |
| 512 | 69 KB | 5.2 s | 正しい | 239 ms | 116.6 %（style 3.8 回/秒 × 234.9 ms） | 正しい | 218 ms | 104.9 % | 誤り（181641 px） | 361 ms | 91.8 % |
| 544 | 69 KB | 5.0 s | 正しい | 254 ms | 110.4 %（style 3.6 回/秒 × 248.3 ms） | 正しい | 228 ms | 105 % | 誤り（181843 px） | 366 ms | 96.3 % |
| 640 | 71 KB | 5.5 s | 正しい | 334 ms | 112.1 %（style 3.2 回/秒 × 290.5 ms） | 正しい | 307 ms | 109 % | 誤り（181753 px） | 352 ms | 96.5 % |
| 800 | 74 KB | 6.4 s | 正しい | 381 ms | 111.3 %（style 2.6 回/秒 × 364 ms） | 正しい | 348 ms | 103.8 % | 誤り（181261 px） | 364 ms | 93.7 % |
| 1024 | 77 KB | 8.8 s | クラッシュ（page.evaluate: Target crashed ） | – | – | 正しい | 457 ms | 103.5 % | 誤り（181772 px） | 358 ms | 93.9 % |

### GitHub の README での扱い（実測）

|  | SVG（README Runtime） | アニメーション WebP | MP4（コミットしたファイル） |
|---|---|---|---|
| Markdown の変換 | `<img>`（残る） | `<img>`（残る） | `<video>` は除去される。`![](x.mp4)` は `<img>` になり再生できない |
| 配信（raw.githubusercontent.com） | image/svg+xml、gzip | image/webp、圧縮なし | application/octet-stream、圧縮なし |
| ページの CSP | img-src で許可 | img-src で許可 | media-src は 7 個のホストのみで、raw.githubusercontent.com を含まない |
| README で自動再生・ループ | できる | できる | できない（web UI でアップロードした user-attachments の動画は再生ボタンつきで表示されると説明されているが、本実験では未検証） |

<!-- results:end -->
