import type { ReactNode } from "react";
import { REDACTED_LEAF, TREE_OPEN_DEPTH, isBodyStub, stubLabel, treeSearch } from "./derive";

/**
 * A recorded body as a collapsible tree, with the record's search highlighted in it.
 *
 * Not a `<pre>` of `JSON.stringify`. A recorded result is routinely a few hundred lines of
 * structured content, and the question a reader opens it with is "what was the argument" — so
 * the first level is open, everything below is one click, and the two things the ledger PUT
 * there rather than the app are drawn as chips instead of as values:
 *
 *  - a **stub**, where §15's cap replaced a whole body or one unstructured block, renders as
 *    its typed size placeholder — `‹blob image/png · 4.2 MB›` — never as the bytes, and never
 *    as an object with a `stub` key, which would read as the app's own field;
 *  - `‹redacted›`, where the gateway's masking replaced a leaf, renders as a chip rather than
 *    as the quoted string it is on the wire, so it cannot be mistaken for a value that happens
 *    to say that.
 *
 * SEARCHING OPENS. A needle that matches a nested key or value opens every node on the way to
 * it, because a highlight inside a collapsed subtree is a hit the reader cannot see — worse
 * than none, since the drawer would look as though it found nothing. `derive.treeSearch` is
 * what decides which paths those are; `matches` above zero is also how the record knows not to
 * say "No matches in this record."
 *
 * `open` is the CALLER's manual toggles, keyed by path, and it WINS over both the search and
 * the default depth — a reader who collapsed a noisy subtree keeps it collapsed. It is the
 * caller's so that collapsing survives the re-render that typing causes.
 */
export function JsonTree({
  value,
  /** The section's own name — the root path, and the root node's label. */
  path,
  open,
  onToggle,
  /** The record search's needle; "" highlights nothing and opens nothing. */
  needle,
}: {
  value: unknown;
  path: string;
  open: Record<string, boolean>;
  onToggle: (path: string) => void;
  needle: string;
}): ReactNode {
  const found = treeSearch(value, path, needle);
  return (
    <div className="a-tree">
      <Node
        value={value}
        name={path}
        path={path}
        depth={0}
        open={open}
        onToggle={onToggle}
        needle={needle}
        opened={found.ancestors}
      />
    </div>
  );
}

/** How far one level indents. 14px: enough to read as nesting at 12px mono, small enough that
 *  a six-deep result still fits a 620px drawer. */
const INDENT = 14;

/**
 * One node: a key and, beside it, either its value or the subtree it opens.
 *
 * `name` is the key this node sits under, carried explicitly rather than read back off the end
 * of `path` — an object key may contain a dot, and splitting the path on one would rename it.
 */
function Node({
  value,
  name,
  path,
  depth,
  open,
  onToggle,
  needle,
  opened,
}: {
  value: unknown;
  name: string;
  path: string;
  depth: number;
  open: Record<string, boolean>;
  onToggle: (path: string) => void;
  needle: string;
  /** Paths the current search has to have open for its matches to be on screen. */
  opened: Set<string>;
}): ReactNode {
  const indent = { "--ind": `${depth * INDENT}px` } as React.CSSProperties;

  // A leaf — a primitive, or a stub the cap put where a body was. Its key is on the same line,
  // because a key on a line of its own doubles the height of every recorded body.
  if (isBodyStub(value) || value === null || typeof value !== "object") {
    return (
      <div className="a-tn" style={indent}>
        <span className="a-tog" />
        <span className="a-tkey">
          <Hl text={name} needle={needle} />:
        </span>
        {isBodyStub(value) ? (
          <span className="a-stub">
            <Hl text={stubLabel(value)} needle={needle} />
          </span>
        ) : (
          <Leaf value={value} needle={needle} />
        )}
      </div>
    );
  }

  const entries: [string, unknown][] = Array.isArray(value)
    ? value.map((each, index) => [`[${index}]`, each])
    : Object.entries(value);
  // A manual toggle first, then the search's own reach, then the default two levels — which is
  // what puts a `‹redacted›` leaf and a `content` stub on screen without a click.
  const isOpen = open[path] ?? (opened.has(path) || depth < TREE_OPEN_DEPTH);

  return (
    <>
      <div className="a-tn" style={indent}>
        <button
          type="button"
          className="a-tog"
          aria-expanded={isOpen}
          aria-label={`${isOpen ? "Collapse" : "Expand"} ${name}`}
          onClick={() => onToggle(path)}
        >
          {isOpen ? "▾" : "▸"}
        </button>
        <span className="a-tkey">
          <Hl text={name} needle={needle} />
        </span>
        <span className="a-tcount">
          {Array.isArray(value) ? `[${entries.length}]` : `{${entries.length}}`}
          {isOpen ? "" : " …"}
        </span>
      </div>
      {isOpen
        ? entries.map(([key, child]) => (
            <Node
              key={key}
              value={child}
              name={key}
              path={`${path}.${key}`}
              depth={depth + 1}
              open={open}
              onToggle={onToggle}
              needle={needle}
              opened={opened}
            />
          ))
        : null}
    </>
  );
}

/** A primitive value. A `‹redacted›` string is the gateway's own marker rather than an app's
 *  text, so it wears the stub chip instead of quotation marks. */
function Leaf({ value, needle }: { value: unknown; needle: string }): ReactNode {
  if (typeof value === "string") {
    if (value === REDACTED_LEAF) return <span className="a-stub">{REDACTED_LEAF}</span>;
    return (
      <span>
        "<Hl text={value} needle={needle} />"
      </span>
    );
  }
  return (
    <span className="a-tnum">
      <Hl text={String(value)} needle={needle} />
    </span>
  );
}

/**
 * Text with every occurrence of the needle marked.
 *
 * Split on the needle rather than matched with a regular expression: the needle is whatever the
 * reader typed, and `(` or `[` from a tool name would otherwise be a syntax error or, worse, a
 * pattern that matches something else.
 */
function Hl({ text, needle }: { text: string; needle: string }): ReactNode {
  const trimmed = needle.trim();
  if (trimmed === "") return <>{text}</>;
  const parts = splitOn(text, trimmed);
  if (parts.length === 1) return <>{text}</>;
  return (
    <>
      {parts.map((part, index) =>
        index % 2 === 1 ? (
          <mark className="a-hit" key={index}>
            {part}
          </mark>
        ) : (
          <span key={index}>{part}</span>
        ),
      )}
    </>
  );
}

/** `text` split around a case-insensitive `needle`, matches at the odd indices — the shape
 *  `String.split` with a capturing group gives, without the regular expression. */
function splitOn(text: string, needle: string): string[] {
  const haystack = text.toLowerCase();
  const lower = needle.toLowerCase();
  const out: string[] = [];
  let at = 0;
  for (;;) {
    const found = haystack.indexOf(lower, at);
    if (found < 0) {
      out.push(text.slice(at));
      return out;
    }
    out.push(text.slice(at, found), text.slice(found, found + needle.length));
    at = found + needle.length;
  }
}
