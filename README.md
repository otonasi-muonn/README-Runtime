# README Runtime

**自分のコードで、GitHubのREADMEを動かす。**

![Collatz conjecture: step() from collatz.wasm, computed live by CSS](readme-runtime/collatz.svg)

上の画像は録画ではありません。[`examples/collatz/collatz.c`](examples/collatz/collatz.c) をWebAssemblyにコンパイルし、その `step()` 関数を **CSSの式に変換** してSVGに埋め込んだものです。
画像を表示した瞬間に、あなたのブラウザのCSSエンジンが `step(27)`, `step(step(27))`, … を計算しています。

- SVGの中に計算結果は1つも入っていません。入っているのは `step()` を変換したCSSと、初期値 `27` だけです。
- JavaScriptは使いません。GitHubのREADMEのように `<img>` で表示され、スクリプトが一切動かない環境で計算します。
- 数値は、本物のWebAssemblyエンジンの実行結果と1ステップずつ一致することを、ビルド時とブラウザ上の両方で検証しています。

`step()` はこのCSSになります（SVG内の `.A` ルールからの抜粋）:

```css
--rxa: calc((var(--rxb) * 3 + 1) * mod(var(--rxb), 2) + round(down, var(--rxb) / 2) * (1 - mod(var(--rxb), 2)));
```

試しに [`readme-runtime/collatz.svg`](readme-runtime/collatz.svg) をテキストエディタで開き、`style="--rxb:27"` を `--rxb:97` に変えてブラウザで開いてください。生成し直さなくても、ブラウザが97からの118ステップを計算し直します。

### 言語は問いません（Rustの例）

![16-bit LFSR written in Rust, computed live by CSS](readme-runtime/lfsr-rust.svg)

[`examples/lfsr-rust/lfsr.rs`](examples/lfsr-rust/lfsr.rs) は Rust で書いた16ビットLFSRです。`readme-runtime.json` の `build.command` を `rustc …` にしているだけで、Cの例と同じ流れでカードになります。こちらは `xor` を含むビット演算がCSSで計算されています。

## 仕組み

```
your code (C / Rust / ...)  ──build command──▶  .wasm  ──readme-runtime──▶  card.svg  ──<img>──▶  browser CSS computes
                                                 │
                                                 └─ export step(i32) -> i32   (状態を1つ進める関数)
```

1. `.wasm` から指定したexport関数を読み、制御フロー（`if` / `block` / `br_if` / `br_table` / `return` / 関数呼び出し）を記号実行して、分岐のない式に変換します。
2. 式を `calc()` / `mod()` / `round()` / `clamp()` などのCSS数学関数に変換し、登録済みカスタムプロパティ（`@property … syntax:'<integer>'`）に割り当てます。
3. SVGの中に `<g>` を入れ子にし、各段が親の状態から次の状態を計算します。段ごとにプロパティ名を交互に切り替えることで、CSSの循環参照を避けています。
4. アニメーションする `--rt`（時計）が、何ステップ目まで表示するかを選びます。`prefers-reduced-motion` の環境では最終状態を静止表示します。

## 使い方

必要なもの: Node.js 20以上と、`step(i32) -> i32` をexportする `.wasm`（言語は問いません）。

```sh
# 1. 設定と、チェック専用のGitHub Actionsワークフローを作る（既存ファイルは上書きしません）
npx github:otonasi-muonn/README-Runtime init --wasm build/step.wasm --init 27

# 2. カードを生成（本物のWasmとの照合つき）
npx github:otonasi-muonn/README-Runtime build

# 3. README.md に貼る（以後のビルドでもファイル名は変わらないので、README自体の更新は不要）
#    ![demo](readme-runtime/step.svg)
```

> まだnpmには公開していないため、GitHubリポジトリから `npx` で実行します。再現性が必要な場合は `github:otonasi-muonn/README-Runtime#<tag>` のように固定してください。

使えるかどうかだけ確かめるには:

