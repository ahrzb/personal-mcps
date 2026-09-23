import { useRender } from "@base-ui/react/use-render";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * The small type every page shares, drawn once each: legacy.css's typography rules (`.note`,
 * `.eyebrow`, `.muted`), its `.code` block, and the name and meta line of a plain row
 * (`.list-title` / `.cell-name`, `.list-meta`). Each sets its own size, so it reads the same
 * whatever it sits in.
 *
 * Each renders the element its default says and takes `render` for the one the sentence needs
 * — `render={<span />}` in a title row, `render={<div />}` around block content, or another
 * component (`render={<Link … />}`, `render={<InputGroupAddon />}`) that should wear the type.
 */

/** A type style: one element, its classes and its slot name, re-targetable with `render`. */
function typeStyle<T extends "p" | "div" | "span" | "pre">(slot: string, tag: T, classes: string) {
  function Type({ className, render, ...props }: useRender.ComponentProps<T>): ReactNode {
    return useRender({
      defaultTagName: tag,
      render,
      props: { ...props, className: cn(classes, className) },
      state: { slot },
    });
  }
  return Type;
}

/** `.note`: the 12px muted aside — a caption, a hint, the small print under a card — capped at
 *  a reading measure of 72 characters. A `<p>`. */
export const Note = typeStyle("note", "p", "max-w-[72ch] text-xs text-muted-foreground");

/** `.eyebrow`: the 11px uppercase label over a card's section or a group. A `<div>`. */
export const Eyebrow = typeStyle(
  "eyebrow",
  "div",
  "text-2xs font-medium tracking-[0.06em] text-muted-foreground uppercase",
);

/** `.muted`: a 13px muted figure or aside inside a line — a count, a time, "—". A `<span>`. */
export const Muted = typeStyle("muted", "span", "text-sm text-muted-foreground");

/**
 * `.code`: a block of machine text — a call's arguments, its result — on the muted ground, in
 * 12px mono at 1.6. It wraps, anywhere: `pre-wrap` keeps a pretty-printed body's indentation,
 * and without it a single-line JSON body would be one long scroll strip. A `<pre>`.
 */
export const CodeBlock = typeStyle(
  "code-block",
  "pre",
  "m-0 overflow-x-auto rounded-md bg-muted px-3.5 py-3 font-mono text-xs leading-[1.6] wrap-anywhere whitespace-pre-wrap text-fg-subtle",
);

/** `.list-title` and `.cell-name`: a plain row's name, 14px medium — a table row's first cell,
 *  a list item in a card. A `<div>`. */
export const RowTitle = typeStyle("row-title", "div", "text-base font-medium");

/** `.list-meta`: the 12px muted line under a row's name. A `<div>`; `.cell-slug` is this with
 *  `className="font-mono"`. */
export const RowMeta = typeStyle("row-meta", "div", "text-xs text-muted-foreground");
