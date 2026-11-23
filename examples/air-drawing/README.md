# air-drawing-board の再利用実験

実際の保存データを、元の `decodeDrawing()` と `renderStroke()` を変更せずに使って再生できた。カメラで描くアプリ全体の移植ではなく、描画処理と配色・太さ・CSSを再利用した README カードである。

![実際の描画データを再生するカード](../../readme-runtime/air-drawing.svg)

上流は `otonasi-muonn/air-drawing-board` のコミット `d71f3368114119d9a47edf53b8cce6768c393b1a`。`tools/sync-upstream.mjs` がコミット済み blob を複製し、SHA-256 を [upstream.json](upstream.json) に記録している。5ファイルとも参照 clone のコミット済み blob とバイト単位で一致した（[検査結果](boundary-results.json)）。

| 結果 | 対象 | 実測・対応方法 |
|---|---|---|
| 無変更で再利用 | `src/domain/drawing.ts` | `DW` / `DH`、`PALETTE`、`WIDTHS`、`Stroke` を使う |
| 無変更でビルド時に再利用 | `src/codec/drawingCodec.ts`、`tests/fixtures/test-vectors-v1.json` | `prepare.mjs` が実際の `sample-face` の圧縮文字列を `decodeDrawing()` で復号。fixture の `expectedDecoded` と完全一致。4ストローク、63 + 21 + 21 + 51 = 156点 |
| 無変更で再利用 | `src/styles.css` | ヘッダー、パレット、太さボタンなどのCSS。DOM自体の移植ではない |
| shim経由でビルド時に再利用 | `src/render/canvasRenderer.ts` の `renderStroke()` | `canvas-svg.ts` が `beginPath` / `moveTo` / `quadraticCurveTo` / `lineTo` / `arc` / `stroke` / `fill` と5描画属性を記録し、SVG path にする。全160個の点数別ケースを実行。1点時の `arc(…, 0, 7)` は2本のSVG arcで全円にする |
| 手書き | `demo.tsx` | 元アプリは `index.html` と `appController.ts` でDOMを組み立てるため、ヘッダー・ツールバーを同じ文言とクラスで記述。Canvasの積層をSVGに置換し、半分のサイズに縮小。ID依存の枠・ペン表示はインラインで指定 |

## 事前計算とライブ計算

**事前計算:** 復号した描画データと、各ストロークの先頭 `k` 点を元の `renderStroke()` に渡して得る形状。形状は点数別の変種として SVG に含まれる。`k0`〜`k3` はそれぞれ64 / 22 / 22 / 52変種で、ペン先の円の位置も変種に含む。任意の曲線や新しい点列をCSSが計算しているわけではない。

**ライブ計算:** `logic.ts` を AssemblyScript から Wasm にし、`step(t) = t + 1` と8つの `view_*()` を README Runtime がCSSへ変換する。表示中のCSSがストロークごとの点数、色・太さの選択、開始済みストローク数、総描画点数を求め、表示する変種を選ぶ。状態は `0..177`、値はすべてi32で ±999,999 以内。50msごとに進み、177段の後に24段保持する。

4ストローク専用の開始時刻とビュー対応は手書き。形状を1枚の巨大な全体変種にせず、ストロークごとに独立した要素・ビューに分けた。点数の上限を区間解析へ伝えるため `view_k*` の返値に `% (点数 + 1)` を指定している（現在の値は変わらない）。任意の長さのストロークへそのまま一般化できるという結果ではない。

## そのまま実行できなかった部分

