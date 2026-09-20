/**
 * The SPA shell document: the whole server-rendered part of `/apps/*` and `/agents/*`
 * (§13, 2026-09-18).
 *
 * Pure, like every other template here — props in, JSX out. The gate, the existence checks
 * and the CSRF minting are web.ts's; this file only draws what they decided.
 *
 * The HEAD is `layout.tsx`'s verbatim, plus `/app.css` after `/styles.css`. That is not
 * copy-paste convenience: the shell and the server-rendered pages must present the same
 * document to a browser — same viewport rule, same theme colour, same manifest and icons, so
 * an installed PWA behaves identically whichever route it was installed from, and the same
 * webfont so the two renderings set type the same way. A difference here would show up as a
 * visual difference on every screenshot and as an installability difference on a phone.
 *
 * The BODY is three elements and no more:
 *
 *  - `<div id="root">`, where the client mounts;
 *  - a `<script type="application/json" id="pmcp-bootstrap">` carrying `{csrf, username}` —
 *    the two facts no API can report, because both are the session's. A JSON island rather
 *    than an executable one, so no page-generated JavaScript runs and the existing CSP needs
 *    no `script-src` relaxation;
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
  /** `{csrf, username}` as a JSON string, already serialized by the caller — which is what
   *  keeps this template from knowing what a session is. */
  bootstrap: string;
  /** The shared sheet every page reads: the design language, and the source of truth for
   *  every token and page-chrome class. */
  stylesheet: string;
  /** The client's own sheet, loaded AFTER the shared one and never instead of it: it carries
   *  only what Tailwind's utilities and the Base UI primitives need to coexist with it. */
  appStylesheet: string;
  /** The client bundle. */
  script: string;
};

/** The PWA links, spelled here for `layout.tsx`'s reason: the document head is its own
 *  contract, and the icon is the 192 because iOS's `apple-touch-icon` wants a raster. */
const MANIFEST = "/manifest.webmanifest";
const ICON = "/icon-192.png";

export const SpaShell: FC<SpaShellProps> = ({ title, bootstrap, stylesheet, appStylesheet, script }) => (
  <>
    {html`<!doctype html>`}
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="theme-color" content="#ffffff" />
        <title>{title}</title>
        <link rel="stylesheet" href={stylesheet} />
        <link rel="stylesheet" href={appStylesheet} />
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
            into entities — which `JSON.parse` cannot read. Safe because the caller built it
            with `JSON.stringify`, whose output cannot contain a raw `<`: the only two values
            in it are a hex CSRF digest and a username from the charset §2 pins. */}
        <script type="application/json" id="pmcp-bootstrap">
          {raw(bootstrap)}
        </script>
        <script type="module" src={script}></script>
      </body>
    </html>
  </>
);
