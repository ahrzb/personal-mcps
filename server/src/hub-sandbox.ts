// hub-sandbox.ts — §23.8/§23.9's platform layer: the HubSandbox Durable Object, the
// `mcp.internal` outbound bridge, and the worker-side executor the composition root
// installs into hub-backend.
//
// THE THREE PIECES AND WHY THEY ARE ONE MODULE:
//
// - `HubSandbox` is a `Sandbox` (the SDK's container-controlling DO) whose id IS the
//   exact-token digest — the DO key and the container are the same single-tenant boundary,
//   which is why two tokens never share a container and a warm container is reused only by
//   the token that created it. Its RPC surface is `admit`/`run`/`cancel`/`bridgeFetch`,
//   thin forwards to one `HubExecutionCoordinator` (hub-runtime.ts) whose container access
//   is the `SandboxSupervisor` below.
// - `SandboxSupervisor` is the ONLY translation between the coordinator's six-method
//   adapter and the SDK: bounded container start, argv exec with a mandatory remote
//   timeout, bounded reads, and the destroy path for uncertain state. The coordinator
//   itself never sees an SDK type, which is what keeps it fakeable in a worker test.
// - `hubBridgeOutbound` is the static `mcp.internal` handler. It trusts exactly one fact —
//   the platform-authored `ctx.containerId` — converts it through
//   `env.HUB_SANDBOX.idFromString`, and RPCs THAT DO. Nothing in the request can name a
//   sandbox, a principal, a credential, or a method; the DO re-checks all of it.
//
// The container's egress is `enableInternet = false` plus one static host handler, so
// `mcp.internal` is the only host the container can reach and it reaches it through the
// bridge above. No SDK failure text, source, nonce, or credential is ever logged here:
// failures are classified, and the classification is the only thing that leaves.
//
// HAND-WRITTEN TYPES: `Env` is the composition root's (index.ts) and every binding stays
// `unknown` there by convention, so the HUB_SANDBOX binding is narrowed exactly once, in
// `hubSandboxBinding`, to the two members this module calls.

import { ContainerProxy, ContainerUnavailableError, Sandbox } from "@cloudflare/sandbox";
import type { ProcessLogEvent } from "@cloudflare/sandbox";
import { env } from "cloudflare:workers";
import { dispatchResourceRead, dispatchTool, reauthorizeCaller } from "./gateway";
import type { Env } from "./index";
import { HubCredentialRevokedError, HubExecutionAbortedError } from "./hub-backend";
import type { HubExecutor, HubExecutionRequest } from "./hub-backend";
import type { HubExecutionResult } from "./hub-contract";
import {
  HUB_BRIDGE_HOST,
  HUB_IMAGE_DIRECTORY,
  HUB_RUN_DIRECTORY,
  HUB_RUN_FILE,
  HUB_RUNNER_FILE,
  HubContainerUnavailableError,
  HubExecutionCoordinator,
  type HubAdmission,
  type HubAdmissionVerdict,
  type HubContainerProcess,
  type HubContainerSupervisor,
  type HubProcessOutput,
  type HubRunSnapshot,
} from "./hub-runtime";
import { HUB_INNER_OPERATION_TIMEOUT_MS, HUB_STDERR_MAX_BYTES, HUB_STDOUT_MAX_BYTES } from "./limits";
import { truncateUtf8 } from "./hub-types";

/**
 * §23.8 — the container's idle window: longer than the 300 s hard execution ceiling plus
 * cleanup margin, so a maximum-length run can never be slept mid-flight by the idle policy
 * alone. A fixed bound was chosen over a heartbeat: warmth costs residency, a heartbeat
 * costs a lifecycle, and only the former can fail harmlessly.
 */
export const HUB_SANDBOX_SLEEP_AFTER = "6m";

/** The Sandbox control server's port (the SDK's `defaultPort`), waited on at start. */
export const HUB_SANDBOX_CONTROL_PORT = 3000;

/** §23.8 — the only three files the image bakes for the run; copied into each fresh run
 *  directory so a run is self-contained and the parent's single read grant covers it. */
const HUB_IMAGE_RUNTIME_FILES = [HUB_RUNNER_FILE, "worker.ts", "deno.json"] as const;

/** The token digest's shape. It is the namespace NAME passed to `idFromName`; only the
 *  platform-authored container id ever goes through `idFromString`. A key that is not 64
 *  lowercase hex characters is an internal identity defect, never a caller error. */
