// Japanese headings for the CLI's codes (src/errors.js, src/perf.js). The CLI's own message and
// hint are always shown under the heading; an unknown code just shows its name.
export const CODE_LABELS: Record<string, string> = {
  CONFIG_INVALID: '設定ファイルに誤りがあります',
  OPTION_INVALID: '設定値が使える範囲の外です',
  WASM_MISSING: 'Wasm ファイルが見つかりません',
  WASM_FORMAT: 'Wasm ファイルを読み込めません',
  WASM_UNSUPPORTED: 'CSS に変換できない処理が Wasm にあります',
  BUILD_COMMAND: 'Wasm のビルドコマンドが失敗しました',
  RANGE_STATE: '状態の値が、CSS で正確に計算できる範囲（±999,999）を超えました',
  RANGE_INTERMEDIATE: '計算の途中の値が、CSS で正確に計算できる範囲を超えました',
  RANGE_GUARD: '計算の途中の値が、範囲を超えるおそれがあります',
  MODEL_MISMATCH: 'ブラウザが正確に計算できない値があります',
  VIEW_RANGE: 'view 関数の値が ±999,999 を超えます',
  VIEW_MISMATCH: 'view 関数の変換が一致しません（内部エラー）',
  INTERNAL: '内部エラー',
  UI_BUNDLE: 'デモのコンポーネントを束ねられません',
  UI_RENDER: 'デモのコンポーネントの描画に失敗しました',
  UI_NONLINEAR: '値と見た目の対応を推定できません',
  UI_TOO_MANY_VARIANTS: '切り替えの組み合わせが多すぎます',
  UI_VERIFY: '描画結果が推定と一致しません',
  UI_CSS: 'スタイルシートを読み込めません',
  UI_SIZE: 'UI の大きさが分かりません',
  UI_NONINTEGER_TEXT: 'テキスト中の数値が整数の一次式ではありません',
  UI_NO_STATES: '表示する状態がありません',
  DEPS_NOT_INSTALLED: 'プロジェクトの依存がインストールされていません',
  CHECK_SOURCES_CHANGED: 'ソースが変わったのに、カードが作り直されていません',
  CHECK_WASM_CHANGED: 'Wasm が、カードを作ったときと違います',
  CHECK_CARD_STALE: 'SVG が古いか、手で編集されています',
  CHECK_CARD_MISSING: 'SVG がありません',
  CHECK_NOT_IN_LOCK: 'カードが lock ファイルにありません',
  GUI_REQUEST: '接続に失敗しました',
  PERF_FAST_CLOCK: '更新が速く、閲覧者の負荷が増えます',
  PERF_ENDLESS: '再生が止まりません（無限ループ）',
  PERF_LONG_RUN: 'ステップ数が多く、初回表示とファイルサイズが増えます',
  PERF_LARGE_DISPLAY: '表示部分の要素が多く、毎ステップの描き直しが重くなります',
};

export const labelFor = (code: string) => CODE_LABELS[code] ?? code;

export const END_LABELS: Record<string, (at: number) => string> = {
  steps: (at) => `${at} ステップ実行`,
  halt: (at) => `${at} ステップ目で停止条件に到達`,
  trap: (at) => `${at} ステップ目でトラップ（TRAP と表示）`,
  range: (at) => `${at} ステップ目で範囲外（OUT OF RANGE と表示）`,
};

export const FIX_LABELS: Record<string, (v: unknown) => string> = {
  stepMs: (v) => `1ステップの時間を ${v} ms にする`,
  loops: (v) => (v === 'auto' ? 'ループを「自動（約1分）」にする' : `ループを ${v} にする`),
  steps: (v) => `ステップ数を ${v} にする`,
};
