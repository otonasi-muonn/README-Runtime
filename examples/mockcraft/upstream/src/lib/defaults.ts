/**
 * Element factory + sample-project bootstrap, ported from the legacy single-file app.
 *
 * Numeric behavior (default sizes/props, the two-page sample project, z-index math,
 * and the id-generation scheme) is reproduced EXACTLY from the original so that
 * snapshots, reflow math, and exports stay byte-for-byte compatible.
 */
import type {
  ElementType,
  ElementProps,
  MockElement,
  Page,
  Project,
  ConstraintX,
  ConstraintY,
} from "./types";

/* ============ DEFAULTS ============ */

/**
 * Per-type default geometry + props table. Ported verbatim from the legacy
 * `defaults()` (mockcraft.html 526-541). The legacy returned a deep clone
 * (`JSON.parse(JSON.stringify(...))`) so callers could freely mutate the result;
 * we preserve that contract here.
 */
export function defaults(type: ElementType): { w: number; h: number; props: ElementProps } {
  const d: Record<ElementType, { w: number; h: number; props: ElementProps }> = {
    button: {
      w: 150,
      h: 46,
      props: { text: "ボタン", fill: "#ff6a45", color: "#ffffff", radius: 10, fontSize: 15, weight: 600 },
    },
    text: {
      w: 300,
      h: 48,
      props: { text: "見出しテキスト", color: "#1b1a18", fontSize: 28, weight: 700, align: "center" },
    },
    para: {
      w: 340,
      h: 84,
      props: {
        text: "本文をここに入力します。クリックで直接編集できます。",
        color: "#5b5852",
        fontSize: 15,
        weight: 400,
        align: "center",
      },
    },
    input: {
      w: 300,
      h: 48,
      props: { text: "入力してください", fill: "#f5f3ef", color: "#8c8881", radius: 9, fontSize: 14, border: true },
    },
    box: {
      w: 280,
      h: 170,
      props: { fill: "#ffffff", radius: 16, border: true },
    },
    image: {
      w: 300,
      h: 180,
      props: { text: "画像", radius: 16 },
    },
    avatar: {
      w: 56,
      h: 56,
      props: { fill: "#e6cabd" },
    },
    icon: {
      w: 46,
      h: 46,
      props: { icon: "star", color: "#ff6a45" },
    },
    badge: {
      w: 78,
      h: 28,
      props: { text: "NEW", fill: "#ffe6df", color: "#e6502d", fontSize: 12, weight: 700 },
    },
    line: {
      w: 240,
      h: 2,
      props: { fill: "#e7e4dd" },
    },
    toggle: {
      w: 52,
      h: 30,
      props: { on: true, fill: "#ff6a45" },
    },
  };
  const entry = d[type] ?? d.box;
  // Deep clone — matches the legacy JSON round-trip so the table is never mutated.
  return JSON.parse(JSON.stringify(entry)) as { w: number; h: number; props: ElementProps };
}

/* ============ IDS ============ */

// Module-level monotonic counter, starting at 1 (legacy `let uidN=1`).
let uidN = 1;

/**
 * Generate a unique-ish id. Replicates the legacy generator EXACTLY:
 *   prefix + (n++) + "_" + Math.random().toString(36).slice(2,6)
 * i.e. prefix, then the pre-increment counter value, then a 4-char base36
 * suffix sliced from a standard JS pseudo-random float.
 */
export function uid(prefix: string): string {
  return prefix + uidN++ + "_" + Math.random().toString(36).slice(2, 6);
}

/* ============ FACTORY ============ */

export interface MkOverride {
  w?: number;
  h?: number;
  cx?: ConstraintX;
  cy?: ConstraintY;
  props?: Partial<ElementProps>;
}

/**
 * Build a fresh element of `type` at (x, y). Ported from legacy `mk()` (553-558):
 * fresh id, defaults props deep-cloned then overridden via Object.assign, with
 * cx defaulting to "center", cy to "top", link to null, and w/h falling back to
 * the type defaults. The `|| base.w` semantics are preserved (a 0 override falls
 * back to the default, exactly as in the legacy truthy check).
 */
export function mk(
  type: ElementType,
  x: number,
  y: number,
  ov?: MkOverride,
  link?: string | null,
): MockElement {
  const base = defaults(type);
  const o: MkOverride = ov ?? {};
  return {
    id: uid("el"),
    type,
    x,
    y,
    w: o.w || base.w,
    h: o.h || base.h,
    props: Object.assign(base.props, o.props ?? {}),
    link: link ?? null,
    cx: o.cx ?? "center",
    cy: o.cy ?? "top",
  };
}

/* ============ Z-INDEX ============ */

/** Highest z among a page's elements (absent z counts as 1). Legacy `topZ` (898). */
export function topZ(pg: Page): number {
  return pg.els.reduce((m, e) => Math.max(m, e.z ?? 1), 0);
}

/* ============ SAMPLE PROJECT ============ */

/**
 * The exact two-page sample project ("ホーム" + "詳細") shipped by the legacy app
 * (559-586). Page ids are minted with `uid("pg")`; the home button links to the
 * detail page and the detail's home icon + bottom button link back, so navigation
 * round-trips. device = "モバイル", transition = "fade", homeId = currentId = p1.
 */
