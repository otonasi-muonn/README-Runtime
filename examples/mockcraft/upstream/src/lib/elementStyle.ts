import type { CSSProperties } from "react";
import type { MockElement } from "./types";

/**
 * Port of the legacy `styleEl` (mockcraft.html 619-636) into a React
 * CSSProperties object.
 *
 * Differences from the legacy DOM mutator:
 * - The `.on` (toggle) and `.linked` (has-link) classes are component-applied
 *   concerns, so they are intentionally NOT produced here.
 * - Returns an immutable style object instead of mutating a node.
 *
 * Numeric behavior is preserved: positions/dimensions/radius/fontSize emit px,
 * zIndex falls back to 1, and only the fields the legacy code set are set.
 */
export function elementStyle(el: MockElement): CSSProperties {
  const p = el.props || {};
  const style: CSSProperties = {
    left: `${el.x}px`,
    top: `${el.y}px`,
    width: `${el.w}px`,
    height: `${el.h}px`,
    zIndex: el.z || 1,
  };

  if (p.fill != null && el.type !== "image") {
    style.background = p.fill;
  }
  if (p.color != null) {
    style.color = p.color;
  }
  if (p.radius != null) {
    style.borderRadius = `${p.radius}px`;
  }
  if (p.fontSize != null) {
    style.fontSize = `${p.fontSize}px`;
  }
  if (p.weight != null) {
    style.fontWeight = p.weight;
  }
  if (el.type === "text" || el.type === "para") {
    style.textAlign = p.align || "left";
    style.alignItems = el.type === "para" ? "flex-start" : "center";
  }
  if (p.border) {
    style.border = "1px solid #e7e4dd";
  }

  return style;
}