```sh
npx github:otonasi-muonn/README-Runtime inspect build/step.wasm
# step(i32) -> i32                 OK: can run in CSS as a step function
```

### 設定 `readme-runtime.json`

```json
{
  "cards": [
    {
      "name": "collatz",
      "title": "Collatz conjecture",
      "wasm": "examples/collatz/collatz.wasm",
      "build": {
        "command": "node tools/cc-wasm.mjs examples/collatz/collatz.c examples/collatz/collatz.wasm",
        "inputs": ["examples/collatz/collatz.c", "tools/cc-wasm.mjs"]
      },
      "export": "step",
      "init": 27,
      "steps": 120,
      "halt": 1
    }
  ]
}
```

| キー | 意味 | 既定値 |
|---|---|---|
| `name` | カード名。出力は `readme-runtime/<name>.svg` | 必須 |
| `wasm` | `.wasm` のパス | 必須 |
| `init` | 初期状態 x₀ | 必須 |
| `export` | 実行するexport関数（`(i32) -> i32`） | `step` |
| `steps` | 最大ステップ数（1〜400） | 120 |
| `halt` | 状態がこの値になったら停止 | なし |
| `haltExport` | 停止判定に使うexport関数（`(i32) -> i32`、非0で停止）。これもCSSに変換されます | なし |
| `build.command` | `.wasm` を作るコマンド。言語非依存で、シェルでそのまま実行します | なし |
| `build.inputs` | コマンドが読むソース（glob可）。これが変わったときだけ `command` を実行します | `build` があれば必須 |
| `title` / `stepMs` / `hold` / `bits` / `out` | 表示タイトル / 1ステップのミリ秒 / 最終状態の保持ステップ数 / トレースの行数（4〜20） / 出力先 | `name` / 120 / 12 / 20 / `readme-runtime/<name>.svg` |

### キャッシュと差分ビルド

`build` は `readme-runtime.lock.json` にハッシュを記録し、必要なものだけを作り直します。

| 変更 | 動作 |
|---|---|
| `build.inputs` のファイル、または `build.command` | ビルドコマンドを実行し、カードも作り直す |
| `.wasm`、カードの設定、README Runtime本体（変換器・テンプレート） | カードだけ作り直す |
| 何も変わっていない | 何もしない（`--force` で強制） |

ハッシュは改行コードを正規化して計算するため、WindowsとLinuxのチェックアウトで結果が変わりません。

### CI（チェックのみ）

`init` が作る `.github/workflows/readme-runtime.yml` は `readme-runtime check` を実行するだけです。

- ソースが変わったのにカードが作り直されていない、`.wasm` がずれている、SVGが手で編集されている、のいずれかで失敗します。
- コンパイラを必要としません（ビルドコマンドは実行せず、記録したハッシュと照合します）。
- 自動commit・pushは一切しません。失敗したらローカルで `build` してcommitしてください。

### CLI

```
readme-runtime init [--wasm <file.wasm>] [--export <name>] [--init <n>]
readme-runtime build [names...] [--force]
readme-runtime check
readme-runtime render <file.wasm> --init <n> [-o card.svg] [--export step] [--steps 120] [--halt <n>] [--halt-export <name>] [--title <text>] [--step-ms 120] [--hold 12] [--bits 20]
readme-runtime inspect <file.wasm>
```

## 対応範囲と制約

CSSには桁あふれする整数型がなく、`calc()` は浮動小数点で計算されます。ブラウザごとの実測結果から、正確に計算できる範囲を決めています。

| | Chromium (Chrome/Edge) | Firefox | WebKit (Safari) |
|---|---|---|---|
| 式の途中の計算 | double | **float32** | double |
| `var()` で受け渡す計算済みの値 | **有効数字6桁に丸める** | float32 | double |