const SANDBOX_KEY_SHAPE = /^[0-9a-f]{64}$/;

/** A Durable Object RPC cannot preserve JavaScript error prototypes, so the DO returns one
 *  closed signal union and the Worker-side adapter reconstructs local error classes. */
type HubSandboxRunAnswer =
  | { readonly kind: "result"; readonly result: HubExecutionResult }
  | { readonly kind: "credential_revoked" }
  | { readonly kind: "aborted" };

/** The HUB_SANDBOX binding as this module calls it: an id resolved from the token digest,
 *  and the stub whose methods are HubSandbox's own RPC surface. */
type HubSandboxStub = {
  admit(input: HubAdmission): Promise<HubAdmissionVerdict>;
  run(generation: string): Promise<HubSandboxRunAnswer>;
  cancel(generation: string): Promise<void>;
  bridgeFetch(request: Request): Promise<Response>;
};

/** The DO-side process descriptor `Sandbox.exec` resolves to: identity plus the capability
 *  that carries the status/logs/kill RPC surface. The SDK does not export this descriptor
 *  from its public entry, so the used members are named structurally here. */
type SandboxProcessDescriptor = {
  readonly id: string;
  readonly pid: number;
  readonly capability: {
    openLogs(options?: { since?: string; replay?: boolean; follow?: boolean }): Promise<{
      next(): Promise<{ readonly done: boolean; readonly value?: ProcessLogEvent }>;
      cancel(): Promise<void>;
    }>;
    kill(signal: number): Promise<void>;
  };
};

/**
 * §23.8 — the container-supervising Durable Object. One instance per exact-token digest;
 * it owns one coordinator, so the token's single execution slot, its generation nonce, its
 * counters and its admitted deadline all live in exactly one place. The class is exported
 * from the composition root (wrangler resolves DO classes against the entry module) and
 * `ContainerProxy` is re-exported beside it, which is what lets the platform route
 * intercepted container egress into this script.
 */
export class HubSandbox extends Sandbox<Env> {
  /** The SDK's control port; waiting on it is what `prepareRunDirectory` bounds. */
  override defaultPort = HUB_SANDBOX_CONTROL_PORT;
  /** §23.8's six-minute idle window. */
  override sleepAfter = HUB_SANDBOX_SLEEP_AFTER;
  /** §23.9 — no public internet, ever; `mcp.internal` is reached through the static
   *  outbound handler below, which routes to THIS DO and nowhere else. */
  override enableInternet = false;

  private readonly coordinator: HubExecutionCoordinator;
  /** The constructor's env, kept because the SDK's base class does not declare one and the
   *  dispatch seams must run against this DO's own bindings. */
  private readonly bindingEnv: Env;

  constructor(ctx: DurableObjectStateLike, env: Env) {
    super(ctx, env);
    this.bindingEnv = env;
    this.coordinator = new HubExecutionCoordinator({
      supervisor: new SandboxSupervisor(this),
      // The dispatch seams run in this isolate against this DO's own env, so a bridge
      // operation crosses the same checks a direct scoped call crosses.
      dispatchTool: (input) => dispatchTool(this.bindingEnv, input),
      dispatchResourceRead: (input) => dispatchResourceRead(this.bindingEnv, input),
      reauthorize: (caller) => reauthorizeCaller(caller),
      waitUntil: (work) => ctx.waitUntil(work),
    });
  }

  /** §23.8 — claims the token's execution slot. A prior generation retains the slot until
   *  its cleanup and any late SDK operation have actually quiesced. */
  async admit(input: HubAdmission): Promise<HubAdmissionVerdict> {
    return this.coordinator.admit(input);
  }

  /** §23.8/§23.11 — runs the admitted generation to one bounded result. Signals that must
   *  retain their class across the RPC boundary are returned as closed tags. */
  async run(generation: string): Promise<HubSandboxRunAnswer> {
    try {
      return { kind: "result", result: await this.coordinator.run(generation) };
    } catch (thrown) {
      if (thrown instanceof HubCredentialRevokedError) return { kind: "credential_revoked" };
      if (thrown instanceof HubExecutionAbortedError) return { kind: "aborted" };
      throw thrown;
    }
  }

  /** §23.11 — aborts the named generation (disconnect or deadline): kill, escalate,
   *  discard. Registered by the caller with `waitUntil` so the cleanup outlives the
   *  response when the runtime offers a background lifetime. */
  async cancel(generation: string): Promise<void> {
    await this.coordinator.cancel(generation);
  }

