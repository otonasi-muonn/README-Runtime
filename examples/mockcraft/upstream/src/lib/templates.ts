/**
 * Screen templates and component-cluster presets.
 *
 * Ported faithfully from the legacy single-file app:
 *  - `SCREEN_TPL`  ← legacy `SCREEN_TPL` (full-screen starters).
 *  - `buildPreset` ← legacy `addPreset` cluster builders (card / nav / login).
 *
 * All element geometry, props and ordering reproduce the legacy math exactly.
 */

import type { MockElement } from "./types";
import { mk } from "./defaults";

/** A full-screen starter template. */
export interface ScreenTpl {
  name: string;
  /** Default page size [width, height] this template was designed for. */
  size: [number, number];
  /** Builds the element list for a page of inner width `w`. */
  build: (w: number) => MockElement[];
}

/**
 * Full-screen starter templates, keyed by id.
 * Ported verbatim from the legacy `SCREEN_TPL` map.
 */
export const SCREEN_TPL: Record<string, ScreenTpl> = {
  blank: { name: "空の画面", size: [390, 844], build: () => [] },

  login: {
    name: "ログイン",
    size: [390, 844],
    build: (w: number): MockElement[] => [
      mk("text", w / 2 - 90, 140, {
        w: 180,
        h: 36,
        props: { text: "ログイン", fontSize: 28, weight: 800, align: "center" },
      }),
      mk("input", 45, 210, {
        w: w - 90,
        h: 48,
        props: { text: "メールアドレス", fill: "#f5f3ef", color: "#8c8881", radius: 9, border: true },
      }),
      mk("input", 45, 270, {
        w: w - 90,
        h: 48,
        props: { text: "パスワード", fill: "#f5f3ef", color: "#8c8881", radius: 9, border: true },
      }),
      mk("button", 45, 340, {
        w: w - 90,
        h: 50,
        props: { text: "ログイン", fill: "#ff6a45", color: "#fff", radius: 10, fontSize: 15, weight: 700 },
      }),
      mk("text", w / 2 - 80, 405, {
        w: 160,
        h: 20,
        props: { text: "新規登録はこちら", fontSize: 13, weight: 600, color: "#ff6a45", align: "center" },
      }),
    ],
  },

  feed: {
    name: "リスト/フィード",
    size: [390, 844],
    build: (w: number): MockElement[] => {
      const a: MockElement[] = [
        mk("box", 16, 40, { w: w - 32, h: 54, props: { fill: "#fff", radius: 12, border: true } }),
        mk("text", 32, 57, { w: 140, h: 22, props: { text: "タイムライン", fontSize: 18, weight: 700, align: "left" } }),
        mk("icon", w - 52, 52, { w: 28, h: 28, props: { icon: "bell", color: "#1b1a18" } }),
      ];
      for (let i = 0; i < 3; i++) {
        const y = 120 + i * 150;
        a.push(mk("box", 16, y, { w: w - 32, h: 134, props: { fill: "#fff", radius: 14, border: true } }));
        a.push(mk("avatar", 32, y + 16, { w: 40, h: 40 }));
        a.push(mk("text", 84, y + 18, { w: 160, h: 20, props: { text: "ユーザー名", fontSize: 15, weight: 700, align: "left" } }));
        a.push(
          mk("para", 32, y + 70, {
            w: w - 64,
            h: 48,
            props: { text: "投稿の本文がここに表示されます。", fontSize: 13, color: "#5b5852", align: "left" },
          }),
        );
      }
      return a;
    },
  },

  dashboard: {
    name: "ダッシュボード",
    size: [1280, 800],
    build: (w: number): MockElement[] => {
      const a: MockElement[] = [
        mk("box", 24, 24, { w: w - 48, h: 60, props: { fill: "#fff", radius: 14, border: true } }),
        mk("text", 44, 42, { w: 160, h: 24, props: { text: "Dashboard", fontSize: 20, weight: 800, align: "left" } }),
      ];
      (["売上", "ユーザー", "成約率", "継続率"] as const).forEach((t, i) => {
        const cw = (w - 48 - 36) / 4;
        const x = 24 + i * (cw + 12);
        a.push(mk("box", x, 108, { w: cw, h: 120, props: { fill: "#fff", radius: 14, border: true } }));
        a.push(
          mk("text", x + 20, 128, {
            w: cw - 40,
            h: 18,
            props: { text: t, fontSize: 13, weight: 600, color: "#8c8881", align: "left" },
          }),
        );
        a.push(
          mk("text", x + 20, 150, {
            w: cw - 40,
            h: 40,
            props: { text: (i + 1) * 123 + "", fontSize: 30, weight: 800, align: "left" },
          }),
        );
      });
      a.push(
        mk("box", 24, 252, {
          w: Math.round((w - 60) * 0.62),
          h: 300,
          props: { fill: "#fff", radius: 14, border: true },
        }),
      );
      a.push(mk("image", Math.round((w - 60) * 0.62) + 44, 252, { w: Math.round((w - 60) * 0.36), h: 300 }));
      return a;
    },
  },

  detail: {
    name: "詳細ページ",
    size: [390, 844],
    build: (w: number): MockElement[] => [
      mk("icon", 24, 44, { w: 30, h: 30, props: { icon: "home", color: "#1b1a18" } }),
      mk("image", 24, 90, { w: w - 48, h: 220 }),
      mk("text", 24, 330, { w: w - 48, h: 34, props: { text: "タイトル", fontSize: 26, weight: 800, align: "left" } }),
      mk("para", 24, 378, {
        w: w - 48,
        h: 120,
        props: { text: "本文の説明がここに入ります。", fontSize: 15, color: "#5b5852", align: "left" },
      }),
      mk("button", 24, 540, {
        w: w - 48,
        h: 52,
        props: { text: "アクション", fill: "#ff6a45", color: "#fff", radius: 12, fontSize: 15, weight: 700 },
      }),
    ],
  },
};