- **状態と、段の間で受け渡す値: |x| ≤ 999,999**。式の途中の値: |x| < 2²³。
- ビルド時に、本物のWasmの実行結果と、生成したCSSを3つのブラウザの演算モデルで評価した結果を全ステップ比較します。範囲を超える値が出るとエラーで止まり、カードは生成しません（例: 初期値77671は14ステップ目で1,327,102になるため拒否）。
- 閲覧時に範囲を超えた場合（SVGの初期値を書き換えたときなど）は、間違った数字を出さずに `OUT OF RANGE` と表示して止まります。
- 対応命令: i32の算術・ビット演算・シフト・比較・`select`、`block` / `if` / `br` / `br_if` / `br_table` / `return`、非importの関数呼び出し（インライン展開）、immutableなglobal。
- 非対応（明確なエラーになります）: ループ、線形メモリ、i64・浮動小数点、import関数の呼び出し、再帰、mutableなglobal、可変量のrotate。ループはREADME Runtime自身が担当するので、`step()` には1ステップ分だけを書いてください。
- 0除算などのトラップは本物のWasmと同じステップで検出し、カードに `STOPPED` / `TRAP` と表示します。
- ステップ数は最大400（WebKitが約510段を超える入れ子を処理できないことを実測）。

動作確認したブラウザ: Chrome 157 / Edge 157（Windows）、Playwright 1.65 の Chromium・Firefox・WebKit。必要な機能: `@property`、`mod()` / `round()`、CSSアニメーション（Chrome/Edge 125以降、Firefox 128以降、Safari 16.4以降が目安）。

## 検証

```sh
npm test                    # Wasm → IR → CSS の照合（約40種類の命令パターン）、決定性、範囲エラー
npm run test:browser        # 実ブラウザで <img> 表示したピクセルを解読して、本物のWasmと照合
node bin/readme-runtime.js check
```

ブラウザ検証（[`test/browser/run.js`](test/browser/run.js)）の条件:

- SVGを `image/svg+xml` と、GitHubと同じCSP（`default-src 'none'; style-src 'unsafe-inline'; sandbox`）で配信し、JavaScriptを無効にしたページの `<img>` で表示します。
- 値はスクリーンショットのピクセル（32bitレジスタのLED、トレースの全列、状態ドットの色）だけから読み取ります。
- **生成済みSVGの初期値だけを書き換えた13通り**（生成器はその値を知りません）で、本物のWasmの軌道と一致することを確認します。範囲外になる初期値では `OUT OF RANGE` で止まることを確認します。
- 時計を固定した決定的な検証、実際のアニメーション（時間とともにステップが進み、どの瞬間も正しい）、`prefers-reduced-motion` の3種類を行います。

直近の結果: Chromium・Firefox・WebKit・Chrome 157・Edge 157 で 124/124 合格。

### GitHub上での確認手順

このリポジトリはまだpushしていません。GitHub上で確認するには:

1. pushしたあと、リポジトリのトップページでカードが表示され、ステップが進み、最後に `HALTED` になることを確認します。
2. 画像を右クリックして「新しいタブで画像を開く」で開き、`raw.githubusercontent.com` から配信されたSVGでも動くことを確認します。
3. Actionsタブで `README Runtime` ワークフローが成功していることを確認します。

## デモの再現（ビルド条件の固定）

[`examples/collatz/collatz.wasm`](examples/collatz/collatz.wasm) はコミット済みで、次の条件で再現できます。

- コンパイラ: WebAssembly版clang [`@yowasp/clang`](https://www.npmjs.com/package/@yowasp/clang) `21.1.4-3`（`package.json` で固定。どのOSでも同じバイト列になります）
- フラグ: `--target=wasm32 -O2 -nostdlib -Wl,--no-entry`（[`tools/cc-wasm.mjs`](tools/cc-wasm.mjs)）
- sha256: `dd40a4b6513c1fe94042a3e636d706a1cf4400f255b9634abea9ccba907e787a`

```sh
npm install
node bin/readme-runtime.js build --force
```
