/**
 * cli/src/yaml.ts — §9's config file FORMAT: text → JSON values, and nothing else.
 *
 * A module of its own, with no imports, for the same reason commands.ts is one: main.ts
 * reaches for node:fs and node:os to read `~/.config/pmcp/config.toml`, and a suite that
 * checks the parser has no business loading that. It also keeps plan.ts's header true —
 * "It HIDES YAML from everything else" — by making the split `yaml.ts` text→JSON,
 * `plan.ts` JSON→meaning, main.ts neither.
 *
 * As much of YAML as §9's file uses: block mappings and lists by indentation, flow lists
 * (`[a, b]`), quoted and bare scalars, booleans, numbers, and `#` comments.
 * plan.parseDesired owns every rule about what the shape MEANS.
 *
 * ponytail: a subset parser, not a YAML implementation — no anchors, no multi-line
 * scalars, no multi-document files, no flow MAPPINGS. The repo may add no dependency
 * (§4), and §9's file is this shape. Swap in `yaml` the day a dependency is allowed;
 * `parseDesired`'s input type is already `unknown`.
 */

export function parseYaml(text: string): unknown {
  // deps: none
  const lines: { indent: number; text: string }[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const stripped = stripComment(raw);
    if (stripped.trim() === "") continue;
    lines.push({ indent: stripped.length - stripped.trimStart().length, text: stripped.trim() });
  }
  let cursor = 0;

  const block = (indent: number): unknown => {
    if (lines[cursor].text.startsWith("- ") || lines[cursor].text === "-") {
      const list: unknown[] = [];
      while (cursor < lines.length && lines[cursor].indent === indent && lines[cursor].text.startsWith("-")) {
        const entry = lines[cursor].text.slice(1).trim();
        cursor += 1;
        list.push(entry === "" ? nested(indent) : scalar(entry));
      }
      return list;
    }
    const map: Record<string, unknown> = {};
    while (cursor < lines.length && lines[cursor].indent === indent) {
      const line = lines[cursor].text;
      const colon = line.indexOf(":");
      if (colon === -1) throw new SyntaxError(`not a mapping entry: ${line}`);
      const key = unquote(line.slice(0, colon).trim());
      const rest = line.slice(colon + 1).trim();
      cursor += 1;
      map[key] = rest === "" ? nested(indent) : scalar(rest);
    }
    return map;
  };

  /** Whatever is indented under the entry just consumed — or null when nothing is. */
  const nested = (indent: number): unknown =>
    cursor < lines.length && lines[cursor].indent > indent ? block(lines[cursor].indent) : null;

  return lines.length === 0 ? {} : block(lines[0].indent);
}

/** Drops a trailing `#` comment, respecting quotes. */
function stripComment(line: string): string {
  let quote: string | null = null;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quote !== null) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"') quote = char;
    else if (char === "#" && (index === 0 || /\s/.test(line[index - 1]))) return line.slice(0, index);
  }
  return line;
}

/** One scalar or flow list. */
function scalar(text: string): unknown {
  if (text.startsWith("[") && text.endsWith("]")) {
    const inner = text.slice(1, -1).trim();
    return inner === "" ? [] : splitFlow(inner).map(scalar);
  }
  if (text === "true") return true;
  if (text === "false") return false;
  if (text === "null" || text === "~") return null;
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
  return unquote(text);
}

/** Splits a flow list on commas that are not inside quotes. */
function splitFlow(inner: string): string[] {
  const parts: string[] = [];
  let quote: string | null = null;
  let start = 0;
  for (let index = 0; index < inner.length; index += 1) {
    const char = inner[index];
    if (quote !== null) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"') quote = char;
    else if (char === ",") {
      parts.push(inner.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(inner.slice(start).trim());
  return parts.filter((part) => part !== "");
}

function unquote(text: string): string {
  const quoted = (text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"));
  return quoted ? text.slice(1, -1) : text;
}
