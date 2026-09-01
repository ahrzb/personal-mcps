/**
 * cli/src/render.ts — §10's presentation helpers: pure text formatting, no I/O, no argv,
 * no environment reads. Every TTY/color decision a caller makes (from `stream.isTTY`,
 * `NO_COLOR`, `--no-color`) arrives here as a plain boolean — this module never reads
 * `process.env` or a stream itself, which is what makes every function below trivially
 * testable without faking a terminal.
 *
 * The output contract this module exists to uphold (§10 "Output contract"): color,
 * truncation, and non-ASCII decoration (`…`) only on a TTY — piped output is complete,
 * plain, and never shears a value to fit a column.
 *
 * deps: picocolors · wrap-ansi
 */

import * as pc from "picocolors";
import wrapAnsi from "wrap-ansi";

/** The picocolors instance `styling` returns — every formatter no-ops when disabled. */
export type Styling = ReturnType<typeof pc.createColors>;

/**
 * The color gate: `enabled` is a plain boolean the CALLER derives from
 * `stream.isTTY && !NO_COLOR && !--no-color` (§10) — this function does not read any of
 * those itself, so a test never needs to fake a terminal to exercise color output.
 */
export function styling(enabled: boolean): Styling {
  return pc.createColors(enabled);
}

/**
 * Wraps `text` to `width` columns (wrap-ansi, soft wrap — a word longer than the column
 * count overflows rather than losing characters, §10's "never shears" guarantee) and
 * indents every resulting line by `indent` spaces. `width` is the FULL line budget;
 * the wrap column count is `width - indent`.
 */
export function wrapText(text: string, width: number, indent = 0): string {
  const pad = " ".repeat(Math.max(0, indent));
  const columns = Math.max(1, width - indent);
  return wrapAnsi(text, columns, { trim: true })
    .split("\n")
    .map((line) => pad + line)
    .join("\n");
}

export type ColumnizeOptions = {
  /** Header labels; omit to render `rows` with no header line (e.g. a schema's argument list). */
  headers?: string[];
  /** Gates `…` truncation against `maxWidths`. A non-TTY stream always prints full content. */
  tty: boolean;
  /** Per-column cap, enforced only when `tty` is true; a column with no cap never truncates. */
  maxWidths?: (number | undefined)[];
  /** Spaces between columns. Default 2. */
  gap?: number;
  /**
   * Per-cell styling for DATA rows (`rowIndex` indexes `rows`; the header line is never
   * styled here — a caller that wants it dim paints the whole line). Applied to the cell's
   * visible text only, with the padding added plain afterwards: widths stay measured in
   * visible characters, so no escape sequence is ever sliced or counted as content. An
   * empty cell is left alone — a formatter would turn it into a bare open/close pair that
   * defeats the trailing-whitespace trim.
   */
  style?: (cell: string, colIndex: number, rowIndex: number) => string;
};

/**
 * Width-aware column layout: every column is padded to its widest cell (header included),
 * one row per line. On a TTY, a column with a `maxWidths` entry is capped to it and a
 * cell that overflows is cut short with a trailing `…`; off a TTY, `maxWidths` is ignored
 * entirely — the output is the complete, plain table (§10).
 */
export function columnize(rows: string[][], opts: ColumnizeOptions): string {
  const gap = " ".repeat(opts.gap ?? 2);
  const allRows = opts.headers === undefined ? rows : [opts.headers, ...rows];
  const cols = allRows.reduce((max, row) => Math.max(max, row.length), 0);
  const widths: number[] = [];
  for (let i = 0; i < cols; i++) {
    let width = 0;
    for (const row of allRows) width = Math.max(width, (row[i] ?? "").length);
    const cap = opts.maxWidths?.[i];
    if (opts.tty && cap !== undefined) width = Math.min(width, cap);
    widths[i] = width;
  }
  const renderRow = (row: string[], rowIndex: number): string =>
    row
      .map((cell, i) => {
        const width = widths[i] ?? 0;
        const truncated = opts.tty && cell.length > width ? `${cell.slice(0, Math.max(0, width - 1))}…` : cell;
        const painted =
          opts.style === undefined || rowIndex < 0 || truncated === "" ? truncated : opts.style(truncated, i, rowIndex);
        // The last column is never padded — trailing spaces on every row are pointless noise.
        return i === cols - 1 ? painted : painted + " ".repeat(Math.max(0, width - truncated.length));
      })
      .join(gap)
      // …and neither is the padding an EMPTY trailing cell leaves behind (a row that stops
      // short of the widest one, an optional last column). No line this module emits ends
      // in whitespace.
      .trimEnd();
  const offset = opts.headers === undefined ? 0 : 1;
  return allRows.map((row, index) => renderRow(row, index - offset)).join("\n");
}

const DEFAULT_LINE_WIDTH = 80;

