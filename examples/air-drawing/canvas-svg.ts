// A recording stand-in for CanvasRenderingContext2D: instead of painting pixels it writes
// the path commands it receives as SVG path data. It implements exactly the members that
// air-drawing-board's renderStroke() uses (upstream/src/render/canvasRenderer.ts);
// touching any other member throws, so a renderer change that needs more is caught at
// build time instead of silently drawing nothing.

export interface SvgShape {
  d: string;
  paint: "stroke" | "fill";
  color: string;
  width: number;
  cap: string;
  join: string;
}

const STATE_KEYS = ["strokeStyle", "fillStyle", "lineWidth", "lineCap", "lineJoin"] as const;
type StateKey = (typeof STATE_KEYS)[number];

const num = (v: number) => String(Math.round(v * 100) / 100);
const pt = (x: number, y: number) => `${num(x)} ${num(y)}`;

export function recordCanvas(): { ctx: CanvasRenderingContext2D; shapes: SvgShape[] } {
  const shapes: SvgShape[] = [];
  const state: Record<StateKey, string | number> = {
    strokeStyle: "#000000", fillStyle: "#000000", lineWidth: 1, lineCap: "butt", lineJoin: "miter",
  };
  let d: string[] = [];
  const shape = (paint: SvgShape["paint"]): SvgShape => ({
    d: d.join(""), paint, color: String(paint === "fill" ? state.fillStyle : state.strokeStyle),
    width: Number(state.lineWidth), cap: String(state.lineCap), join: String(state.lineJoin),
  });
  const api: Record<string, (...a: number[]) => void> = {
    beginPath() { d = []; },
    moveTo(x, y) { d.push(`M${pt(x, y)}`); },
    lineTo(x, y) { d.push(`${d.length ? "L" : "M"}${pt(x, y)}`); },
    quadraticCurveTo(cx, cy, x, y) { d.push(`Q${pt(cx, cy)} ${pt(x, y)}`); },
    // Canvas arc(): a sweep of 2π or more in the drawing direction is the whole circle.
    arc(x, y, r, a0, a1, ccw = 0) {
      const at = (a: number) => pt(x + r * Math.cos(a), y + r * Math.sin(a));
      const sweep = ccw ? a0 - a1 : a1 - a0;
      const dir = ccw ? 0 : 1;
      d.push(`${d.length ? "L" : "M"}${at(a0)}`);
      if (sweep >= 2 * Math.PI) {
        const half = ccw ? a0 - Math.PI : a0 + Math.PI;
        d.push(`A${num(r)} ${num(r)} 0 1 ${dir} ${at(half)}A${num(r)} ${num(r)} 0 1 ${dir} ${at(a0)}`);
      } else {
        const s = ((sweep % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
        d.push(`A${num(r)} ${num(r)} 0 ${s > Math.PI ? 1 : 0} ${dir} ${at(a1)}`);
      }
    },
    stroke() { shapes.push(shape("stroke")); },
    fill() { shapes.push(shape("fill")); },
  };
  const ctx = new Proxy({}, {
    get(_, key) {
      if (typeof key === "string" && key in api) return api[key];
      if (typeof key === "string" && (STATE_KEYS as readonly string[]).includes(key)) return state[key as StateKey];
      throw new Error(`canvas-svg: CanvasRenderingContext2D.${String(key)} is not recorded (only what renderStroke uses is)`);
    },
    set(_, key, value) {
      if (typeof key !== "string" || !(STATE_KEYS as readonly string[]).includes(key)) {
        throw new Error(`canvas-svg: setting CanvasRenderingContext2D.${String(key)} is not recorded`);
      }
      state[key as StateKey] = value;
      return true;
    },
  });
  return { ctx: ctx as unknown as CanvasRenderingContext2D, shapes };
}
