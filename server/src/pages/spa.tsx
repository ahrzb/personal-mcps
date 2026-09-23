/**
 * The SPA shell document: the whole server-rendered part of every browser page — `/apps/*`
 * and `/agents/*` since 2026-09-18, `/audit` since decision 36, and the rest, `/login` last,
 * since decision 38.
 *
 * Pure — props in, JSX out. The gate, the existence checks and the CSRF minting are
 * web.ts's; this file only draws what they decided — and it is the one place an island is
 * SERIALIZED, so the escaping below is the shell's rule rather than each caller's.
 *
 * The HEAD is the same at every URL, which is the point: one viewport rule, one theme
 * colour, one manifest and icon set, so an installed PWA behaves identically whichever route
 * it was installed from, one webfont, and one stylesheet of the hub's own (`/app.css`).
 *
 * The BODY is three elements and no more:
 *
 *  - `<div id="root">`, where the client mounts;
 *  - ONE `<script type="application/json">` island carrying what no API reports:
 *    `#pmcp-bootstrap` on every session-gated URL (the session's two facts and the
 *    configuration the client needs — web.ts's `shellDocument` says which), or `#pmcp-login`
 *    on `/login`, which has no session to report. A JSON island rather than an executable
 *    one, so no page-generated JavaScript runs and the CSP needs no `script-src` relaxation;
 *  - the module script.
 *
 * There is no `<noscript>`. The pages this replaces worked with scripting off and these do
 * not, which is a real loss and is recorded as the cost of the change (§18 decision 21) —
 * but a fallback that said so would be a fourth element with nothing behind it.
 */

import { html, raw } from "hono/html";
import type { FC } from "hono/jsx";

export type SpaShellProps = {
  /** The tab title, matching what the page this replaces rendered. The client sets it again
   *  on every client-side navigation, because a client navigation changes no head. */
  title: string;
  /** The document's one island: its element id, which is how the client finds it, and its
   *  value UNserialized — this template serializes it, which is what makes the escaping
   *  unskippable. What the value means is the caller's business, which keeps this template
   *  from knowing what a session or a sign-in step is. */
  island: { id: "pmcp-bootstrap" | "pmcp-login"; value: unknown };
  /** The client bundle's one sheet (web/src/app.css, built): the theme, Tailwind's preflight
   *  with the base rules today's look restores, and the utilities. */
  stylesheet: string;
  /** The client bundle. */
  script: string;
};

/** The PWA links, spelled here rather than read from `paths`: the document head is its own
 *  contract, and the icon is the 192 because iOS's `apple-touch-icon` wants a raster. */
const MANIFEST = "/manifest.webmanifest";
const ICON = "/icon-192.png";

/**
 * One value as a literal inside a `<script>` element — JSON, with the three characters an
 * HTML parser or a JavaScript parser reads differently escaped (§13, decision 38):
 *
 *  - `<` → `\u003c`, which is what closes the `</script>` and `<!--` doors. `/` buys
 *    nothing once `<` is gone and is deliberately left alone.
 *  - U+2028 / U+2029, legal in JSON strings and line TERMINATORS in JavaScript source,
 *    which would otherwise end a statement mid-literal in an executable script.
 *
 * Each escape is a JSON escape too, so `JSON.parse` reads the value back unchanged. Every
 * island goes through it: `/login`'s carries `?next=`, `?error=` and `?username=` text any
 * link can set to `</script><img …>`.
 */
function jsLiteral(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

export const SpaShell: FC<SpaShellProps> = ({ title, island, stylesheet, script }) => (
  <>
    {html`<!doctype html>`}
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="theme-color" content="#ffffff" />
        <title>{title}</title>
        <link rel="stylesheet" href={stylesheet} />
        <link rel="manifest" href={MANIFEST} />
        <link rel="icon" href={ICON} />
        <link rel="apple-touch-icon" href={ICON} />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="anonymous" />
        <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&display=swap" />
      </head>
      <body>
        <div id="root"></div>
        {/* `raw`, because the content is JSON and hono would otherwise escape its quotes
            into entities — which `JSON.parse` cannot read. Safe because `jsLiteral` leaves
            no raw `<` to end the element, whatever the values are. */}
        <script type="application/json" id={island.id}>
          {raw(jsLiteral(island.value))}
        </script>
        <script type="module" src={script}></script>
      </body>
    </html>
  </>
);
