/**
 * cli/src/config.ts — §10's profile store: where a hub identity lives between invocations,
 * and which profile is ACTIVE for a given invocation.
 *
 * Parses and emits `~/.config/pmcp/config.toml` via smol-toml (§4 dependency), behind a
 * wrapper whose contract is pinned by the implementation plan and cli/test/config-store.test.ts:
 *
 *   - A parse error never lets smol-toml's own message escape: every line of this file is a
 *     live credential, and TomlError's message embeds the offending line's text. Only the
 *     line NUMBER survives, in a message this module composes itself.
 *   - Unknown keys — top-level or inside a `[profiles.<name>]` table — survive a
 *     parse→emit round trip; this module never drops a hand-written key it does not
 *     recognize (`bootstrap_secret` is the standing example, §12).
 *   - Profiles are `Record<string, string>`. A non-string TOML value (an unquoted number,
 *     bool, date, array, inline table) is stringified rather than rejected, so a file with
 *     one odd hand-edited line still loads instead of failing the whole config.
 *
 * `configPath`/`readConfig`/`writeConfig`/`activeProfile`/`profileOf`/`applyProfile` are
 * ports of the functions of the same name in `main.ts` (~lines 150-250) — same behavior,
 * same precedence, same 0600 write. `resolveActiveProfile` is new: it names WHERE the active
 * profile came from, for `profile list --json`.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parse as parseSmolToml, stringify as stringifySmolToml, TomlError } from "smol-toml";
import type { TomlValue } from "smol-toml";

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

/** Where profile-list resolved its `name` from, most-specific first. */
export type ProfileSource = "flag" | "env" | "config" | "builtin";

/** The key order emitConfig writes inside a profile; everything else follows, sorted. */
const PROFILE_KEYS = ["url", "token", "bootstrap_secret"];

/** Where the profiles live between invocations (§10). */
export function configPath(): string {
  return join(homedir(), ".config", "pmcp", "config.toml");
}

/**
 * The file as it was before profiles: one flat `{ url, token }`. Read once as profile
 * `default` and superseded by the next write (§10) — never rewritten, never deleted, so a
 * downgrade still finds the session it left behind.
 */
export function legacyConfigPath(): string {
  return join(homedir(), ".config", "pmcp", "config.json");
}

/**
 * Text → shape, via smol-toml, with the pinned parse-error contract: a `TomlError`'s own
 * message (which embeds the offending line's text — a live credential) never escapes.
 */
export function parseConfig(text: string): PmcpConfig {
  let raw: Record<string, TomlValue>;
  try {
    raw = parseSmolToml(text);
  } catch (err) {
    if (err instanceof TomlError) throw new Error(`config: line ${err.line} is not valid TOML`);
    throw err;
  }
  const config: PmcpConfig = { profiles: {} };
  for (const [key, value] of Object.entries(raw)) {
    if (key !== "profiles") config[key] = toStringValue(value);
  }
  if (isTable(raw.profiles)) {
    for (const [name, profile] of Object.entries(raw.profiles)) {
      if (!isTable(profile)) continue;
      const entry: PmcpProfile = {};
      for (const [key, value] of Object.entries(profile)) entry[key] = toStringValue(value);
      config.profiles[name] = entry;
    }
  }
  return config;
}

/** Shape → text, via smol-toml. Known keys first in their declared order, then the rest sorted. */
export function emitConfig(config: PmcpConfig): string {
  const table: Record<string, TomlValue> = {};
  for (const key of ordered(Object.keys(config).filter((k) => k !== "profiles" && typeof config[k] === "string"), ["profile"])) {
    table[key] = config[key] as string;
  }
  const profiles: Record<string, TomlValue> = {};
  for (const name of Object.keys(config.profiles).sort()) {
    const profile = config.profiles[name];
    const entry: Record<string, TomlValue> = {};
    for (const key of ordered(Object.keys(profile), PROFILE_KEYS)) entry[key] = profile[key];
    profiles[name] = entry;
  }
  table.profiles = profiles;
  return stringifySmolToml(table);
}

