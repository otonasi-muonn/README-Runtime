// mockcraft editor "auto-pilot" (AssemblyScript): a card preset bouncing around the page,
// snapped to mockcraft's 8 px grid. README Runtime calls step() once per frame and the
// view_*() functions on the current state; all of it is compiled to CSS.
//
// State, packed into one i32 (17 bits):
//   bits 0-4  x       grid column 0..23
//   bits 5-8  y       grid row    0..11
//   bit  9    right   moving right?
//   bit  10   down    moving down?
//   bits 11-16 hits   wall bounces, mod 64

const COLS: i32 = 23;
const ROWS: i32 = 11;
export const GRID: i32 = 8; // mockcraft GRID_DEFAULT (src/lib/snap.ts)

function x(s: i32): i32 { return s & 31; }
function y(s: i32): i32 { return (s >> 5) & 15; }
function right(s: i32): i32 { return (s >> 9) & 1; }
function down(s: i32): i32 { return (s >> 10) & 1; }
function hits(s: i32): i32 { return (s >> 11) & 63; }

export function step(s: i32): i32 {
  let nx = x(s) + (right(s) ? 1 : -1);
  let ny = y(s) + (down(s) ? 1 : -1);
  let r = right(s);
  let d = down(s);
  let h = hits(s);
  if (nx < 0 || nx > COLS) { r = 1 - r; nx = x(s) + (r ? 1 : -1); h = (h + 1) & 63; }
  if (ny < 0 || ny > ROWS) { d = 1 - d; ny = y(s) + (d ? 1 : -1); h = (h + 1) & 63; }
  return nx | (ny << 5) | (r << 9) | (d << 10) | (h << 11);
}

/** Card offset in px (multiples of the grid). */
export function view_dx(s: i32): i32 { return x(s) * GRID; }
export function view_dy(s: i32): i32 { return y(s) * GRID; }
/** The toggle element shows the horizontal direction. */
export function view_on(s: i32): i32 { return right(s); }
/** The selection outline moves to the next element on every bounce. */
export function view_sel(s: i32): i32 { return hits(s) % 6; }
/** Number shown in the badge. */
export function view_hits(s: i32): i32 { return hits(s); }
