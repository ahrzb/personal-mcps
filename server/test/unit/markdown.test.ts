// markdown.test.ts — the one renderer that turns an app's own prose into markup.
//
// PINS §13's Markdown rule (2026-09-16): descriptions on tools, prompts, resources and
// templates are Markdown by convention, and the hub renders them — which makes
// server/src/pages/markdown.ts a trust boundary, not a formatter. The text is whatever the
// app answered `tools/list` with, so every rule below is about what an app must NOT be able
// to do with it: no raw HTML, no `javascript:` link, no image fetch, no heading that
// out-ranks the page's own, no class reaching the hub's one stylesheet.
//
// The three functions are one contract read at three widths — whole, one line, no markup —
// so one source runs through all of them: a difference between them would be a page that
// escapes in the details pane and not in the row above it.
//
// PROJECT: `unit` — the module's deps line is `none`: a string in, a string out, no D1, no
// binding, no request.
//
// NOT HERE: that the PAGES call these and pass the result to `raw()` — a rendered `<strong>`
// in a tool row and an escaped `<script>` beside it are worker/web-pages.test.ts's rows, on
// the app page's Tools pane and the agent page's grant pane. This file pins the strings.

// deps: none (no harness — pure seams) · markdown.renderMarkdown · markdown.inlineMarkdown · markdown.plainText · no platform APIs

import { describe, it, expect } from "vitest";
import { inlineMarkdown, plainText, renderMarkdown } from "../../src/pages/markdown";

/**
 * One description carrying every case §13's rule names at once: inline emphasis and a
 * fence, a list, a link the whitelist admits, one it must refuse, and raw HTML. One source
 * rather than six, because the rules are about what survives BESIDE each other — a
 * sanitizer that only ever sees its own case is a sanitizer nobody proved composes.
 */
const SOURCE = [
  "Fetch the **latest** stories from `news://feed`.",
  "",
  "```js",
  'const feed = "https://example.com/feed";',
  "```",
  "",
  "- newest first",
  "- capped at 50",
  "",
  "See the [handbook](https://example.com/docs), or [run it](javascript:alert(1)).",
  "",
  "<script>alert(1)</script>",
].join("\n");

describe("§13 · an app's description is Markdown, and the renderer is the trust boundary", () => {
  it("§13 · renderMarkdown draws the whole description — emphasis, inline code, a fenced block and a list as elements", () => {
    const html = renderMarkdown(SOURCE);
    expect(html).toContain("<strong>latest</strong>");
    expect(html).toContain("<code>news://feed</code>");
    expect(html).toContain("<pre><code>");
    expect(html).toContain("<ul>");
    expect(html).toContain("<li>newest first</li>");
    // No class on the fence: `marked`'s own emits `language-js`, and a class from an app is
    // a foothold in the hub's one stylesheet.
    expect(html).not.toContain("class=");
    expect(html).not.toContain("id=");
    expect(html).not.toContain("style=");
  });

  it("§13 · a link is rendered only for http/https/mailto and carries rel/target — a javascript: link is its own text, and raw HTML from the app is escaped, never an element", () => {
    const html = renderMarkdown(SOURCE);
    expect(html).toContain('<a href="https://example.com/docs" rel="noopener noreferrer" target="_blank">handbook</a>');

    // The refused scheme survives as WORDS: the text renders, the href does not exist.
    expect(html).toContain("run it");
    expect(html).not.toContain("javascript:");
    expect(html).not.toMatch(/<a[^>]*>run it<\/a>/);

    // The app's own tag, escaped — the four characters, never the element.
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>");

    // The twin every escaper owes: the same rule with the tag spelled inline, mid-sentence.
    expect(renderMarkdown("a <img src=x onerror=alert(1)> b")).not.toContain("<img");
  });

  it("§13 · mailto is admitted, an image is a LINK to its URL with its alt text, and a heading is demoted to a strong block so app text cannot out-rank the page's own", () => {
    expect(renderMarkdown("[write](mailto:ops@example.com)")).toContain(
      '<a href="mailto:ops@example.com" rel="noopener noreferrer" target="_blank">write</a>',
    );

    // No image tag at all: an app's prose cannot make the hub fetch a URL of its choosing.
    const image = renderMarkdown("![the board](https://example.com/board.png)");
    expect(image).not.toContain("<img");
    expect(image).toContain('<a href="https://example.com/board.png" rel="noopener noreferrer" target="_blank">the board</a>');
    expect(renderMarkdown("![alt](javascript:alert(1))")).toBe("<p>alt</p>\n");

    for (const heading of ["# Shouting", "## Shouting", "###### Shouting"]) {
      expect(renderMarkdown(heading), heading).toBe("<p><strong>Shouting</strong></p>\n");
    }
  });

  it("§13 · inlineMarkdown is the FIRST paragraph and inline only — the emphasis renders, every block wrapper is gone, and a description opening on a fence still says something", () => {
    const line = inlineMarkdown(SOURCE);
    expect(line).toBe("Fetch the <strong>latest</strong> stories from <code>news://feed</code>.");
    for (const block of ["<p>", "<pre>", "<ul>", "<li>"]) expect(line, block).not.toContain(block);

    // The whitelist is the same one line up: a refused link is text here too.
    expect(inlineMarkdown("[run it](javascript:alert(1)) now")).toBe("run it now");
    expect(inlineMarkdown("<script>alert(1)</script> hi")).not.toContain("<script>");

    // A description whose first block is a fence or a list has no first paragraph: it
    // falls back to its own flattened text rather than rendering an empty row.
    expect(inlineMarkdown("```\ncrawl --all\n```")).toBe("crawl --all");
    expect(inlineMarkdown("- one\n- two")).toBe("one two");
    expect(inlineMarkdown("")).toBe("");
  });

  it("§13 · plainText is TEXT — every tag off, newlines and runs of space collapsed to one, for the attributes that can hold nothing else", () => {
    const text = plainText(SOURCE);
    expect(text).toBe(
      "Fetch the latest stories from news://feed. const feed = \"https://example.com/feed\"; newest first capped at 50 See the handbook, or run it. <script>alert(1)</script>",
    );
    // One line, whatever the app wrote: a `title` cannot carry a fence.
    expect(text).not.toContain("\n");
    expect(plainText("")).toBe("");
  });
});
