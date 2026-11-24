// What a card asks of its viewers, from its options and its output, and warnings with a fix
// for readme-runtime.json. The browser recomputes the display (not the run) once per step:
// the cost per second follows the update rate and the size of the display; the number of
// steps adds to the first render and to the size of the file. Thresholds are rules of thumb
// from bench/ (one desktop), not guarantees.
import zlib from 'node:zlib';

// "loops": "auto" (the default) plays whole runs for at least this long, then the card stays
// on its last step and costs nothing. Browsers keep a card's clock running while it is out of
// view (bench/policy.mjs), so this is about a minute from opening the page, not from seeing it.
export const AUTO_PLAY_MS = 60000;
export const loopMs = (o) => (o.steps + o.hold + 1) * o.stepMs; // the clock counts 0..steps+hold
export function resolveLoops(o) {
  return o.loops === 'auto' ? Math.max(1, Math.ceil(AUTO_PLAY_MS / loopMs(o))) : o.loops;
}

export const PERF_LIMITS = {
  minStepMs: 100, // above 10 updates per second
  longRun: 240, // steps: first render and file size grow with the run
  displayElements: 600, // elements restyled and repainted on every step
  containerRules: 120, // @container style() rules (switched markup) re-evaluated on every step
};

export function perfReport(o, svg) {
  const display = svg.slice(svg.indexOf('<g class="C">'));
  const displayElements = (display.match(/<[a-zA-Z][\w-]*/g) ?? []).length;
  const containerRules = (svg.match(/@container/g) ?? []).length;
  const loopSeconds = loopMs(o) / 1000;
  const loops = resolveLoops(o);
  const report = {
    updatesPerSecond: Number((1000 / o.stepMs).toFixed(1)),
    loopSeconds: Number(loopSeconds.toFixed(1)),
    // how long the card keeps updating while visible; null: as long as it is shown
    loops,
    activeSeconds: loops === 'infinite' ? null : Number((loopSeconds * loops).toFixed(1)),
    steps: o.steps, displayElements, containerRules,
    bytes: Buffer.byteLength(svg), gzipBytes: zlib.gzipSync(svg, { level: 9 }).length,
  };
  const warnings = [];
  const large = displayElements > PERF_LIMITS.displayElements || containerRules > PERF_LIMITS.containerRules;
  // one stepMs that both clock warnings agree on
  const slower = Math.max(o.stepMs, large ? 200 : 150);
  if (o.stepMs < PERF_LIMITS.minStepMs) {
    warnings.push({
      code: 'PERF_FAST_CLOCK',
      message: `the card updates ${report.updatesPerSecond} times per second (stepMs ${o.stepMs}); every update restyles and repaints the display, so viewers' CPU use grows with the rate`,
      fix: { stepMs: slower },
    });
  }
  if (loops === 'infinite') {
    warnings.push({
      code: 'PERF_ENDLESS',
      message: 'loops is "infinite": the card keeps updating for as long as the page is open and the card is on screen (WebKit also while it is scrolled out of view); "auto" plays for about a minute and then rests on the last step, which costs nothing',
      fix: { loops: 'auto' },
    });
  }
  if (o.steps > PERF_LIMITS.longRun) {
    warnings.push({
      code: 'PERF_LONG_RUN',
      message: `${o.steps} steps: the first render computes every step and the file grows with each one (${(report.gzipBytes / 1024).toFixed(1)} kB gzip); a shorter run or a halt condition keeps both small`,
      fix: { steps: PERF_LIMITS.longRun },
    });
  }
  if (large) {
    warnings.push({
      code: 'PERF_LARGE_DISPLAY',
      message: `the display has ${displayElements} elements and ${containerRules} @container rules, restyled on every step; show a smaller part of the UI, or fewer switched (discrete) props`,
      fix: { stepMs: slower },
    });
  }
  return { report, warnings };
}
