// air-drawing-board replay (AssemblyScript). The state is a frame counter t; every frame one
// more input point of the real drawing lands, as when the app receives pointer moves and
// redraws the active stroke. README Runtime calls step() once per frame and the view_*()
// functions on the current state; all of it is compiled to CSS.
//
// What a stroke looks like after k points is not computed here: demo.tsx runs the app's own
// renderStroke() on the first k points (at build time). This file only decides, from t, how
// many points of each stroke are down and which colour / width the toolbar shows.
import {
  POINTS_0, POINTS_1, POINTS_2, POINTS_3,
  COLOR_0, COLOR_1, COLOR_2, COLOR_3, WIDTH_0, WIDTH_1, WIDTH_2, WIDTH_3,
} from "./generated/drawing";

const LEAD: i32 = 4; // empty-canvas frames before the first stroke
const GAP: i32 = 6; // pen-up frames between strokes
const PICK: i32 = 3; // the next stroke's colour / width is picked this many frames before it starts

const START_0: i32 = LEAD;
const START_1: i32 = START_0 + POINTS_0 + GAP;
const START_2: i32 = START_1 + POINTS_1 + GAP;
const START_3: i32 = START_2 + POINTS_2 + GAP;
/** Frame on which the last point lands: the card's "steps" (readme-runtime.json). */
export const LAST_FRAME: i32 = START_3 + POINTS_3 - 1;

export function step(t: i32): i32 {
  return t + 1;
}

// Points of a stroke that are down at frame t (0 before it starts, n once it is finished).
function drawn(t: i32, start: i32, n: i32): i32 {
  const k = t - start + 1;
  return k < 0 ? 0 : k > n ? n : k;
}

// Stroke whose colour / width the toolbar shows at frame t.
function current(t: i32): i32 {
  return t >= START_3 - PICK ? 3 : t >= START_2 - PICK ? 2 : t >= START_1 - PICK ? 1 : 0;
}

// Points drawn of each stroke. The unsigned "% (n + 1)" never changes the value (it is
// already 0..n); it lets README Runtime's interval analysis see that the view takes exactly
// n + 1 values. A view that switches markup variants may take at most 64 (else UI_NONLINEAR).
export function view_k0(t: i32): i32 { return <i32>(<u32>drawn(t, START_0, POINTS_0) % <u32>(POINTS_0 + 1)); }
export function view_k1(t: i32): i32 { return <i32>(<u32>drawn(t, START_1, POINTS_1) % <u32>(POINTS_1 + 1)); }
export function view_k2(t: i32): i32 { return <i32>(<u32>drawn(t, START_2, POINTS_2) % <u32>(POINTS_2 + 1)); }
export function view_k3(t: i32): i32 { return <i32>(<u32>drawn(t, START_3, POINTS_3) % <u32>(POINTS_3 + 1)); }

/** Palette index (PALETTE in src/domain/drawing.ts) of the selected swatch. */
export function view_col(t: i32): i32 {
  const i = current(t);
  return i == 3 ? COLOR_3 : i == 2 ? COLOR_2 : i == 1 ? COLOR_1 : COLOR_0;
}

/** Width index (WIDTHS) of the selected width button. */
export function view_wid(t: i32): i32 {
  const i = current(t);
  return i == 3 ? WIDTH_3 : i == 2 ? WIDTH_2 : i == 1 ? WIDTH_1 : WIDTH_0;
}

/** Strokes begun so far, and points drawn so far (shown as numbers). */
export function view_n(t: i32): i32 {
  return i32(t >= START_0) + i32(t >= START_1) + i32(t >= START_2) + i32(t >= START_3);
}
export function view_pts(t: i32): i32 {
  return drawn(t, START_0, POINTS_0) + drawn(t, START_1, POINTS_1) + drawn(t, START_2, POINTS_2) + drawn(t, START_3, POINTS_3);
}
