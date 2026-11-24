# README Runtime

**自分のコードで、GitHubのREADMEを動かす。**

![mockcraft: the project's own React components, driven live by Wasm computed in CSS](readme-runtime/mockcraft.svg)

このカードは録画ではありません。[UIdesign](https://github.com/otonasi-muonn/UIdesign)（Next.js + React 19 + Tailwind 4）の実コンポーネントを1行も書き換えずに使い、カードの位置・向き・反射回数を、WebAssembly の `step()` から変換した CSS が**表示した瞬間にあなたのブラウザで**計算しています。JavaScript は使わず、GitHub の README の `<img>` のまま動きます。

## 録画ではない証拠

下の2枚は**同じファイル**（[`readme-runtime/collatz.svg`](readme-runtime/collatz.svg)）です。2枚目は、画像の URL に `#x97` を付けただけです（`?x97` は、Safari が同じファイルの2枚を別々に描くための目印で、配信されるファイルは同じです）。ブラウザは初期値 97 から計算し直し、1枚目（27 から始まり 111 ステップで 1 に着く）とは違う、118 ステップの軌道を描きます。録画では、1つのファイルは1本の映像しか再生できません。

![Collatz from 27: step() from collatz.wasm, computed live by CSS](readme-runtime/collatz.svg)

![The same file from 97: the URL fragment #x97 changes the initial value](readme-runtime/collatz.svg?x97#x97)

- SVG の中にあるのは、[`collatz.c`](examples/collatz/collatz.c) の `step()` を変換した CSS と初期値だけです。途中の値は1つも入っていません。テキストエディタで `style="--rxb:27"` の数字を書き換えても、ブラウザはその値から計算します。
- 表示する値は、本物の WebAssembly の実行と1ステップずつ一致することを、ビルド時と実ブラウザ（Chromium・Firefox・WebKit）で確かめています。CSS で正確に計算できない値になると、間違った数字を出さずに `OUT OF RANGE` で止まります（例: 初期値 77671）。

`step()` はこの CSS になります（SVG内の `.A` ルールからの抜粋）:

```css
--rxa: calc((var(--rxb) * 3 + 1) * mod(var(--rxb), 2) + round(down, var(--rxb) / 2) * (1 - mod(var(--rxb), 2)));
```

## 録画（WebP・MP4）との比較

上の mockcraft カード（160 ステップ、1ステップ 150 ms）を、同じ UI を録画したアニメーション WebP・MP4 と比べました（[`bench/`](bench/README.md)。CPU は Windows のデスクトップ1台での計測で、保証値ではありません）。

| | README Runtime | 録画 |
|---|---|---|
| GitHub の README で動くか | 動く（`<img>`） | WebP は動く。MP4 はリポジトリのファイルでは再生できない |
| 転送量 | **約 11 KB**（gzip。ステップ数を増やしても 40〜320 ステップで 9〜13 KB） | WebP 0.7〜0.8 MB、MP4 117 KB（ステップ数に比例） |
| 色を1回変えたときの Git 履歴の増加 | **約 +0.7 KiB** | WebP +0.65〜1.5 MB |
| ソースとの一致の確認 | `check` を CI で実行 | なし（今回の録画パイプラインには実装していない） |
| 再生中の閲覧者の CPU（1コア＝100%） | 6〜11%（3エンジン。40〜320 ステップでも 6〜13%） | WebP 2〜7%、MP4 1〜13% |
| 再生中のメモリの増加（Chromium） | +46 MB | WebP +115 MB、MP4 +27 MB |
| 再生が終わった後 | 既定では約1分で最後の状態に止まり、CPU を使わない | ループし続ける |
| 表せるもの | 整数の状態から計算できる UI（固定小数点、64通りまでの切り替え、一次式の数値） | 画面に映るものすべて（Canvas、写真、Webフォント、実際の操作） |

再生中の CPU は、時計と状態計算を分けた改善（2026-11-24）で、改善前の 51〜75% から下がりました。それでも録画（特に Chromium の MP4）より多く使います。README Runtime の CPU は改善後のカードの5回の中央値、録画の CPU とメモリは同じセッションで測った各1回の値（README Runtime は同じセッションで 6.8〜9.2%）、Git 履歴は改善前の比較（2026-11-23）の測定です。詳細は [`bench/README.md`](bench/README.md#css-ランタイムの改善2026-11-24) にあります。

## 使い方

必要なもの: Node.js 20 以上と、`step(i32) -> i32` を export する `.wasm`（言語は問いません）。

```sh
# 1. 設定と、チェック専用の GitHub Actions ワークフローを作る（既存ファイルは上書きしない）
npx --yes https://github.com/otonasi-muonn/README-Runtime/archive/HEAD.tar.gz init --wasm build/step.wasm --init 27

# 2. カードを生成（本物の Wasm との照合つき）。init が表示した、コミットに固定したコマンドを使う
npx --yes https://github.com/otonasi-muonn/README-Runtime/archive/<commit>.tar.gz build

# 3. README.md に貼る（ファイル名は変わらないので、以後の再生成で README の更新は不要）
#    ![demo](readme-runtime/step.svg)
```

npm にはまだ公開していないため、GitHub のアーカイブ（`archive/<ref>.tar.gz`）から実行します（npm 10 の `npx github:owner/repo#ref` は、git からのインストールで失敗します）。`init` は、いま実行した README Runtime のコミットを調べ、CI ワークフローをそのコミットに固定します（`init --json` の `tool` にも同じコマンドが入ります）。生成器の版が変わると SVG が変わり、CI の `check` が失敗するためです。

使えるかどうかだけ確かめるには:

```sh
npx --yes https://github.com/otonasi-muonn/README-Runtime/archive/HEAD.tar.gz inspect build/step.wasm
# step(i32) -> i32                 OK: can run in CSS as a step function
```

既存の React コンポーネントを使うカードは、`analyze` で再利用できる部品を調べ、`init --ui <file>#<Export>` で雛形（`logic.ts` と `demo.tsx`）を作ってから `build` します（手順は [`AGENTS.md`](AGENTS.md)）。

### AI エージェントから使う

すべてのコマンドは非対話で、`--json` を付けると結果を JSON 1個で返します。失敗時は `{ ok: false, error: { code, message, hint } }` を返し、終了コードは 2 です。手順は [`AGENTS.md`](AGENTS.md) にまとめています（エージェントの AGENTS.md や Skill にそのまま貼れる分量です）。

```sh
readme-runtime analyze --json                      # 再利用できるコンポーネントを、実際に描画して判定
readme-runtime init --ui src/components/X.tsx#X --name demo --json   # 雛形と CI ワークフロー
readme-runtime build --json                        # 変更のあったカードだけ作り直し、理由・負荷・警告も返す
readme-runtime check --json                        # CI と同じ検査。ファイルは書き換えない
```

AI エージェントが、初めて見る既存プロジェクト（すべて作者の実リポジトリのコピー）に `AGENTS.md` だけを見て導入した実測です（2026-11-23）。

| エージェント | プロジェクト | 結果 | CLIの実行回数 | 時間 | つまずいた点（→ 対応） |
|---|---|---|---|---|---|
| Claude（修正前のCLI） | UIdesign（Next.js 16、Tailwind 4） | カード作成 | 11（うち build 4、失敗 2） | 約6分 | `UI_NONLINEAR`（viewの範囲の説明不足）、`UI_VERIFY`（条件付きで現れる数値）、生成した `logic.ts` がプロジェクトの `tsc` と `next build` を壊す、`logic.wasm` のコミット漏れ → すべて修正 |
| Codex（修正後のCLI） | BukaiLive（Next.js 15、Tailwind 3） | カード作成 | 15 | 約17分 | 最初の独自デモが1回でビルド成功。タイムゾーン依存のデータで `check` 失敗 → 描画をUTC・en-USに固定 |
| Codex（修正後のCLI） | phase4_collelis（Next.js、サブフォルダ） | カード作成 | 12 | 約15分 | `SUBPACKAGES` 警告で正しいフォルダへ。CRLFのチェックアウトで `check` が必ず失敗 → 出力の改行を統一 |

## 閲覧者の負担

- カードが再生中に使う CPU は、1ステップごとに表示部分を描き直す分だけです（実行全体は最初に1回だけ計算します）。目安は、更新の頻度（`stepMs`）と表示部分の要素数です。
- 既定（`"loops": "auto"`）では、ページを開いてから約1分ぶん再生し、最後の状態で止まります。止まった後は CPU を使いません（3エンジンで確認）。
- 画面外にあるカードの時計は、Chromium と WebKit では表示中と同じように進み、Firefox では画面に入るまで止まります（実測）。そのため Chromium と WebKit では、ページの下の方のカードが、読み手が着く前に再生を終えていることがあります。ずっと動かすには `"loops": "infinite"` にします。
- WebKit（Windows の Playwright）は、画面外のカードも描き続けます（無限ループで 1コアの約 2〜3%）。無限ループのカードを表示し続けると、メモリも増え続けました（3分で +41 → +79 MB。改善前のカードでも +84 → +130 MB）。再生が止まった後は増えません。
- 「視差効果を減らす（prefers-reduced-motion）」の設定では、アニメーションせずに最後の状態を表示します。
- `build --json` は、カードごとに1秒あたりの更新回数、再生が続く秒数、表示部分の要素数、gzip のサイズを `perf` で返し、重くなりそうな設定を `PERF_*` の警告（設定の直し方 `fix` つき）で知らせます。

## 安全性

README Runtime は、信頼できるプロジェクトで使うローカル・CI 用のビルドツールです。`build` と `check` は、設定にあるビルドコマンドをシェルで実行し、デモのコンポーネントを Node.js で描画します。任意の外部コードを安全に実行するためのサンドボックスではありません。

生成した SVG は、スクリプトも外部リソースも含みません。GitHub は README の画像を `<img>` で表示し、SVG 内のスクリプトを実行しません。

## 仕組み

```
your code (C / Rust / AssemblyScript ...)  ──build command──▶  .wasm  ──readme-runtime──▶  card.svg  ──<img>──▶  browser CSS computes
                                                                 │
                                                                 └─ export step(i32) -> i32   (状態を1つ進める関数)
```

1. `.wasm` から指定した export 関数を読み、制御フロー（`if` / `block` / `br_if` / `br_table` / `return` / 関数呼び出し）を記号実行して、分岐のない式に変換します。
2. 式を `calc()` / `mod()` / `round()` / `clamp()` などの CSS 数学関数に変換し、登録済みカスタムプロパティ（`@property … syntax:'<integer>'`）に割り当てます。
3. SVG の中に `<g>` を入れ子にし、各段が親の状態から次の状態を計算します。段ごとにプロパティ名を交互に切り替えることで、CSS の循環参照を避けています。各段は自分の状態を段ごとの名前（`--rS<k>`）でも書き出します。
4. 区間解析で、CSS で正確に表せない値になりうる箇所を見つけ、そこに範囲ガードを入れます。ガードが働くと、その段で `OUT OF RANGE` と表示して止まります。
5. アニメーションする時計 `--rt` は、最も内側の表示部分だけにあり、書き出された状態から何ステップ目を表示するかを選びます。時計が進んでも、実行全体（入れ子の段）は計算し直されません。

既存 UI のカードでは、デモの TSX を esbuild で束ね、React の `renderToStaticMarkup` で静的 HTML にします。view 値を変えて何度か描画し、出力の違いから束縛を推定します（style の数値は `calc(var(--view) * a + b)`、テキスト中の数値は CSS カウンタ、クラス名・文言・要素の有無の違いは値ごとの変種を `@container style(--view: k)` で切り替え）。推定したテンプレートは、実行中のすべての状態でコンポーネントの直接描画と一致することを確かめてから出力します。

## ほかの例

- [Rust の 16 ビット LFSR](examples/lfsr-rust/README.md): 言語を問わないこと（`build.command` を `rustc …` にするだけ）。
- [air-drawing-board](examples/air-drawing/README.md): Canvas アプリの描画処理 `renderStroke()` を、ビルド時に SVG の path として再利用した例と、再利用できなかった部分の記録。

<details>
<summary><b>設定 <code>readme-runtime.json</code></b></summary>

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
      "altInits": [97, 871],
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
| `altInits` | URL の `#x<値>` で選べる、ほかの初期値（16個まで）。それぞれ `init` と同じくビルド時に照合します。同じページに同じファイルを2回以上置くときは、`card.svg?x97#x97` のようにクエリも変えてください（WebKit は URL が同じ画像の文書を共有し、フラグメントを切り替えるたびに実行全体を計算し直すため、2枚で 1コア近くになりました） | なし |
| `export` | 実行する export 関数（`(i32) -> i32`） | `step` |
| `steps` | 最大ステップ数（1〜400） | 120 |
| `halt` | 状態がこの値になったら停止 | なし |
| `haltExport` | 停止判定に使う export 関数（`(i32) -> i32`、非0で停止）。これも CSS に変換されます | なし |
| `stepMs` | 1ステップのミリ秒 | 150 |
| `loops` | 再生の回数。`"auto"` はページを開いてから約1分ぶん、`"infinite"` は止まらない。終わると最後の状態で止まる | `"auto"` |
| `build.command` | `.wasm` を作るコマンド。言語非依存で、シェルでそのまま実行します | なし |
| `build.inputs` | コマンドが読むソース（glob可）。これが変わったときだけ `command` を実行します | `build` があれば必須 |
| `ui` | 既存UIのカードにする: `entry`（デモのTSX/JSX）、`views`（view名→export関数）、`css`（スタイルシート）、`tsconfig`、`width`/`height`、`credit` | なし |
| `title` / `hold` / `bits` / `out` | 表示タイトル / 最終状態の保持ステップ数 / トレースの行数（4〜20） / 出力先 | `name` / 12 / 20 / `readme-runtime/<name>.svg` |

</details>

<details>
<summary><b>キャッシュと差分ビルド</b></summary>

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

</details>

<details>
<summary><b>CI（チェックのみ）</b></summary>

`init` が作る `.github/workflows/readme-runtime.yml` は `readme-runtime check` を実行するだけです。

- ソースが変わったのにカードが作り直されていない、`.wasm` がずれている、SVGが手で編集されている、のいずれかで失敗します。
- コンパイラを必要としません（ビルドコマンドは実行せず、記録したハッシュと照合します）。既存UIのカードのために、プロジェクトの依存はインストールします。
- README Runtime は `init` を実行したコミットに固定されます。版を上げるときは、ローカルで新しい版の `build` を実行し、ワークフローのコミットも合わせて更新します。
- 自動commit・pushは一切しません。失敗したらローカルで `build` してcommitしてください。

</details>

<details>
<summary><b>CLI</b></summary>

```
readme-runtime analyze [dir]
readme-runtime init --ui <file.tsx>[#Export] [--name demo] [--css a.css,b.css]
readme-runtime init [--wasm <file.wasm>] [--export <name>] [--init <n>]
readme-runtime build [names...] [--force]
readme-runtime check
readme-runtime render <file.wasm> --init <n> [-o card.svg] [--export step] [--steps 120] [--halt <n>] [--halt-export <name>] [--loops auto|infinite|<n>] [--title <text>] [--step-ms 150] [--hold 12] [--bits 20]
readme-runtime inspect <file.wasm>
```

</details>

<details>
<summary><b>対応範囲と制約</b></summary>

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

- **ビルド時**: 本物のWasmの実行結果と、生成したCSSを4つの演算モデル（理想・Chromium・Firefox・WebKit）で評価した結果を全ステップ比較します。表示部分が時計で選ぶ値（表示するステップ、状態、停止の表示）も、時刻を変えて比較します。範囲を超える値が出るとエラーで止まり、カードは生成しません（例: 初期値77671は14ステップ目で1,327,102になるため拒否。`(x * 65536) % 32749` のように途中で2²⁴を超える式も拒否）。`altInits` の初期値も同じように照合します。
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
- SVG のサイズはステップ数に比例して少しずつ増えます（gzip で 160 ステップ約 11 KB、320 ステップ約 13 KB）。

動作確認したブラウザ: Chrome 157 / Edge 157（Windows）、Playwright 1.65 の Chromium・Firefox・WebKit。実機のSafari（macOS/iOS）では未確認です。
必要な機能: `@property`、`mod()` / `round()`、CSSアニメーション。目安は Chrome/Edge 125以降、Firefox 128以降、Safari 16.4以降です。既存UIのカードの変種の切り替えには、さらにカスタムプロパティの `@container style()` が必要です（Safari は 18 以降と言われていますが、実機では未確認です）。`altInits` の切り替えは、URL のフラグメントが SVG 内の `:target` になることを使います（3エンジンで確認）。

既存UIのカード（`ui`）で保証すること:

- **設定した実行の全状態**と、**変種で表すview（64通り以内）の全値**は、直接描画と一致することをビルド時に確認します。
- 値の範囲が広いview（数値の束縛）は、範囲が8,192値以内なら全値を1つずつ確認します（他のviewはランダム）。
- **広いview同士の組み合わせは、抽出による確認です。** 例えば「`x` と `y` がともに特定の範囲にあるときだけ色が変わる」部品では、SVGの初期値を書き換えた先の状態が確認から漏れることがあります。どのviewを全値確認し、どのviewを抽出で済ませたかは、`build --json` の `ui.verifiedEachValue` / `ui.sampledViews` に出ます。

既存UIのカード（`ui`）の制約:

- view値は ±999,999 以内です。
- 表示の違いを値ごとの変種で表すviewは、64通り以内（組み合わせは512通り以内）にしてください。viewの値の範囲は、実行で現れる値ではなく、Wasmのコードからすべての状態について求めます（SVGの初期値を書き換えても正しく表示するため）。
- ルート直下で要素が増減すると、UI全体が組み合わせごとに複製されます（`build` が `UI_WHOLE_VARIANTS` で警告します）。増減する部品は要素で包んでください。
- スタイル: Tailwind 4 はREADME Runtime同梱のコンパイラで、Tailwind 3（`@tailwind base` など）はプロジェクト自身の tailwindcss 3・PostCSS・`tailwind.config` でコンパイルします（依存のインストールが必要）。
- テキスト中の数値は整数の一次式に限ります。ゼロ埋め（`padStart`）や桁区切りのように形が変わる数値は、値ごとの変種にする必要があります。SVGの `<text>` 内の数値は、`<svg>` 要素ごとの変種になります（CSSカウンタがSVG内では使えないため）。
- 属性はすべて残します（`type`、`id`、`data-*`、`aria-*` など）。`data-*`・`aria-*`・`title`・`role` などの変化は、CSSやTailwindのクラスがその属性を参照しているときだけ変種にし、それ以外は最初の値のまま残します（画像には影響しないため）。変種の中のSVG定義（marker、gradient など）は、変種ごとに別のidを付けます。
- `style` とテキスト以外の数値（SVGの `width` 属性など）は束縛できません。Reactは長さの0を単位なしで書く（`left:0` と `left:4px`）ため、0をまたぐ値は形が変わります。どちらもエラーメッセージで理由を示します。
- 変種の要素は `<rr-case>` で包まれ、表示しない変種も文書に残ります。そのため、子や兄弟を条件にするセレクタ（`li + li`、`:nth-child`、`space-y-*` など）が変種の要素に当たる場合は、アプリと見た目が変わることがあります（`build` が `UI_STRUCTURAL_CSS` で警告します）。
- ページ全体のレイアウト用の `html`/`body` のルール（`display`、中央寄せ、`min-height:100vh`、余白など）はUIに適用しません。文字・色・カスタムプロパティだけをUIの外枠に引き継ぎ、`html` の `font-size` は `rem` の基準としてSVGのルートに移します。
- 描画は UTC・`en-US` で行います（開発機とCIで同じカードになるように）。日時や数値の書式は、このロケールで表示されます。
- 変種の切り替えに `@container style()` を使います（実測した Chromium / Firefox / WebKit は対応）。Firefox はアニメーションだけで変わった値ではこの条件を評価し直さないため（実測）、UIのさらに外側の要素をサイズコンテナにして、幅をステップごとに変えています（UIの寸法は変わりません）。`@container style()` に対応しないブラウザでは、各変種の最初の状態が表示されます。
- 外部画像とWebフォントは `<img>` 内では読み込まれないため、システムフォントで代替します。
- Canvasへの命令的な描画、ブラウザAPIを描画中に使うコンポーネント、フレームワーク専用のimport（`next/font` など）は、そのままでは使えません（`analyze` が判定します）。

</details>

<details>
<summary><b>検証</b></summary>

```sh
npm test                    # 単体・結合テスト
npm run test:browser        # 実ブラウザで <img> 表示したピクセルを解読して、本物のWasmと照合
npm run test:browser:ui     # 既存UIのカードが、同じ状態の直接描画とピクセル単位で一致するか
node bin/readme-runtime.js check
```

`npm test` の内容:

- 約100の命令パターンについて、境界値を含むサンプル入力（2²³〜2²⁴の窓、49や65521の倍数を含む）と4つの演算モデルで「本物のWasmと一致するか、範囲フラグが立つか」を確認します（[`test/compiler.test.js`](test/compiler.test.js)）。
- 出力の決定性、範囲エラー、トラップ、停止判定、時計の各時刻で表示部分が選ぶ値（書き換えた初期値を含む）、`altInits` を確認します（[`test/pipeline.test.js`](test/pipeline.test.js)）。
- 2回の敵対的レビューで見つかった不具合の再現ケースを回帰テストにしています（[`test/soundness.test.js`](test/soundness.test.js)）。
- キャッシュ・差分ビルド・`check` の挙動を確認します（[`test/project.test.js`](test/project.test.js)）。
- 既存UIのカード: 上流ファイルのハッシュ、束縛の推定（条件付きで現れる要素を含む）、非一次式の拒否、Tailwind 3 / 4、描画の決定性、部品やCSSの変更による再生成、時計が唯一のアニメーションであることを確認します（[`test/ui.test.js`](test/ui.test.js)）。
- CLI: `--json` の形式、エラーコード、`analyze` の判定、`init --ui` からビルドまで、CI ワークフローのコミット固定を確認します（[`test/cli.test.js`](test/cli.test.js)）。再生回数と負荷の報告・警告は [`test/perf.test.js`](test/perf.test.js) です。

ブラウザ検証（[`test/browser/run.js`](test/browser/run.js)）の条件:

- SVGを `image/svg+xml` と、GitHubと同じCSP（`default-src 'none'; style-src 'unsafe-inline'; sandbox`）で配信し、JavaScriptを無効にしたページの `<img>` で表示します。
- 値はスクリーンショットのピクセル（32bitレジスタのLED、トレースの全列、状態ドットの色）だけから読み取ります。
- 対象は21プログラムです。C（Collatz、90分岐のif連鎖、符号なし剰余、49や65521での除算、Fibonacci LFSR、Rule 30）、Rust（ガロアLFSR）、命令を直接組んだWasm（LCG、xorshift、桁あふれ依存、2乗の剰余、popcount、float32が溢れるハッシュ、0除算トラップなど）を含みます。
- 各プログラムについて、**生成済みSVGの初期値だけを書き換えた値**（生成器はその値を知りません）でも、表示が本物のWasmの軌道と一致するか、範囲外になるステップで `OUT OF RANGE` になることを確認します。URL のフラグメント（`#x97`）で選んだ初期値も同じように確認します。
- 時計を固定した決定的な検証、実際のアニメーション（時間とともにステップが進み、どの瞬間も正しい）、`prefers-reduced-motion` の3種類を行います。

既存UIのカード（[`test/browser/ui.js`](test/browser/ui.js)）: mockcraft と air-drawing で、生成時の初期値と書き換えた初期値の両方について、時計を固定した場合とアニメーションを一時停止した場合を、直接描画した画像とピクセル単位で比べます。

</details>

<details>
<summary><b>技術選定</b></summary>

採用技術は、2026年11月時点の候補と比較して選びました。

| 領域 | 採用 | 比較と判断 |
|---|---|---|
| CSSでの計算 | 登録カスタムプロパティ + `calc()`/`mod()`/`round()`、入れ子の段 | `if()` はFirefoxが非対応（実測）。`@container style()` は3エンジンとも対応（実測）なので、UIの変種の切り替えに採用。Firefox のアニメーション中の再評価は、サイズコンテナで補う |
| Wasm→CSS | 独自のi32変換器 | 対象はi32のみで、命令名つきのエラーが必要。汎用の最適化器（Binaryenなど）は不要 |
| TSX→静的マークアップ | `react-dom/server` をVM内で決定的に実行 | Satoriは独自のレイアウトとフォントでプロジェクトのCSSを再現できない。スクリーンショットはラスタで動かない |
| バンドル | esbuild 0.28 | tsconfigのpathsとJSXに対応し、高速。Vite/Rollupはこの用途には過剰 |
| スタイル | Tailwind 4 のコンパイラAPI / Tailwind 3 はプロジェクト自身の tailwindcss 3 + PostCSS（どちらも使用クラスのみ）/ 素のCSS | プロジェクトのCSSをそのまま使える。Tailwind 3 のファイルを 4 で処理すると、v3のテーマがないため色や余白が無言で消える（実測）ので分けた |
| TSプロジェクトの計算 | AssemblyScript 0.28 | JSをWasm化する方式（Javyなど）は、JSエンジンと線形メモリを含むため対象外 |

</details>

<details>
<summary><b>デモの再現（ビルド条件の固定）</b></summary>

[`examples/collatz/collatz.wasm`](examples/collatz/collatz.wasm) はコミット済みで、次の条件で再現できます。

- コンパイラ: WebAssembly版clang [`@yowasp/clang`](https://www.npmjs.com/package/@yowasp/clang) `21.1.4-3`（`package.json` で固定。どのOSでも同じバイト列になります）
- フラグ: `--target=wasm32 -O2 -nostdlib -Wl,--no-entry`（[`tools/cc-wasm.mjs`](tools/cc-wasm.mjs)）
- sha256: `dd40a4b6513c1fe94042a3e636d706a1cf4400f255b9634abea9ccba907e787a`

```sh
npm install
node bin/readme-runtime.js build --force collatz
```

Rustの例（`lfsr-rust`）も作り直す場合は、`rustc` と `rustup target add wasm32-unknown-unknown` が必要です（[`examples/lfsr-rust/README.md`](examples/lfsr-rust/README.md)）。

</details>
