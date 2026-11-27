// The thresholds of the PERF_* warnings, as in src/perf.js (d11668f). They are rules of thumb from
// bench/ on one desktop, not guarantees; the GUI draws them as reference lines only.
export const PERF_LIMITS = {
  minStepMs: 100, // PERF_FAST_CLOCK below this: above 10 updates per second
  longRun: 240, // PERF_LONG_RUN above this many steps
  displayElements: 600, // PERF_LARGE_DISPLAY above this (or containerRules)
  containerRules: 120,
};

/** "loops": "auto" plays whole runs for at least this long from page load. */
export const AUTO_PLAY_SECONDS = 60;
