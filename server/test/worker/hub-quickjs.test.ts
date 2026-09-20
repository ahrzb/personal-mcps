// hub-quickjs.test.ts — §23.8–§23.11's real workerd/Wasm proof.
//
// These cases execute the pinned QuickJS artifact, not a fake interpreter. They pin the
// properties whose failure would cross the trust boundary: async host promises resume guest
// code, callable targets come from the catalog closure, contexts do not share globals, and
// the interrupt handler stops non-yielding source at the admitted deadline.
//
// deps: hub-quickjs (real Wasm) · hub-catalog (real snapshot builder) · gateway dispatch
// types only. No D1 row, tunnel, container, network, or product log is involved.

import { describe, expect, it, vi } from "vitest";
import type { HubExecutionRequest } from "../../src/hub-backend";
import { buildCatalogSnapshot } from "../../src/hub-catalog";
import { createHubQuickJsExecutor } from "../../src/hub-quickjs";
import type { JsonRpcResponse, ResourceDispatch, ToolDispatch } from "../../src/gateway";

const snapshot = buildCatalogSnapshot({
  services: [
    {
      appId: "app-1",
      service: "canonical-service",
      typescriptName: "demo",
      kind: "proxy",
      tools: [
        {
          canonicalName: "canonical-add",
          typescriptName: "add",
          inputSchema: {
            type: "object",
            properties: { left: { type: "number" }, right: { type: "number" } },
            required: ["left", "right"],
            additionalProperties: false,
          },
          outputSchema: {
            type: "object",
            properties: { answer: { type: "number" } },
            required: ["answer"],
          },
        },
      ],
      resources: [{ uri: "memory://note", description: "A note" }],
      resourceTemplates: [],
    },
  ],
});

/** Builds one already-admitted request. The exact credential is fake but structurally real;
 * executor tests inject reauthorization and never ask identity.ts to read it. */
function request(code: string, timeoutMs = 2_000): HubExecutionRequest {
  const startedAt = Date.now();
  return {
    caller: {
      principal: { kind: "user", userId: "user-1", username: "owner" },
      credential: {
        reference: { kind: "session", sessionId: "session-1", userId: "user-1", expiresAt: "2999-01-01T00:00:00.000Z" },
      },
    },
    ownerId: "user-1",
    code,
    timeoutMs,
    deadlineAt: startedAt + timeoutMs,
    settings: { defaultTimeoutMs: 30_000, maxTimeoutMs: 30_000 },
    snapshot,
    lifecycle: { signal: new AbortController().signal },
  };
}

/** A successful JSON-RPC response with no consumer id; host operations are internal calls. */
function answer(value: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id: null, result: value };
}

/** An executor whose tool adds two numbers and whose resource returns one text block. */
function harness(now?: () => number) {
  const toolCalls: ToolDispatch[] = [];
  const resourceReads: ResourceDispatch[] = [];
  const reauthorize = vi.fn(async () => true);
  const executor = createHubQuickJsExecutor({
    dispatchTool: async (input) => {
      toolCalls.push(input);
      const left = Number(input.args?.left);
      const right = Number(input.args?.right);
      return answer({
        content: [{ type: "text", text: String(left + right) }],
        structuredContent: { answer: left + right },
      });
    },
    dispatchResourceRead: async (input) => {
      resourceReads.push(input);
      return answer({ contents: [{ uri: input.uri, text: "hello" }] });
    },
    reauthorize,
    ...(now === undefined ? {} : { now }),
  });
  return { executor, toolCalls, resourceReads, reauthorize };
}

