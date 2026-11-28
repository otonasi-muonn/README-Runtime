# README Runtime — notes for coding agents

Adding a live README card to a project. Every command is non-interactive; add `--json` to get
one JSON object on stdout (`ok`, results, or `error: { code, message, hint }`, exit code 2).
`build` runs the project's build commands in a shell, and `build` and `check` render its
components in Node (`check` runs no build command): use it on code you trust. It is a build tool,
not a sandbox.

```sh
RR="npx --yes https://github.com/otonasi-muonn/README-Runtime/archive/HEAD.tar.gz"   # or: node <checkout>/bin/readme-runtime.js
$RR analyze --json                 # what can be reused: components[].reusable, warnings, nextSteps
$RR init --ui src/components/X.tsx#X --name demo --json   # scaffold + CI workflow; returns "tool"
$RR build --json                   # repeat until ok; only changed cards are rebuilt (cards[].reason)
$RR check --json                   # what CI runs; never writes
```

Run it in the folder that has the components' `package.json` (`analyze` says so with `SUBPACKAGES`).
`init` writes `.github/workflows/readme-runtime.yml` at the repository root (it runs `check` in that
folder and installs dependencies where the nearest lockfile is: npm, pnpm, yarn or bun), pinned to
the README Runtime commit you ran,
and returns that command as `tool` (`npx --yes https://github.com/otonasi-muonn/README-Runtime/archive/<commit>.tar.gz`;
npm 10 cannot install the git spec `github:owner/repo#ref` with npx).
Use `tool` for every later command: another version may write different SVG, which `check`
then reports as out of date. In `package.json` scripts run by Bun, `npx` becomes `bun x`, which
cannot install that URL: write `npm exec --yes --package=<archive URL> -- readme-runtime build`.

1. `analyze`: a `DEPS_NOT_INSTALLED` warning means install the project first (`npm ci`); a
   `SUBPACKAGES` warning means run it in the folder it names. `reusable: "yes"` components render
   without props; `needs props` ones need values from the demo. `exports[].name` is what to put
   after `#` (`default` for a default export).
2. `init --ui` creates `readme-runtime/demo/<name>/logic.ts` (AssemblyScript) and `demo.tsx`, and a
   card in `readme-runtime.json` (tsconfig and Tailwind entry CSS are detected; `--tsconfig` and
   `--css` override). The scaffold renders the component without props: for one that `analyze`
   lists as `needs props`, pass them in `demo.tsx` before the first build. Keep the first two
   lines of `logic.ts` (`/* eslint-disable */`, then `// @ts-nocheck`): they keep the project's own
   lint and type check off the AssemblyScript file.
3. `logic.ts`: `step(s: i32): i32` advances one i32 state; each `view_<v>(s: i32): i32` is a value the
   UI uses (list it in `ui.views`). No loops, memory, floats or i64; keep every value within ±999,999.
   A view's range is derived from its code for every state (not only those the run reaches), so a
   view that switches markup must bound itself: `s < 32 ? 0 : 1`, `x % 4`, not `s / 32`.
   A state of several values needs no bit packing: list the names in order in `"state"` and
   give `"init"` as an object (`"state": ["x", "y"], "init": {"x": 3, "y": 5}`; the order is the
   array's, so tools that sort JSON keys cannot change it). Either `"export": "step"` is a
   `step(): void` that updates exported mutable i32 globals with those names (AssemblyScript:
   `export let x: i32 = 0;`; views and `haltExport` are `(): i32` reading them), or
   `"export": {"x": "step_x", "y": "step_y"}` gives one pure function per value, each taking the
   whole state in `"state"` order (views and `haltExport` too). In C, mark a helper several step
   functions call `static inline __attribute__((always_inline))`. Up to 8 values, each within
   ±999,999; `"halt"` (a value) needs one integer; `altInits` are objects like `"init"`. Check
   `cards[].state.binding` in `build --json` (returned when the card is generated; `--force` to see
   it again). Such a state is shown by a UI card (`ui`): the trace
   card shows one integer, so a state of several values without `ui` is an error.
4. `demo.tsx`: render the project's own components with props computed from the views. Numbers in
   style values or text may be any `a*view + b`; anything else (class names, texts, whether an element
   exists) needs a view with at most 64 values. Give the root element an inline width/height in px.
   Set `"interpolate": true` (or `"ease"`, `"cubic-bezier(...)"`, or `{"easing": "ease-in-out", "views": ["dx"]}`)
   on a UI card to smoothly interpolate continuous `style` bindings (`left`, `top`, `transform`, `width`,
   `opacity`, etc.) across each `stepMs` via a local `--rf` (`0..1`) animation on `.rr-ui`, while keeping
   `.C`/`.D` discrete once per `stepMs` and keeping text counters, `@container` switches, integer-only
   CSS properties (`z-index`, `grid-*`, `columns`, `repeat()`), and `halt`/`hold`/`trap` boundaries discrete
   (`UI_INTERPOLATE_DISCRETE_ONLY` warns when a listed view has no continuous style bindings).
   The display selects, on every step, the state values the views read (`cards[].perf.selectedValues`,
   plus `nextSelectedValues` when interpolated; `PERF_WIDE_SELECTION` when it gets expensive).
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
   whole run). `steps` may be 1..2,000 (above 400, multiple steps are unrolled per `<g>` so DOM
   nesting stays <= 320 levels, and selection uses 2D power-of-two factoring). `build --json`
   returns `cards[].perf` (updates per second, `interpolated`, `activeSeconds` it keeps updating, `levels`,
   `stepsPerLevel`, display elements, gzip bytes), `cards[].execution` (`mode`: `"finite"`,
   `"finite-replay"`, `"halt"`, or `"periodic"` when `loops: "infinite"`, `hold: 0`, and
   `step(x_steps) == x_0`; plus `cycle` and `interpolation`), and `cards[].warnings` with `PERF_*` codes, each with a
   `fix` to merge into the card in `readme-runtime.json`. Defaults: `stepMs` 150, `loops: "auto"`
   (whole runs for about a minute from page load, then it rests on the last step and costs
   nothing); `"loops": "infinite"` keeps it running while it is on screen. Use `"infinite"` for the
   card a visitor sees first (the top of a README): a finite card is still once its runs are over,
   also after a reload in Firefox (measured; the image is apparently not recreated, so its clock
   goes on).
