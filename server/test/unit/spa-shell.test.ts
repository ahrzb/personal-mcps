// spa-shell.test.ts — the shell document's JSON islands, which carry data into a `<script>`.
//
// PINS §13's island rule (2026-09-23, decision 38): every island is serialized with `<`,
// U+2028 and U+2029 escaped. A `<script type="application/json">` is still a script element
// to the HTML parser, so a `</script>` inside its text ends it and whatever follows is
// markup. The bootstrap's values happen to be safe (a hex digest, a charset-bound username,
// configuration), but `/login`'s island carries text any link sets, and the rule is the
// shell's rather than each value's provenance — so it is pinned for both islands.
//
// PROJECT: `unit` — the template is props in, a string out: no D1, no binding, no request.
//
// NOT HERE: that `web.ts` hands the template the session's real bootstrap, or /login's query
// as its island, and that each URL's gate runs first — worker/web-pages.test.ts's shell rows, driven through
// the composition root.

// deps: none (no harness — pure seams) · pages/spa.SpaShell · no platform APIs

import { describe, expect, it } from "vitest";
import { SpaShell } from "../../src/pages/spa";
import type { SpaShellProps } from "../../src/pages/spa";

/** A value built to break out of the element in every way the rule names: a closing tag
 *  followed by markup, a comment opener, and the two JavaScript line terminators JSON
 *  allows raw inside a string. */
const HOSTILE = {
  csrf: "</script><img src=x onerror=alert(1)>",
  username: "a\u2028b\u2029c",
  origin: "<!--",
};

async function rendered(island: SpaShellProps["island"]): Promise<string> {
  const node = SpaShell({
    title: "Approvals",
    island,
    stylesheet: "/styles.css",
    appStylesheet: "/app.css",
    script: "/app.js",
  }) as { toString(): string | Promise<string> };
  return node.toString();
}

describe("§13 · the shell's JSON islands", () => {
  it.each(["pmcp-bootstrap", "pmcp-login"] as const)("§13 · a #%s value carrying `</script>`, `<!--`, U+2028 and U+2029 never appears raw in the document — the island is still ONE element ending where the shell ends it, and the only island drawn — and it parses back to exactly the value given (the twin: the escape is lossless, so the client reads what the server meant)", async (id) => {
    const html = await rendered({ id, value: HOSTILE });
    expect(html).not.toContain("</script><img");
    expect(html).not.toContain("<!--");
    expect(html).not.toContain("\u2028");
    expect(html).not.toContain("\u2029");

    const islands = [...html.matchAll(/<script type="application\/json" id="([^"]*)">([\s\S]*?)<\/script>/g)];
    expect(islands.map((island) => island[1])).toEqual([id]);
    expect(JSON.parse(islands[0][2])).toEqual(HOSTILE);
  });
});
