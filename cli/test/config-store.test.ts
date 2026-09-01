/**
 * cli/test/config-store.test.ts — pins cli/src/config.ts: the smol-toml wrapper contract
 * (parse-error redaction, unknown-key round trip, non-string coercion), the legacy-json
 * fallback, the 0600 write, profile precedence, and `resolveActiveProfile`'s `source`.
 *
 * Not here: what `main.ts` DOES with a resolved context (config.test.ts, unchanged) — this
 * file exercises config.ts directly, with no argv layer and no fetch stub.
 *
 * Project: `cli` — plain Node, parallel. Every case owns its own HOME, mocked the same way
 * config.test.ts does: `node:os.homedir` redirected to a fresh temp directory, because that
 * is what configPath() actually calls, on every platform.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const home = vi.hoisted(() => ({ dir: "" }));
vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  homedir: () => home.dir,
}));

/** Captures the `mode` writeConfig passes, since a real filesystem's mode bits are not
 * reliably readable back on every platform (Windows in particular). */
const writes = vi.hoisted(() => ({ calls: [] as unknown[][] }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    writeFileSync: (...args: unknown[]) => {
      writes.calls.push(args);
      return (actual.writeFileSync as (...a: unknown[]) => void)(...args);
    },
  };
});

import {
  activeProfile,
  applyProfile,
  configPath,
  emitConfig,
  legacyConfigPath,
  parseConfig,
  profileOf,
  readConfig,
  resolveActiveProfile,
  writeConfig,
} from "../src/config";

beforeEach(() => {
  home.dir = mkdtempSync(join(tmpdir(), "pmcp-config-"));
  for (const name of ["PMCP_URL", "PMCP_TOKEN", "PMCP_PROFILE", "BOOTSTRAP_SECRET"]) vi.stubEnv(name, undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home.dir, { recursive: true, force: true });
});

