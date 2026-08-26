/**
 * cli/test/toml.test.ts — the one check behind `toml.parseToml` / `toml.emitToml`, the
 * §10 config file's FORMAT. It exists for exactly the reason yaml.test.ts does: the repo
 * may add no dependency (§4), so the CLI carries a subset parser of its own — and a parser
 * with no test is a silent mis-read of the one file that holds every hub token this
 * machine has.
 *
 * Scope, deliberately narrow: text → the profile shape and back. WHICH profile is active,
 * and what its url/token then mean, is main.ts's and is pinned in config.test.ts; nothing
 * here resolves anything.
 *
 * Project: `cli` — plain Node, parallel, pure. deps: none.
 */

// deps: none · cli/src/toml.ts (parseToml, emitToml — a module with no imports, so this
//   suite's "deps: none" stays true) · vitest

import { describe, expect, it } from "vitest";
import { emitToml, parseToml } from "../src/toml";

/** Obviously fake, and shaped like the real thing so the hygiene case below has a target. */
const TOKEN = "pmcp_sa_FAKE0000000000000000000000000000";

/** §10's example file, verbatim from the spec — the format's only real specimen. */
const SPEC_EXAMPLE = `profile = "default"        # active when nothing else selects one

[profiles.default]
url = "https://hub.example"
token = "${TOKEN}"                # written by \`pmcp login\`, cleared by \`pmcp logout\`

[profiles.local]
url = "http://localhost:8787"
token = "${TOKEN}"
bootstrap_secret = "FAKE-secret"     # dev-only; hand-written, survives login/logout
`;

describe("parseToml · §10's config file format", () => {
  it("§10 · the whole vocabulary in one file: a top-level key, `[profiles.<name>]` tables, `#` comments both on their own line and trailing a value, blank lines and stray indentation", () => {
    const config = parseToml(SPEC_EXAMPLE);
    expect(config.profile).toBe("default");
    expect(Object.keys(config.profiles)).toEqual(["default", "local"]);
    expect(config.profiles.default).toEqual({ url: "https://hub.example", token: TOKEN });
    expect(config.profiles.local).toEqual({
      url: "http://localhost:8787",
      token: TOKEN,
      bootstrap_secret: "FAKE-secret",
    });
    // Comments and whitespace are not values, and an empty file is an empty config.
    const sparse = parseToml(["# just a comment", "", "   [profiles.local]   ", '   url = "http://x"   ', ""].join("\n"));
    expect(sparse).toEqual({ profiles: { local: { url: "http://x" } } });
    expect(parseToml("")).toEqual({ profiles: {} });
  });

  it("§10 · a `#` inside a quoted value belongs to the value: a token or a URL fragment is never truncated into half a credential", () => {
    const config = parseToml(['[profiles.default]', 'url = "https://hub.example/#/app"  # trailing', 'token = "aa#bb"'].join("\n"));
    expect(config.profiles.default).toEqual({ url: "https://hub.example/#/app", token: "aa#bb" });
  });

  it('§10 · quoted strings are the only values there are: a bare word, a number, or a bare `true` is a refusal rather than a guess', () => {
    for (const line of ["url = hub.example", "port = 8787", "archived = true", "url = 'single'"]) {
      expect(() => parseToml(`[profiles.default]\n${line}\n`)).toThrow(SyntaxError);
    }
  });

  it("§10 · a line the subset does not understand is refused by LINE NUMBER and by nothing else — the message never echoes the line, because every line of this file is a live credential", () => {
    const broken = ['profile = "default"', "", "[profiles.default]", `token = ${TOKEN}`, ""].join("\n");
    const thrown = (() => {
      try {
        parseToml(broken);
        return "";
      } catch (error) {
        return String(error instanceof Error ? error.message : error);
      }
    })();
    expect(thrown).toMatch(/line 4/);
    expect(thrown).not.toContain("FAKE");
    // A table this shape has no meaning for is named as such, not as a broken key.
    expect(() => parseToml("[server]\n")).toThrow(/line 1/);
  });
});

describe("emitToml · the file the CLI writes back", () => {
  it("§10 · emit is canonical: `profile` first, then one table per profile in a stable order with `url`, `token`, `bootstrap_secret` in that order — the file a human reads twice looks the same twice", () => {
    const text = emitToml({
      profiles: {
        local: { bootstrap_secret: "FAKE-secret", token: TOKEN, url: "http://localhost:8787" },
        default: { token: TOKEN, url: "https://hub.example" },
      },
      profile: "default",
    });
    expect(text).toBe(
      [
        'profile = "default"',
        "",
        "[profiles.default]",
        'url = "https://hub.example"',
        `token = "${TOKEN}"`,
        "",
        "[profiles.local]",
        'url = "http://localhost:8787"',
        `token = "${TOKEN}"`,
        'bootstrap_secret = "FAKE-secret"',
        "",
      ].join("\n"),
    );
  });

  it("§10 · a round trip keeps every key, the ones this subset knows nothing about included: a hand-written key beside `bootstrap_secret` survives the login that rewrites the file", () => {
    const original = parseToml(
      [
        'profile = "local"',
        'editor = "vim"',
        "",
        "[profiles.local]",
        'url = "http://localhost:8787"',
        'bootstrap_secret = "FAKE-secret"',
        'note = "the box under the desk"',
        "",
      ].join("\n"),
    );
    const again = parseToml(emitToml(original));
    expect(again).toEqual(original);
    expect(again.editor).toBe("vim");
    expect(again.profiles.local.note).toBe("the box under the desk");
    // Canonical means idempotent: emitting what was emitted changes nothing.
    expect(emitToml(again)).toBe(emitToml(original));
  });
});
