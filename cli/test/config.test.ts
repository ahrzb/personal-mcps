/**
 * cli/test/config.test.ts — where a hub identity COMES FROM: §10's profile precedence, and
 * the two writes main.ts makes to `~/.config/pmcp/config.toml`.
 *
 * The file is the CLI's only persistent state and the only place it keeps a credential, so
 * every rule about it is a rule about which hub a command reaches and whose token it
 * presents. The load-bearing ones, and the damage each prevents: precedence (a `--profile`
 * that lost to the file default would run a production command against a dev hub, or the
 * reverse), `login` writing ONE profile (a login that rewrote the whole file would drop the
 * hand-written `bootstrap_secret` beside it — §12's script reads that), `logout` clearing
 * ONE token (logging out of the laptop hub must not log the operator out of the box under
 * the desk), and the json migration (the old flat file must read as `default`, once).
 *
 * The seam is the real thing: real `main(argv)`, a stubbed global `fetch`, and
 * `node:os.homedir` mocked to a fresh temp directory per case — so every case here truly
 * reads and WRITES a config file, and none of them is the developer's own. Nothing about
 * the CLI itself is mocked; argv parsing, the device flow, and the whoami handshake all run.
 *
 * Not here: what each command DOES once resolved (commands.test.ts), and the file's format
 * (config-store.test.ts).
 *
 * Project: `cli` — plain Node, parallel. Every case owns its own HOME.
 */

// deps: cli/src/main.ts (main — the real dispatcher — and applyProfile, the `pnpm users`
//   bridge) · cli/src/config.ts (parseConfig, to read back what was written) · node:fs +
//   node:os (the temp HOME) · a stubbed global fetch · vitest

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * HOME is redirected by mocking `node:os.homedir` rather than by setting an env var: it is
 * the one thing that works the same on every platform, and `homedir()` is exactly what
 * main.ts calls. The holder is `vi.hoisted` because the factory is hoisted above it.
 */
const home = vi.hoisted(() => ({ dir: "" }));
vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  homedir: () => home.dir,
}));

import { applyProfile, main } from "../src/main";
import { parseConfig } from "../src/config";

/** Obviously fake, and never a `pmcp_svc_` value — main.ts refuses that kind outright. */
const TOKEN = "pmcp_sa_FAKE0000000000000000000000000000";
const DEVICE_TOKEN = "pmcp_sess_FAKE00000000000000000000000000";
const SECRET = "FAKE-bootstrap-secret";

/** Every request the stubbed hub saw, in order — the oracle for "which hub did it reach". */
let seen: { url: string; token: string | undefined }[] = [];
let configPath = "";

