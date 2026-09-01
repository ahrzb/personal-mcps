/**
 * cli/test/render.test.ts — pins render.ts's output contract (§10): color is a boolean the
 * caller passes in (never a faked terminal), wrapping never shears a long word or run of
 * text at a narrow width, truncation with `…` happens only when `tty: true`, and
 * `schemaTable` picks the right one of its three renderings.
 *
 * Project: `cli` — plain Node, parallel, pure. deps: none.
 */

import { describe, expect, it } from "vitest";
import { catalogLine, columnize, renderJson, schemaTable, styling, wrapText } from "../src/render";

describe("styling", () => {
  it("gates every formatter on the passed-in boolean alone — no formatter reads a stream or env itself", () => {
    expect(styling(true).red("x")).toBe("\x1b[31mx\x1b[39m");
    expect(styling(false).red("x")).toBe("x");
  });
});

describe("wrapText · never shears", () => {
  it("a long run of text survives a very narrow width: every original word is still present, in order, once whitespace is collapsed", () => {
    const text = "Fetch a paper by URL or arXiv id and extract its title, abstract, and full text when the source allows it.";
    const wrapped = wrapText(text, 12, 0);
    // Soft-wrap: no hard cut mid-word, so joining the wrapped lines back with spaces
    // reproduces the exact original word sequence — nothing lost, nothing merged.
    expect(wrapped.split("\n").join(" ").replace(/\s+/g, " ").trim()).toBe(text);
  });

  it("indents every line uniformly, and the indent counts against the wrap column budget", () => {
    const wrapped = wrapText("one two three four five", 10, 2);
    for (const line of wrapped.split("\n")) {
      expect(line.startsWith("  ")).toBe(true);
      expect(line.length).toBeLessThanOrEqual(10);
    }
  });
});

describe("columnize · TTY-only truncation", () => {
  const rows = [["mcp-tools", "a very long description that goes on and on and on"]];

  it("off a TTY, maxWidths is ignored — the row prints complete regardless of width", () => {
    const out = columnize(rows, { tty: false, maxWidths: [5, 10] });
    expect(out).toContain("a very long description that goes on and on and on");
    expect(out).not.toContain("…");
  });

  it("on a TTY, a column past its maxWidths cap is cut short with a trailing …", () => {
    const out = columnize(rows, { tty: true, maxWidths: [undefined, 10] });
    expect(out).toContain("…");
    // The capped column itself (the last cell on the line) never exceeds its cap.
    const cappedCell = out.split(/\s{2,}/).pop()!;
    expect(cappedCell.length).toBeLessThanOrEqual(10);
    expect(out).not.toContain("a very long description that goes on and on and on");
  });

  it("aligns columns to the widest cell (header included) when no cap applies", () => {
    const out = columnize(
      [
        ["a", "1"],
        ["bb", "22"],
      ],
      { headers: ["NAME", "N"], tty: true },
    );
    const lines = out.split("\n");
    expect(lines[0]).toBe("NAME  N");
    // "a"/"bb" column widens to fit "NAME" (4 chars) plus the gap.
    expect(lines[1].startsWith("a   ")).toBe(true);
    expect(lines[2].startsWith("bb  ")).toBe(true);
  });

  it("renders rows with no header line at all when headers is omitted", () => {
    const out = columnize([["url", "string"]], { tty: false });
    expect(out.split("\n")).toHaveLength(1);
  });

  it("`style` paints a cell's TEXT and never its padding, so alignment is measured in visible characters — a decoration that widened a column, or that a later slice could cut through, is what `ls` colouring a whole rendered line used to do", () => {
    // The slug column deliberately CONTAINS the status word: a colourer that searched the
    // rendered line for "online" would paint the wrong column here.
    const out = columnize(
      [
        ["online-notes", "online"],
        ["b", "offline"],
      ],
      { headers: ["APP", "STATUS"], tty: true, style: (cell, column) => (column === 1 ? `<${cell}>` : cell) },
    );
    const lines = out.split("\n");
    // The header is never styled — a caller that wants it dim paints the whole line.
    expect(lines[0]).toBe("APP           STATUS");
    // The slug is untouched, and the STATUS column still starts at the header's column.
    expect(lines[1]).toBe("online-notes  <online>");
    expect(lines[1].indexOf("<online>")).toBe(lines[0].indexOf("STATUS"));
    expect(lines[2].indexOf("<offline>")).toBe(lines[0].indexOf("STATUS"));
  });

  it("`style` skips empty cells — a formatter would turn one into a bare open/close pair and leave the line ending in invisible noise", () => {
    const out = columnize([["a", ""]], { tty: false, style: (cell) => `<${cell}>` });
    expect(out).toBe("<a>");
  });

  it("data rows are indexed from zero whether or not a header was rendered — a caller pairs `rowIndex` with the row it passed in", () => {
    const seen: [string, number][] = [];
    columnize([["a"], ["b"]], {
      headers: ["H"],
      tty: false,
      style: (cell, _column, rowIndex) => {
        seen.push([cell, rowIndex]);
        return cell;
      },
    });
    expect(seen).toEqual([
      ["a", 0],
      ["b", 1],
    ]);
  });
});

