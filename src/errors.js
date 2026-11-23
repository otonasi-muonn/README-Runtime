// Stable error codes with one actionable hint each, for humans and for agents (--json).
export const HINTS = {
  CONFIG_INVALID: 'Fix readme-runtime.json as the message says. `readme-runtime analyze --json` prints a suggested card.',
  OPTION_INVALID: 'Adjust the option named in the message (see `readme-runtime --help`).',
  WASM_MISSING: 'Build the .wasm (add "build": {"command", "inputs"} to the card so `readme-runtime build` runs it) or fix the "wasm" path.',
  WASM_FORMAT: 'The file is not a WebAssembly module README Runtime can read; check the build output path and flags.',
  WASM_UNSUPPORTED: 'Rewrite the function without the named feature (loops, memory, i64/float, imports): step() computes one step from an i32 state; README Runtime does the looping.',
  BUILD_COMMAND: 'Run the build command yourself to see the full error; fix the source or the command in "build.command".',
  RANGE_STATE: 'A state value exceeds ±999,999. Use a smaller "init", fewer "steps", a halt condition, or scale the state down.',
  RANGE_INTERMEDIATE: 'An intermediate value exceeds 2^24 (Firefox float32). Reduce products before a modulo/shift, or split the state.',
  RANGE_GUARD: 'A value inside step()/view functions can leave the exact range (both arms of a conditional count). Keep intermediates below 2^23, or narrow the state.',
  MODEL_MISMATCH: 'A browser would not compute the exact value; keep values smaller (see the limits in README).',
  VIEW_RANGE: 'A view function returns a value beyond ±999,999; return smaller numbers (pixels, indices).',
  VIEW_MISMATCH: 'Internal mismatch in a view function translation; report it with the .wasm.',
  INTERNAL: 'Internal error; please report it with the .wasm and the config.',
  UI_BUNDLE: 'Fix the import named in the message. Framework-only modules (next/*) cannot be bundled: pass their values as props from the demo entry.',
  UI_RENDER: 'The component threw during a static render: give it the props it needs in the demo entry and avoid browser APIs (window, document, canvas) while rendering.',
  UI_NONLINEAR: 'Make the markup depend on the view linearly (a number = a*view + b), or narrow the view to at most 64 values in its Wasm view function.',
  UI_TOO_MANY_VARIANTS: 'Split the view into separate views that change different elements, or narrow their ranges.',
  UI_VERIFY: 'The component output depends on something other than its props (time, randomness, module state); make it a pure function of the views.',
  UI_CSS: 'Check the stylesheet path in "ui.css"; Tailwind 4 entry files are compiled automatically.',
  UI_SIZE: 'Give the root element of the demo an inline width and height in px, or set "ui.width" and "ui.height".',
  UI_NONINTEGER_TEXT: 'Numbers shown as text must be integer functions of a view (a*view + b with integer a, b).',
  UI_NO_STATES: 'The run shows no state; check "steps" and the halt condition.',
  DEPS_NOT_INSTALLED: 'Install the project dependencies (npm ci or the project package manager), then run analyze again.',
  CHECK_SOURCES_CHANGED: 'Run `readme-runtime build` and commit the result.',
  CHECK_WASM_CHANGED: 'Run `readme-runtime build` and commit the result.',
  CHECK_CARD_STALE: 'Run `readme-runtime build` (with the same README Runtime version as CI) and commit the result.',
  CHECK_CARD_MISSING: 'Run `readme-runtime build` and commit the generated SVG.',
  CHECK_NOT_IN_LOCK: 'Run `readme-runtime build` and commit readme-runtime.lock.json.',
};

export class CodedError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

const BY_CLASS = {
  ConfigError: 'CONFIG_INVALID',
  OptionError: 'OPTION_INVALID',
  RangeError: 'OPTION_INVALID',
  UnsupportedError: 'WASM_UNSUPPORTED',
  WasmFormatError: 'WASM_FORMAT',
  UnsupportedOpcode: 'WASM_UNSUPPORTED',
};

export function describeError(e) {
  const code = e?.code && typeof e.code === 'string' && HINTS[e.code] ? e.code : BY_CLASS[e?.constructor?.name] ?? 'INTERNAL';
  return { code, message: e?.message ?? String(e), hint: HINTS[code], details: e?.details ?? {} };
}
