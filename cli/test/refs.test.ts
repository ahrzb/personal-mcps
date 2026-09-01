/**
 * cli/test/refs.test.ts — §10's ref grammar, the one piece of argv shared by `describe`
 * and `get`.
 *
 * A ref is a path whose FIRST segment names the kind of thing (`app/`, `agent/`,
 * `prompt/`, `resource/`), and splitting stops after the SECOND slash. That second rule is
 * the whole reason this file exists: a resource is addressed by a URI, and a URI has
 * slashes of its own (`resource/notes/file:///todo.md`). A splitter that kept going —
 * `ref.split("/")` — would hand `resources/read` the string `file:` and address nothing,
 * silently, with a well-formed frame the hub would answer about a resource that does not
 * exist. §20.2 pins that the URI reaches `params.uri` verbatim; this file pins that the
 * ref parser is not what breaks it.
 *
 * The second half is the vocabulary check: an unknown first segment is a LOCAL `usage`
 * error carrying the corrected spelling (mock §5), never a network call — `pmcp get
 * prompts/…` (the retired listing spelling) is the mistake a user who learned the old
 * grammar makes first.
 *
 * Not here: what `describe`/`get` DO with a parsed ref (commands.test.ts), and the error
 * grammar itself (errors.test.ts).
 *
 * Project: `cli` — plain Node, parallel.
 */

// deps: cli/src/main.ts (parseRef — the parser under test — and main, for the end-to-end
//   URI case) · cli/src/errors.ts (CliError, to read the code off a refusal) · a stubbed
//   global fetch · vitest

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CliError } from "../src/errors";
import { main, parseRef } from "../src/main";

const TOKEN = "pmcp_agt_FAKE0000000000000000000000000000";
const ORIGIN = "https://hub.invalid";
const NAMESPACE = "owner";

/** A URI with something in every component a careless splitter would touch. */
const URI = "news://feed/tech?q=a b&limit=5";

describe("§10 · a ref splits on its first two slashes and no further", () => {
  it("§10 · `app/<slug>` and `app/<slug>/<item>` are the two app forms", () => {
    expect(parseRef("app/mcp-tools", ["app", "agent"], "describe")).toEqual({
      kind: "app",
      slug: "mcp-tools",
    });
    expect(parseRef("app/mcp-tools/paper_fetch", ["app", "agent"], "describe")).toEqual({
      kind: "app",
      slug: "mcp-tools",
      item: "paper_fetch",
    });
    expect(parseRef("agent/ci", ["app", "agent"], "describe")).toEqual({ kind: "agent", slug: "ci" });
  });

  it("§10/§20.2 · an item that is itself a URI keeps every slash it carries — the split stops after the second one, so `resource/notes/file:///todo.md` names the file and not `file:`", () => {
    expect(parseRef("resource/notes/file:///todo.md", ["prompt", "resource"], "get")).toEqual({
      kind: "resource",
      slug: "notes",
      item: "file:///todo.md",
    });
    expect(parseRef(`resource/docs/${URI}`, ["prompt", "resource"], "get")).toEqual({
      kind: "resource",
      slug: "docs",
      item: URI,
    });
  });

  it("§10 · the first segment names the KIND, so a ref that is only a kind, or only a slug, is a usage error rather than a guess", () => {
    for (const ref of ["app", "app/", "mcp-tools"]) {
      let thrown: unknown;
      try {
        parseRef(ref, ["app", "agent"], "describe");
      } catch (error) {
        thrown = error;
      }
      expect(thrown, ref).toBeInstanceOf(CliError);
      // Malformed argv is exit 2 (§10); a well-formed ref naming a nonexistent thing is 1.
      expect((thrown as CliError).exitCode, ref).toBe(2);
      expect((thrown as CliError).code, ref).toBe("usage");
    }
  });

  it("§10 · an unknown kind names the valid vocabulary and suggests the corrected command — `get prompts/…` is the mistake the retired listing spelling teaches, and it costs no network call", () => {
    let thrown: unknown;
    try {
      parseRef("prompts/mcp-tools/daily-digest", ["prompt", "resource"], "get");
    } catch (error) {
      thrown = error;
    }
    const error = thrown as CliError;
    expect(error.code).toBe("usage");
    expect(error.message).toBe('unknown ref type "prompts" (valid: prompt, resource)');
    expect(error.hints).toEqual(["pmcp get prompt/mcp-tools/daily-digest"]);
    expect(error.extra?.didYouMean).toBe("prompt");
  });

  it("§10 · a kind that resembles nothing valid still refuses, without inventing a suggestion", () => {
    let thrown: unknown;
    try {
      parseRef("widget/mcp-tools", ["app", "agent"], "describe");
    } catch (error) {
      thrown = error;
    }
    expect((thrown as CliError).extra?.didYouMean).toBeUndefined();
  });
});

describe("§20.2 · the parsed ref reaches the wire intact", () => {
  let frames: { path: string; method: string; params: Record<string, unknown> }[] = [];

  beforeEach(() => {
    frames = [];
    vi.stubEnv("PMCP_URL", ORIGIN);
    vi.stubEnv("PMCP_TOKEN", TOKEN);
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    vi.stubGlobal("fetch", async (url: string, init?: { body?: string }) => {
      if (String(url).endsWith("/api/whoami")) {
        return json({ principal: `user:${NAMESPACE}`, namespace: NAMESPACE });
      }
      const message = JSON.parse(init?.body ?? "{}") as { method?: string; params?: Record<string, unknown> };
      frames.push({ path: new URL(String(url)).pathname, method: String(message.method), params: message.params ?? {} });
      return json({ jsonrpc: "2.0", id: 1, result: {} });
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function json(body: unknown): { ok: boolean; status: number; json: () => Promise<unknown> } {
    return { ok: true, status: 200, json: async () => body };
  }

  it("§20.2 · `pmcp get resource/<slug>/<uri>` reads on the SLUG's endpoint with the URI verbatim — never percent-encoded, never routed by the URI's own scheme", async () => {
    expect(await main(["get", `resource/docs/${URI}`])).toBe(0);
    expect(frames).toEqual([{ path: `/${NAMESPACE}/mcp/docs`, method: "resources/read", params: { uri: URI } }]);
  });

  it("§10 · `pmcp get prompt/<slug>/<name> key=value` sends the arguments where prompts/get declares them", async () => {
    expect(await main(["get", "prompt/news/digest", "topic=tech"])).toBe(0);
    expect(frames).toEqual([
      {
        path: `/${NAMESPACE}/mcp/news`,
        method: "prompts/get",
        params: { name: "digest", arguments: { topic: "tech" } },
      },
    ]);
  });

  it("§10 · a ref whose kind is wrong never reaches the wire: exit 2, no frame", async () => {
    expect(await main(["get", "prompts/news/digest"])).toBe(2);
    expect(frames).toEqual([]);
  });
});