beforeEach(() => {
  seen = [];
  home.dir = mkdtempSync(join(tmpdir(), "pmcp-home-"));
  configPath = join(home.dir, ".config", "pmcp", "config.toml");
  // The developer's own environment must not decide any case here — and applyProfile writes
  // to process.env, so these stubs are also what keeps one case out of the next one.
  for (const name of ["PMCP_URL", "PMCP_TOKEN", "PMCP_PROFILE", "BOOTSTRAP_SECRET"]) {
    vi.stubEnv(name, undefined);
  }
  vi.spyOn(process.stdout, "write").mockReturnValue(true);
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
  vi.stubGlobal("fetch", async (url: string, init?: { headers?: Record<string, string> }) => {
    const target = String(url);
    seen.push({ url: target, token: init?.headers?.Authorization?.replace("Bearer ", "") });
    if (target.endsWith("/api/auth/device/code")) {
      // interval 0: the poll loop sleeps for exactly as long as this says.
      return json({ device_code: "dev_FAKE", user_code: "FAKE-CODE", interval: 0, expires_in: 600, verification_uri: "/device" });
    }
    if (target.endsWith("/api/auth/device/token")) return json({ access_token: DEVICE_TOKEN });
    return json({ principal: "user:owner", namespace: "owner" });
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  rmSync(home.dir, { recursive: true, force: true });
});

function json(body: unknown): { ok: boolean; status: number; json: () => Promise<unknown> } {
  return { ok: true, status: 200, json: async () => body };
}

function writeConfigFile(text: string): void {
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, text);
}

function readConfigFile(): ReturnType<typeof parseConfig> {
  return parseConfig(readFileSync(configPath, "utf8"));
}

/** The origin every request in this invocation went to — one per `pmcp whoami`. */
function origins(): string[] {
  return seen.map((request) => new URL(request.url).origin);
}

const FOUR_PROFILES = [
  'profile = "filed"',
  "",
  "[profiles.default]",
  'url = "https://named-default.invalid"',
  `token = "${TOKEN}"`,
  "",
  "[profiles.filed]",
  'url = "https://filed.invalid"',
  `token = "${TOKEN}"`,
  "",
  "[profiles.enved]",
  'url = "https://enved.invalid"',
  `token = "${TOKEN}"`,
  "",
  "[profiles.flagged]",
  'url = "https://flagged.invalid"',
  `token = "${TOKEN}"`,
  "",
].join("\n");

describe("§10 · which profile is active", () => {
  it("§10 · the precedence chain end to end: `--profile` beats PMCP_PROFILE beats the file's top-level `profile` key beats the name `default` — four hubs, and each invocation reaches exactly one of them", async () => {
    writeConfigFile(FOUR_PROFILES);

    expect(await main(["whoami"])).toBe(0);
    expect(origins()).toEqual(["https://filed.invalid"]);

    seen = [];
    vi.stubEnv("PMCP_PROFILE", "enved");
    expect(await main(["whoami"])).toBe(0);
    expect(origins()).toEqual(["https://enved.invalid"]);

    seen = [];
    expect(await main(["whoami", "--profile", "flagged"])).toBe(0);
    expect(origins()).toEqual(["https://flagged.invalid"]);

    // Nothing selects one: the neutral name `default`, never the first table in the file.
    seen = [];
    vi.stubEnv("PMCP_PROFILE", undefined);
    writeConfigFile(FOUR_PROFILES.replace('profile = "filed"\n', ""));
    expect(await main(["whoami"])).toBe(0);
    expect(origins()).toEqual(["https://named-default.invalid"]);
  });

  it("§10 · the environment stays flat and profile-free: PMCP_URL and PMCP_TOKEN override whatever the active profile resolved, so a one-off command against another hub needs no file at all", async () => {
    writeConfigFile(FOUR_PROFILES);
    vi.stubEnv("PMCP_URL", "https://override.invalid");
    vi.stubEnv("PMCP_TOKEN", "pmcp_sa_FAKE1111111111111111111111111111");
    expect(await main(["whoami"])).toBe(0);
    expect(seen).toEqual([
      { url: "https://override.invalid/api/whoami", token: "pmcp_sa_FAKE1111111111111111111111111111" },
    ]);
  });

  it("§10 · a profile that is logged out fails as not-logged-in and NAMES it, and a profile that does not exist fails before any request — a `--profile` typo never reaches a hub as somebody else", async () => {
    writeConfigFile([...FOUR_PROFILES.split("\n"), "[profiles.parked]", 'url = "https://parked.invalid"', ""].join("\n"));
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    expect(await main(["whoami", "--profile", "parked"])).toBe(1);
    expect(String(stderr.mock.calls[0]?.[0])).toContain("profile parked");

    // A name with no table has no url either, so it stops one message earlier — the point
    // is that it stops: no request is made with the previous profile's token.
    expect(await main(["whoami", "--profile", "typo"])).toBe(1);
    expect(seen).toEqual([]);
  });
});

describe("§10 · what `login` and `logout` write", () => {
  it("§10 · `login --profile local` writes url+token into that profile ALONE: the other profile keeps its token, the top-level default is untouched, and a hand-written `bootstrap_secret` survives the write", async () => {
    writeConfigFile(
      [
        'profile = "default"',
        "",
        "[profiles.default]",
        'url = "https://hub.invalid"',
        `token = "${TOKEN}"`,
        "",
        "[profiles.local]",
        `bootstrap_secret = "${SECRET}"`,
        "",
      ].join("\n"),
    );
    expect(await main(["login", "--profile", "local", "--url", "http://localhost:8787"])).toBe(0);

    const config = readConfigFile();
    expect(config.profiles.local).toEqual({
      url: "http://localhost:8787",
      token: DEVICE_TOKEN,
      bootstrap_secret: SECRET,
    });
    expect(config.profiles.default).toEqual({ url: "https://hub.invalid", token: TOKEN });
    // The default a user chose is theirs: logging into another profile never moves it.
    expect(config.profile).toBe("default");
    expect(origins()).toEqual(["http://localhost:8787", "http://localhost:8787", "http://localhost:8787"]);
  });

  it("§10 · the first-ever write also sets the top-level default — a machine with one profile should not need the flag twice — and the second login leaves that default alone", async () => {
    expect(await main(["login", "--profile", "local", "--url", "http://localhost:8787"])).toBe(0);
    expect(readConfigFile().profile).toBe("local");

    expect(await main(["login", "--profile", "work", "--url", "https://work.invalid"])).toBe(0);
    const config = readConfigFile();
    expect(config.profile).toBe("local");
    expect(Object.keys(config.profiles)).toEqual(["local", "work"]);
  });

  it("§10 · `logout` clears the active profile's token and only that one: the other hub stays logged in, and the hand-written `bootstrap_secret` beside the cleared token survives", async () => {
    writeConfigFile(
      [
        'profile = "default"',
        "",
        "[profiles.default]",
        'url = "https://hub.invalid"',
        `token = "${TOKEN}"`,
        "",
        "[profiles.local]",
        'url = "http://localhost:8787"',
        `token = "${TOKEN}"`,
        `bootstrap_secret = "${SECRET}"`,
        "",
      ].join("\n"),
    );
    expect(await main(["logout", "--profile", "local"])).toBe(0);

    const config = readConfigFile();
    expect(config.profiles.local).toEqual({ url: "http://localhost:8787", token: "", bootstrap_secret: SECRET });
    expect(config.profiles.default).toEqual({ url: "https://hub.invalid", token: TOKEN });
    // Best effort, but it is the local hub's session that was revoked.
    expect(origins()).toEqual(["http://localhost:8787"]);
  });

  it("§10 · `login --json` is the agent path: stdout carries the device document the instant the hub issues it, then the outcome document, and NOTHING else — the chatter that guides a human goes to stderr", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    expect(await main(["login", "--json", "--url", "http://localhost:8787"])).toBe(0);
    const documents = stdout.mock.calls
      .map((call) => String(call[0]))
      .join("")
      .split("\n")
      .filter((line) => line !== "");
    // Two lines, both parseable — a progress line on stdout would break every agent that
    // reads this stream with JSON.parse.
    expect(documents).toHaveLength(2);
    expect(JSON.parse(documents[0])).toEqual({
      verificationUri: "http://localhost:8787/device",
      userCode: "FAKE-CODE",
      expiresIn: 600,
    });
    expect(JSON.parse(documents[1])).toEqual({ principal: "user:owner", namespace: "owner", profile: "default" });
    // …and the token still landed in the file, exactly as the human path leaves it.
    expect(readConfigFile().profiles.default.token).toBe(DEVICE_TOKEN);
  });

  it("§10 · polling stops at the device code's own expiry — `login_timeout`, exit 1 — rather than waiting forever on a code the hub has already forgotten", async () => {
    vi.stubGlobal("fetch", async (url: string) => {
      const target = String(url);
      if (target.endsWith("/api/auth/device/code")) {
        // expires_in 0: the code is dead the moment it is issued.
        return json({ device_code: "dev_FAKE", user_code: "FAKE-CODE", interval: 0, expires_in: 0 });
      }
      return json({ error: "authorization_pending" });
    });
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    stderr.mockClear();
    expect(await main(["login", "--url", "http://localhost:8787"])).toBe(1);
    expect(stderr.mock.calls.map((call) => String(call[0])).join("")).toContain("error: login_timeout:");
    // Nothing was written: a timed-out login must not clear or half-write a profile.
    expect(existsSync(configPath)).toBe(false);
  });
});

