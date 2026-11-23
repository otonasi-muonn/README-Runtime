/**
 * Core data model for mockcraft. This is the shared contract every layer
 * (pure-logic libs, the Zustand store, and the React components) builds on.
 * Ported and typed from the original single-file app's runtime shapes.
 */

export type ElementType =
  | "text"
  | "para"
  | "button"
  | "input"
  | "toggle"
  | "box"
  | "avatar"
  | "icon"
  | "badge"
  | "line"
  | "image";

/** Horizontal responsive constraint (how an element follows when width changes). */
export type ConstraintX = "left" | "center" | "right" | "stretch" | "scale";
/** Vertical responsive constraint (how an element follows when height changes). */
export type ConstraintY = "top" | "center" | "bottom" | "stretch" | "scale";

export type TextAlign = "left" | "center" | "right";

/** Built-in glyph keys usable by the `icon` element type. */
export type GlyphKey = "star" | "heart" | "bell" | "search" | "user" | "cart" | "home" | "check";

export interface ElementProps {
  /** Text content for text/para/button/input(placeholder)/badge/image(label). */
  text?: string;
  /** Background / surface fill (CSS color). */
  fill?: string;
  /** Foreground (text or icon) color (CSS color). */
  color?: string;
  /** Corner radius in px. */
  radius?: number;
  /** Font size in px. */
  fontSize?: number;
  /** Font weight (100–800). */
  weight?: number;
  /** Text alignment for text/para. */
  align?: TextAlign;
  /** Whether box/input shows a hairline border. */
  border?: boolean;
  /** Glyph key for the icon element. */
  icon?: string;
  /** On/off state for the toggle element. */
  on?: boolean;
}

export interface MockElement {
  id: string;
  type: ElementType;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Stacking order; higher is in front. Defaults to 1 when absent. */
  z?: number;
  cx: ConstraintX;
  cy: ConstraintY;
  props: ElementProps;
  /** Target page id to navigate to on click in Play/export, or null. */
  link: string | null;
}

export interface Page {
  id: string;
  name: string;
  w: number;
  h: number;
  /** Background color of the screen. */
  bg: string;
  els: MockElement[];
  /** Flow-canvas card position (assigned lazily when the flow view lays out). */
  fx?: number;
  fy?: number;
}

export type DeviceName = "デスクトップ" | "ノートPC" | "タブレット" | "モバイル";

export type TransitionKind = "fade" | "slide-left" | "slide-up" | "none";

export type Mode = "flow" | "edit" | "play";

export interface Project {
  pages: Page[];
  /** Page shown first in Play/export. */
  homeId: string;
  /** Page currently open in the editor. */
  currentId: string;
  /** Project-wide device size preset. */
  device: DeviceName;
  /** Screen-transition animation used in Play and in exported prototypes. */
  transition: TransitionKind;
}

/** Device preset dimensions [width, height] in px. */
export const SIZES: Record<DeviceName, readonly [number, number]> = {
  デスクトップ: [1440, 900],
  ノートPC: [1280, 800],
  タブレット: [834, 1112],
  モバイル: [390, 844],
};

/** Japanese display labels per element type (palette / inspector header). */
export const LABELS: Record<ElementType, string> = {
  text: "見出し",
  para: "本文",
  button: "ボタン",
  input: "入力",
  toggle: "トグル",
  box: "四角",
  line: "線",
  avatar: "アバター",
  icon: "アイコン",
  badge: "バッジ",
  image: "画像",
};

/** Ordered list of glyph keys offered by the icon picker. */
export const GLYPHS: readonly GlyphKey[] = [
  "star",
  "heart",
  "bell",
  "search",
  "user",
  "cart",
  "home",
  "check",
];

/** Element types whose primary content is editable text. */
export const TEXT_TYPES: readonly ElementType[] = [
  "button",
  "text",
  "para",
  "input",
  "badge",
];

export const hasText = (t: ElementType): boolean => TEXT_TYPES.includes(t);
