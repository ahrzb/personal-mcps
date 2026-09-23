// spa-shell.test.ts — the shell document's JSON islands, which carry data into a `<script>`.
//
// PINS §13's island rule (2026-09-23, decision 38): every island is serialized with `<`,
// U+2028 and U+2029 escaped. A `<script type="application/json">` is still a script element
// to the HTML parser, so a `</script>` inside its text ends it and whatever follows is
// markup. The bootstrap's values happen to be safe today (a hex digest, a charset-bound
// username, configuration), but `/login`'s island will carry text any link sets, and the
// rule is the shell's rather than each value's provenance.
//
// PROJECT: `unit` — the template is props in, a string out: no D1, no binding, no request.
//
// NOT HERE: that `web.ts`'s `shell()` hands the template the session's real bootstrap, and
// that each URL's gate runs first — worker/web-pages.test.ts's shell rows, driven through
// the composition root.

// deps: none (no harness — pure seams) · pages/spa.SpaShell · no platform APIs

import { describe, expect, it } from "vitest";
import { SpaShell } from "../../src/pages/spa";

/** A value built to break out of the element in every way the rule names: a closing tag
 *  followed by markup, a comment opener, and the two JavaScript line terminators JSON
 *  allows raw inside a string. */
const HOSTILE = {
  csrf: "</script><img src=x onerror=alert(1)>",
  username: "a\u2028b\u2029c",
  origin: "<!--",
};

async function rendered(bootstrap: Record<string, string>): Promise<string> {
  const node = SpaShell({
    title: "Approvals",
    bootstrap,
    stylesheet: "/styles.css",
    appStylesheet: "/app.css",
    script: "/app.js",
  }) as { toString(): string | Promise<string> };
  return node.toString();
}

describe("§13 · the shell's JSON islands", () => {
  it("§13 · an island value carrying `</script>`, `<!--`, U+2028 and U+2029 never appears raw in the document — the island is still ONE element ending where the shell ends it — and it parses back to exactly the value given (the twin: the escape is lossless, so the client reads what the server meant)", async () => {
    const html = await rendered(HOSTILE);
    expect(html).not.toContain("</script><img");
    expect(html).not.toContain("<!--");
    expect(html).not.toContain("\u2028");
    expect(html).not.toContain("\u2029");

    const island = /<script type="application\/json" id="pmcp-bootstrap">([\s\S]*?)<\/script>/.exec(html);
    expect(island, "the shell drew no #pmcp-bootstrap island").not.toBeNull();
    expect(JSON.parse(island?.[1] ?? "null")).toEqual(HOSTILE);
  });
});