  /** §23.9 — the bridge entry: the ContainerProxy handler RPCs exactly this method on the
   *  DO the platform's container id resolved to, and nothing else may call it. */
  async bridgeFetch(request: Request): Promise<Response> {
    return await this.coordinator.bridge(request);
  }
}

/** §23.9 — the static `mcp.internal` outbound handler. It resolves the DO from the
 *  platform-authored container id (never from the request) and hands the request to that
 *  DO's `bridgeFetch`; the request itself carries only the nonce header and a bounded
 *  body, both re-validated there. */
async function hubBridgeOutbound(request: Request, workerEnv: Env, ctx: { containerId: string }): Promise<Response> {
  const binding = hubSandboxBinding(workerEnv);
  return await binding.get(binding.idFromString(ctx.containerId)).bridgeFetch(request);
}

// §23.9 — registered as the class's static host map: the container's only allowed egress
// is intercepted per-host and routed here, without promoting the instance to catch-all
// interception (which would make every other host a proxy decision instead of a network
// failure).
HubSandbox.outboundByHost = { [HUB_BRIDGE_HOST]: hubBridgeOutbound };

/**
 * §23.8 — the coordinator's view of the SDK. Every method translates an SDK failure into
 * exactly one of two verdicts: `HubContainerUnavailableError` when the failure is PROVEN
 * pre-launch (the SDK's own "container not ready; work did not start" class), or the
 * original error when it is not — the coordinator retries only the first and never replays
 * the second.
 */
class SandboxSupervisor implements HubContainerSupervisor {
  private readonly sandbox: HubSandbox;

  constructor(sandbox: HubSandbox) {
    this.sandbox = sandbox;
  }

  async prepareRunDirectory(deadlineAt: number): Promise<void> {
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) throw new HubContainerUnavailableError();
    try {
      await this.sandbox.startAndWaitForPorts({
        ports: [HUB_SANDBOX_CONTROL_PORT],
        cancellationOptions: { abort: AbortSignal.timeout(remaining), portReadyTimeoutMS: remaining },
      });
    } catch (thrown) {
      throw prelaunchFailure(thrown) ?? thrown;
    }
    // Fresh by construction: the previous run's directory is removed, never reused, so a
    // leftover file from a killed run cannot be read as this run's input.
    await this.execOrThrow(["rm", "-rf", HUB_RUN_DIRECTORY], deadlineAt);
    await this.execOrThrow(["mkdir", "-p", HUB_RUN_DIRECTORY], deadlineAt);
    await this.execOrThrow([
      "cp",
      ...HUB_IMAGE_RUNTIME_FILES.map((name) => `${HUB_IMAGE_DIRECTORY}/${name}`),
      `${HUB_RUN_DIRECTORY}/`,
    ], deadlineAt);
  }

  async writeRunFile(name: string, content: string): Promise<void> {
    const written = await this.sandbox.writeFile(`${HUB_RUN_DIRECTORY}/${name}`, content);
    if (!written.success) throw new Error("run file was not written");
  }

  async spawn(
    argv: readonly string[],
    options: { readonly timeoutMs: number; readonly env?: Record<string, string> },
  ): Promise<HubContainerProcess> {
    if (argv.length === 0) throw new Error("empty argv");
    const command = argv as unknown as [string, ...string[]];
    let process: SandboxProcessDescriptor;
    try {
      process = await this.sandbox.exec(command, {
        cwd: HUB_RUN_DIRECTORY,
        // §23.11 — the REMOTE lifetime; without it a local observation could mistake a
        // still-running program for a finished one.
        timeout: options.timeoutMs,
        ...(options.env === undefined ? {} : { env: options.env }),
      });
    } catch (thrown) {
      throw prelaunchFailure(thrown) ?? thrown;
    }
    return containerProcess(process);
  }

  async readRunFile(name: string, maxBytes: number): Promise<string | null> {
    try {
      // Binary mode streams over capnp; unlike the text overload it never buffers the
      // entire parent-written envelope before this adapter can enforce its cap.
      const read = await this.sandbox.readFile(`${HUB_RUN_DIRECTORY}/${name}`, { encoding: "none" });
      const reader = read.content.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel().catch(() => {});
          return null;
        }
        chunks.push(value);
      }
      const joined = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        joined.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return new TextDecoder().decode(joined);
    } catch {
      // Absent, unreadable, or gone with a replaced container: the coordinator classifies
      // every one of these as "no result", never as a fabricated value.
      return null;
    }
  }

  async removeRunDirectory(): Promise<boolean> {
    try {
      const removed = await this.sandbox.exec(["rm", "-rf", HUB_RUN_DIRECTORY], {
        cwd: "/workspace",
        timeout: HUB_INNER_OPERATION_TIMEOUT_MS,
      });
      const collected = await collectProcess(removed);
      return !collected.exit.failed && collected.exit.exitCode === 0;
    } catch {
      return false;
    }
  }

  async destroyContainer(): Promise<void> {
    await this.sandbox.destroy();
  }

  /** One argv through the SDK, rejecting unless it exited zero; used for the fixed
   *  directory setup commands, whose failure means the run must not start. The command's
   *  remote timeout is the remaining admitted budget, and its cwd exists before the fresh
   *  run directory does. */
  private async execOrThrow(argv: readonly string[], deadlineAt: number): Promise<void> {
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) throw new HubContainerUnavailableError();
    const command = argv as unknown as [string, ...string[]];
    const collected = await collectProcess(
      await this.sandbox.exec(command, { cwd: "/workspace", timeout: remaining }),
    );
    if (collected.exit.failed || collected.exit.exitCode !== 0) throw new Error("run directory setup failed");
  }
}

