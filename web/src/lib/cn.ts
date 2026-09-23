// cn.ts — the one class-name merger every component uses, taught the theme's own names.
//
// `cn` (the package) resolves conflicts like tailwind-merge: it must KNOW that two classes set
// the same property to drop the earlier one. It knows Tailwind's default scales only, so the
// names P1a added to app.css's @theme were invisible to it — `text-badge-xs` read as a COLOUR
// (dropping the real colour), and `h-control` beside `h-auto` kept both, leaving the winner to
// stylesheet order. Found by p2-fields, 2026-09-23.
//
// The lists below are app.css's @theme names by namespace. server/test/unit/cn.test.ts reads
// app.css and fails when a name there is missing here, so the two cannot drift.

import { createCn } from "cn/config";

/** `--spacing-<name>` in app.css's @theme: the named heights, widths and sizes. */
export const THEME_SPACING = [
  "badge",
  "badge-title",
  "badge-xs",
  "code-chip",
  "code-display-touch",
  "control",
  "control-sm",
  "control-touch",
  "control-xs",
  "header",
  "level-header",
  "nav-badge",
  "otp-h",
  "otp-h-touch",
  "otp-w",
  "otp-w-touch",
  "rail-row",
] as const;

/** `--text-<name>`: font sizes beyond Tailwind's defaults, so `text-<name>` is a SIZE, not a colour. */
export const THEME_TEXT = ["2xs", "badge-xs", "md", "title-narrow"] as const;

/** `--shadow-<name>` beyond Tailwind's defaults. */
export const THEME_SHADOW = ["menu", "pop", "record", "thumb"] as const;

/** `--container-<name>`: the named max widths. */
export const THEME_CONTAINER = ["auth", "kv-key", "kv-key-dense", "page", "page-narrow", "pane", "rail"] as const;

export const cn = createCn({
  extend: {
    theme: {
      spacing: [...THEME_SPACING],
      text: [...THEME_TEXT],
      shadow: [...THEME_SHADOW],
      container: [...THEME_CONTAINER],
    },
  },
  // A size no longer drops an earlier `leading-*`: Tailwind 4 reads a size's line height through
  // `--tw-leading`, so the leading wins in CSS whatever the order (cn.test.ts has the case).
  override: { conflictingClassGroups: { "font-size": [] } },
});
