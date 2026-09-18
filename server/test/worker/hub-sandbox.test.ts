// hub-sandbox.test.ts — §23.8–§23.11's execution state machine, driven with a fake
// container supervisor.
//
// The point of this suite is the CONTAINERLESS half of the contract: admission is a
// synchronous single-slot claim; the check runs before the program and a type error
// dispatches nothing; the counters and the nonce are enforced at the bridge before any
// dispatch; the deadline and the cancellation paths bound the process; the credential is
// reauthorized before publication and a refusal discards the run; and cleanup that cannot
// be proven replaces the container. What a fake CANNOT prove — the Deno permission model,
// the container network, remote kill, image compatibility — is §23.13's staging list, not
// this suite's.
//
// deps: hub-runtime (pure) · hub-backend (error classes) · hub-contract (result type)

import { describe, expect, it, vi } from "vitest";
import { HubCredentialRevokedError, HubExecutionAbortedError } from "../../src/hub-backend";
import {
  HUB_BRIDGE_NONCE_HEADER,
  HubContainerUnavailableError,
  HubExecutionCoordinator,
  type HubContainerProcess,
  type HubContainerSupervisor,
  type HubProcessOutput,
  type HubRunSnapshot,
} from "../../src/hub-runtime";
import type { JsonRpcResponse, ResourceDispatch, ToolDispatch } from "../../src/gateway";
import type { AuthenticatedCaller } from "../../src/identity";
import {
  HUB_CHECK_TIMEOUT_MS,
  HUB_INNER_OPERATION_TIMEOUT_MS,
  HUB_PRELAUNCH_RETRY_BACKOFF_MS,
} from "../../src/limits";

/** A one-service snapshot: one tool, one resource, no templates. */
function snapshot(): HubRunSnapshot {
  return {
    services: [
      {
        appId: "app-1",
        service: "news",
        typescriptName: "news",
        diagnostics: [],
        tools: [
          {
            canonicalName: "search",
            typescriptName: "search",
            inputType: null,
            inputDeclarations: [],
            inputRequired: false,
            outputType: "unknown",
            outputDeclarations: [],
            description: "search the news",
            signature: "search(input?: unknown): Promise<CallToolResult<unknown>>",
            declarationUri: "pmcp://hub/types/tools/news/search.d.ts",
            diagnostics: [],
          },
        ],
        resources: [
          {
            uri: "news://front",
            description: "the front page",
            signature: "read(): Promise<ReadResourceResult>",
            declarationUri: "pmcp://hub/types/resources/news/news%3A%2F%2Ffront.d.ts",
            diagnostics: [],
          },
        ],
        resourceTemplates: [],
      },
    ],
    diagnostics: [],
    truncated: false,
    overflow: null,
  };
}

/** A well-formed credential: 64 lowercase hex, as identity.ts mints the digest. */
function caller(): AuthenticatedCaller {
  return {
    principal: { kind: "agent", agentId: "agent-1", ownerId: "owner-1", slug: "agent" },
    credential: { sandboxKey: "a".repeat(64), reference: { kind: "agentToken", tokenId: "token-1", agentId: "agent-1" } },
  };
}

/** One scripted process: how it settles, what it printed, and what it does when killed. */
type ScriptedProcess = {
  readonly exitCode?: number;
  readonly timedOut?: boolean;
  readonly stdout?: string;
  readonly stderr?: string;
  /** `wait` stays pending until the test calls `release()` — how a still-running program
   *  is simulated while bridge requests are exercised against it. */
  readonly manual?: boolean;
  /** `wait` resolves when SIGTERM arrives — how an abort's kill is observed to work. */
  readonly settleOnKill?: boolean;
  /** Runs while output is observed; lets a deadline case consume time after a successful
   *  check without turning the check itself into an observation timeout. */
  readonly onOutput?: () => void;
};

/** A pending promise with its resolver, ES2022-style (the repo compiles against ES2022,
 *  whose lib predates `Promise.withResolvers`). */
function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

class FakeProcess implements HubContainerProcess {
  readonly pid = 4321;
  readonly killed: number[] = [];
  private readonly script: ScriptedProcess;
  private readonly releaseWait: (() => void) | null;
  private readonly waitPromise: Promise<{ exitCode: number; timedOut: boolean; failed: boolean }>;
  private resolveWait: ((exit: { exitCode: number; timedOut: boolean; failed: boolean }) => void) | null = null;