describe("QuickJS hub execution", () => {
  it("resumes async host calls with canonical targets and frozen schemas", async () => {
    const { executor, toolCalls, resourceReads, reauthorize } = harness();
    const result = await executor(request(`
      const sum = await mcp.demo.add({ left: 20, right: 22 });
      const note = await mcp.demo.resources.read("memory://note");
      const answer = sum.structuredContent!;
      const schema = mcp.demo.add.inputSchema as { type: string };
      console.log("answer", answer.answer);
      return {
        answer: answer.answer,
        note: note.contents[0].text,
        schemaType: schema.type,
        frozen: Object.isFrozen(mcp) && Object.isFrozen(mcp.demo.add.inputSchema),
      };
    `));

    expect(result).toEqual({
      kind: "completed",
      value: { answer: 42, note: "hello", schemaType: "object", frozen: true },
      stdout: "answer 42\n",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      operations: { calls: 1, reads: 1 },
    });
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]).toMatchObject({
      slug: "canonical-service",
      tool: "canonical-add",
      args: { left: 20, right: 22 },
      expectAppId: "app-1",
      reauthorizeCredential: true,
    });
    expect(resourceReads[0]).toMatchObject({
      slug: "canonical-service",
      uri: "memory://note",
      expectAppId: "app-1",
      reauthorizeCredential: true,
    });
    expect(reauthorize).toHaveBeenCalledOnce();
  });

  it("creates a fresh guest global for every execution", async () => {
    const { executor } = harness();
    const first = await executor(request("(globalThis as Record<string, unknown>).leaked = 1; return typeof (globalThis as Record<string, unknown>).fetch;"));
    const second = await executor(request("return typeof (globalThis as Record<string, unknown>).leaked;"));

    expect(first).toMatchObject({ kind: "completed", value: "undefined" });
    expect(second).toMatchObject({ kind: "completed", value: "undefined" });
  });

  it("removes dynamic source compilers before guest code runs", async () => {
    const { executor } = harness();
    const result = await executor(request(`
      return {
        eval: typeof eval,
        Function: typeof Function,
        functionConstructor: typeof (() => {}).constructor,
        asyncFunctionConstructor: typeof Object.getPrototypeOf(async function () {}).constructor,
      };
    `));

    expect(result).toMatchObject({
      kind: "completed",
      value: {
        eval: "undefined",
        Function: "undefined",
        functionConstructor: "undefined",
        asyncFunctionConstructor: "undefined",
      },
    });
  });

  it("interrupts non-yielding source at the admitted wall clock", async () => {
    const { executor } = harness();
    const result = await executor(request("for (;;) {}", 100));

    expect(result).toMatchObject({
      kind: "limit_exceeded",
      limit: "wall_clock",
      transient: false,
      mayHaveRun: false,
    });
  });

  it("interrupts CPU-bound source when the Workers wall clock is frozen", async () => {
    const frozenNow = Date.now();
    const { executor } = harness(() => frozenNow);
    const result = await executor(request("for (;;) {}", 2_000));

    expect(result).toMatchObject({
      kind: "limit_exceeded",
      limit: "cpu",
      observed: 10_000,
      transient: false,
      mayHaveRun: false,
    });
  });

  it("classifies QuickJS heap exhaustion without leaking or aborting the runtime", async () => {
    const { executor } = harness();
    const result = await executor(request(`return "x".repeat(20_000_000);`));

    expect(result).toMatchObject({
      kind: "limit_exceeded",
      limit: "memory",
      observed: 16_777_216,
      transient: false,
      mayHaveRun: false,
    });
  });

  it("classifies QuickJS stack exhaustion", async () => {
    const { executor } = harness();
    const result = await executor(request(`
      function recurse() { return recurse(); }
      return recurse();
    `));

    expect(result).toMatchObject({
      kind: "limit_exceeded",
      limit: "stack",
      observed: 65_536,
      transient: false,
      mayHaveRun: false,
    });
  });

  it("rejects schema-invalid tool input before dispatch with an actionable path", async () => {
    const { executor, toolCalls } = harness();
    const result = await executor(request(`
      const input = JSON.parse('{"left":"20","right":22}');
      return await mcp.demo.add(input);
    `));

    expect(result).toMatchObject({
      kind: "runtime_error",
      cause: "program_error:HubOperationError",
      message: expect.stringContaining("input.left"),
      transient: false,
      mayHaveRun: false,
    });
    expect(toolCalls).toHaveLength(0);
  });

  it("reports TypeScript errors before evaluating the program", async () => {
    const { executor, toolCalls } = harness();
    const result = await executor(request(`return await mcp.demo.add({ left: "20", right: 22 });`));

    expect(result).toMatchObject({
      kind: "type_error",
      diagnostics: [
        expect.objectContaining({
          code: 2322,
          message: expect.stringContaining("not assignable to type 'number'"),
          line: 1,
        }),
      ],
      transient: false,
      mayHaveRun: false,
    });
    expect(toolCalls).toHaveLength(0);
  });

  it("shortens unknown-tool diagnostics while preserving TypeScript's suggestion", async () => {
    const { executor, toolCalls } = harness();
    const result = await executor(request(`return await mcp.demo.adds({ left: 20, right: 22 });`));

    expect(result).toMatchObject({
      kind: "type_error",
      diagnostics: [
        expect.objectContaining({
          code: 2551,
          message: 'unknown tool "adds" on mcp.demo; did you mean "add"?',
          line: 1,
        }),
      ],
      transient: false,
      mayHaveRun: false,
    });
    expect(JSON.stringify(result).length).toBeLessThan(300);
    expect(toolCalls).toHaveLength(0);
  });

  it("reports uncaught exception messages and source locations", async () => {
    const { executor } = harness();
    const result = await executor(request(`throw new Error("boom");`));

    expect(result).toMatchObject({
      kind: "runtime_error",
      cause: "program_error:Error",
      message: "boom",
      stack: expect.stringContaining("program.ts"),
      transient: false,
      mayHaveRun: false,
    });
  });

  it("sanitizes non-Error guest rejections", async () => {
    const { executor } = harness();
    const result = await executor(request("throw null;"));

    expect(result).toMatchObject({
      kind: "runtime_error",
      cause: "program_error:Error",
      transient: false,
      mayHaveRun: false,
    });
  });

  it("reports syntax diagnostics without echoing source", async () => {
    const { executor } = harness();
    const result = await executor(request("return (;"));

    expect(result).toMatchObject({
      kind: "type_error",
      diagnostics: [
        expect.objectContaining({
          category: "error",
          message: expect.any(String),
          line: 1,
          column: expect.any(Number),
        }),
      ],
      transient: false,
      mayHaveRun: false,
    });
    expect(JSON.stringify(result)).not.toContain("return (");
  });
});
