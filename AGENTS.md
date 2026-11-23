# README Runtime — notes for coding agents

Adding a live README card to a project. Every command is non-interactive; add `--json` to get
one JSON object on stdout (`ok`, results, or `error: { code, message, hint }`, exit code 2).

```sh
RR="npx --yes github:otonasi-muonn/README-Runtime#v0.1.0"   # or: node <checkout>/bin/readme-runtime.js
$RR analyze --json                 # what can be reused: components[].reusable, warnings, nextSteps
$RR init --ui src/components/X.tsx#X --name demo --json   # scaffold; builds as generated
$RR build --json                   # repeat until ok; only changed cards are rebuilt (cards[].reason)
$RR check --json                   # what CI runs; never writes
```

1. `analyze`: a `DEPS_NOT_INSTALLED` warning means install the project first (`npm ci`).
   `reusable: "yes"` components render without props; `needs props` ones need values from the demo.
2. `init --ui` creates `readme-runtime/demo/<name>/logic.ts` (AssemblyScript) and `demo.tsx`, and a
   card in `readme-runtime.json` (tsconfig and Tailwind entry CSS are detected).
3. `logic.ts`: `step(s: i32): i32` advances one i32 state; each `view_<v>(s: i32): i32` is a value the
   UI uses (list it in `ui.views`). No loops, memory, floats or i64; keep every value within ±999,999.
4. `demo.tsx`: render the project's own components with props computed from the views. Numbers in
   style values or text may be any `a*view + b`; anything else (class names, texts, whether an element
   exists) needs a view with at most 64 values. Give the root element an inline width/height in px.
5. On an error, act on `error.code` + `error.hint`. Frequent ones: `WASM_UNSUPPORTED` (rewrite the
   named construct), `RANGE_*` (values too large for exact CSS), `UI_NONLINEAR` (make the dependence
   linear or the view smaller), `UI_RENDER` (missing props / browser APIs during render),
   `UI_BUNDLE` (framework-only import such as `next/font`: pass the value as a prop instead).
6. Embed `![demo](readme-runtime/<name>.svg)` in README.md; commit the SVG, `readme-runtime.json` and
   `readme-runtime.lock.json`. Never edit generated SVGs or the lock by hand.

Working on README Runtime itself: `npm test` (unit), `npm run test:browser` and
`npm run test:browser:ui` (real browsers, pixels from `<img>` with JS off). Generated cards are
checked byte-for-byte by `node bin/readme-runtime.js check`.
