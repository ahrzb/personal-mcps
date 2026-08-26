/**
 * cli/src/toml.ts — §10's config file FORMAT: text → the profile shape, and back.
 *
 * A module of its own, with no imports, for the same reason yaml.ts is one: main.ts
 * reaches for node:fs and node:os to read `~/.config/pmcp/config.toml`, and a suite that
 * checks the parser has no business loading that. The split is the same too — this module
 * is text↔shape, main.ts is shape→meaning (which profile is active, what its url and token
 * override), and neither knows the other's half.
 *
 * As much of TOML as §10's file uses, and not one rule more: `#` comments, top-level
 * `key = "quoted string"`, `[profiles.<name>]` table headers, and quoted strings as the
 * ONLY value kind — the config holds urls, tokens and a bootstrap secret, all of them
 * strings. Keys this subset does not know survive a parse → emit round trip, at the top
 * level and inside a profile: the file is hand-edited (`bootstrap_secret` always is, §12)
 * and a `pmcp login` that dropped a neighbouring key would be a data loss the user finds
 * out about much later. A line it cannot read is a thrown error naming the LINE NUMBER and
 * never the line — every line of this file is a live credential.
 *
 * ponytail: a subset parser, not a TOML implementation — no arrays, no inline tables, no
 * numbers/booleans/dates, no multi-line or literal (`'…'`) strings, no dotted keys beyond
 * the one `profiles.<name>` form, and profile names are bare keys (`[A-Za-z0-9_-]+`). The
 * repo may add no dependency (§4). Swap in `smol-toml` the day one is allowed; both
 * functions are the whole seam.
 */

/** One hub identity: `url`, `token`, and whatever else the operator wrote beside them. */
export type PmcpProfile = Record<string, string>;

/**
 * The config file as data: the top-level `profile` key (which profile is active when
 * nothing else selects one), the named profiles, and any other top-level key the file
 * carried — kept as `unknown` because this module never interprets one.
 */
export type PmcpConfig = {
  profile?: string;
  profiles: Record<string, PmcpProfile>;
  [key: string]: unknown;
};

/** The key order emitToml writes inside a profile; everything else follows, sorted. */
const PROFILE_KEYS = ["url", "token", "bootstrap_secret"];

export function parseToml(text: string): PmcpConfig {
  // deps: none
  const config: PmcpConfig = { profiles: {} };
  // null while no `[profiles.<name>]` header has been seen: keys land at the top level.
  let table: PmcpProfile | null = null;
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = stripComment(lines[index]).trim();
    if (line === "") continue;
    const at = `line ${index + 1}`;
    const header = /^\[profiles\.([A-Za-z0-9_-]+)\]$/.exec(line);
    if (header !== null) {
      table = config.profiles[header[1]] ?? (config.profiles[header[1]] = {});
      continue;
    }
    if (line.startsWith("[")) throw new SyntaxError(`config: ${at} is not a [profiles.<name>] table header`);
    const equals = line.indexOf("=");
    const key = equals === -1 ? "" : line.slice(0, equals).trim();
    const value = equals === -1 ? null : quoted(line.slice(equals + 1).trim());
    // The line never reaches the message — see the header: it is a credential.
    if (key === "" || value === null) throw new SyntaxError(`config: ${at} is not \`key = "quoted value"\``);
    if (table === null) config[key] = value;
    else table[key] = value;
  }
  return config;
}

export function emitToml(config: PmcpConfig): string {
  // deps: none
  const lines: string[] = [];
  // Top-level scalars first, `profile` at the head; `profiles` is the tables below.
  for (const key of ordered(Object.keys(config).filter((k) => k !== "profiles" && typeof config[k] === "string"), ["profile"])) {
    lines.push(`${key} = ${JSON.stringify(config[key])}`);
  }
  for (const name of Object.keys(config.profiles).sort()) {
    if (lines.length > 0) lines.push("");
    lines.push(`[profiles.${name}]`);
    const profile = config.profiles[name];
    for (const key of ordered(Object.keys(profile), PROFILE_KEYS)) lines.push(`${key} = ${JSON.stringify(profile[key])}`);
  }
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

/** Known keys in their declared order, then everything else alphabetically. */
function ordered(keys: string[], known: string[]): string[] {
  const rank = (key: string): number => (known.indexOf(key) === -1 ? known.length : known.indexOf(key));
  return [...keys].sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : 1));
}

/** Drops a trailing `#` comment; a `#` inside a quoted value is part of the value. */
function stripComment(line: string): string {
  let inString = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"' && line[index - 1] !== "\\") inString = !inString;
    else if (char === "#" && !inString) return line.slice(0, index);
  }
  return line;
}

/**
 * One basic string, or null for anything this subset refuses. JSON does the unescaping:
 * every escape a JSON string may carry is one a TOML basic string may carry, which is why
 * emitToml can spell a value with JSON.stringify and this can read it back.
 */
function quoted(text: string): string | null {
  if (text.length < 2 || !text.startsWith('"') || !text.endsWith('"')) return null;
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}