7. `altInits: [97]` lets the same file start from other initial values, each verified like
   `init`: embed `![demo](readme-runtime/<name>.svg?x97#x97)` (negative: `#x-17`). Keep the query:
   WebKit shares one document between images of the same URL and recomputes the whole run each
   time it switches fragments (two such images used a full CPU core). `build --json` returns the
   lines to paste in `cards[].embed`.
8. Embed `![demo](readme-runtime/<name>.svg)` in README.md; commit the SVG, `readme-runtime.json`,
   `readme-runtime.lock.json`, the workflow and `readme-runtime/demo/<name>/` including `logic.wasm`
   (CI checks against it and never builds it). Never edit generated SVGs or the lock by hand. CI
   installs the project's dependencies before `check` (the workflow `init` writes does).
   Renders run in UTC with the en-US locale, so dates and numbers are the same on every machine.
9. Looking at the card yourself: it follows the viewer's reduce-motion setting (it shows the last
   step, still), and Playwright's per-page emulation does not reach an SVG inside `<img>`. Launch
   Chromium with `--force-prefers-no-reduced-motion` (Firefox: pref `ui.prefersReducedMotion` 0)
   to see it move. Images and web fonts are not loaded inside `<img>`: pass small images to the
   demo as data URIs.

Working on README Runtime itself: `npm test` (unit), `npm run test:browser` and
`npm run test:browser:ui` (real browsers, pixels from `<img>` with JS off). Generated cards are
checked byte-for-byte by `node bin/readme-runtime.js check`.

## Design principles

- Improve execution and rendering capabilities, correctness and performance.
- Report results, limitations, failure causes and verification coverage accurately, in machine-readable form where applicable.
- Respect the host project. Keep Runtime-specific adapters and dependencies outside its production code. Prefer reuse without edits; make only necessary, behavior-preserving extractions or exports when useful, not unrelated refactors. Avoid changing host build settings or dependencies unnecessarily. Demo directories can still be picked up by the host toolchain; verify its existing build, lint and tests after integration. Use isolated clones for adoption experiments; do not push to the host repository without permission.

## Development and verification

- Match verification to the actual impact of a change, with particular care for compiler semantics, state transitions, numerical precision and browser rendering.
- Prefer existing tests, CI and benchmarks; turn reproducible bugs into regression tests where practical. Review new or modified tests and benchmarks for whether they actually measure the intended property.
- Keep output concise: summarize pass/fail, relevant differences and untested conditions; read detailed logs when needed.
- Require concrete evidence and impact for review findings. Do not turn speculative risks or subjective preferences into implementation requirements.
- Independent review, when needed, normally takes one round plus a targeted recheck of significant fixes. Escalate unresolved serious issues rather than treating the review limit as a pass.
- Stop searching for additional problems once the relevant quality criteria are met. Do not claim verification that was not performed.
- For handoffs, share the commit/diff, test results and unresolved questions with references to the originals. Use existing task channels; do not create handoff files by default.