/** One process's bounded outcome: how it settled, plus the two captured streams. */
type CollectedProcess = {
  readonly exit: { readonly exitCode: number; readonly timedOut: boolean; readonly failed: boolean };
  readonly output: HubProcessOutput;
};

/**
 * §23.8/§23.11 — one SDK process as the coordinator's adapter. The capability's log
 * subscription is consumed EXACTLY ONCE (replay + follow), so `wait` and `output` observe
 * the same events and a second consumer can never see a view the first one drained; each
 * stream is retained to one byte past its §23.11 cap, so a stream that hit the cap is cut
 * here — visibly and exactly — rather than mistaken for a short one.
 *
 * The subscription ending without a terminal event (a replaced container, a lost runtime)
 * is a FAILED observation, never a clean exit: `failed` is what stops the coordinator from
 * reading a made-up exit code as the program's result.
 */
function collectProcess(descriptor: SandboxProcessDescriptor): Promise<CollectedProcess> {
  return (async (): Promise<CollectedProcess> => {
    const subscription = await descriptor.capability.openLogs({ replay: true, follow: true });
    const stdout: Uint8Array[] = [];
    const stderr: Uint8Array[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    // The SDK's replay-loss event does not identify a stream, so conservatively mark both.
    let sdkTruncated = false;
    let exit: CollectedProcess["exit"] = { exitCode: -1, timedOut: false, failed: true };
    try {
      for (;;) {
        const { done, value } = await subscription.next();
        if (done || value === undefined) break;
        if (value.type === "stdout" || value.type === "stderr") {
          const cap = value.type === "stdout" ? HUB_STDOUT_MAX_BYTES : HUB_STDERR_MAX_BYTES;
          const seen = value.type === "stdout" ? stdoutBytes : stderrBytes;
          const room = Math.max(0, cap + 1 - seen);
          if (room === 0) continue;
          const chunk = value.data.byteLength <= room ? value.data : value.data.slice(0, room);
          if (value.type === "stdout") {
            stdout.push(chunk);
            stdoutBytes += chunk.byteLength;
          } else {
            stderr.push(chunk);
            stderrBytes += chunk.byteLength;
          }
          continue;
        }
        if (value.type === "truncated") {
          sdkTruncated = true;
          continue;
        }
        if (value.type === "terminal" && value.state === "exited") {
          exit = { exitCode: value.exit.code, timedOut: value.exit.timedOut, failed: false };
        }
        break;
      }
    } finally {
      await subscription.cancel().catch(() => {});
    }
    const stdoutText = truncateUtf8(decode(stdout, stdoutBytes), HUB_STDOUT_MAX_BYTES);
    const stderrText = truncateUtf8(decode(stderr, stderrBytes), HUB_STDERR_MAX_BYTES);
    return {
      exit,
      output: {
        stdout: stdoutText.text,
        stderr: stderrText.text,
        stdoutTruncated: sdkTruncated || stdoutText.truncated,
        stderrTruncated: sdkTruncated || stderrText.truncated,
      },
    };
  })();
}

/** One process handle whose collection started at spawn: both observations await the same
 *  single pass over the log stream. */
function containerProcess(descriptor: SandboxProcessDescriptor): HubContainerProcess {
  const collected = collectProcess(descriptor);
  return {
    pid: descriptor.pid,
    wait: async () => (await collected).exit,
    kill: async (signal) => {
      await descriptor.capability.kill(signal).catch(() => {});
    },
    output: async () => (await collected).output,
  };
}

function decode(chunks: readonly Uint8Array[], length: number): string {
  const joined = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}

/**
 * §23.10 — the ONE translation the coordinator's retry policy keys on: an SDK failure that
 * PROVES nothing launched. `ContainerUnavailableError` is the SDK's own "container not
 * ready; work did not start" class; every other error (interruption, transport loss, wait
 * abort, spawn failure) may have run and is returned untouched for the coordinator to
 * classify as post-launch and never replay.
 */
function prelaunchFailure(thrown: unknown): HubContainerUnavailableError | null {
  return thrown instanceof ContainerUnavailableError ? new HubContainerUnavailableError() : null;
}

/**
 * §23.8 — the composition root's executor: resolves the exact-token DO, admits one
 * execution, wires the request's abort signal to that generation's cancel, and returns the
 * bounded result. The digest is the DO key, so the container, its state, and its counters
 * are single-tenant per presented bearer; the raw bearer never crosses this boundary.
 *
 * The two out-of-band signals travel as hub-backend's own classes (thrown, not returned):
 * `HubCredentialRevokedError` when the pre-publication reauthorization failed and the run's
 * whole value was discarded, `HubExecutionAbortedError` when the request was aborted and no
 * response is published. Everything else is §23.11's result union.
 */
export function createHubExecutor(): HubExecutor {
  return async (request: HubExecutionRequest): Promise<HubExecutionResult> => {
    const binding = hubSandboxBinding(env);
    if (!SANDBOX_KEY_SHAPE.test(request.caller.credential.sandboxKey)) {
      // A digest that is not a digest is an internal defect in the credential resolution,
      // not a caller's mistake; refusing here keeps it from becoming a DO-key guess.
      throw new Error("invalid sandbox key");
    }
    const snapshot: HubRunSnapshot = request.snapshot;
    // The digest is the deterministic namespace name; only the platform-issued container
    // id round-trips through idFromString in the outbound handler above.
    const stub = binding.get(binding.idFromName(request.caller.credential.sandboxKey));
    const verdict = await stub.admit({
      caller: request.caller,
      snapshot,
      code: request.code,
      deadlineAt: request.deadlineAt,
      clientMeta: request.clientMeta,
    });
    if (!verdict.ok) {
      return { kind: "limit_exceeded", limit: "active_execution", observed: 1, transient: true, mayHaveRun: false };
    }
    let aborted = request.lifecycle.signal.aborted;
    const run = stub.run(verdict.generation);
    const onAbort = (): void => {
      aborted = true;
      // The request lifetime must own both halves: cancellation performs kill/escalation,
      // while `run` owns directory cleanup and the DO's active-slot release. Waiting only
      // for `cancel` could let the host discard the latter when the client disconnects.
      const cleanup = Promise.allSettled([
        stub.cancel(verdict.generation),
        run,
      ]).then(() => undefined);
      request.lifecycle.waitUntil?.(cleanup);
    };
    if (aborted) onAbort();
    else request.lifecycle.signal.addEventListener("abort", onAbort, { once: true });
    try {
      const answer = await run;
      if (aborted || answer.kind === "aborted") throw new HubExecutionAbortedError();
      if (answer.kind === "credential_revoked") throw new HubCredentialRevokedError();
      return answer.result;
    } finally {
      request.lifecycle.signal.removeEventListener("abort", onAbort);
    }
  };
}

/** §23.8 — the ONE narrowing of the HUB_SANDBOX binding. `Env` types every binding
 *  `unknown` by the repo's skeleton convention (index.ts), so the two members this module
 *  calls are named here and nowhere else. */
function hubSandboxBinding(workerEnv: Env): DurableObjectNamespaceLike<HubSandboxStub> {
  return workerEnv.HUB_SANDBOX as DurableObjectNamespaceLike<HubSandboxStub>;
}

/** UTF-8 byte length for the envelope read's cap check (the same unit §23.11 measures in). */
function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

// §23.9 — the platform resolves `ctx.exports.ContainerProxy` against the ENTRY module, so
// the SDK's proxy class (which carries the SDK's own outbound handlers) is re-exported
// through the composition root beside the DO class.
export { ContainerProxy };