export function readConfig(): PmcpConfig {
  // A malformed config.toml is NOT swallowed: parseConfig names the line, and the caller
  // prints it. Silently resolving to "not logged in" would send the user to `pmcp login`
  // for a typo three lines up. The legacy json is best-effort — it is on its way out.
  if (existsSync(configPath())) return parseConfig(readFileSync(configPath(), "utf8"));
  if (!existsSync(legacyConfigPath())) return { profiles: {} };
  try {
    const flat = JSON.parse(readFileSync(legacyConfigPath(), "utf8")) as { url?: string; token?: string };
    return {
      profile: "default",
      profiles: {
        default: { ...(flat.url === undefined ? {} : { url: flat.url }), ...(flat.token === undefined ? {} : { token: flat.token }) },
      },
    };
  } catch {
    return { profiles: {} };
  }
}

export function writeConfig(config: PmcpConfig): void {
  const path = configPath();
  mkdirSync(dirname(path), { recursive: true });
  // 0600: the file holds a live session bearer — one per profile.
  writeFileSync(path, emitConfig(config), { mode: 0o600 });
}

/**
 * Which profile this invocation acts on: the `--profile` flag, else PMCP_PROFILE, else the
 * file's own top-level `profile`, else the name `default` — neutral on purpose, since the
 * CLI's users are not only developers with environments (§10).
 */
export function activeProfile(config: PmcpConfig, flag?: string): string {
  return flag ?? process.env.PMCP_PROFILE ?? config.profile ?? "default";
}

/** The active profile's stored values — `{}` when the file has no table by that name. */
export function profileOf(config: PmcpConfig, name: string): PmcpProfile {
  return config.profiles[name] ?? {};
}

/**
 * The `pnpm users` bridge, called by scripts/users.mts: consumes a leading
 * `--profile <name>`, fills PMCP_URL and BOOTSTRAP_SECRET from that profile wherever the
 * environment has not already spoken, and returns the rest of argv. It lives here because
 * the precedence lives here — scripts/users.ts stays env-only, which is its tested
 * contract (§12), and gains a config file it never reads.
 */
export function applyProfile(argv: string[]): string[] {
  const rest = [...argv];
  const flag = rest[0] === "--profile" ? rest.splice(0, 2)[1] : undefined;
  const config = readConfig();
  const profile = profileOf(config, activeProfile(config, flag));
  for (const [variable, key] of [["PMCP_URL", "url"], ["BOOTSTRAP_SECRET", "bootstrap_secret"]] as const) {
    // The environment wins where it is already set; an empty value is not set (users.ts
    // reads it the same way), and `undefined` is never assigned — process.env would spell
    // it as the string "undefined".
    if ((process.env[variable] ?? "") === "" && (profile[key] ?? "") !== "") process.env[variable] = profile[key];
  }
  return rest;
}

/**
 * Which profile a command resolves to, and WHERE that name came from — the same precedence
 * as `activeProfile`, exposed for `profile list --json` (source ∈ flag/env/config/builtin).
 */
export function resolveActiveProfile(flagValue?: string): { name: string; source: ProfileSource } {
  if (flagValue !== undefined) return { name: flagValue, source: "flag" };
  if (process.env.PMCP_PROFILE !== undefined) return { name: process.env.PMCP_PROFILE, source: "env" };
  const config = readConfig();
  if (config.profile !== undefined) return { name: config.profile, source: "config" };
  return { name: "default", source: "builtin" };
}

/** Known keys in their declared order, then everything else alphabetically. */
function ordered(keys: string[], known: string[]): string[] {
  const rank = (key: string): number => (known.indexOf(key) === -1 ? known.length : known.indexOf(key));
  return [...keys].sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : 1));
}

function isTable(value: unknown): value is Record<string, TomlValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Date);
}

/** Non-string TOML values (numbers, booleans, dates, arrays, inline tables) are stringified. */
function toStringValue(value: TomlValue): string {
  if (typeof value === "string") return value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