describe("catalogLine · TTY-only truncation, first line only", () => {
  it("off a TTY the full first line prints regardless of length", () => {
    const line = catalogLine("paper_fetch", "Fetch a paper by URL or arXiv id and extract its title.", 12, false, 40);
    expect(line).toContain("Fetch a paper by URL or arXiv id and extract its title.");
    expect(line).not.toContain("…");
  });

  it("on a TTY the first line is cut short with … to fit lineWidth", () => {
    const line = catalogLine("paper_fetch", "Fetch a paper by URL or arXiv id and extract its title.", 12, true, 40);
    expect(line.length).toBeLessThanOrEqual(40);
    expect(line).toContain("…");
  });

  it("only the description's first line is ever shown, TTY or not", () => {
    const line = catalogLine("x", "first line\nsecond line", 4, false, 80);
    expect(line).toContain("first line");
    expect(line).not.toContain("second line");
  });
});

describe("schemaTable · three shapes", () => {
  it("a flat object schema renders aligned name/type/required/description rows", () => {
    const schema = {
      type: "object",
      properties: {
        url: { type: "string", description: "paper URL or arXiv id" },
        format: { type: "string", enum: ["text", "markdown"], default: "markdown" },
        max_pages: { type: "integer", description: "cap on extracted pages" },
      },
      required: ["url"],
    };
    const out = schemaTable(schema, false);
    const lines = out.split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("url");
    expect(lines[0]).toContain("string");
    expect(lines[0]).toContain("required");
    expect(lines[0]).toContain("paper URL or arXiv id");
    expect(lines[1]).toContain("\"text\" | \"markdown\"");
    expect(lines[1]).toContain("(default \"markdown\")");
    // format is not required: the word "required" never appears as its own column value.
    expect(lines[1].split(/\s{2,}/).includes("required")).toBe(false);
  });

  it("a schema with a nested object property renders as an indented tree instead of a flat table", () => {
    const schema = {
      type: "object",
      properties: {
        filter: {
          type: "object",
          properties: { status: { type: "string" } },
        },
      },
    };
    const out = schemaTable(schema, false);
    const lines = out.split("\n");
    expect(lines[0].startsWith(" ")).toBe(false);
    expect(lines[0]).toContain("filter");
    // The child property is indented deeper than its parent.
    const childLine = lines.find((line) => line.includes("status"));
    expect(childLine).toBeDefined();
    expect(childLine!.startsWith("  ")).toBe(true);
  });

  it("anything that isn't an object schema with properties falls back to raw JSON.stringify", () => {
    expect(schemaTable({ type: "string" })).toBe(JSON.stringify({ type: "string" }, null, 2));
    expect(schemaTable("not a schema")).toBe(JSON.stringify("not a schema", null, 2));
    expect(schemaTable({ type: "array", items: { type: "string" } })).toBe(
      JSON.stringify({ type: "array", items: { type: "string" } }, null, 2),
    );
  });
});

describe("renderJson", () => {
  it("uncolored is exactly JSON.stringify(value, null, 2)", () => {
    const value = { a: 1, b: "x", c: true, d: null };
    expect(renderJson(value, false)).toBe(JSON.stringify(value, null, 2));
  });

  it("colored wraps keys, strings, numbers, booleans, and null in ANSI codes without changing the parsed value", () => {
    const value = { name: "mcp-tools", count: 3, ok: true, note: null };
    const colored = renderJson(value, true);
    expect(colored).not.toBe(JSON.stringify(value, null, 2));
    expect(colored).toContain("\x1b[");
    // Stripping ANSI codes must reproduce byte-identical plain JSON — coloring never
    // touches the actual content, and the result must still be the same JSON document.
    // eslint-disable-next-line no-control-regex
    const stripped = colored.replace(/\x1b\[[0-9;]*m/g, "");
    expect(stripped).toBe(JSON.stringify(value, null, 2));
    expect(JSON.parse(stripped)).toEqual(value);
  });
});