  constructor(script: ScriptedProcess) {
    this.script = script;
    if (script.manual === true) {
      const { promise, resolve } = deferred<{ exitCode: number; timedOut: boolean; failed: boolean }>();
      this.waitPromise = promise;
      this.releaseWait = () => resolve({ exitCode: script.exitCode ?? 0, timedOut: script.timedOut ?? false, failed: false });
    } else if (script.settleOnKill === true) {
      const { promise, resolve } = deferred<{ exitCode: number; timedOut: boolean; failed: boolean }>();
      this.waitPromise = promise;
      this.releaseWait = null;
      this.resolveWait = resolve;
    } else {
      this.waitPromise = Promise.resolve({ exitCode: script.exitCode ?? 0, timedOut: script.timedOut ?? false, failed: false });
      this.releaseWait = null;
    }
  }

  release(): void {
    this.releaseWait?.();
  }

  wait(): Promise<{ exitCode: number; timedOut: boolean; failed: boolean }> {
    return this.waitPromise;
  }

  async kill(signal: 15 | 9): Promise<void> {
    this.killed.push(signal);
    if (signal === 15) this.resolveWait?.({ exitCode: 0, timedOut: false, failed: false });
  }

  output(): Promise<HubProcessOutput> {
    this.script.onOutput?.();
    return Promise.resolve({
      stdout: this.script.stdout ?? "",
      stderr: this.script.stderr ?? "",
      stdoutTruncated: false,
      stderrTruncated: false,
    });
  }
}

class FakeSupervisor implements HubContainerSupervisor {
  files = new Map<string, string>();
  readonly spawns: { argv: readonly string[]; timeoutMs: number; env?: Record<string, string> }[] = [];
  readonly processes: FakeProcess[] = [];
  prepared = 0;
  removed = 0;
  destroyed = 0;
  /** How many `prepareRunDirectory` calls fail with a proven pre-launch error before one
   *  succeeds; `Number.POSITIVE_INFINITY` fails every call. */
  prepareFailures = 0;
  /** A non-availability supervisor defect thrown before launch. */
  prepareError: Error | null = null;
  /** Optional pending cleanup operations exercise the coordinator's deadline ownership. */
  removeResult: Promise<boolean> | null = null;
  destroyResult: Promise<void> | null = null;
  removeProven = true;
  /** What the parent would have written as the result envelope for the run. */
  envelope: string | null = null;
  /** Decides what the process for one spawn looks like; index 0 is the check, 1 the run. */
  scripts: ScriptedProcess[] = [];
  private readonly waiters: { count: number; resolve: () => void }[] = [];

  /** Resolves once at least `count` processes have been launched. */
  whenSpawned(count: number): Promise<void> {
    if (this.spawns.length >= count) return Promise.resolve();
    const { promise, resolve } = deferred<void>();
    this.waiters.push({ count, resolve });
    return promise;
  }

  prepareRunDirectory(): Promise<void> {
    this.prepared += 1;
    if (this.prepareError !== null) return Promise.reject(this.prepareError);
    if (this.prepareFailures > 0) {
      this.prepareFailures -= 1;
      return Promise.reject(new HubContainerUnavailableError());
    }
    this.files.clear();
    return Promise.resolve();
  }

  writeRunFile(name: string, content: string): Promise<void> {
    this.files.set(name, content);
    return Promise.resolve();
  }

  spawn(argv: readonly string[], options: { timeoutMs: number; env?: Record<string, string> }): Promise<HubContainerProcess> {
    this.spawns.push({ argv, timeoutMs: options.timeoutMs, env: options.env });
    if (argv.includes("run") && this.envelope !== null) this.files.set("result.json", this.envelope);
    const process = new FakeProcess(this.scripts[this.spawns.length - 1] ?? {});
    this.processes.push(process);
    for (const waiter of [...this.waiters]) {
      if (this.spawns.length >= waiter.count) {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        waiter.resolve();
      }
    }
    return Promise.resolve(process);
  }

  readRunFile(name: string): Promise<string | null> {
    return Promise.resolve(this.files.get(name) ?? null);
  }

  removeRunDirectory(): Promise<boolean> {
    this.removed += 1;
    return this.removeResult ?? Promise.resolve(this.removeProven);
  }

  destroyContainer(): Promise<void> {
    this.destroyed += 1;
    return this.destroyResult ?? Promise.resolve();
  }
}

type Harness = {
  readonly coordinator: HubExecutionCoordinator;
  readonly supervisor: FakeSupervisor;
  readonly calls: ToolDispatch[];
  readonly reads: ResourceDispatch[];
  readonly state: { reauthorized: boolean };
};

