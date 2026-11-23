"use client";

/**
 * Shared, pure visual renderer for a single canvas element.
 *
 * This is the SINGLE source of truth for how a {@link MockElement} looks on the
 * board, in the flow thumbnails, and in play mode. It renders only the element
 * `div` (geometry via {@link elementStyle}, type/state classes) plus the inner
 * content for its type. It holds NO pointer/interaction logic — callers spread
 * `...divProps` to attach handlers (pointerdown, dblclick, click, …).
 *
 * Ported from the legacy `buildNode` / `elInner` (mockcraft.html 605-642). The
 * modifier classes match globals.css: `is-linked`, `is-selected`, `is-on`.
 */
import type { HTMLAttributes, ReactElement, ReactNode } from "react";
import type { MockElement } from "@/lib/types";
import { elementStyle } from "@/lib/elementStyle";
import { cn } from "@/lib/cn";
import { Icon } from "@/lib/icons";

export interface ElementViewProps extends HTMLAttributes<HTMLDivElement> {
  /** The element to render. */
  el: MockElement;
  /** Whether to apply the `is-selected` outline (used by multi-select). */
  selected?: boolean;
}

/** Inner content per element type (port of legacy `elInner`, 606-618). */
function elInner(el: MockElement): ReactNode {
  const p = el.props || {};
  switch (el.type) {
    case "text":
    case "para":
      return <span className="t">{p.text}</span>;
    case "button":
      return <span>{p.text}</span>;
    case "input":
      return <span className="ph">{p.text}</span>;
    case "badge":
      return <span>{p.text}</span>;
    case "image":
      return (
        <span className="imlbl">
          <Icon name="img" />
          <span>{p.text || "画像"}</span>
        </span>
      );
    case "icon":
      return <Icon name={p.icon || "star"} />;
    case "toggle":
      return <span className="knob" />;
    default:
      // box / avatar / line have no inner content.
      return null;
  }
}

/**
 * Render the element `div`. Geometry comes from {@link elementStyle}; the class
 * list mirrors the legacy node plus the contract's modifier classes. All extra
 * props (handlers, `style` overrides, etc.) are forwarded to the `div`.
 */
export function ElementView({ el, selected, className, ...divProps }: ElementViewProps): ReactElement {
  return (
    <div
      {...divProps}
      data-id={el.id}
      className={cn(
        "el",
        "el-" + el.type,
        el.link && "is-linked",
        selected && "is-selected",
        el.type === "toggle" && el.props.on && "is-on",
        className,
      )}
      style={elementStyle(el)}
    >
      {elInner(el)}
    </div>
  );
}