export function freshProject(): Project {
  const p1 = uid("pg");
  const p2 = uid("pg");
  return {
    transition: "fade",
    device: "モバイル",
    homeId: p1,
    currentId: p1,
    pages: [
      {
        id: p1,
        name: "ホーム",
        w: 390,
        h: 844,
        bg: "#ffffff",
        els: [
          mk("box", 16, 40, { w: 358, h: 60, cx: "stretch", props: { fill: "#ffffff", radius: 14, border: true } }),
          mk("text", 32, 58, {
            w: 140,
            h: 26,
            cx: "left",
            props: { text: "mockcraft", fontSize: 18, weight: 800, color: "#1b1a18", align: "left" },
          }),
          mk("icon", 330, 55, { w: 28, h: 28, cx: "right", props: { icon: "bell", color: "#1b1a18" } }),
          mk("text", 32, 140, {
            w: 320,
            h: 44,
            cx: "stretch",
            props: { text: "思った通りに、置くだけ。", fontSize: 30, weight: 800, color: "#1b1a18", align: "center" },
          }),
          mk("para", 32, 196, {
            w: 320,
            h: 56,
            cx: "stretch",
            props: {
              text: "部品をドラッグして配置。クリックで画面遷移するプロトタイプが作れます。",
              fontSize: 14,
              color: "#5b5852",
              align: "center",
            },
          }),
          mk("image", 32, 272, { w: 326, h: 180, cx: "center" }),
          mk(
            "button",
            32,
            480,
            {
              w: 160,
              h: 50,
              cx: "left",
              props: { text: "詳細を見る →", fill: "#ff6a45", color: "#fff", radius: 12, fontSize: 15, weight: 700 },
            },
            p2,
          ),
          mk("button", 204, 480, {
            w: 120,
            h: 50,
            cx: "left",
            props: { text: "スキップ", fill: "#f5f3ef", color: "#1b1a18", radius: 12, fontSize: 15, weight: 600 },
          }),
        ],
      },
      {
        id: p2,
        name: "詳細",
        w: 390,
        h: 844,
        bg: "#fbfaf8",
        els: [
          mk("icon", 24, 44, { w: 30, h: 30, cx: "left", props: { icon: "home", color: "#1b1a18" } }, p1),
          mk("text", 24, 120, {
            w: 320,
            h: 40,
            cx: "stretch",
            props: { text: "詳細ページ", fontSize: 28, weight: 800, color: "#1b1a18", align: "center" },
          }),
          mk("para", 24, 172, {
            w: 330,
            h: 120,
            cx: "stretch",
            props: {
              text: "これは2枚目の画面です。左上のホームアイコンをクリックすると、最初の画面へ戻ります。プレビューで遷移を確認してください。",
              fontSize: 15,
              color: "#5b5852",
              align: "center",
            },
          }),
          mk("box", 24, 320, { w: 342, h: 120, cx: "stretch", props: { fill: "#ffffff", radius: 16, border: true } }),
          mk("avatar", 44, 344, { w: 48, h: 48, cx: "left" }),
          mk("text", 108, 348, {
            w: 200,
            h: 22,
            cx: "left",
            props: { text: "田中 美咲", fontSize: 16, weight: 700, color: "#1b1a18", align: "left" },
          }),
          mk("para", 108, 374, {
            w: 230,
            h: 40,
            cx: "left",
            props: { text: "プロダクトマネージャー", fontSize: 13, color: "#8c8881", align: "left" },
          }),
          mk(
            "button",
            24,
            470,
            {
              w: 342,
              h: 52,
              cx: "stretch",
              props: { text: "ホームに戻る", fill: "#1b1a18", color: "#fff", radius: 12, fontSize: 15, weight: 700 },
            },
            p1,
          ),
        ],
      },
    ],
  };
}

/* ============ PALETTE ============ */

/** A palette section: a group label, optional preset flag, and [key,label,iconKey] rows. */
export interface PaletteGroup {
  group: string;
  preset?: boolean;
  items: [string, string, string][];
}

/**
 * Palette definition ported from legacy (979-985). Unlike the legacy version
 * (which inlined SVG via the ICO map), the third tuple slot here stores the ICON
 * KEY string so the React layer can resolve the glyph through `iconSvg`/`Icon`.
 * Note the `image` row's icon key is "img" (legacy `ICO.img`).
 */
export const PALETTE: PaletteGroup[] = [
  {
    group: "テキスト",
    items: [
      ["text", "見出し", "text"],
      ["para", "本文", "para"],
    ],
  },
  {
    group: "入力",
    items: [
      ["button", "ボタン", "button"],
      ["input", "入力欄", "input"],
      ["toggle", "トグル", "toggle"],
    ],
  },
  {
    group: "図形・装飾",
    items: [
      ["box", "四角", "box"],
      ["avatar", "アバター", "avatar"],
      ["icon", "アイコン", "icon"],
      ["badge", "バッジ", "badge"],
      ["line", "線", "line"],
    ],
  },
  {
    group: "メディア",
    items: [["image", "画像", "img"]],
  },
  {
    group: "まとめて配置",
    preset: true,
    items: [
      ["card", "カード一式", "card"],
      ["nav", "ナビバー", "nav"],
      ["login", "ログイン一式", "login"],
    ],
  },
];