| 対象 | エラーまたは理由 |
|---|---|
| 65値以上を取る形状ビュー | 現在のエントリーで `k0` の範囲を意図的に `0..64` に拡大すると、下記の `UI_NONLINEAR` を再現。採用版は `0..63` に制限する |
| `renderAll()` / `renderActive()` | この最小shimではそれぞれ `CanvasRenderingContext2D.save is not recorded` / `clearRect is not recorded`。変換全般の不可能性ではなくshimの範囲外。背景・積層・途中描画はデモ側で構成した |
| PNG書き出し・Canvas画素API | `renderStrokesToDataUrl()` の既定Canvas生成はNodeで `ReferenceError: document is not defined`。画素読み取りの境界検査では `CanvasRenderingContext2D.getImageData is not recorded`。元レンダラーが `getImageData` を使っているという意味ではない |
| カメラ・MediaPipe | `cameraInput.ts` は `getUserMedia()`、動画、外部モデル/Wasm、GPU/CPU推論を要求。JSも外部資源も使えないSVG画像内では実行できない（コード確認、実カメラは起動していない） |
| One Euro Filter | `oneEuroFilter.ts` は小数の時刻・座標・速度、`Math.PI`、複数の可変フィールドを持つ。無変更でi32状態1個の変換対象にはならない。固定小数点化などの書き直しは未実施 |
| QR生成 | `qrService.ts` の `QRCode.toCanvas()`、非同期コールバック、Canvasへの書き込みはライブCSS計算へ移せない。固定QRのビルド時生成は別途可能だが、本実験では未実施 |
| タイマー・DOM・入力イベント | `setTimeout` / `setInterval` / `requestAnimationFrame`、DOM更新、クリック・ポインターイベントは画像内で実行できない。整数時計による自動再生へ置換。ボタンは表示のみ |
| localStorage | `workStore.ts` の `globalThis.localStorage.getItem/setItem` はSVG画像内のCSSに提供されない。作品の保存・掲示板管理は移植していない |

範囲拡大プローブで得たメッセージ全文（本番カードのビルド失敗を示すものではない）:

```text
UI_NONLINEAR: the UI depends on view "k0" in a way that is not affine (element 0.1.0.0.0), and "k0" can take 65 values (0..64; more than 64). view ranges are derived from the Wasm code for every possible state (an edited init can reach any of them), so the view function itself must bound the value (e.g. a comparison chain or x % n). Or make the markup depend on it linearly (numbers in style/text).
```

## 検証結果と再実行

```sh
node bin/readme-runtime.js build air-drawing --force --json
node bin/readme-runtime.js check --json
node examples/air-drawing/verify-boundaries.mjs [上流cloneのパス]
node examples/air-drawing/verify-browser.mjs
npm test
```

ビルドは `ok: true`、`build: "built"`、`card: "unchanged"`、`150.3 kB, 177 steps, verified against Wasm under 4 browser arithmetic models`。最新の通常ビルドではUIの178状態と266組の追加サンプルを検証し、SVGは同一だった。`build air-drawing --json` のWasmビルドはキャッシュが有効、`check --json` は `ok: true, problems: [], exitCode: 0`。`npm test` は66件成功、失敗0件。

Playwrightで HTTP の `image/svg+xml` を `<img>` に読み込み、ページJS無効、画像CSPを `default-src 'none'; style-src 'unsafe-inline'; sandbox` にした。時計規則だけを `t=20` / `t=150` に固定し、状態・ビュー計算のCSSは変更していない。前者は1ストローク17点、後者は4ストローク129点。実Wasmから求めた同じビューをデモに直接渡した参照画像とも比較した。

| ブラウザ | 描画部分の参照との差 | 描画画素数（t20 → t150） | 時刻間で変化した描画画素 | スクリーンショット |
|---|---:|---:|---:|---|
| Chromium | 0 | 1,024 → 4,838 | 4,484 | [t20](screenshots/chromium-t20.png) / [t150](screenshots/chromium-t150.png) |
| Firefox | 0 | 1,026 → 4,839 | 4,491 | [t20](screenshots/firefox-t20.png) / [t150](screenshots/firefox-t150.png) |
| WebKit | 0 | 1,024 → 4,838 | 4,493 | [t20](screenshots/webkit-t20.png) / [t150](screenshots/webkit-t150.png) |

UI全体も参照との画素差0だった。ブラウザ版、計測領域、SVGのSHA-256、実Wasmのビュー値は [screenshots/results.json](screenshots/results.json) に保存。これはCSSによる切替と、同じSVG shimを使った直接描画の比較であり、実Canvasのラスタライズとの一致検証ではない。時計を固定した2時点の検査で、無加工カードを時間待ちして測定する検査は行っていない。