function harness(overrides: {
  reauthorized?: boolean;
  now?: () => number;
  retryBackoffMs?: number;
  abortGraceMs?: number;
  dispatchTool?: (input: ToolDispatch) => Promise<JsonRpcResponse>;
  waitUntil?: (work: Promise<unknown>) => void;
} = {}): Harness {
  const supervisor = new FakeSupervisor();
  const calls: ToolDispatch[] = [];
  const reads: ResourceDispatch[] = [];
  const state = { reauthorized: overrides.reauthorized ?? true };
  const coordinator = new HubExecutionCoordinator({
    supervisor,
    dispatchTool: overrides.dispatchTool ?? (async (input): Promise<JsonRpcResponse> => {
      calls.push(input);
      return { jsonrpc: "2.0", id: null, result: { content: [{ type: "text", text: "ok" }] } };
    }),
    dispatchResourceRead: async (input): Promise<JsonRpcResponse> => {
      reads.push(input);
      return { jsonrpc: "2.0", id: null, result: { contents: [{ uri: input.uri, text: "body" }] } };
    },
    reauthorize: () => Promise.resolve(state.reauthorized),
    waitUntil: overrides.waitUntil,
    now: overrides.now,
    prelaunchRetryBackoffMs: overrides.retryBackoffMs ?? 1,
    abortGraceMs: overrides.abortGraceMs ?? 1,
  });
  return { coordinator, supervisor, calls, reads, state };
}

function admitAt(coordinator: HubExecutionCoordinator, deadlineAt: number): string {
  const verdict = coordinator.admit({ caller: caller(), snapshot: snapshot(), code: "export default 1;", deadlineAt });
  if (!verdict.ok) throw new Error("admission refused");
  return verdict.generation;
}