describe("§10 · the flat config.json left over from before profiles", () => {
  it("§10 · an existing flat `config.json` reads as profile `default` and is superseded by the next write: the session survives the upgrade, config.toml appears, and the json is left behind untouched", async () => {
    const legacy = join(home.dir, ".config", "pmcp", "config.json");
    mkdirSync(dirname(legacy), { recursive: true });
    writeFileSync(legacy, `${JSON.stringify({ url: "https://old.invalid", token: TOKEN }, null, 2)}\n`);

    // Read once, in memory — the old file still resolves a command.
    expect(await main(["whoami"])).toBe(0);
    expect(seen).toEqual([{ url: "https://old.invalid/api/whoami", token: TOKEN }]);

    // …and the next write is the supersession.
    expect(await main(["logout"])).toBe(0);
    const config = readConfigFile();
    expect(config.profile).toBe("default");
    expect(config.profiles.default).toEqual({ url: "https://old.invalid", token: "" });
    expect(JSON.parse(readFileSync(legacy, "utf8"))).toEqual({ url: "https://old.invalid", token: TOKEN });
  });
});

/**
 * §10's `profile` family (2026-09-01) — the only commands besides `login`/`logout` that
 * write the file, and the only ones that never touch the network. They live in this file
 * rather than commands.test.ts for one reason: a profile write goes to `homedir()`, and
 * this is the suite that redirects it.
 */
