// mockcraft editor "auto-pilot" (AssemblyScript), written with a state of several values: the
// same card preset bouncing around the page as logic.ts, without packing the state into one
// integer. README Runtime keeps each exported global below as one value of the state ("init"
// in readme-runtime.json lists them), calls step() once per frame and the view_*() functions
// on the current state; all of it is compiled to CSS.

const COLS: i32 = 23;
const ROWS: i32 = 11;
export const GRID: i32 = 8; // mockcraft GRID_DEFAULT (src/lib/snap.ts)

export let x: i32 = 0; // grid column 0..23
export let y: i32 = 0; // grid row    0..11
export let right: i32 = 1; // moving right?
export let down: i32 = 1; // moving down?
export let hits: i32 = 0; // wall bounces, mod 64

export function step(): void {
  let nx = x + (right ? 1 : -1);
  let ny = y + (down ? 1 : -1);
  if (nx < 0 || nx > COLS) { right = 1 - right; nx = x + (right ? 1 : -1); hits = (hits + 1) & 63; }
  if (ny < 0 || ny > ROWS) { down = 1 - down; ny = y + (down ? 1 : -1); hits = (hits + 1) & 63; }
  x = nx;
  y = ny;
}

// A view's range is derived for every state, not only those the run reaches: the views that
// switch markup (on, sel) bound themselves.
/** Card offset in px (multiples of the grid). */
export function view_dx(): i32 { return x * GRID; }
export function view_dy(): i32 { return y * GRID; }
/** The toggle element shows the horizontal direction. */
export function view_on(): i32 { return right ? 1 : 0; }
/** The selection outline moves to the next element on every bounce. */
export function view_sel(): i32 { return (hits & 63) % 6; }
/** Number shown in the badge. */
export function view_hits(): i32 { return hits; }