function bridgeRequest(body: unknown, nonce: string, path = "/bridge/call"): Request {
  return new Request(`http://mcp.internal${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", [HUB_BRIDGE_NONCE_HEADER]: nonce },
    body: JSON.stringify(body),
  });
}

/** The nonce is generated inside `admit`; the fake learns it from the run process's
 *  environment, which is exactly where the trusted parent gets it. */
function runNonce(supervisor: FakeSupervisor): string {
  return supervisor.spawns.find((spawn) => spawn.env !== undefined)?.env?.PMCP_EXECUTION_ID ?? "";
}

describe("HubExecutionCoordinator admission", () => {
  it("admits one execution per token and refuses a concurrent second without launching", async () => {
    const { coordinator, supervisor } = harness();
    const first = admitAt(coordinator, Date.now() + 30_000);
    const second = coordinator.admit({ caller: caller(), snapshot: snapshot(), code: "export default 1;", deadlineAt: Date.now() + 30_000 });
    expect(second).toEqual({ ok: false, limit: "active_execution" });
    expect(supervisor.spawns).toHaveLength(0);
    supervisor.scripts = [{ exitCode: 0 }, { exitCode: 0 }];
    supervisor.envelope = '{"status":"completed","value":1}';
    await coordinator.run(first);
    const third = coordinator.admit({ caller: caller(), snapshot: snapshot(), code: "export default 1;", deadlineAt: Date.now() + 30_000 });
    expect(third.ok).toBe(true);
  });

  it("reclaims an expired admission when no run RPC ever claimed it", () => {
    let now = 1_000;
    const { coordinator } = harness({ now: () => now });
    admitAt(coordinator, 1_500);
    now = 1_600;
    const successor = coordinator.admit({
      caller: caller(),
      snapshot: snapshot(),
      code: "export default 1;",
      deadlineAt: 2_000,
    });
    expect(successor).toMatchObject({ ok: true, replacedStale: false });
  });

  it("keeps an expired started generation authoritative until it quiesces", async () => {
    let now = 1_000;
    const { coordinator, supervisor } = harness({ now: () => now });
    const first = admitAt(coordinator, 1_500);
    supervisor.scripts = [{ manual: true }];
    const running = coordinator.run(first);
    await supervisor.whenSpawned(1);
    now = 1_600;
    expect(coordinator.admit({
      caller: caller(),
      snapshot: snapshot(),
      code: "export default 1;",
      deadlineAt: 2_000,
    })).toEqual({ ok: false, limit: "active_execution" });
    supervisor.processes[0]?.release();
    await expect(running).rejects.toBeInstanceOf(HubCredentialRevokedError);
  });
});

describe("HubExecutionCoordinator run classification", () => {
  it("runs the bounded offline check before the program and publishes the parent's value", async () => {
    const { coordinator, supervisor } = harness();
    const generation = admitAt(coordinator, Date.now() + 30_000);
    supervisor.scripts = [{ exitCode: 0 }, { exitCode: 0, stdout: "hello" }];
    supervisor.envelope = '{"status":"completed","value":{"answer":42}}';
    const result = await coordinator.run(generation);
    expect(supervisor.spawns[0]?.argv).toContain("check");
    expect(supervisor.spawns[1]?.argv).toContain("run");
    expect(supervisor.spawns[0]?.argv).toContain("--frozen");
    expect(supervisor.spawns[1]?.argv).toContain("--unstable-worker-options");
    expect(supervisor.files.get("program.ts")).toBe("export default 1;");
    expect(supervisor.files.get("program.d.ts")).toContain("mcp");
    expect(result).toMatchObject({ kind: "completed", value: { answer: 42 }, stdout: "hello", operations: { calls: 0, reads: 0 } });
  });

  it("turns a failed check into type_error with source-free diagnostics and no launch", async () => {
    const { coordinator, supervisor } = harness();
    const generation = admitAt(coordinator, Date.now() + 30_000);
    supervisor.scripts = [
      {
        exitCode: 1,
        stderr: [
          "Check program.ts",
          "TS2322 [ERROR]: Type 'string' is not assignable to type 'number'.",
          'const x: number = "not a number";',
          "      ^",
          "    at file:///workspace/pmcp-exec/program.ts:1:7",
          "",
          "error: Type checking failed.",
        ].join("\n"),
      },
    ];
    const result = await coordinator.run(generation);
    expect(result.kind).toBe("type_error");
    if (result.kind !== "type_error") return;
    expect(result.diagnostics).toContain("TS2322 [ERROR]: Type 'string' is not assignable to type 'number'.");
    expect(result.diagnostics).toContain("  at program.ts:1:7");
    // The offending source line and its caret never leave the container.
    expect(result.diagnostics.join("\n")).not.toContain("not a number");
    expect(result.diagnostics.join("\n")).not.toContain("^");
    expect(result.transient).toBe(false);
    expect(result.mayHaveRun).toBe(false);
    expect(supervisor.spawns).toHaveLength(1);
  });

  it("classifies a check budget expiry as non-transient check_time", async () => {
    const { coordinator, supervisor } = harness();
    const generation = admitAt(coordinator, Date.now() + 30_000);
    supervisor.scripts = [{ timedOut: true }];
    const result = await coordinator.run(generation);
    expect(result).toEqual({ kind: "limit_exceeded", limit: "check_time", observed: 5_000, transient: false, mayHaveRun: false });
  });

  it("maps a local check observation deadline to check_time instead of sandbox_error", async () => {
    vi.useFakeTimers();
    try {
      const { coordinator, supervisor } = harness();
      const generation = admitAt(coordinator, Date.now() + 30_000);
      supervisor.scripts = [{ manual: true }];
      const running = coordinator.run(generation);
      await supervisor.whenSpawned(1);
      await vi.advanceTimersByTimeAsync(HUB_CHECK_TIMEOUT_MS);
      expect(await running).toMatchObject({
        kind: "limit_exceeded",
        limit: "check_time",
        transient: false,
        mayHaveRun: false,
      });
      supervisor.processes[0]?.release();
    } finally {
      vi.useRealTimers();
    }
  });

  it("classifies a budget consumed after checking but before evaluation as transient cold_start", async () => {
    let now = 1_000;
    const { coordinator, supervisor } = harness({ now: () => now });
    const generation = admitAt(coordinator, 2_000);
    supervisor.scripts = [{ onOutput: () => { now = 1_500; } }];
    const result = await coordinator.run(generation);
    expect(result).toEqual({
      kind: "limit_exceeded",
      limit: "cold_start",
      observed: 0,
      transient: true,
      mayHaveRun: false,
    });
    expect(supervisor.spawns).toHaveLength(1);
  });

  it("classifies a remote process timeout after evaluation as non-transient wall_clock", async () => {
    const { coordinator, supervisor } = harness();
    const generation = admitAt(coordinator, Date.now() + 30_000);
    supervisor.scripts = [{ exitCode: 0 }, { timedOut: true, stdout: "partial" }];
    const result = await coordinator.run(generation);
    expect(result).toMatchObject({ kind: "limit_exceeded", limit: "wall_clock", transient: false, mayHaveRun: false });
    if (result.kind === "limit_exceeded") expect(result.observed).toBeGreaterThan(0);
  });

  it("maps a local evaluation deadline to wall_clock instead of sandbox_error", async () => {
    vi.useFakeTimers();
    try {
      const { coordinator, supervisor } = harness();
      const generation = admitAt(coordinator, Date.now() + 1_000);
      supervisor.scripts = [{ exitCode: 0 }, { manual: true }];
      const running = coordinator.run(generation);
      await supervisor.whenSpawned(2);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await running).toMatchObject({
        kind: "limit_exceeded",
        limit: "wall_clock",
        transient: false,
        mayHaveRun: false,
      });
      supervisor.processes[1]?.release();
    } finally {
      vi.useRealTimers();
    }
  });

  it("withholds a timeout result when final credential reauthorization refuses it", async () => {
    vi.useFakeTimers();
    try {
      const { coordinator, supervisor } = harness({ reauthorized: false });
      const generation = admitAt(coordinator, Date.now() + 1_000);
      supervisor.scripts = [{ exitCode: 0 }, { manual: true }];
      const running = coordinator.run(generation);
      const refused = expect(running).rejects.toBeInstanceOf(HubCredentialRevokedError);
      await vi.advanceTimersByTimeAsync(1_000);
      await refused;
      supervisor.processes[1]?.release();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports a missing envelope as a runtime_error that may have run, never as a value", async () => {
    const { coordinator, supervisor } = harness();
    const generation = admitAt(coordinator, Date.now() + 30_000);
    supervisor.scripts = [{ exitCode: 0 }, { exitCode: 0, stdout: "printed", stderr: "warned" }];
    supervisor.envelope = null;
    const result = await coordinator.run(generation);
    expect(result).toMatchObject({
      kind: "runtime_error",
      cause: "no_result",
      stdout: "printed",
      stderr: "warned",
      transient: false,
      mayHaveRun: false,
      containerReplaced: false,
    });
  });

  it("classifies a parent-reported program error by its sanitized class", async () => {
    const { coordinator, supervisor } = harness();
    const generation = admitAt(coordinator, Date.now() + 30_000);
    supervisor.scripts = [{ exitCode: 0 }, { exitCode: 0 }];
    supervisor.envelope = '{"status":"error","error":{"name":"TypeError"}}';
    const result = await coordinator.run(generation);
    expect(result).toMatchObject({ kind: "runtime_error", cause: "program_error:TypeError" });
  });

  it("classifies an uncaught inner limit as limit_exceeded with the parent's observed value", async () => {
    const { coordinator, supervisor } = harness();
    const generation = admitAt(coordinator, Date.now() + 30_000);
    supervisor.scripts = [{ exitCode: 0 }, { exitCode: 0 }];
    supervisor.envelope = '{"status":"error","error":{"name":"HubOperationError"},"limit":{"name":"inner_operations","observed":33}}';
    const result = await coordinator.run(generation);
    expect(result).toEqual({ kind: "limit_exceeded", limit: "inner_operations", observed: 33, transient: false, mayHaveRun: false });
  });

  it("retries one proven pre-launch unavailability and refuses cold_start when it persists", async () => {
    const retried = harness();
    retried.supervisor.prepareFailures = 1;
    retried.supervisor.scripts = [{ exitCode: 0 }, { exitCode: 0 }];
    retried.supervisor.envelope = '{"status":"completed","value":1}';
    const generation = admitAt(retried.coordinator, Date.now() + 30_000);
    const result = await retried.coordinator.run(generation);
    expect(retried.supervisor.prepared).toBe(2);
    expect(result.kind).toBe("completed");

    const refused = harness();
    refused.supervisor.prepareFailures = Number.POSITIVE_INFINITY;
    const refusedGeneration = admitAt(refused.coordinator, Date.now() + 30_000);
    const refusedResult = await refused.coordinator.run(refusedGeneration);
    expect(refusedResult).toMatchObject({ kind: "limit_exceeded", limit: "cold_start", transient: true, mayHaveRun: false });
    expect(refused.supervisor.prepared).toBe(2);
  });

  it("withholds a pre-launch cold_start result when final reauthorization refuses it", async () => {
    const { coordinator, supervisor } = harness({ reauthorized: false });
    supervisor.prepareFailures = Number.POSITIVE_INFINITY;
    const generation = admitAt(coordinator, Date.now() + 30_000);
    await expect(coordinator.run(generation)).rejects.toBeInstanceOf(HubCredentialRevokedError);
  });

  it("turns an unexpected supervisor exception into a sanitized runtime result", async () => {
    const { coordinator, supervisor } = harness();
    supervisor.prepareError = new Error("sdk included a secret here");
    const generation = admitAt(coordinator, Date.now() + 30_000);
    const result = await coordinator.run(generation);
    expect(result).toMatchObject({
      kind: "runtime_error",
      cause: "sandbox_error",
      stdout: "",
      stderr: "",
      transient: false,
      mayHaveRun: false,
    });
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("does not let uncertain cleanup outlive the execution deadline", async () => {
    const lifetimes: Promise<unknown>[] = [];
    const { coordinator, supervisor } = harness({
      waitUntil: (work) => lifetimes.push(work),
    });
    supervisor.scripts = [{ exitCode: 0 }, { exitCode: 0 }];
    supervisor.envelope = '{"status":"completed","value":1}';
    const removal = deferred<boolean>();
    const destruction = deferred<void>();
    supervisor.removeResult = removal.promise;
    supervisor.destroyResult = destruction.promise;
    // This case deliberately exercises the real local deadline race; fake time would not
    // settle the promise race that is the behavior under test.
    const startedAt = Date.now();
    const generation = admitAt(coordinator, startedAt + 50);
    const result = await coordinator.run(generation);
    expect(result).toMatchObject({ kind: "completed", value: 1 });
    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(supervisor.destroyed).toBe(1);
    expect(lifetimes).toHaveLength(1);
    let quiesced = false;
    void lifetimes[0]?.then(() => { quiesced = true; });
    await Promise.resolve();
    expect(quiesced).toBe(false);
    expect(coordinator.admit({
      caller: caller(),
      snapshot: snapshot(),
      code: "export default 1;",
      deadlineAt: Date.now() + 30_000,
    })).toEqual({ ok: false, limit: "active_execution" });
    removal.resolve(false);
    destruction.resolve();
    await lifetimes[0];
    expect(quiesced).toBe(true);
    expect(coordinator.admit({
      caller: caller(),
      snapshot: snapshot(),
      code: "export default 1;",
      deadlineAt: Date.now() + 30_000,
    })).toMatchObject({ ok: true });
  });

  it("withholds the whole value when the credential is revoked before publication", async () => {
    const { coordinator, supervisor } = harness({ reauthorized: false });
    const generation = admitAt(coordinator, Date.now() + 30_000);
    supervisor.scripts = [{ exitCode: 0 }, { exitCode: 0 }];
    supervisor.envelope = '{"status":"completed","value":"secret"}';
    await expect(coordinator.run(generation)).rejects.toBeInstanceOf(HubCredentialRevokedError);
  });

  it("destroys the container when the run directory cannot be proven deleted", async () => {
    const { coordinator, supervisor } = harness();
    supervisor.removeProven = false;
    const generation = admitAt(coordinator, Date.now() + 30_000);
    supervisor.scripts = [{ exitCode: 0 }, { exitCode: 0 }];
    supervisor.envelope = '{"status":"error","error":{"name":"Error"}}';
    const result = await coordinator.run(generation);
    expect(supervisor.destroyed).toBe(1);
    expect(result).toMatchObject({ kind: "runtime_error", containerReplaced: true });
  });
});

describe("HubExecutionCoordinator cancellation", () => {
  it("kills the running process group and discards the result", async () => {
    const { coordinator, supervisor } = harness();
    const generation = admitAt(coordinator, Date.now() + 30_000);
    supervisor.scripts = [{ exitCode: 0 }, { settleOnKill: true }];
    supervisor.envelope = '{"status":"completed","value":"too late"}';
    const running = coordinator.run(generation);
    await supervisor.whenSpawned(2);
    const cancel = coordinator.cancel(generation);
    await expect(running).rejects.toBeInstanceOf(HubExecutionAbortedError);
    await cancel;
    expect(supervisor.processes[1]?.killed).toContain(15);
    expect(supervisor.destroyed).toBe(1);
  });

  it("ignores a cancel for a generation that is no longer active", async () => {
    const { coordinator, supervisor } = harness();
    const generation = admitAt(coordinator, Date.now() + 30_000);
    supervisor.scripts = [{ exitCode: 0 }, { exitCode: 0 }];
    supervisor.envelope = '{"status":"completed","value":1}';
    await coordinator.run(generation);
    await coordinator.cancel(generation);
    expect(supervisor.processes[1]?.killed).toEqual([]);
  });
});

describe("HubExecutionCoordinator bridge", () => {
  it("dispatches a canonical call through the seam with the pinned app id and inner deadline", async () => {
    const { coordinator, supervisor, calls } = harness();
    const generation = admitAt(coordinator, Date.now() + 30_000);
    supervisor.scripts = [{ exitCode: 0 }, { manual: true }];
    supervisor.envelope = '{"status":"completed","value":1}';
    const running = coordinator.run(generation);
    await supervisor.whenSpawned(2);
    const response = await coordinator.bridge(bridgeRequest({ service: "news", appId: "app-1", tool: "search", args: { q: "x" } }, runNonce(supervisor)));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, result: { content: [{ type: "text", text: "ok" }] } });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ slug: "news", tool: "search", expectAppId: "app-1", reauthorizeCredential: true });
    expect(calls[0]?.deadlineAt).toBeGreaterThan(Date.now() - 1_000);
    supervisor.processes[1]?.release();
    const result = await running;
    expect(result).toMatchObject({ kind: "completed", operations: { calls: 1, reads: 0 } });
  });

  it("refuses a wrong nonce, an unknown path, and a forged canonical target", async () => {
    const { coordinator, supervisor, calls } = harness();
    const generation = admitAt(coordinator, Date.now() + 30_000);
    supervisor.scripts = [{ exitCode: 0 }, { manual: true }];
    supervisor.envelope = '{"status":"completed","value":1}';
    const running = coordinator.run(generation);
    await supervisor.whenSpawned(2);
    const nonce = runNonce(supervisor);
    const forged = await coordinator.bridge(bridgeRequest({ service: "news", appId: "app-1", tool: "search" }, "wrong-nonce"));
    expect(forged.status).toBe(403);
    const wrongPath = await coordinator.bridge(bridgeRequest({ service: "news", appId: "app-1", tool: "search" }, nonce, "/bridge/other"));
    expect(wrongPath.status).toBe(404);
    const unknownService = await coordinator.bridge(bridgeRequest({ service: "hidden", appId: "app-1", tool: "search" }, nonce));
    expect(await unknownService.json()).toEqual({ ok: false, error: { code: -32001, message: "tool not permitted" } });
    const unknownTool = await coordinator.bridge(bridgeRequest({ service: "news", appId: "app-1", tool: "delete" }, nonce));
    expect(await unknownTool.json()).toEqual({ ok: false, error: { code: -32001, message: "tool not permitted" } });
    const movedApp = await coordinator.bridge(bridgeRequest({ service: "news", appId: "app-2", tool: "search" }, nonce));
    expect(await movedApp.json()).toEqual({ ok: false, error: { code: -32001, message: "tool not permitted" } });
    expect(calls).toHaveLength(0);
    supervisor.processes[1]?.release();
    await running;
  });

  it("reads a raw URI through the resource seam without rewriting it", async () => {
    const { coordinator, supervisor, reads } = harness();
    const generation = admitAt(coordinator, Date.now() + 30_000);
    supervisor.scripts = [{ exitCode: 0 }, { manual: true }];
    supervisor.envelope = '{"status":"completed","value":1}';
    const running = coordinator.run(generation);
    await supervisor.whenSpawned(2);
    const response = await coordinator.bridge(bridgeRequest({ service: "news", appId: "app-1", uri: "news://front?x=1" }, runNonce(supervisor), "/bridge/read"));
    expect(response.status).toBe(200);
    expect(reads[0]).toMatchObject({ slug: "news", uri: "news://front?x=1", expectAppId: "app-1", reauthorizeCredential: true });
    supervisor.processes[1]?.release();
    const result = await running;
    expect(result).toMatchObject({ kind: "completed", operations: { calls: 0, reads: 1 } });
  });

  it("refuses the thirty-third operation as a non-transient inner_operations limit", async () => {
    const { coordinator, supervisor } = harness();
    const generation = admitAt(coordinator, Date.now() + 30_000);
    supervisor.scripts = [{ exitCode: 0 }, { manual: true }];
    supervisor.envelope = '{"status":"completed","value":1}';
    const running = coordinator.run(generation);
    await supervisor.whenSpawned(2);
    const nonce = runNonce(supervisor);
    for (let at = 0; at < 32; at += 1) {
      const response = await coordinator.bridge(bridgeRequest({ service: "news", appId: "app-1", tool: "search" }, nonce));
      expect(response.status).toBe(200);
    }
    const overflow = await coordinator.bridge(bridgeRequest({ service: "news", appId: "app-1", tool: "search" }, nonce));
    expect(await overflow.json()).toMatchObject({
      ok: false,
      error: { code: -32000 },
      limit: { name: "inner_operations", observed: 32, transient: false },
    });
    supervisor.processes[1]?.release();
    await running;
  });

  it("charges refused dispatches to the operation cap and marks their uncertainty", async () => {
    const { coordinator, supervisor } = harness({
      dispatchTool: async (): Promise<JsonRpcResponse> => ({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32002, message: "app unavailable" },
      }),
    });
    const generation = admitAt(coordinator, Date.now() + 30_000);
    supervisor.scripts = [{ exitCode: 0 }, { manual: true }];
    supervisor.envelope = '{"status":"completed","value":1}';
    const running = coordinator.run(generation);
    await supervisor.whenSpawned(2);
    const nonce = runNonce(supervisor);
    for (let at = 0; at < 32; at += 1) {
      const refused = await coordinator.bridge(
        bridgeRequest({ service: "news", appId: "app-1", tool: "search" }, nonce),
      );
      expect(await refused.json()).toMatchObject({ ok: false, error: { code: -32002 } });
    }
    const overflow = await coordinator.bridge(
      bridgeRequest({ service: "news", appId: "app-1", tool: "search" }, nonce),
    );
    expect(await overflow.json()).toMatchObject({
      limit: { name: "inner_operations", observed: 32, mayHaveRun: true },
    });
    supervisor.processes[1]?.release();
    const result = await running;
    expect(result).toMatchObject({ kind: "completed", operations: { calls: 32, reads: 0 } });
  });

  it("holds an inner-concurrency slot until the actual dispatcher promise settles", async () => {
    vi.useFakeTimers();
    try {
      const pending: Array<ReturnType<typeof deferred<JsonRpcResponse>>> = [];
      const { coordinator, supervisor } = harness({
        dispatchTool: (): Promise<JsonRpcResponse> => {
          const operation = deferred<JsonRpcResponse>();
          pending.push(operation);
          return operation.promise;
        },
      });
      const generation = admitAt(coordinator, Date.now() + 30_000);
      supervisor.scripts = [{ exitCode: 0 }, { manual: true }];
      supervisor.envelope = '{"status":"completed","value":1}';
      const running = coordinator.run(generation);
      await supervisor.whenSpawned(2);
      const nonce = runNonce(supervisor);
      const timedOut = Array.from({ length: 4 }, () =>
        coordinator.bridge(
          bridgeRequest({ service: "news", appId: "app-1", tool: "search" }, nonce),
        ));
      await vi.advanceTimersByTimeAsync(HUB_INNER_OPERATION_TIMEOUT_MS);
      const timedOutResponses = await Promise.all(timedOut);
      for (const response of timedOutResponses) {
        expect(await response.json()).toMatchObject({
          ok: false,
          error: {
            code: -32000,
            message: "app unavailable: the call may have executed",
          },
        });
      }

      const refused = await coordinator.bridge(
        bridgeRequest({ service: "news", appId: "app-1", tool: "search" }, nonce),
      );
      expect(await refused.json()).toMatchObject({
        limit: { name: "inner_concurrency", observed: 4, mayHaveRun: true },
      });

      pending[0]?.resolve({ jsonrpc: "2.0", id: null, result: {} });
      await Promise.resolve();
      const admitted = coordinator.bridge(
        bridgeRequest({ service: "news", appId: "app-1", tool: "search" }, nonce),
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(pending).toHaveLength(5);
      for (const operation of pending) {
        operation.resolve({ jsonrpc: "2.0", id: null, result: {} });
      }
      expect(await (await admitted).json()).toMatchObject({ ok: true });
      supervisor.processes[1]?.release();
      vi.useRealTimers();
      await running;
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses bridge traffic at the reserved work boundary without converting it to abort", async () => {
    let now = 1_000;
    const { coordinator, supervisor } = harness({ now: () => now });
    const generation = admitAt(coordinator, 5_000);
    supervisor.scripts = [{ exitCode: 0 }, { manual: true }];
    supervisor.envelope = '{"status":"completed","value":1}';
    const running = coordinator.run(generation);
    await supervisor.whenSpawned(2);
    const nonce = runNonce(supervisor);
    now = 4_500;
    const refused = await coordinator.bridge(
      bridgeRequest({ service: "news", appId: "app-1", tool: "search" }, nonce),
    );
    expect(refused.status).toBe(503);
    supervisor.processes[1]?.release();
    await expect(running).resolves.toMatchObject({
      kind: "limit_exceeded",
      limit: "wall_clock",
      mayHaveRun: false,
    });
  });
});

describe("HubExecutionCoordinator defaults", () => {
  it("keeps the pre-launch backoff short and bounded", () => {
    expect(HUB_PRELAUNCH_RETRY_BACKOFF_MS).toBeGreaterThan(0);
    expect(HUB_PRELAUNCH_RETRY_BACKOFF_MS).toBeLessThanOrEqual(1_000);
  });
});