describe("parseConfig / emitConfig — the smol-toml wrapper", () => {
  it("wraps a smol-toml parse error down to a bare line number, and the offending line's own text (a live credential) never appears in the message", () => {
    const credential = "pmcp_sa_SUPER-SECRET-VALUE-000000000000";
    const text = `profile = "default"\ntoken == "${credential}"\n`;
    let caught: unknown;
    try {
      parseConfig(text);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe("config: line 2 is not valid TOML");
    expect((caught as Error).message).not.toContain(credential);
  });

  it("round-trips an unknown top-level key and an unknown per-profile key unchanged", () => {
    const text = ['profile = "default"', 'bootstrap_secret = "top-level-secret"', "", "[profiles.default]", 'url = "https://hub.invalid"', 'weird_key = "keepme"', ""].join("\n");
    const config = parseConfig(text);
    expect(config.bootstrap_secret).toBe("top-level-secret");
    expect(config.profiles.default.weird_key).toBe("keepme");

    const roundTripped = parseConfig(emitConfig(config));
    expect(roundTripped.bootstrap_secret).toBe("top-level-secret");
    expect(roundTripped.profiles.default).toEqual({ url: "https://hub.invalid", weird_key: "keepme" });
  });

  it("stringifies a non-string TOML value rather than rejecting it", () => {
    const config = parseConfig(['[profiles.default]', "count = 5", "enabled = true", ""].join("\n"));
    expect(config.profiles.default).toEqual({ count: "5", enabled: "true" });
  });
});

describe("configPath / legacyConfigPath", () => {
  it("point at ~/.config/pmcp/config.toml and config.json under the (mocked) home directory", () => {
    expect(configPath()).toBe(join(home.dir, ".config", "pmcp", "config.toml"));
    expect(legacyConfigPath()).toBe(join(home.dir, ".config", "pmcp", "config.json"));
  });
});

describe("readConfig", () => {
  it("returns an empty profile set when neither file exists", () => {
    expect(readConfig()).toEqual({ profiles: {} });
  });

  it("reads config.toml when present, ignoring any legacy json beside it", () => {
    writeFileSync(mkParentAnd(configPath()), '[profiles.default]\nurl = "https://toml.invalid"\n');
    writeFileSync(mkParentAnd(legacyConfigPath()), JSON.stringify({ url: "https://json.invalid" }));
    expect(readConfig().profiles.default).toEqual({ url: "https://toml.invalid" });
  });

  it("upgrades a legacy flat config.json to profile `default`", () => {
    writeFileSync(mkParentAnd(legacyConfigPath()), JSON.stringify({ url: "https://old.invalid", token: "tok" }));
    expect(readConfig()).toEqual({ profile: "default", profiles: { default: { url: "https://old.invalid", token: "tok" } } });
  });

  it("falls back to an empty profile set when the legacy json is unparseable", () => {
    writeFileSync(mkParentAnd(legacyConfigPath()), "not json");
    expect(readConfig()).toEqual({ profiles: {} });
  });

  it("propagates a malformed config.toml's line-numbered error rather than swallowing it", () => {
    writeFileSync(mkParentAnd(configPath()), "not toml ===\n");
    expect(() => readConfig()).toThrow("config: line 1 is not valid TOML");
  });
});

describe("writeConfig", () => {
  it("creates the directory, and the content reads back via parseConfig", () => {
    writeConfig({ profile: "default", profiles: { default: { url: "https://hub.invalid", token: "tok" } } });
    expect(existsSync(configPath())).toBe(true);
    expect(parseConfig(readFileSync(configPath(), "utf8"))).toEqual({
      profile: "default",
      profiles: { default: { url: "https://hub.invalid", token: "tok" } },
    });
  });

  it("passes { mode: 0o600 } to the underlying write — the file holds a live session bearer", () => {
    writes.calls.length = 0;
    writeConfig({ profiles: {} });
    expect(writes.calls[0]?.[2]).toEqual({ mode: 0o600 });
  });
});

describe("activeProfile / profileOf", () => {
  it("prefers the flag, then PMCP_PROFILE, then the file's own `profile`, then `default`", () => {
    const config = { profile: "filed", profiles: {} };
    expect(activeProfile(config, "flagged")).toBe("flagged");
    vi.stubEnv("PMCP_PROFILE", "enved");
    expect(activeProfile(config)).toBe("enved");
    vi.stubEnv("PMCP_PROFILE", undefined);
    expect(activeProfile(config)).toBe("filed");
    expect(activeProfile({ profiles: {} })).toBe("default");
  });

  it("returns {} for a name with no table", () => {
    expect(profileOf({ profiles: {} }, "missing")).toEqual({});
  });
});

describe("resolveActiveProfile", () => {
  it("names the source at each precedence rung: flag, env, config, builtin", () => {
    writeConfig({ profile: "filed", profiles: {} });
    expect(resolveActiveProfile("flagged")).toEqual({ name: "flagged", source: "flag" });

    vi.stubEnv("PMCP_PROFILE", "enved");
    expect(resolveActiveProfile()).toEqual({ name: "enved", source: "env" });
    vi.stubEnv("PMCP_PROFILE", undefined);

    expect(resolveActiveProfile()).toEqual({ name: "filed", source: "config" });

    writeConfig({ profiles: {} });
    expect(resolveActiveProfile()).toEqual({ name: "default", source: "builtin" });
  });
});

describe("applyProfile — the `pnpm users` bridge", () => {
  it("consumes a leading --profile flag and fills PMCP_URL/BOOTSTRAP_SECRET from that profile where the environment is unset", () => {
    writeFileSync(mkParentAnd(configPath()), ["[profiles.local]", 'url = "http://localhost:8787"', 'bootstrap_secret = "SECRET"', ""].join("\n"));
    expect(applyProfile(["--profile", "local", "create", "amir"])).toEqual(["create", "amir"]);
    expect(process.env.PMCP_URL).toBe("http://localhost:8787");
    expect(process.env.BOOTSTRAP_SECRET).toBe("SECRET");
  });

  it("leaves an already-set environment variable alone and passes argv through unchanged with no --profile flag", () => {
    writeFileSync(mkParentAnd(configPath()), ["[profiles.default]", 'url = "http://localhost:8787"', ""].join("\n"));
    vi.stubEnv("PMCP_URL", "https://exported.invalid");
    expect(applyProfile(["list"])).toEqual(["list"]);
    expect(process.env.PMCP_URL).toBe("https://exported.invalid");
  });
});

function mkParentAnd(path: string): string {
  mkdirSync(dirname(path), { recursive: true });
  return path;
}
