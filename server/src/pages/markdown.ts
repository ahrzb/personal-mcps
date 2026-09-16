// markdown.ts — an MCP app's own prose, rendered as the Markdown it is written in.
//
// Descriptions on tools, prompts, resources and resource templates are Markdown by
// convention (CommonMark/GFM), and every one of them is UNTRUSTED: the text is whatever
// the app answered `tools/list` with, so it is an injection vector the same way a request
// body is. That is the whole reason this module exists as ONE module — the three functions
// below are the only place the hub turns app text into markup, and their outputs are the
// only strings a page may hand to Hono's `raw()`. `raw()` on anything else, anywhere in
// server/src/pages, is a hole; a description rendered as a JSX child (escaped) is always
// safe and needs nothing from here.
//
// What the whitelist lets through, on the OUTPUT rather than the input (the source is
// never pattern-matched, because a filter over Markdown source is a filter over a grammar
// nobody can enumerate):
//
//   - No raw HTML from the source. `marked` emits an `html` token's text verbatim, block
//     and inline alike, so `html` is overridden to ESCAPE it: `<script>` from an app reads
//     as the four characters `&lt;s…` and never as an element.
//   - Links only where the URL is an absolute `http:`, `https:` or `mailto:` — anything
//     else (`javascript:`, `data:`, a relative path that means nothing outside the app)
//     renders as its own text. A link that IS rendered carries
//     `rel="noopener noreferrer" target="_blank"`: it leaves the hub for somewhere the app
//     chose.
//   - No images. An app's prose cannot make the hub fetch a URL of its choosing on the
//     owner's behalf, so an image renders as a link to its URL carrying its alt text.
//   - No headings. They are demoted to `<strong>` blocks so app text cannot out-rank the
//     page's own headings in a document outline.
//   - No `id`, `class` or `style` attribute reaches the output — which is why `code` is
//     overridden too: `marked`'s own emits `class="language-<lang>"`, and a class from an
//     app is a foothold in the hub's one stylesheet.
//
// Totality: a description that makes the parser throw renders as its own escaped text
// rather than taking the page down with it. App text decides what a page SAYS, never
// whether it answers.

import { Marked } from "marked";
import type { RendererObject, Tokens } from "marked";

/** The schemes a link out of app prose may carry. Anything else is not a link. */
const SAFE_SCHEMES = new Set(["http:", "https:", "mailto:"]);

const ENTITIES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escape(text: string): string {
  return text.replace(/[&<>"']/g, (character) => ENTITIES[character] ?? character);
}

/** The inverse, over the five `escape` writes — for `plainText`, which un-marks up. */
function unescape(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

/** The href verbatim where it is an ABSOLUTE safe-scheme URL, else null. Relative is null
 *  on purpose: a path is relative to the app's own docs, never to the hub. */
function safeUrl(href: string): string | null {
  try {
    return SAFE_SCHEMES.has(new URL(href).protocol) ? href : null;
  } catch {
    return null;
  }
}

function anchor(url: string, body: string): string {
  return `<a href="${escape(url)}" rel="noopener noreferrer" target="_blank">${body}</a>`;
}

const renderer: RendererObject = {
  html({ text }: Tokens.HTML | Tokens.Tag): string {
    return escape(text);
  },
  code({ text }: Tokens.Code): string {
    return `<pre><code>${escape(text)}</code></pre>\n`;
  },
  heading({ tokens }: Tokens.Heading): string {
    return `<p><strong>${this.parser.parseInline(tokens)}</strong></p>\n`;
  },
  link({ href, text, tokens, autolink }: Tokens.Link): string {
    // An autolink's text IS its URL and carries no inline tokens to parse.
    const body = autolink === true ? escape(text) : this.parser.parseInline(tokens);
    const url = safeUrl(href);
    return url === null ? body : anchor(url, body);
  },
  image({ href, text }: Tokens.Image): string {
    const alt = escape(text === "" ? href : text);
    const url = safeUrl(href);
    return url === null ? alt : anchor(url, alt);
  },
};

const marked = new Marked({ gfm: true, async: false, renderer });

/** The block tokens that carry a paragraph's worth of inline text — what `inlineMarkdown`
 *  is allowed to call "the first paragraph". */
const PARAGRAPHS = new Set(["paragraph", "heading", "text"]);

/**
 * One app description as safe HTML: block structure and all (paragraphs, lists, fences,
 * tables), under the module's whitelist. The result is markup — pass it to `raw()` and
 * NEVER to anything that escapes, or a reader sees the tags.
 *
 * `source` is untrusted app text. The empty string renders as the empty string.
 */
export function renderMarkdown(source: string): string {
  try {
    return marked.parse(source) as string;
  } catch {
    return escape(source);
  }
}

/**
 * The same description as ONE line of safe HTML: the first paragraph's inline formatting
 * (emphasis, inline code, links) with every block wrapper dropped — for a listing row that
 * must stay one line high whatever the app wrote. A description whose first block is a
 * fence or a list falls back to its own flattened text.
 *
 * `source` is untrusted app text; the result is markup, for `raw()` alone.
 */
export function inlineMarkdown(source: string): string {
  try {
    const first = marked.lexer(source).find((token) => PARAGRAPHS.has(token.type));
    if (first === undefined) return escape(plainText(source));
    return marked.parseInline((first as Tokens.Paragraph).text) as string;
  } catch {
    return escape(source);
  }
}

/**
 * The same description with the Markdown taken OFF: no markup at all, for the places that
 * can hold only text — a `title`, an `aria-label`, anything inside an attribute. Newlines
 * and runs of space collapse to single spaces, because an attribute is one line.
 *
 * `source` is untrusted app text. The result is TEXT: it goes in as a JSX value, which
 * escapes it, and never through `raw()`.
 */
export function plainText(source: string): string {
  return unescape(renderMarkdown(source).replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    // A tag between a word and its punctuation left a space behind it — `code`.` is two
    // elements and one sentence, and "…feed ." is not what the app wrote.
    .replace(/ ([,.;:!?])/g, "$1")
    .trim();
}
