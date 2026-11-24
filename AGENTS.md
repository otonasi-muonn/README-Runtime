# README Runtime — notes for coding agents

Adding a live README card to a project. Every command is non-interactive; add `--json` to get
one JSON object on stdout (`ok`, results, or `error: { code, message, hint }`, exit code 2).
README Runtime runs the project's build commands and renders its components in Node during
`build` and `check`: use it on code you trust. It is a build tool, not a sandbox.

```sh
RR="npx --yes github:otonasi-muonn/README-Runtime"   # or: node <checkout>/bin/readme-runtime.js
$RR analyze --json                 # what can be reused: components[].reusable, warnings, nextSteps
$RR init --ui src/components/X.tsx#X --name demo --json   # scaffold + CI workflow; returns "tool"
$RR build --json                   # repeat until ok; only changed cards are rebuilt (cards[].reason)
$RR check --json                   # what CI runs; never writes
```

`init` writes `.github/workflows/readme-runtime.yml`, pinned to the README Runtime commit you ran,
and returns that command as `tool` (`npx --yes github:otonasi-muonn/README-Runtime#<commit>`).
Use `tool` for every later command: another version may write different SVG, which `check`
then reports as out of date.

1. `analyze`: a `DEPS_NOT_INSTALLED` warning means install the project first (`npm ci`); a
   `SUBPACKAGES` warning means run it in the folder it names. `reusable: "yes"` components render
   without props; `needs props` ones need values from the demo. `exports[].name` is what to put
   after `#` (`default` for a default export).
2. `init --ui` creates `readme-runtime/demo/<name>/logic.ts` (AssemblyScript) and `demo.tsx`, and a
   card in `readme-runtime.json` (tsconfig and Tailwind entry CSS are detected). Keep the first two
   lines of `logic.ts` (`/* eslint-disable */`, then `// @ts-nocheck`): they keep the project's own
   lint and type check off the AssemblyScript file.
3. `logic.ts`: `step(s: i32): i32` advances one i32 state; each `view_<v>(s: i32): i32` is a value the
   UI uses (list it in `ui.views`). No loops, memory, floats or i64; keep every value within ±999,999.
   A view's range is derived from its code for every state (not only those the run reaches), so a
   view that switches markup must bound itself: `s < 32 ? 0 : 1`, `x % 4`, not `s / 32`.
4. `demo.tsx`: render the project's own components with props computed from the views. Numbers in
   style values or text may be any `a*view + b`; anything else (class names, texts, whether an element
   exists) needs a view with at most 64 values. Give the root element an inline width/height in px.
   Build warnings (`cards[].ui.warnings`): `UI_WHOLE_VARIANTS` means the whole UI is copied per view
   value: wrap each part that appears or disappears (e.g. a component that renders null) in its own
   element. `UI_STRUCTURAL_CSS` means child/sibling selectors may style switched elements
   differently than in the app: look at the card. Each value of a wide view is checked against
   the component (`ui.verifiedEachValue`; `ui.sampledViews` were too wide), but combinations of
   wide views are only sampled: a condition on two of them at once can slip through.
5. On an error, act on `error.code` + `error.hint`. Frequent ones: `WASM_UNSUPPORTED` (rewrite the
   named construct), `RANGE_*` (values too large for exact CSS), `UI_NONLINEAR` (make the dependence
   linear or the view smaller), `UI_RENDER` (missing props / browser APIs during render),
   `UI_BUNDLE` (framework-only import such as `next/font`: pass the value as a prop instead).
6. Viewers' cost: while a card plays, the browser restyles its display once per step (not the
   whole run). `build --json` returns `cards[].perf` (updates per second, `activeSeconds` it keeps
   updating, display elements, gzip bytes) and `cards[].warnings` with `PERF_*` codes, each with a
   `fix` to merge into the card in `readme-runtime.json`. Defaults: `stepMs` 150, `loops: "auto"`
   (whole runs for about a minute from page load, then it rests on the last step and costs
   nothing); `"loops": "infinite"` keeps it running while it is on screen.
7. `altInits: [97]` lets the same file start from other initial values, each verified like
   `init`: embed `![demo](readme-runtime/<name>.svg#x97)` (negative: `#x-17`).
8. Embed `![demo](readme-runtime/<name>.svg)` in README.md; commit the SVG, `readme-runtime.json`,
   `readme-runtime.lock.json`, the workflow and `readme-runtime/demo/<name>/` including `logic.wasm`
   (CI checks against it and never builds it). Never edit generated SVGs or the lock by hand. CI
   installs the project's dependencies before `check` (the workflow `init` writes does).
   Renders run in UTC with the en-US locale, so dates and numbers are the same on every machine.

Working on README Runtime itself: `npm test` (unit), `npm run test:browser` and
`npm run test:browser:ui` (real browsers, pixels from `<img>` with JS off). Generated cards are
checked byte-for-byte by `node bin/readme-runtime.js check`.