describe("§10 · the profile family", () => {
  it("§10 · `profile add` writes the url ALONE and never destroys a credential: a second add with a different url warns about the stale token instead of clearing it, and nothing reaches the network", async () => {
    expect(await main(["profile", "add", "work", "--url", "https://work.invalid"])).toBe(0);
    expect(readConfigFile().profiles.work).toEqual({ url: "https://work.invalid" });

    // Give it a token the way `login` would, then move the url underneath it.
    writeConfigFile(["[profiles.work]", 'url = "https://work.invalid"', `token = "${TOKEN}"`, ""].join("\n"));
    expect(await main(["profile", "add", "work", "--url", "https://moved.invalid"])).toBe(0);
    expect(readConfigFile().profiles.work).toEqual({ url: "https://moved.invalid", token: TOKEN });
    expect(seen).toEqual([]);
  });

  it("§10 · `profile use` moves the top-level default, and `profile list --json` resolves the precedence chain — token presence as a boolean, never the value", async () => {
    writeConfigFile(FOUR_PROFILES);
    expect(await main(["profile", "use", "flagged"])).toBe(0);
    expect(readConfigFile().profile).toBe("flagged");

    // The shared beforeEach already spies this stream; re-spying returns that same mock,
    // so the `profile use` line above has to be cleared before the document is read back.
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    stdout.mockClear();
    expect(await main(["profile", "list", "--json"])).toBe(0);
    const doc = JSON.parse(stdout.mock.calls.map((call) => String(call[0])).join("")) as {
      active: string;
      activeSource: string;
      profiles: { name: string; url: string; token: boolean }[];
    };
    expect(doc.active).toBe("flagged");
    expect(doc.activeSource).toBe("config");
    expect(doc.profiles.map((entry) => entry.name)).toEqual(["default", "enved", "filed", "flagged"]);
    expect(doc.profiles.every((entry) => entry.token === true)).toBe(true);
    // The stored bearer never prints, in either rendering.
    expect(JSON.stringify(doc)).not.toContain(TOKEN);
    expect(seen).toEqual([]);
  });

  it("§10 · `profile remove` refuses the ACTIVE profile without --yes on a non-TTY, and removes a non-active one outright — the file's default is cleared with it", async () => {
    writeConfigFile(FOUR_PROFILES);
    // `filed` is the file's own default, so it is the active one here.
    expect(await main(["profile", "remove", "filed"])).toBe(1);
    expect(Object.keys(readConfigFile().profiles)).toContain("filed");

    expect(await main(["profile", "remove", "flagged"])).toBe(0);
    expect(Object.keys(readConfigFile().profiles)).not.toContain("flagged");

    expect(await main(["profile", "remove", "filed", "--yes"])).toBe(0);
    const config = readConfigFile();
    expect(Object.keys(config.profiles)).not.toContain("filed");
    expect(config.profile).toBeUndefined();
    expect(seen).toEqual([]);
  });

  it("§10 · a profile that does not exist is `not_found` (exit 1), not malformed argv", async () => {
    writeConfigFile(FOUR_PROFILES);
    expect(await main(["profile", "use", "typo"])).toBe(1);
    expect(await main(["profile", "remove", "typo"])).toBe(1);
  });
});

describe("§12 · the `pnpm users` bridge", () => {
  it("§12 · a leading `--profile <name>` is consumed before users.ts sees argv, and fills PMCP_URL and BOOTSTRAP_SECRET from that profile — the operator stops exporting two variables to talk to the dev box", () => {
    writeConfigFile(
      ["[profiles.local]", 'url = "http://localhost:8787"', `bootstrap_secret = "${SECRET}"`, ""].join("\n"),
    );
    expect(applyProfile(["--profile", "local", "create", "amir"])).toEqual(["create", "amir"]);
    expect(process.env.PMCP_URL).toBe("http://localhost:8787");
    expect(process.env.BOOTSTRAP_SECRET).toBe(SECRET);
  });

  it("§12 · the environment wins where it already spoke, and a machine with no config file is left exactly as it was — today's env-only invocation keeps working", () => {
    writeConfigFile(
      ["[profiles.default]", 'url = "http://localhost:8787"', `bootstrap_secret = "${SECRET}"`, ""].join("\n"),
    );
    vi.stubEnv("PMCP_URL", "https://exported.invalid");
    expect(applyProfile(["list"])).toEqual(["list"]);
    expect(process.env.PMCP_URL).toBe("https://exported.invalid");
    expect(process.env.BOOTSTRAP_SECRET).toBe(SECRET);

    rmSync(configPath);
    vi.stubEnv("BOOTSTRAP_SECRET", undefined);
    expect(applyProfile(["--profile", "local", "list"])).toEqual(["list"]);
    expect(process.env.BOOTSTRAP_SECRET).toBeUndefined();
  });
});