/**
 * One catalog row: `name` padded to `width`, then the description's FIRST line only —
 * a catalog line is one line by design, so a multi-line description is not shown in
 * full here (that is `wrapText`'s or `schemaTable`'s job, for the leaf view). On a TTY
 * the first line is cut short with `…` to fit `lineWidth`; off a TTY it prints whole.
 */
export function catalogLine(name: string, description: string, width: number, tty: boolean, lineWidth = DEFAULT_LINE_WIDTH): string {
  const namePad = name.padEnd(width);
  const firstLine = description.split("\n")[0] ?? "";
  const budget = lineWidth - namePad.length - 1;
  const shown = tty && budget > 0 && firstLine.length > budget ? `${firstLine.slice(0, Math.max(0, budget - 1))}…` : firstLine;
  return `${namePad} ${shown}`;
}

/** The subset of JSON Schema this module renders; anything else falls back to raw JSON. */
export type JsonSchema = {
  type?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  description?: string;
  enum?: unknown[];
  default?: unknown;
  items?: JsonSchema;
  [key: string]: unknown;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A property is "nested" when laying it out needs more than one table row. */
function isNested(prop: JsonSchema): boolean {
  if (prop.type === "object" && isPlainObject(prop.properties)) return true;
  if (prop.type === "array" && isPlainObject(prop.items) && prop.items.type === "object") return true;
  return false;
}

/** enum / description / default composed into one description-column string. */
function describeProp(prop: JsonSchema): string {
  const parts: string[] = [];
  if (Array.isArray(prop.enum)) parts.push(prop.enum.map((value) => JSON.stringify(value)).join(" | "));
  if (typeof prop.description === "string" && prop.description !== "") parts.push(prop.description);
  if (prop.default !== undefined) parts.push(`(default ${JSON.stringify(prop.default)})`);
  return parts.join("  ");
}

function typeLabel(prop: JsonSchema): string {
  if (prop.type === "array") return `array<${(prop.items as JsonSchema | undefined)?.type ?? "any"}>`;
  return String(prop.type ?? "");
}

/** The indented-tree form for a schema carrying at least one nested property. */
function schemaTree(schema: JsonSchema, depth: number): string {
  const indent = "  ".repeat(depth);
  const required = new Set(schema.required ?? []);
  const lines: string[] = [];
  for (const [name, prop] of Object.entries(schema.properties ?? {})) {
    const bits = [typeLabel(prop), required.has(name) ? "required" : "", describeProp(prop)].filter((bit) => bit !== "");
    lines.push(`${indent}${name}  ${bits.join("  ")}`.trimEnd());
    if (isNested(prop)) {
      const child = prop.type === "array" ? (prop.items as JsonSchema) : prop;
      lines.push(schemaTree(child, depth + 1));
    }
  }
  return lines.join("\n");
}

/**
 * A JSON Schema object → a rendering: a FLAT object schema (every property primitive)
 * becomes aligned `name / type / required / description` rows (`columnize`, no header —
 * a leaf's argument list is not itself a table with column titles, §10's mock); a schema
 * with at least one nested (object- or object-array-typed) property becomes an indented
 * tree instead; anything that is not an object schema with `properties` at all — no
 * `type: "object"`, a primitive schema, an array schema, `properties` missing or not an
 * object — falls back to `JSON.stringify(schema, null, 2)` verbatim, so nothing this
 * renderer cannot lay out is ever silently dropped.
 */
export function schemaTable(schema: unknown, tty = true): string {
  if (!isPlainObject(schema) || schema.type !== "object" || !isPlainObject(schema.properties)) {
    return JSON.stringify(schema, null, 2);
  }
  const s = schema as JsonSchema & { properties: Record<string, JsonSchema> };
  if (Object.values(s.properties).some(isNested)) return schemaTree(s, 0);
  const required = new Set(s.required ?? []);
  const rows = Object.entries(s.properties).map(([name, prop]) => [
    name,
    typeLabel(prop),
    required.has(name) ? "required" : "",
    describeProp(prop),
  ]);
  return columnize(rows, { tty });
}

const JSON_TOKEN = /("(?:\\u[0-9a-fA-F]{4}|\\[^u]|[^\\"])*"(?:\s*:)?)|\b(?:true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;

/**
 * `JSON.stringify(value, null, 2)`, lightly colored when `colored` is true: keys cyan,
 * strings green, numbers magenta, `true`/`false` yellow, `null` gray. `colored: false`
 * (or `styling(false)`'s underlying gate) returns the plain stringified text unchanged —
 * this function creates its own picocolors instance rather than taking one, since every
 * picocolors formatter is already a safe no-op when its instance is disabled.
 */
export function renderJson(value: unknown, colored: boolean): string {
  const json = JSON.stringify(value, null, 2);
  const c = pc.createColors(colored);
  return json.replace(JSON_TOKEN, (match, key: string | undefined) => {
    if (key !== undefined) return key.endsWith(":") ? c.cyan(key) : c.green(key);
    if (match === "true" || match === "false") return c.yellow(match);
    if (match === "null") return c.gray(match);
    return c.magenta(match);
  });
}
