// README demo for air-drawing-board (github.com/otonasi-muonn/air-drawing-board): a replay of
// a real drawing, point by point. Reused from the project, unchanged (see upstream.json):
//   renderStroke()               -> every stroke's geometry (src/render/canvasRenderer.ts),
//                                   run on canvas-svg.ts, a recording 2D-context stand-in
//   PALETTE / WIDTHS / DW / DH   -> src/domain/drawing.ts
//   the drawing                  -> tests/fixtures/test-vectors-v1.json "sample-face", decoded at
//                                   build time by the real decodeDrawing() (prepare.mjs)
//   styles.css                   -> header, toolbar, swatch and width-button styles
// The app builds this markup imperatively (index.html + appController.ts); it is written out
// here with the same elements and class names. The props are view values that README Runtime
// computes in CSS from logic.wasm.
import { renderStroke } from "./upstream/src/render/canvasRenderer";
import { DH, DW, PALETTE, WIDTHS, type Stroke } from "./upstream/src/domain/drawing";
import { recordCanvas } from "./canvas-svg";
import drawing from "./generated/drawing.json";

type Views = { k0: number; k1: number; k2: number; k3: number; col: number; wid: number; n: number; pts: number };

const strokes = drawing.strokes as Stroke[];
const total = strokes.reduce((s, x) => s + x.pts.length, 0);
const STAGE_W = 480; // the app scales its 960x720 canvas with CSS; here to one half
const scale = STAGE_W / DW;
const WIDTH_LABELS = ["細", "中", "太"]; // index.html .wbtn data-w="0|1|2"

// One <svg> per stroke, stacked in drawing order like the canvas paints them. A stroke whose
// first k points are down looks exactly like the app's active layer at that moment:
// renderStroke() on those k points. The ring at the newest point has #penDot's geometry
// (18px, 3px accent border), which the app shows while drawing with the camera.
function StrokeLayer({ stroke, k }: { stroke: Stroke; k: number }) {
  const { ctx, shapes } = recordCanvas();
  renderStroke(ctx, { ...stroke, pts: stroke.pts.slice(0, k) });
  const tip = k >= 1 && k < stroke.pts.length ? stroke.pts[k - 1] : null;
  return (
    <svg viewBox={`0 0 ${DW} ${DH}`} width={STAGE_W} height={STAGE_W * (DH / DW)} style={{ position: "absolute", left: 0, top: 0 }}>
      {shapes.map((s, i) =>
        s.paint === "stroke" ? (
          <path key={i} d={s.d} fill="none" stroke={s.color} strokeWidth={s.width} strokeLinecap={s.cap as "round"} strokeLinejoin={s.join as "round"} />
        ) : (
          <path key={i} d={s.d} fill={s.color} />
        ),
      )}
      {tip && <circle cx={tip[0]} cy={tip[1]} r={7.5 / scale} fill="none" strokeWidth={3 / scale} style={{ stroke: "var(--accent)" }} />}
    </svg>
  );
}

export default function Demo({ k0, k1, k2, k3, col, wid, n, pts }: Views) {
  const ks = [k0, k1, k2, k3];
  // The card applies the page's body rules (font, colour) to the UI but not its background,
  // so the root paints styles.css's body background (#fdfdf8) itself.
  return (
    <div style={{ position: "relative", width: 760, height: 448, overflow: "hidden", background: "#fdfdf8", borderRadius: 10 }}>
      <header>
        <span className="title">🎨 空中お絵描き掲示板</span>
        <button className="active">かく</button>
        <button>掲示板</button>
        <button>全画面</button>
      </header>
      <main>
        <section className="view show" style={{ display: "flex", gap: 16, alignItems: "flex-start" }}>
          {/* #stage + #drawCanvas: the app styles these by id, and ids do not survive into the card */}
          <div style={{ position: "relative", flex: "none", width: STAGE_W + 4, height: STAGE_W * (DH / DW) + 4, background: "#fff", border: "2px solid #333", borderRadius: 10, overflow: "hidden" }}>
            {strokes.map((s, i) => (
              <StrokeLayer key={i} stroke={s} k={ks[i]} />
            ))}
          </div>
          <div style={{ width: 240 }}>
            <div className="steps" style={{ justifyContent: "flex-start" }}>
              <span className="now">① 描く</span>
              <span>② 「完成！」を押す</span>
              <span>③ QRでスマホに保存</span>
            </div>
            <div className="toolbar">
              {PALETTE.map((c, i) => (
                <button key={c} className={i === col ? "swatch sel" : "swatch"} style={{ background: c }} title={c} />
              ))}
            </div>
            <div className="toolbar">
              <span>太さ:</span>
              {/* .wbtn sets no text colour; WebKit draws an <img> on a dark page with light
                  button text (color-scheme does not help), so unselected ones get the app's ink */}
              {WIDTHS.map((w, i) => (
                <button key={w} className={i === wid ? "wbtn sel" : "wbtn"} style={i === wid ? undefined : { color: "var(--ink)" }}>
                  {WIDTH_LABELS[i]}
                </button>
              ))}
            </div>
            <p className="hint" style={{ textAlign: "left" }}>
              ストローク {n} / {strokes.length} · 点 {pts} / {total}
            </p>
          </div>
        </section>
      </main>
    </div>
  );
}