/** Component-cluster preset names supported by {@link buildPreset}. */
export type PresetName = "card" | "nav" | "login";

/**
 * Builds a component cluster ("card" | "nav" | "login") positioned relative to
 * the given origin (`ox`, `oy`). Element `x`/`y` are rounded like the legacy
 * `addPreset`, and `z` is assigned incrementally 1..n.
 *
 * For "nav", the inner width follows the legacy formula `min(pageW - 32, 1200)`
 * (the legacy code read this from the page width `pg.w`).
 *
 * Pure: builds and returns a fresh array; does not mutate any page.
 */
export function buildPreset(name: PresetName, ox: number, oy: number, pageW: number): MockElement[] {
  const out: MockElement[] = [];
  let z = 0;
  const add = (
    t: Parameters<typeof mk>[0],
    dx: number,
    dy: number,
    ov?: Parameters<typeof mk>[3],
  ): void => {
    const e = mk(t, Math.round(ox + dx), Math.round(oy + dy), ov);
    e.z = ++z;
    out.push(e);
  };

  if (name === "card") {
    add("box", 0, 0, { w: 300, h: 200, props: { fill: "#fff", radius: 16, border: true } });
    add("icon", 24, 24, { w: 44, h: 44, props: { icon: "star", color: "#ff6a45" } });
    add("text", 24, 84, { w: 250, h: 24, props: { text: "カードタイトル", fontSize: 18, weight: 700, color: "#1b1a18", align: "left" } });
    add("para", 24, 116, { w: 252, h: 44, props: { text: "説明テキストが入ります。", fontSize: 13, color: "#8c8881", align: "left" } });
    add("button", 24, 158, { w: 120, h: 36, props: { text: "詳細", fill: "#ff6a45", color: "#fff", radius: 8, fontSize: 13, weight: 600 } });
  } else if (name === "nav") {
    const w = Math.min(pageW - 32, 1200);
    add("box", 0, 0, { w, h: 62, props: { fill: "#fff", radius: 14, border: true } });
    add("text", 20, 18, { w: 140, h: 26, props: { text: "Brand", fontSize: 19, weight: 800, color: "#1b1a18", align: "left" } });
    add("button", w - 110, 14, { w: 96, h: 34, props: { text: "ログイン", fill: "#ff6a45", color: "#fff", radius: 8, fontSize: 13, weight: 600 } });
    add("text", w - 280, 20, { w: 150, h: 22, props: { text: "機能   料金   会社", fontSize: 14, weight: 500, color: "#5b5852", align: "right" } });
  } else if (name === "login") {
    add("box", 0, 0, { w: 360, h: 380, props: { fill: "#fff", radius: 18, border: true } });
    add("text", 90, 40, { w: 180, h: 30, props: { text: "ログイン", fontSize: 24, weight: 800, color: "#1b1a18", align: "center" } });
    add("input", 30, 100, { w: 300, h: 46, props: { text: "メールアドレス", fill: "#f5f3ef", color: "#8c8881", radius: 9, border: true } });
    add("input", 30, 158, { w: 300, h: 46, props: { text: "パスワード", fill: "#f5f3ef", color: "#8c8881", radius: 9, border: true } });
    add("button", 30, 224, { w: 300, h: 48, props: { text: "ログイン", fill: "#ff6a45", color: "#fff", radius: 10, fontSize: 15, weight: 700 } });
    add("text", 90, 290, { w: 180, h: 20, props: { text: "新規登録はこちら", fontSize: 13, weight: 600, color: "#ff6a45", align: "center" } });
  }

  return out;
}
