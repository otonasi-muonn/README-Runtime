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

試しに [`readme-runtime/collatz.svg`](readme-runtime/collatz.svg) をテキストエディタで開き、`style="--rxb:27"` を `--rxb:97` に変えてブラウザで開いてください。生成し直さなくても、ブラウザが97からの118ステップを計算し直します。CSSで正確に計算できない値になる初期値（例: 77671）に変えると、間違った数字は出さずに `OUT OF RANGE` で止まります。

### 言語は問いません（Rustの例）

![16-bit LFSR written in Rust, computed live by CSS](readme-runtime/lfsr-rust.svg)

[`examples/lfsr-rust/lfsr.rs`](examples/lfsr-rust/lfsr.rs) は Rust で書いた16ビットLFSRです。`readme-runtime.json` の `build.command` を `rustc …` にしているだけで、Cの例と同じ流れでカードになります。こちらは `xor` を含むビット演算がCSSで計算されています。

### 既存のUIをそのまま使う（UIdesign / mockcraft の例）

![mockcraft: the project's own React components, driven live by Wasm computed in CSS](readme-runtime/mockcraft.svg)

[otonasi-muonn/UIdesign](https://github.com/otonasi-muonn/UIdesign)（画面モック工房 mockcraft、Next.js + React 19 + Tailwind 4）の実コンポーネントを、**1行も書き換えずに**使ったカードです。

- 表示: `ElementView`・`buildPreset`・`mk`・`globals.css` を、コミット `2f97712` からバイト単位で同一のまま取り込んでいます（[`examples/mockcraft/upstream.json`](examples/mockcraft/upstream.json) にハッシュを記録し、テストで照合）。
- 状態: [`examples/mockcraft/logic.ts`](examples/mockcraft/logic.ts)（AssemblyScript）が、カードの位置・向き・反射回数を1ステップずつ更新します。`view_*` 関数がUIに渡す値を計算します。
- 作者が書いたのは [`examples/mockcraft/demo.tsx`](examples/mockcraft/demo.tsx)（約30行）だけです。どのコンポーネントを置き、view値をどのpropsに渡すかを書いています。

仕組み:

1. デモのTSXを esbuild で束ね、React の `renderToStaticMarkup` で静的HTMLにします（毎回新しいVMで、`Math.random` と `Date` を固定）。
2. view値を変えて何度か描画し、出力の違いから束縛を推定します。
   - style の数値が view に対して一次式なら `calc(var(--view) * a + b)` にします。
   - テキスト中の数値は CSSカウンタで表示します。
   - クラス名・文言・要素の有無の違いは、値ごとの変種にし、`@container style(--view: k)` で切り替えます。
3. 推定したテンプレートが、実行中のすべての状態と、範囲内のランダムなview値で、コンポーネントの直接描画と一致することを確認してから出力します。
4. 実ブラウザ検証では、`<img>`（JS無効）に表示したカードのUI部分が、同じ状態を直接描画した画像とピクセル単位で一致することを確認します。Firefox と WebKit は完全一致、Chromium はCSSカウンタの前後で数px の字送り差があります。

フレーム（時刻ごとの画像）は1枚も保存していません。SVGが持つのは、静的なUIのひな形と変種、および束縛だけです。何を表示するかは、表示時にCSSがWasmの状態から計算します。

## 仕組み

```
your code (C / Rust / ...)  ──build command──▶  .wasm  ──readme-runtime──▶  card.svg  ──<img>──▶  browser CSS computes
                                                 │
                                                 └─ export step(i32) -> i32   (状態を1つ進める関数)
```

1. `.wasm` から指定したexport関数を読み、制御フロー（`if` / `block` / `br_if` / `br_table` / `return` / 関数呼び出し）を記号実行して、分岐のない式に変換します。
2. 式を `calc()` / `mod()` / `round()` / `clamp()` などのCSS数学関数に変換し、登録済みカスタムプロパティ（`@property … syntax:'<integer>'`）に割り当てます。
3. SVGの中に `<g>` を入れ子にし、各段が親の状態から次の状態を計算します。段ごとにプロパティ名を交互に切り替えることで、CSSの循環参照を避けています。
4. 区間解析で、CSSで正確に表せない値になりうる箇所を見つけ、そこに範囲ガードを入れます。ガードが働くと、その段で `OUT OF RANGE` と表示して止まります。
5. アニメーションする `--rt`（時計）が、何ステップ目まで表示するかを選びます。`prefers-reduced-motion` の環境では最終状態を静止表示します。

## 使い方

必要なもの: Node.js 20以上と、`step(i32) -> i32` をexportする `.wasm`（言語は問いません）。

```sh
# 1. 設定と、チェック専用のGitHub Actionsワークフローを作る（既存ファイルは上書きしません）
npx github:otonasi-muonn/README-Runtime#v0.1.0 init --wasm build/step.wasm --init 27

# 2. カードを生成（本物のWasmとの照合つき）
npx github:otonasi-muonn/README-Runtime#v0.1.0 build

# 3. README.md に貼る（以後のビルドでもファイル名は変わらないので、README自体の更新は不要）
#    ![demo](readme-runtime/step.svg)
```

> まだnpmには公開していないため、GitHubリポジトリから `npx` で実行します。ローカルの `build` と、`init` が作るCIワークフローは同じバージョンのタグ（`#v0.1.0`）に固定してください。版が違うと、ジェネレータの出力が変わって `check` が失敗します（そのときは版の違いをメッセージで示します）。
> **注意:** このリポジトリはまだpushしておらず、タグ `v0.1.0` も未作成です。公開時にタグを作成するまで、上のコマンドは動きません。

使えるかどうかだけ確かめるには:

```sh
npx github:otonasi-muonn/README-Runtime#v0.1.0 inspect build/step.wasm
# step(i32) -> i32                 OK: can run in CSS as a step function
```

### AIエージェントから使う

すべてのコマンドは非対話で、`--json` を付けると結果をJSON 1個で返します。失敗時は `{ ok: false, error: { code, message, hint } }` を返し、終了コードは2です。手順は [`AGENTS.md`](AGENTS.md) にまとめています（エージェントのAGENTS.mdやSkillにそのまま貼れる分量です）。

```sh
readme-runtime analyze --json                      # 再利用できるコンポーネントを、実際に描画して判定
readme-runtime init --ui src/components/X.tsx#X --name demo --json   # 生成直後からビルドできる雛形
readme-runtime build --json                        # 変更のあったカードだけ作り直し、理由も返す
readme-runtime check --json                        # CIと同じ検査。ファイルは書き換えない
```

- `analyze` は、各コンポーネントを props なしで実際に静的描画して判定します。判定は「そのまま使える」「props が必要」「フレームワーク専用のimportがある」「Canvas描画」「依存が未インストール」のいずれかです。
- エラーコードの例:
  - `UI_NONLINEAR`: view と表示の関係が一次式でない
  - `RANGE_INTERMEDIATE`: 途中の値が大きすぎる
  - `WASM_UNSUPPORTED`: ループなど非対応の命令がある
  - `BUILD_COMMAND`: ビルドコマンドが失敗した

  コードごとに修正方法を1つ返します。

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
| `ui` | 既存UIのカードにする: `entry`（デモのTSX/JSX）、`views`（view名→export関数）、`css`（スタイルシート）、`tsconfig`、`width`/`height`、`credit` | なし |
| `title` / `stepMs` / `hold` / `bits` / `out` | 表示タイトル / 1ステップのミリ秒 / 最終状態の保持ステップ数 / トレースの行数（4〜20） / 出力先 | `name` / 120 / 12 / 20 / `readme-runtime/<name>.svg` |

### キャッシュと差分ビルド

`build` は `readme-runtime.lock.json` にハッシュを記録し、必要なものだけを作り直します。

| 変更 | 動作 |
|---|---|
| `build.inputs` のファイル、または `build.command` | ビルドコマンドを実行する。できた `.wasm` が前回と同じバイト列なら、カードは作り直さない |
| `.wasm`、カードの設定、README Runtime本体（変換器・テンプレート） | カードだけ作り直す |
| 何も変わっていない | 何もしない（`--force` で強制） |

`build.inputs` の書き方:

- ファイルのパス、またはディレクトリ（その下のすべてのファイル）を指定します。
- globも使えます。`*` と `?` はパスの1階層内、`**` は0個以上のディレクトリに一致します（`src/**` はsrc以下のすべて、`src/**/*.c` はsrc以下のすべての `.c`）。
- どのファイルにも一致しないパターンはエラーになります（ソースを変えたのに何も起きない、という事故を防ぐため）。
- すべてのカードの出力（`.wasm` とSVG）と `readme-runtime.lock.json` は、パターンに含まれていても自動的に除外します。ディレクトリやglobの走査では、`node_modules`・`.git` などと、`.DS_Store` などOSが作るファイルも除外します（それ以外の隠しファイルは含めます）。

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
| 式の途中の計算 | double | **float32**（`rem()` は `a − b·trunc(a/b)`、`mod()` は `a − b·floor(a/b)` をfloat32で計算） | double |
| 除算 `a / b` | 正確 | float32で正確に丸め | **`a × (1/b)` で計算**（例: 2401/49 が 48.999…） |
| `var()` で受け渡す計算済みの値 | **有効数字6桁に丸める** | int32に丸めたfloat32 | double |
| `calc()` の入れ子の深さ | 約95段まで | **約75段まで**（超えると宣言ごと無効） | 約105段まで |

この実測から、次の範囲を保証します。

- **状態と、段の間で受け渡す値: |x| ≤ 999,999**。
- 式の途中の値: |x| < 2²⁴。ただし、2の冪以外で割る・剰余を取る値と、ビット演算（`and` / `or` / `xor` / `clz` / `popcnt`）にかける値は |x| < 2²³。
- 商は `round(nearest, (a − rem(a, b)) / b)` の形で求めます。`rem()` と `mod()` はどのエンジンでも正確なので、WebKitの除算の誤差も吸収できます。
- 式は入れ子24段ごとに一時プロパティへ分割し、どの宣言も40段以内に収めます。

保証のしかた:

- **ビルド時**: 本物のWasmの実行結果と、生成したCSSを4つの演算モデル（理想・Chromium・Firefox・WebKit）で評価した結果を全ステップ比較します。範囲を超える値が出るとエラーで止まり、カードは生成しません（例: 初期値77671は14ステップ目で1,327,102になるため拒否。`(x * 65536) % 32749` のように途中で2²⁴を超える式も拒否）。
- **閲覧時**: すべての状態（|x| ≤ 999,999）について区間解析を行い、範囲を超えうる値には「範囲ガード」をCSSに埋め込みます。SVGの初期値を書き換えた場合でも、表示は **本物のWasmと同じ値か、`OUT OF RANGE` で停止するかのどちらか** になるように設計しています（i32の桁あふれに依存するコードも、桁あふれが起きる入力では停止します）。この性質は、命令パターンごとに境界値を含む入力と、21プログラムの実ブラウザ検証で確認していますが、形式的な証明ではありません。
- ガードは保守的です。CSSは条件分岐の**両方の腕**を計算するため、使われない側の腕で範囲を超える値が出るプログラム（例: `x < 4000 ? x*x % 10007 : x / 3`）は、ビルド時に拒否されます。

対応する命令:

- i32の算術・ビット演算・シフト・比較・`select`（符号なしの除算・剰余・比較を含む）
- `block` / `if` / `br` / `br_if` / `br_table` / `return`、非importの関数呼び出し（インライン展開）、immutableなglobal

非対応（命令名とヒントつきのエラーになります）:

- ループ、線形メモリ、i64・浮動小数点、import関数の呼び出し、再帰、mutableなglobal、可変量のrotate
- ループはREADME Runtime自身が担当するので、`step()` には1ステップ分だけを書いてください。

その他:

- 0除算などのトラップは、本物のWasmと同じステップで検出し、カードに `TRAP` / `STOPPED` と表示します。
- 実行は、ビルド時に `steps` 段の入れ子として展開されます。値はすべて表示時にCSSが計算し、SVGには保存されません。
- ステップ数は最大400です（WebKitが約510段を超える入れ子を処理できないことを実測）。

動作確認したブラウザ: Chrome 157 / Edge 157（Windows）、Playwright 1.65 の Chromium・Firefox・WebKit。実機のSafari（macOS/iOS）では未確認です。
必要な機能: `@property`、`mod()` / `round()`、CSSアニメーション。目安は Chrome/Edge 125以降、Firefox 128以降、Safari 16.4以降です。

既存UIのカード（`ui`）の制約:

- view値は ±999,999 以内です。
- 表示の違いを値ごとの変種で表すviewは、64通り以内（組み合わせは512通り以内）にしてください。
- テキスト中の数値は整数の一次式に限ります。
- 変種の切り替えに `@container style()` を使います（実測した Chromium / Firefox / WebKit は対応）。
- 外部画像とWebフォントは `<img>` 内では読み込まれないため、システムフォントで代替します。
- Canvasへの命令的な描画、ブラウザAPIを描画中に使うコンポーネント、フレームワーク専用のimport（`next/font` など）は、そのままでは使えません（`analyze` が判定します）。

## 技術選定

採用技術は、2026年11月時点の候補と比較して選びました。

| 領域 | 採用 | 比較と判断 |
|---|---|---|
| CSSでの計算 | 登録カスタムプロパティ + `calc()`/`mod()`/`round()`、入れ子の段 | `if()` はFirefoxが非対応（実測）。`@container style()` は3エンジンとも対応（実測）なので、UIの変種の切り替えに採用 |
| Wasm→CSS | 独自のi32変換器 | 対象はi32のみで、命令名つきのエラーが必要。汎用の最適化器（Binaryenなど）は不要 |
| TSX→静的マークアップ | `react-dom/server` をVM内で決定的に実行 | Satoriは独自のレイアウトとフォントでプロジェクトのCSSを再現できない。スクリーンショットはラスタで動かない |
| バンドル | esbuild 0.28 | tsconfigのpathsとJSXに対応し、高速。Vite/Rollupはこの用途には過剰 |
| スタイル | Tailwind 4 のコンパイラAPI（使用クラスのみ）/ 素のCSS | プロジェクトのCSSをそのまま使える |
| TSプロジェクトの計算 | AssemblyScript 0.28 | JSをWasm化する方式（Javyなど）は、JSエンジンと線形メモリを含むため対象外 |

## 検証

```sh
npm test                    # 単体・結合テスト 54件（下記）
npm run test:browser        # 実ブラウザで <img> 表示したピクセルを解読して、本物のWasmと照合
node bin/readme-runtime.js check
```

`npm test` の内容:

- 約100の命令パターンについて、境界値を含むサンプル入力（2²³〜2²⁴の窓、49や65521の倍数を含む）と4つの演算モデルで「本物のWasmと一致するか、範囲フラグが立つか」を確認します（[`test/compiler.test.js`](test/compiler.test.js)）。
- 出力の決定性、範囲エラー、トラップ、停止判定を確認します（[`test/pipeline.test.js`](test/pipeline.test.js)）。
- 2回の敵対的レビューで見つかった不具合の再現ケースを回帰テストにしています（[`test/soundness.test.js`](test/soundness.test.js)）。
- キャッシュ・差分ビルド・`check` の挙動を確認します（[`test/project.test.js`](test/project.test.js)）。

ブラウザ検証（[`test/browser/run.js`](test/browser/run.js)）の条件:

- SVGを `image/svg+xml` と、GitHubと同じCSP（`default-src 'none'; style-src 'unsafe-inline'; sandbox`）で配信し、JavaScriptを無効にしたページの `<img>` で表示します。
- 値はスクリーンショットのピクセル（32bitレジスタのLED、トレースの全列、状態ドットの色）だけから読み取ります。
- 対象は21プログラムです。C（Collatz、90分岐のif連鎖、符号なし剰余、49や65521での除算、Fibonacci LFSR、Rule 30）、Rust（ガロアLFSR）、命令を直接組んだWasm（LCG、xorshift、桁あふれ依存、2乗の剰余、popcount、float32が溢れるハッシュ、0除算トラップなど）を含みます。
- 各プログラムについて、**生成済みSVGの初期値だけを書き換えた値**（生成器はその値を知りません）でも、表示が本物のWasmの軌道と一致するか、範囲外になるステップで `OUT OF RANGE` になることを確認します。
- 時計を固定した決定的な検証、実際のアニメーション（時間とともにステップが進み、どの瞬間も正しい）、`prefers-reduced-motion` の3種類を行います。

直近の結果（2026-11-22）: Chromium・Firefox・WebKit（Playwright 1.65.1）、Chrome 157、Edge 157 の5エンジンで **409/409 合格**。21プログラムと、生成済みSVGの初期値を書き換えた47通りを含みます。

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
node bin/readme-runtime.js build --force collatz
```

Rustの例（`lfsr-rust`）も作り直す場合は、`rustc` と `rustup target add wasm32-unknown-unknown` が必要です（`examples/lfsr-rust/README.md`）。
