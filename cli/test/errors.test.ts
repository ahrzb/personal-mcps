/**
 * cli/test/errors.test.ts — pins the frozen error contract (§10 "Errors", §8): the human
 * grammar parses by column-0 prefix alone (never line counts), the JSON form is one
 * `{"error":{...}}` document, `usage` is the sole exit-2 code, and `didYouMean` only ever
 * suggests something close enough to be worth showing.
 *
 * Project: `cli` — plain Node, parallel, pure. deps: none.
 */

import { describe, expect, it } from "vitest";
import { CliError, didYouMean, emitError } from "../src/errors";

/** A tiny stream double: emitError's whole contract with the outside world is `write`. */
function captureStream(): { write(text: string): void; text: string } {
  return {
    text: "",
    write(text: string) {
      this.text += text;
    },
  };
}

describe("CliError", () => {
  it("derives exitCode from code: usage is 2, every other code is 1", () => {
    expect(new CliError("usage", "bad argv").exitCode).toBe(2);
    for (const code of [
      "not_found",
      "invalid_arguments",
      "unauthenticated",
      "ambiguous_id",
      "approval_required",
      "remote_error",
      "login_timeout",
      "no_url",
    ] as const) {
      expect(new CliError(code, "x").exitCode).toBe(1);
    }
  });

  it("defaults hints/detail to empty arrays and leaves usage/extra undefined", () => {
    const err = new CliError("not_found", "no service \"x\"");
    expect(err.hints).toEqual([]);
    expect(err.detail).toEqual([]);
    expect(err.usage).toBeUndefined();
    expect(err.extra).toBeUndefined();
  });
});

/** Every line of the human grammar must start with one of these three column-0 prefixes,
 * or be indented (whitespace) detail attached to the line above (§8). */
function classify(line: string): "error" | "usage" | "hint" | "detail" {
  if (line.startsWith("error:")) return "error";
  if (line.startsWith("usage:")) return "usage";
  if (line.startsWith("hint:")) return "hint";
  if (/^\s/.test(line)) return "detail";
  throw new Error(`line parses as neither a column-0 prefix nor indented detail: ${JSON.stringify(line)}`);
}

describe("emitError · human grammar", () => {
  it("a bare error is exactly one `error: <code>: <message>` line", () => {
    const stream = captureStream();
    const code = emitError(new CliError("not_found", "no service \"mcptools\""), { json: false, stream });
    expect(code).toBe(1);
    expect(stream.text).toBe("error: not_found: no service \"mcptools\"\n");
  });

  it("every line parses by column-0 prefix or indentation alone — detail before usage before hints, in order", () => {
    const err = new CliError("invalid_arguments", "unknown argument \"ur\"", {
      usage: "pmcp call <service> <tool> [key=value … | --args '{…}']",
      hints: ["pmcp describe service/mcp-tools/paper_fetch"],
      detail: ["did you mean \"url\"?", "paper_fetch expects\n  url        string    required  paper URL or arXiv id"],
    });
    const stream = captureStream();
    emitError(err, { json: false, stream });
    const lines = stream.text.replace(/\n$/, "").split("\n");
    const kinds = lines.map(classify);
    expect(kinds[0]).toBe("error");
    expect(kinds.at(-2)).toBe("usage");
    expect(kinds.at(-1)).toBe("hint");
    expect(kinds.slice(1, -2).every((k) => k === "detail")).toBe(true);
    // A multi-line detail entry keeps its own relative indentation nested one level deeper.
    const nestedLine = lines.find((line) => line.includes("required"));
    expect(nestedLine!.startsWith("    ")).toBe(true);
  });

  it("multiple hints each get their own column-0 `hint:` line, in order", () => {
    const err = new CliError("usage", "missing ref", { hints: ["pmcp ls lists your services", "pmcp describe -h"] });
    const stream = captureStream();
    const code = emitError(err, { json: false, stream });
    expect(code).toBe(2);
    const hintLines = stream.text.trim().split("\n").filter((l) => l.startsWith("hint:"));
    expect(hintLines).toEqual(["hint: pmcp ls lists your services", "hint: pmcp describe -h"]);
  });

  it("a plain Error (not a CliError) becomes a bare remote_error line, never a stack trace", () => {
    const stream = captureStream();
    const code = emitError(new Error("ECONNREFUSED"), { json: false, stream });
    expect(code).toBe(1);
    expect(stream.text).toBe("error: remote_error: ECONNREFUSED\n");
    expect(stream.text).not.toContain("at ");
  });
});

