// cn.test.ts — the app's `cn` knows every name app.css's @theme defines, and resolves a
// conflict between a custom name and any other class of the same property.
//
// Why a test and not a comment: the theme and the merger's lists are two files, and a name
// added to the theme but not the merger fails SILENTLY — `text-<size>` reads as a colour and
// drops the real one, `h-<name>` beside `h-auto` keeps both. Reading app.css makes drift loud.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { cn, THEME_CONTAINER, THEME_SHADOW, THEME_SPACING, THEME_TEXT } from "../../../web/src/lib/cn";

const APP_CSS = readFileSync(new URL("../../../web/src/app.css", import.meta.url), "utf8");

/** The `--<namespace>-<name>` declarations inside app.css's @theme block(s). */
function themeNames(namespace: string): string[] {
  const names = new Set<string>();
  for (const block of APP_CSS.matchAll(/@theme[^{]*\{([\s\S]*?)\n\}/g)) {
    for (const hit of (block[1] ?? "").matchAll(new RegExp(`^\\s*--${namespace}-([a-z0-9-]+)\\s*:`, "gm"))) {
      const name = hit[1] ?? "";
      // `--text-sm--line-height` style sub-properties are not names of their own.
      if (!name.includes("--")) names.add(name);
    }
  }
  return [...names].sort();
}

/** Tailwind's own names in each namespace, which the merger already knows. */
const DEFAULTS: Record<string, readonly string[]> = {
  text: ["xs", "sm", "base", "lg", "xl", "2xl", "3xl", "4xl", "5xl", "6xl", "7xl", "8xl", "9xl"],
  shadow: ["2xs", "xs", "sm", "md", "lg", "xl", "2xl"],
  container: ["3xs", "2xs", "xs", "sm", "md", "lg", "xl", "2xl", "3xl", "4xl", "5xl", "6xl", "7xl"],
  spacing: [],
};

describe("cn — the theme's names", () => {
  it("lists every custom name app.css's @theme defines, per namespace", () => {
    const lists: Record<string, readonly string[]> = {
      spacing: THEME_SPACING,
      text: THEME_TEXT,
      shadow: THEME_SHADOW,
      container: THEME_CONTAINER,
    };
    for (const [namespace, listed] of Object.entries(lists)) {
      const custom = themeNames(namespace).filter((name) => !DEFAULTS[namespace]?.includes(name));
      expect([...listed].sort(), `app.css @theme --${namespace}-* vs lib/cn.ts`).toEqual(custom);
    }
  });

  it("a custom text size is a SIZE: it replaces another size and keeps the colour beside it", () => {
    for (const size of THEME_TEXT) {
      expect(cn("text-sm", `text-${size}`)).toBe(`text-${size}`);
      expect(cn("text-primary", `text-${size}`)).toBe(`text-primary text-${size}`);
      expect(cn(`text-${size}`, "text-primary")).toBe(`text-${size} text-primary`);
    }
  });

  it("a custom spacing name conflicts with any other value of the same property", () => {
    for (const name of THEME_SPACING) {
      expect(cn(`h-${name}`, "h-auto")).toBe("h-auto");
      expect(cn("h-auto", `h-${name}`)).toBe(`h-${name}`);
      expect(cn("w-full", `w-${name}`)).toBe(`w-${name}`);
      expect(cn(`size-${name}`, "size-4")).toBe("size-4");
    }
  });

  it("a custom shadow and a custom container width each replace their own kind", () => {
    for (const name of THEME_SHADOW) expect(cn("shadow-xs", `shadow-${name}`)).toBe(`shadow-${name}`);
    for (const name of THEME_CONTAINER) expect(cn("max-w-sm", `max-w-${name}`)).toBe(`max-w-${name}`);
  });
});
