// README demo for mockcraft (github.com/otonasi-muonn/UIdesign).
// Everything visual comes from the project's own code, unchanged (see upstream.json):
//   buildPreset / mk      -> element data   (src/lib/templates.ts, src/lib/defaults.ts)
//   ElementView           -> element markup (src/components/board/ElementView.tsx)
//   globals.css           -> element styles (src/app/globals.css, Tailwind 4)
// The props are view values that README Runtime computes in CSS from logic.wasm.
import { ElementView } from "@/components/board/ElementView";
import { buildPreset } from "@/lib/templates";
import { mk } from "@/lib/defaults";

type Views = { dx: number; dy: number; on: number; sel: number; hits: number };

export default function Demo({ dx, dy, on, sel, hits }: Views) {
  const card = buildPreset("card", 16 + dx, 16 + dy, 520);
  const panel = [
    mk("text", 540, 20, { w: 150, h: 22, props: { text: on ? "→ 右へ移動中" : "← 左へ移動中", fontSize: 13, weight: 700, color: "#1b1a18" } }),
    mk("toggle", 540, 52),
    mk("badge", 540, 100, { w: 150, h: 30, props: { text: `反射 ${hits} 回`, fill: "#ff6a45", color: "#fff" } }),
    mk("text", 540, 146, { w: 150, h: 20, props: { text: `x ${16 + dx} · y ${16 + dy}`, fontSize: 12, color: "#5b5852" } }),
  ];
  panel[1].props.on = on === 1;
  const els = [...card, ...panel];
  return (
    <div style={{ position: "relative", width: 712, height: 330, background: "#f6f4ef", borderRadius: 14, overflow: "hidden" }}>
      {els.map((el, i) => (
        <ElementView key={i} el={el} selected={sel === i} />
      ))}
    </div>
  );
}