describe("emitError · --json", () => {
  it("emits exactly one {\"error\":{...}} document, code+message always present", () => {
    const stream = captureStream();
    const code = emitError(new CliError("not_found", "no service \"mcptools\""), { json: true, stream });
    expect(code).toBe(1);
    const doc = JSON.parse(stream.text.trim());
    expect(doc).toEqual({ error: { code: "not_found", message: "no service \"mcptools\"" } });
  });

  it("hint is the FIRST of hints — detail never rides the JSON document", () => {
    const err = new CliError("not_found", "no service \"mcptools\"", {
      hints: ["pmcp ls lists your services", "second hint never appears"],
      detail: ["did you mean \"mcp-tools\"?"],
    });
    const stream = captureStream();
    emitError(err, { json: true, stream });
    const doc = JSON.parse(stream.text.trim());
    expect(doc.error.hint).toBe("pmcp ls lists your services");
    expect(doc.error).not.toHaveProperty("detail");
    expect(JSON.stringify(doc)).not.toContain("second hint");
  });

  it("didYouMean and expectedArguments ride from extra when present, absent otherwise", () => {
    const withExtra = new CliError("invalid_arguments", "unknown argument \"ur\"", {
      hints: ["pmcp describe service/mcp-tools/paper_fetch"],
      extra: { didYouMean: "url", expectedArguments: { type: "object", required: ["url"] } },
    });
    const stream = captureStream();
    emitError(withExtra, { json: true, stream });
    const doc = JSON.parse(stream.text.trim());
    expect(doc.error.didYouMean).toBe("url");
    expect(doc.error.expectedArguments).toEqual({ type: "object", required: ["url"] });

    const withoutExtra = new CliError("not_found", "no such thing");
    const stream2 = captureStream();
    emitError(withoutExtra, { json: true, stream: stream2 });
    const doc2 = JSON.parse(stream2.text.trim());
    expect(doc2.error).not.toHaveProperty("didYouMean");
    expect(doc2.error).not.toHaveProperty("expectedArguments");
  });

  it("writes exactly one line (one JSON document) regardless of how much detail the error carries", () => {
    const err = new CliError("invalid_arguments", "bad args", { detail: ["a", "b", "c"], hints: ["h1", "h2"] });
    const stream = captureStream();
    emitError(err, { json: true, stream });
    expect(stream.text.trim().split("\n")).toHaveLength(1);
  });
});

describe("didYouMean", () => {
  it("suggests the closest candidate within edit distance ≤2", () => {
    expect(didYouMean("mcptools", ["mcp-tools", "linear", "scratch"])).toBe("mcp-tools");
    expect(didYouMean("paper_fetc", ["paper_fetch", "duocards_query"])).toBe("paper_fetch");
    expect(didYouMean("ur", ["url", "format", "max_pages"])).toBe("url");
  });

  it("a candidate the input is a PREFIX of wins outright, at any edit distance — the mock's `describe service/mcp-tools/paper` suggests `paper_fetch` (distance 6), which the ≤2 rule alone could never reach", () => {
    const catalog = ["duocards_query", "duocards_schema", "jobfeed_crawl", "jobfeed_feed", "paper_fetch"];
    expect(didYouMean("paper", catalog)).toBe("paper_fetch");
    // The shortest of several prefix matches — the least the caller has to have typed wrong.
    expect(didYouMean("jobfeed", catalog)).toBe("jobfeed_feed");
    // Under three characters the prefix rule stays off, so a short typo keeps the distance
    // answer instead of matching whatever happens to start with those two letters.
    expect(didYouMean("ur", ["url", "urgent_flag_name"])).toBe("url");
    // An exact hit is not a suggestion — the caller typed the name, the failure is elsewhere.
    expect(didYouMean("paper_fetch", ["paper_fetch", "paper_fetch_v2"])).toBe("paper_fetch_v2");
  });

  it("returns undefined when nothing is close enough", () => {
    expect(didYouMean("completely_unrelated_name", ["url", "format"])).toBeUndefined();
    expect(didYouMean("x", [])).toBeUndefined();
  });

  it("picks the single closest candidate when several are within range", () => {
    expect(didYouMean("cat", ["cats", "car", "dog"])).toBe("cats");
  });
});
