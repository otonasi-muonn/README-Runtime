# 16ビットLFSR（Rust）

![16-bit LFSR written in Rust, computed live by CSS](../../readme-runtime/lfsr-rust.svg)

Rustで書いた16ビットのガロア型LFSR（線形帰還シフトレジスタ）の `step()` です。ビルドコマンドを差し替えるだけで、C以外の言語でも [`examples/collatz`](../collatz/) と同じ流れでカードを作れることを示す例です。`readme-runtime.json` の `build.command` を `rustc …` にしているだけで、`xor` を含むビット演算がCSSで計算されます。

```text
step(s) = (s >> 1) ^ (if s & 1 != 0 { 0xB400 } else { 0 })   // タップ 16, 14, 13, 11
```

- 初期値が1〜65535なら、0以外の16ビット値65535個をすべて巡ってから元に戻ります（最大周期）。0には到達しません。
- `u32` 経由で計算するため、Wasmの命令は `i32` の `and` / `sub` / `shr_u` / `xor` だけです。

## ビルド

Cargoは使いません。リポジトリのルートで実行します。

```sh
rustup target add wasm32-unknown-unknown
rustc --edition 2021 --crate-type cdylib --target wasm32-unknown-unknown -C opt-level=2 -C panic=abort -C strip=symbols -o examples/lfsr-rust/lfsr.wasm examples/lfsr-rust/lfsr.rs
```

- rustc: `rustc 1.93.1 (01f6ddf75 2026-02-11)`（LLVM 21.1.8、ホスト `x86_64-pc-windows-msvc`）
- 出力: 123バイト、sha256 `bac5ae0dce92bcae0ec8cf01117b79300f39bcb543f7c729f54fcb30bee41a73`
- `#![no_std]` と `-C panic=abort` で、標準ライブラリとパニック処理を含めません。
- `-C strip=symbols` で name / producers / target_features セクションを削ります。rustcのバージョン文字列やファイルパスは `.wasm` に入りません。

## 確認

```sh
node bin/readme-runtime.js inspect examples/lfsr-rust/lfsr.wasm
# step(i32) -> i32                 OK: can run in CSS as a step function

node bin/readme-runtime.js render examples/lfsr-rust/lfsr.wasm --init 1 --steps 120 --bits 16 --title "16-bit LFSR (Rust)" -o lfsr.svg
# wrote lfsr.svg (31.6 kB): 120 steps, verified against Wasm
```
