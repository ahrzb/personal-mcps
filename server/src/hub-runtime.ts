// hub-runtime.ts — §23.8–§23.11's execution coordinator: one admitted request in, one
// bounded result out, over a narrow container supervisor.
//
// WHO RUNS IT: the HubSandbox Durable Object (hub-sandbox.ts) owns one instance of this
// class, so the state that must have exactly one writer — the token's single execution
// slot, the generation and its unguessable nonce, the admitted absolute deadline, the
// call/concurrency counters, the running process handle — has exactly one home. The DO
// reaches its container only through `HubContainerSupervisor` (six methods, no SDK types),
// which is what lets a worker test drive this whole state machine against a fake adapter
// with containers disabled.
//
// WHAT IT GUARANTEES, in the order a run needs them: admission is a synchronous claim made
// before the first `await` (a concurrent second call is refused, never queued); the
// container is reached with a mandatory REMOTE process timeout (local observation is never
// termination proof); `deno check` runs — offline and bounded — before any user module
// evaluates, so a type error dispatches nothing; the result envelope is read from a path
// the user Worker cannot write, so user stdout cannot forge completion; the credential is
// reauthorized once more immediately before publication, and a refusal discards the whole
// value; and cleanup that cannot be proven destroys the container instead of reusing
// questionable state.
//
// NODE-CLEAN: no `cloudflare:workers`, no gateway/admin/tunnel/Sandbox import. The two
// dispatch seams and the pre-publication reauthorization arrive as constructor functions
// bound to `env` by the DO, and the gateway/identity types are imported by type only.

import { HubExecutionAbortedError, HubCredentialRevokedError } from "./hub-backend";
import type { HubExecutionResult } from "./hub-contract";
import { CODES, HubError, unavailable } from "./errors";
import type { JsonRpcResponse, ResourceDispatch, ToolDispatch } from "./gateway";
import { renderProgramDeclaration } from "./hub-types";
import type { DeclarationResource, DeclarationResourceTemplate, DeclarationService, DeclarationTool } from "./hub-types";
import type { AuthenticatedCaller } from "./identity";
import {
  HUB_ABORT_GRACE_MS,
  HUB_FINAL_REAUTH_RESERVE_MS,
  HUB_BRIDGE_ARGUMENTS_MAX_BYTES,
  HUB_BRIDGE_RESPONSE_MAX_BYTES,
  HUB_CHECK_TIMEOUT_MS,
  HUB_INNER_CONCURRENCY_MAX,
  HUB_INNER_OPERATIONS_MAX,
  HUB_INNER_OPERATION_TIMEOUT_MS,
  HUB_PRELAUNCH_RETRY_BACKOFF_MS,
  HUB_RESULT_MAX_BYTES,
  HUB_TYPE_DIAGNOSTIC_MAX_BYTES,
  HUB_TYPE_DIAGNOSTIC_MAX_LINES,
} from "./limits";


/** §23.9 — the one environment variable the parent process may read, carrying the
 *  generation nonce; it is deliberately NOT named like a credential. */
export const HUB_NONCE_ENV = "PMCP_EXECUTION_ID";

/** §23.9 — the bridge nonce header the trusted parent presents on every bridge request. */
export const HUB_BRIDGE_NONCE_HEADER = "x-pmcp-nonce";

/** §23.9 — the two fixed bridge paths the parent may POST to; anything else is not a
 *  bridge route, whatever the container dials. */
export const HUB_BRIDGE_CALL_PATH = "/bridge/call";
export const HUB_BRIDGE_READ_PATH = "/bridge/read";

/** §23.9 — the container-internal host the trusted parent dials; the only egress the
 *  container is allowed, and the only host whose interception routes to the DO. */
export const HUB_BRIDGE_HOST = "mcp.internal";

// ── the fixed container layout (§23.8) ───────────────────────────────────────────────
//
// One directory, recreated fresh for every run: the run's files are written there, the
// parent is launched with it as cwd, and it is deleted — or the container destroyed — once
// the envelope has been read. The path is fixed rather than nonce-derived so no diagnostic,
// error, or audit line can leak a per-run secret through a filesystem path; one token
// admits one execution, so a fixed path cannot collide with a live run.

/** The fresh per-run directory, under the container's workspace root. */
export const HUB_RUN_DIRECTORY = "/workspace/pmcp-exec";

/** The image directory holding the immutable runtime files copied into each run directory. */
export const HUB_IMAGE_DIRECTORY = "/opt/hub";

/** The trusted parent's file name; the other two immutable files are `worker.ts` and
 *  `deno.json`, and all three are copied from the image into every fresh run directory. */
export const HUB_RUNNER_FILE = "runner.ts";

/** The per-run file names. `result.json` is the one path the parent may write, and the user
 *  Worker has no write permission at all — that split is what keeps the envelope
 *  unforgeable from inside the program. */
export const HUB_RUN_FILE = {
  program: "program.ts",
  declaration: "program.d.ts",
  snapshot: "snapshot.json",
  result: "result.json",
} as const;

/** The pinned Deno binary the image ships; the control server execs it by absolute path so
 *  a PATH change inside the container cannot redirect the trusted parent. */
export const HUB_DENO_BINARY = "/usr/bin/deno";

/** §23.9 — the trusted parent's argv. Every flag is load-bearing: `--unstable-worker-options`
 *  is what makes the Worker permission split a boundary at all; `--frozen --cached-only
 *  --no-remote --no-npm` pin the run offline; the single read grant covers the fresh run
 *  directory, the single write grant covers the result envelope, and `--allow-env` names
 *  only the nonce. */
export function hubRunArgv(): readonly string[] {
  return [
    HUB_DENO_BINARY,
    "run",
    "--unstable-worker-options",
    "--no-prompt",
    "--frozen",
    "--cached-only",
    "--no-remote",
    "--no-npm",
    `--allow-net=${HUB_BRIDGE_HOST}:80`,
    `--allow-read=${HUB_RUN_DIRECTORY}`,
    `--allow-write=${HUB_RUN_DIRECTORY}/${HUB_RUN_FILE.result}`,
    `--allow-env=${HUB_NONCE_ENV}`,
    HUB_RUNNER_FILE,
  ];
}

/** §23.9 — the bounded offline typecheck argv; it runs in the same fresh directory, so
 *  `deno.json`'s `compilerOptions.types` (which names only `program.d.ts`) is discovered
 *  from the entry file and no remote or cached dependency can enter the graph. */
export function hubCheckArgv(): readonly string[] {
  return [HUB_DENO_BINARY, "check", "--frozen", "--cached-only", "--no-remote", "--no-npm", HUB_RUN_FILE.program];
}

// ── the run's view of the catalog snapshot ───────────────────────────────────────────
//
// `CatalogSnapshot` carries declaration data plus the richer search/execution fields. The
// run names the subset it serializes across the container boundary: pinned app ids,
// canonical names, rendered signatures, direct declaration URIs, and diagnostics. Every
// later bridge read is checked against these names, while the declaration renderer accepts
// the same structural value unchanged.

/** One tool as a run sees it: the declaration shape plus its search face. */
export type HubRunTool = DeclarationTool & {
  /** Bounded description, search metadata only. */
  readonly description: string;
  /** Rendered callable signature, as `search_types` reports it. */
  readonly signature: string;
  /** Direct declaration URI, as `search_types` reports it. */
  readonly declarationUri: string;
  /** Bounded mapping/render diagnostics for this entry. */
  readonly diagnostics: readonly string[];
};

/** One resource as a run sees it; the raw URI is its identity and is never aliased. */
export type HubRunResource = DeclarationResource & {
  readonly description: string;
  readonly signature: string;
  readonly declarationUri: string;
  readonly diagnostics: readonly string[];
};

/** One resource template as a run sees it. */
export type HubRunTemplate = DeclarationResourceTemplate & {
  readonly description: string;
  readonly signature: string;
  readonly declarationUri: string;
  readonly diagnostics: readonly string[];
};

/** One service as a run sees it: canonical slug, pinned app id, and resolved members. */
export type HubRunService = Omit<
  DeclarationService,
  "tools" | "resources" | "resourceTemplates"
> & {
  /** Immutable app id the snapshot pinned; a bridge operation refuses when the slug now
   *  resolves elsewhere. */
  readonly appId: string;
  /** Tools with their runtime mapping and search metadata. */
  readonly tools: readonly HubRunTool[];
  /** Static resources addressable through the structured API. */
  readonly resources: readonly HubRunResource[];
  /** Resource templates exposed by the structured API. */
  readonly resourceTemplates: readonly HubRunTemplate[];
  /** Caller-visible mapping diagnostics for this service. */
  readonly diagnostics: readonly string[];
};

/** The immutable catalog/mapping one execution resolves through. */
export type HubRunSnapshot = {
  readonly services: readonly HubRunService[];
  readonly diagnostics: readonly string[];
  /** True when a catalog cap cut the snapshot to a canonical prefix. */
  readonly truncated: boolean;
  /** Non-null when a cap cut the snapshot; declarations then render as a banner. */
  readonly overflow: string | null;
};

// ── the container supervisor: the one platform boundary this module sees ──────────────

/** One process's bounded output, exactly §23.11's four fields. */
export type HubProcessOutput = {
  /** Captured stdout text, cut to its byte cap. */
  readonly stdout: string;
  /** Captured stderr text, cut to its byte cap. */
  readonly stderr: string;
  /** True when stdout hit its cap and was cut. */
  readonly stdoutTruncated: boolean;
  /** True when stderr hit its cap and was cut. */
  readonly stderrTruncated: boolean;
};

/** Empty bounded output for infrastructure failures that happen outside a settled process. */
const EMPTY_PROCESS_OUTPUT: HubProcessOutput = {
  stdout: "",
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
};

/**
 * §23.8/§23.11 — one running container process, as the coordinator observes it. `wait` is a
 * LOCAL observation: it resolving proves only that the supervisor saw the process group
 * settle, never that the remote side stopped — the remote lifetime comes from `spawn`'s
 * mandatory `timeoutMs`, and the coordinator treats a missing remote timeout as a bug
 * rather than as an unbounded run.
 */
export type HubContainerProcess = {
  /** Container pid at launch; for diagnostics only, never an authorization input. */
  readonly pid: number;
  /** Resolves when the supervised process group settles. Rejection means the supervisor
   *  lost the process (container replaced, transport gone) — never a clean exit. `failed`
   *  is the supervisor's own verdict that it never observed a normal exit, which the
   *  coordinator classifies as an infrastructure failure rather than reading `exitCode`. */
  wait(): Promise<{ readonly exitCode: number; readonly timedOut: boolean; readonly failed: boolean }>;
  /** SIGTERM(15) or SIGKILL(9) to the process group. Best-effort: a process already gone
   *  is not an error. */
  kill(signal: 15 | 9): Promise<void>;
  /** Bounded stdout/stderr text, each stream cut to its §23.11 cap; safe to call once
   *  `wait` has settled. */
  output(): Promise<HubProcessOutput>;
};

/**
 * §23.8 — the narrow adapter the coordinator drives. `hub-sandbox.ts` implements it over
 * the Sandbox SDK; a worker test implements it as a fake, which is why nothing here may
 * assume a container exists, a file system is durable, or a `wait` ever returns on its own.
 *
 * Every method is bounded by the caller and may reject: `HubContainerUnavailableError` when
 * the failure is PROVEN pre-launch (nothing ran), any other error when the supervisor
 * cannot prove that — the coordinator classifies the two differently and never replays the
 * second.
 */
export type HubContainerSupervisor = {
  /** Recreate the run directory from scratch and copy the immutable runtime files into it.
   *  Rejects `HubContainerUnavailableError` when the container could not be brought up
   *  within the caller's remaining budget. */
  prepareRunDirectory(deadlineAt: number): Promise<void>;
  /** Write one file into the run directory, bounded by the caller's own size checks. */
  writeRunFile(name: string, content: string): Promise<void>;
  /** Launch one argv in the run directory with a MANDATORY remote timeout in milliseconds;
   *  resolves once the process is launched, not when it exits. Rejects
   *  `HubContainerUnavailableError` only when the launch provably did not happen. */
  spawn(
    argv: readonly string[],
    options: { readonly timeoutMs: number; readonly env?: Record<string, string> },
  ): Promise<HubContainerProcess>;
  /** Read one run-directory file, or `null` when it is absent or larger than `maxBytes`. */
  readRunFile(name: string, maxBytes: number): Promise<string | null>;
  /** Delete the run directory. `false` means the deletion could not be PROVEN — the
   *  coordinator then destroys the container rather than trust the state. */
  removeRunDirectory(): Promise<boolean>;
  /** Hard-destroy the container (SIGKILL + teardown) for uncertain state. Best-effort:
   *  the caller only needs the attempt, never a proof. */
  destroyContainer(): Promise<void>;
};

/** §23.9/§23.10 — raised by a supervisor method whose failure is PROVEN pre-launch, so the
 *  coordinator may apply the one bounded retry §23.10 allows. Anything the supervisor
 *  cannot prove pre-launch must reject with a plain error instead. */
export class HubContainerUnavailableError extends Error {
  constructor() {
    super("container unavailable before launch");
    this.name = "HubContainerUnavailableError";
  }
}

// ── the bridge wire between the trusted parent and this coordinator ───────────────────

/** §23.11 — one inner limit refusal as the program receives it: the limit's name, the
 *  observed quantity, and the same transience/may-have-run classification the outer result
 *  union uses. */
export type HubInnerLimit = {
  readonly name: string;
  readonly observed: number;
  readonly transient: boolean;
  readonly mayHaveRun: boolean;
};

/** §23.9 — the bridge's answer to the parent: either the inner MCP result verbatim, or the
 *  typed error the program's promise rejects with. `limit` is present exactly when the
 *  refusal was a hub limit, which is what lets an uncaught refusal classify the whole run
 *  as `limit_exceeded` rather than as an opaque runtime error. */
export type HubBridgeAnswer =
  | { readonly ok: true; readonly result: unknown }
  | {
      readonly ok: false;
      readonly error: { readonly code: number; readonly message: string; readonly data?: unknown };
      readonly limit?: HubInnerLimit;
    };

/** One canonical target the parent may address, already resolved from its TypeScript
 *  mapping; the coordinator re-checks it against the execution's own snapshot. */
type BridgeTarget =
  | { readonly kind: "call"; readonly service: string; readonly appId: string; readonly tool: string; readonly args?: Record<string, unknown> }
  | { readonly kind: "read"; readonly service: string; readonly appId: string; readonly uri: string };

// ── admission and the active execution ───────────────────────────────────────────────

/** §23.8 — what the DO hands `admit`: everything the run needs that cannot be re-derived,
 *  all of it already validated by the gateway. */
export type HubAdmission = {
  /** The exact credential this execution is keyed to and reauthorized by. */
  readonly caller: AuthenticatedCaller;
  /** The immutable caller-visible catalog/mapping the run resolves through. */
  readonly snapshot: HubRunSnapshot;
  /** The submitted source, already shape- and size-validated. */
  readonly code: string;
  /** The absolute epoch-ms instant the whole path must finish by (settings-snapshotted). */
  readonly deadlineAt: number;
  /** Display-only client metadata for inner audit rows; never forwarded as `_meta`. */
  readonly clientMeta?: { name?: string; version?: string; sessionId?: string };
};

/** §23.8 — the synchronous verdict of `admit`. A refusal is §23.11's transient
 *  `active_execution` limit: no launch, no queue. */
export type HubAdmissionVerdict =
  | {
      readonly ok: true;
      /** The generation's opaque id, presented back to `run`/`cancel`. */
      readonly generation: string;
      /** Reserved for observability: replacement is never concurrent with prior cleanup. */
      readonly replacedStale: false;
    }
  | { readonly ok: false; readonly limit: "active_execution" };

/** The live execution, as `admit` creates it. `cancelled` and the counters are the
 *  authority every bridge request is checked against; `process` is what `cancel` kills.
 *  Timed-out SDK promises remain in `pending`, keeping this token slot quarantined until
 *  their late side effects have conclusively settled. */
type ActiveExecution = {
  readonly generation: string;
  readonly nonce: string;
  readonly caller: AuthenticatedCaller;
  readonly snapshot: HubRunSnapshot;
  readonly code: string;
  readonly deadlineAt: number;
  readonly clientMeta?: HubAdmission["clientMeta"];
  /** Admission instant, used to report elapsed wall-clock limits. */
  readonly startedAt: number;
  /** True once the sole `run` RPC has claimed this generation. */
  started: boolean;
  cancelled: boolean;
  /** True once the one proven-pre-launch retry has been spent. */
  retried: boolean;
  inFlight: number;
  /** Operations admitted past bridge validation and snapshot membership, whether their
   *  dispatcher answer succeeds or refuses. This is the total-cap and may-have-run fact. */
  dispatched: number;
  calls: number;
  reads: number;
  process: HubContainerProcess | null;
  readonly pending: Set<Promise<unknown>>;
  /** True once this generation has claimed its one idempotent cleanup attempt. */
  cleanupStarted: boolean;
  /** True when that cleanup had to replace or begin replacing the container. */
  cleanupReplaced: boolean;
};

/** The coordinator's constructor dependencies: the adapter, the two dispatch seams, and the
 *  pre-publication credential check. All are bound to `env` by the DO that owns this
 *  instance; nothing here is per-run state. */
export type HubExecutionCoordinatorOptions = {
  readonly supervisor: HubContainerSupervisor;
  /** §23.10 — the gateway's `tools/call` seam. Throws HubError on every refusal; the
   *  coordinator maps that to the bridge's typed error, exactly as the wire mapping does. */
  readonly dispatchTool: (input: ToolDispatch) => Promise<JsonRpcResponse>;
  /** §23.10 — the gateway's `resources/read` seam, same contract. */
  readonly dispatchResourceRead: (input: ResourceDispatch) => Promise<JsonRpcResponse>;
  /** §23.4 — the gateway's `reauthorizeCaller`: true only while the reference is live and
   *  still resolves to the same principal key. */
  readonly reauthorize: (caller: AuthenticatedCaller) => Promise<boolean>;
  /** Owns late SDK/cleanup quiescence after the bounded RPC result has returned. */
  readonly waitUntil?: (work: Promise<unknown>) => void;
  /** Clock injection; defaults to `Date.now`. */
  readonly now?: () => number;
  /** Backoff before the one pre-launch retry; tests shrink it. */
  readonly prelaunchRetryBackoffMs?: number;
  /** Grace before escalating a kill; tests shrink it. */
  readonly abortGraceMs?: number;
};

/**
 * §23.8–§23.11 — the state machine behind one HubSandbox DO. Constructed once per DO
 * instance; `admit`/`run`/`cancel`/`bridge` are its entry points, and the DO's RPC methods
 * are thin forwards to them.
 */
export class HubExecutionCoordinator {
  private readonly supervisor: HubContainerSupervisor;
  private readonly dispatchTool: HubExecutionCoordinatorOptions["dispatchTool"];
  private readonly dispatchResourceRead: HubExecutionCoordinatorOptions["dispatchResourceRead"];
  private readonly reauthorize: HubExecutionCoordinatorOptions["reauthorize"];
  private readonly waitUntil: HubExecutionCoordinatorOptions["waitUntil"];
  private readonly now: () => number;
  private readonly retryBackoffMs: number;
  private readonly abortGraceMs: number;
  private active: ActiveExecution | null = null;

  constructor(options: HubExecutionCoordinatorOptions) {
    this.supervisor = options.supervisor;
    this.dispatchTool = options.dispatchTool;
    this.dispatchResourceRead = options.dispatchResourceRead;
    this.reauthorize = options.reauthorize;
    this.waitUntil = options.waitUntil;
    this.now = options.now ?? Date.now;
    this.retryBackoffMs = options.prelaunchRetryBackoffMs ?? HUB_PRELAUNCH_RETRY_BACKOFF_MS;
    this.abortGraceMs = options.abortGraceMs ?? HUB_ABORT_GRACE_MS;
  }

  /**
   * §23.8 — synchronously claims the token's one execution slot. An expired admission
   * that no `run` RPC claimed is safe to reclaim because it cannot have touched the
   * workspace. Once claimed, a predecessor remains authoritative until its whole lifecycle
   * and every timed-out SDK operation quiesce; that fail-closed rule prevents a late
   * file/process/container operation from touching a successor's fixed workspace.
   */
  admit(admission: HubAdmission): HubAdmissionVerdict {
    if (
      this.active !== null &&
      !this.active.started &&
      this.now() >= this.active.deadlineAt
    ) {
      // No run RPC ever crossed the admission gap, so no SDK operation exists to join.
      this.active = null;
    }
    if (this.active !== null) return { ok: false, limit: "active_execution" };
    this.active = {
      generation: crypto.randomUUID(),
      nonce: crypto.randomUUID(),
      caller: admission.caller,
      snapshot: admission.snapshot,
      code: admission.code,
      deadlineAt: admission.deadlineAt,
      startedAt: this.now(),
      started: false,
      clientMeta: admission.clientMeta,
      cancelled: false,
      retried: false,
      inFlight: 0,
      dispatched: 0,
      calls: 0,
      reads: 0,
      process: null,
      pending: new Set(),
      cleanupStarted: false,
      cleanupReplaced: false,
    };
    return { ok: true, generation: this.active.generation, replacedStale: false };
  }


  /**
   * §23.8/§23.11 — runs the admitted generation to one bounded result. Known cancellation
   * and credential revocation retain their control-flow classes across the DO boundary;
   * every other SDK/process exception becomes the result union's sanitized runtime error
   * after bounded cleanup.
   */
  async run(generation: string): Promise<HubExecutionResult> {
    const active = this.active;
    if (active === null || active.generation !== generation || active.started) {
      throw new HubExecutionAbortedError();
    }
    active.started = true;
    try {
      return await this.execute(active);
    } catch (thrown) {
      if (thrown instanceof HubExecutionAbortedError || thrown instanceof HubCredentialRevokedError) {
        throw thrown;
      }
      const replaced = await this.cleanup(active, workDeadlineAt(active));
      const failure = runtimeError("sandbox_error", active, EMPTY_PROCESS_OUTPUT);
      return await this.publish(
        active,
        replaced ? { ...failure, containerReplaced: true } : failure,
      );
    } finally {
      const quiescence = this.releaseWhenQuiescent(active);
      if (this.waitUntil === undefined) void quiescence;
      else this.waitUntil(quiescence);
    }
  }

  /**
   * §23.11 — aborts the named generation: new bridge traffic is refused from this instant,
   * the running process group is terminated (SIGTERM, then SIGKILL after a bounded grace,
   * then container destroy), and the run's output is discarded. Idempotent, and a no-op for
   * a generation that is no longer active — a late cancel must never touch a successor.
   */
  async cancel(generation: string): Promise<void> {
    const active = this.active;
    if (active === null || active.generation !== generation) return;
    active.cancelled = true;
    await this.terminate(active);
  }

  /**
   * §23.9 — one bridge request from the trusted parent. The checks are ordered so nothing
   * expensive or side-effecting happens before the cheapest refusal: method and path, the
   * active nonce, the deadline and cancellation state, the body cap, the shape, the
   * counters, then snapshot membership — and only then the dispatch seam, which performs
   * the per-operation reauthorization itself (`reauthorizeCredential`). A refusal is a
   * typed error the program may catch; only malformed protocol (bad nonce, unknown path,
   * oversized body) is an HTTP-level refusal the parent turns into a failed run.
   */
  async bridge(request: Request): Promise<Response> {
    const active = this.active;
    if (request.method !== "POST") return bridgeRefusal(405, "method not allowed");
    if (active === null || request.headers.get(HUB_BRIDGE_NONCE_HEADER) !== active.nonce) {
      return bridgeRefusal(403, "bridge not permitted");
    }
    if (active.cancelled) return bridgeRefusal(503, "execution no longer active");
    if (this.now() >= workDeadlineAt(active)) {
      return bridgeRefusal(503, "execution no longer active");
    }
    const path = new URL(request.url).pathname;
    const kind = path === HUB_BRIDGE_CALL_PATH ? "call" : path === HUB_BRIDGE_READ_PATH ? "read" : null;
    if (kind === null) return bridgeRefusal(404, "unknown bridge path");
    const body = await readBoundedBody(request, HUB_BRIDGE_ARGUMENTS_MAX_BYTES);
    if (body === null) {
      return answerResponse({
        ok: false,
        error: { code: CODES.invalidParams, message: "invalid params" },
        limit: { name: "bridge_arguments", observed: HUB_BRIDGE_ARGUMENTS_MAX_BYTES, transient: false, mayHaveRun: false },
      });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return bridgeRefusal(400, "malformed bridge body");
    }
    const target = bridgeTarget(parsed, kind);
    if (target === null) return bridgeRefusal(400, "malformed bridge body");

    // §23.11's two counters, checked at the authoritative boundary before any dispatch.
    // Refused attempts are immediate and never queued, but prior admitted operations still
    // make the execution non-replayable.
    if (active.inFlight >= HUB_INNER_CONCURRENCY_MAX) {
      return answerResponse({
        ok: false,
        error: { code: CODES.unavailable, message: "hub limit exceeded: inner_concurrency" },
        limit: {
          name: "inner_concurrency",
          observed: active.inFlight,
          transient: false,
          mayHaveRun: active.dispatched > 0,
        },
      });
    }
    if (active.dispatched >= HUB_INNER_OPERATIONS_MAX) {
      return answerResponse({
        ok: false,
        error: { code: CODES.unavailable, message: "hub limit exceeded: inner_operations" },
        limit: {
          name: "inner_operations",
          observed: active.dispatched,
          transient: false,
          mayHaveRun: active.dispatched > 0,
        },
      });
    }
    // §23.6/§23.9 — the immutable snapshot is the authorization input for what the run may
    // address at all: a service that is not in it, an app id that moved, or a tool that is
    // not one of the service's tools is refused exactly like an ungranted name.
    const service = active.snapshot.services.find((candidate) => candidate.service === target.service);
    if (service === undefined || service.appId !== target.appId) {
      return answerResponse({ ok: false, error: { code: CODES.notPermitted, message: "tool not permitted" } });
    }
    if (target.kind === "call" && !service.tools.some((tool) => tool.canonicalName === target.tool)) {
      return answerResponse({ ok: false, error: { code: CODES.notPermitted, message: "tool not permitted" } });
    }

    // §23.10 — the inner deadline is the EARLIER of the execution deadline and the hub
    // inner-operation cap; the gateway seam enforces it, and no operation starts after it.
    const deadlineAt = Math.min(workDeadlineAt(active), this.now() + HUB_INNER_OPERATION_TIMEOUT_MS);
    active.inFlight += 1;
    active.dispatched += 1;
    if (target.kind === "call") active.calls += 1;
    else active.reads += 1;
    const answer = target.kind === "call"
      ? await this.callInner(active, target, deadlineAt)
      : await this.readInner(active, target, deadlineAt);
    return answerResponse(answer, true);
  }

  /** The call half of `bridge`, mapping the seam's refusals to the program's typed error. */
  private async callInner(
    active: ActiveExecution,
    target: Extract<BridgeTarget, { kind: "call" }>,
    deadlineAt: number,
  ): Promise<HubBridgeAnswer> {
    try {
      const response = await this.within(active, () => this.dispatchTool({
        caller: active.caller,
        slug: target.service,
        tool: target.tool,
        args: target.args,
        clientMeta: active.clientMeta,
        deadlineAt,
        expectAppId: target.appId,
        reauthorizeCredential: true,
      }), deadlineAt, false, true);
      return response.error === undefined
        ? { ok: true, result: response.result }
        : { ok: false, error: wireError(response.error) };
    } catch (thrown) {
      return {
        ok: false,
        error: seamError(
          thrown instanceof HubDeadlineExceededError ? unavailable("timeout") : thrown,
        ),
      };
    }
  }

  /** The read half of `bridge`; current grants, not the snapshot, authorize the raw URI. */
  private async readInner(
    active: ActiveExecution,
    target: Extract<BridgeTarget, { kind: "read" }>,
    deadlineAt: number,
  ): Promise<HubBridgeAnswer> {
    try {
      const response = await this.within(active, () => this.dispatchResourceRead({
        caller: active.caller,
        slug: target.service,
        uri: target.uri,
        clientMeta: active.clientMeta,
        deadlineAt,
        expectAppId: target.appId,
        reauthorizeCredential: true,
      }), deadlineAt, false, true);
      return response.error === undefined
        ? { ok: true, result: response.result }
        : { ok: false, error: wireError(response.error) };
    } catch (thrown) {
      return {
        ok: false,
        error: seamError(
          thrown instanceof HubDeadlineExceededError ? unavailable("timeout") : thrown,
        ),
      };
    }
  }
  // ── the run itself ─────────────────────────────────────────────────────────────────

  private async execute(active: ActiveExecution): Promise<HubExecutionResult> {
    const workDeadline = workDeadlineAt(active);
    if (active.cancelled) throw new HubExecutionAbortedError();
    if (this.now() >= workDeadline) return await this.publish(active, coldStart(active, 0));

    // The one retry surrounds only proven pre-launch unavailability. A timed-out mutating
    // SDK call schedules destruction after its late settlement before this slot can reopen.
    try {
      await this.attempt(active, () => this.within(
        active,
        () => this.supervisor.prepareRunDirectory(workDeadline),
        workDeadline,
        true,
      ));
    } catch (thrown) {
      if (active.cancelled) {
        await this.destroyWithin(active, active.deadlineAt);
        throw new HubExecutionAbortedError();
      }
      if (
        thrown instanceof HubContainerUnavailableError ||
        thrown instanceof HubDeadlineExceededError
      ) {
        return await this.publish(
          active,
          coldStart(active, Math.max(0, workDeadline - this.now())),
        );
      }
      throw thrown;
    }
    if (active.cancelled) {
      await this.cleanup(active, active.deadlineAt);
      throw new HubExecutionAbortedError();
    }

    const { result, replaced } = await this.evaluateAndCleanup(active);
    if (active.cancelled) throw new HubExecutionAbortedError();
    const final = result.kind === "runtime_error" && replaced
      ? { ...result, containerReplaced: true }
      : result;
    return await this.publish(active, final);
  }

  /** Releases a result only after the mandatory final credential reauthorization. */
  private async publish(
    active: ActiveExecution,
    result: HubExecutionResult,
  ): Promise<HubExecutionResult> {
    await this.authorizePublication(active);
    return result;
  }

  /** Fails closed unless the credential is proven live inside the reserved tail budget. */
  private async authorizePublication(active: ActiveExecution): Promise<void> {
    const remaining = active.deadlineAt - this.now();
    if (remaining <= 0) throw new HubCredentialRevokedError();
    try {
      // This is a read-only liveness check: a late settlement cannot touch Sandbox state
      // and therefore must not quarantine the token's execution slot.
      if (!(await valueWithin(this.reauthorize(active.caller), remaining))) {
        throw new HubCredentialRevokedError();
      }
    } catch (thrown) {
      if (thrown instanceof HubDeadlineExceededError) throw new HubCredentialRevokedError();
      throw thrown;
    }
  }

  /** Runs check/evaluation and cleans the directory on every outcome. */
  private async evaluateAndCleanup(
    active: ActiveExecution,
  ): Promise<{ readonly result: HubExecutionResult; readonly replaced: boolean }> {
    let result: HubExecutionResult;
    try {
      result = await this.evaluate(active);
    } catch (thrown) {
      if (!(thrown instanceof HubContainerUnavailableError)) {
        await this.cleanup(active, workDeadlineAt(active));
        throw thrown;
      }
      result = coldStart(active, Math.max(0, workDeadlineAt(active) - this.now()));
    }
    const replaced = await this.cleanup(active, workDeadlineAt(active));
    return { result, replaced };
  }

  /** The offline-check then permissionless-evaluation half. */
  private async evaluate(active: ActiveExecution): Promise<HubExecutionResult> {
    try {
      await this.within(
        active,
        () => this.supervisor.writeRunFile(HUB_RUN_FILE.program, active.code),
        workDeadlineAt(active),
        true,
      );
      await this.within(
        active,
        () => this.supervisor.writeRunFile(
          HUB_RUN_FILE.declaration,
          renderProgramDeclaration(active.snapshot),
        ),
        workDeadlineAt(active),
        true,
      );
      await this.within(
        active,
        () => this.supervisor.writeRunFile(HUB_RUN_FILE.snapshot, JSON.stringify(active.snapshot)),
        workDeadlineAt(active),
        true,
      );
    } catch (thrown) {
      if (thrown instanceof HubDeadlineExceededError) return coldStart(active, 0);
      throw thrown;
    }

    const checkBudget = Math.min(HUB_CHECK_TIMEOUT_MS, workDeadlineAt(active) - this.now());
    if (checkBudget <= 0) return coldStart(active, 0);
    let check: HubProcessOutput & { readonly exitCode: number; readonly timedOut: boolean; readonly failed: boolean };
    try {
      check = await this.launch(active, hubCheckArgv(), checkBudget, undefined);
    } catch (thrown) {
      if (thrown instanceof HubDeadlineExceededError) {
        return limit("check_time", checkBudget, false, false);
      }
      throw thrown;
    }
    if (check.failed) return runtimeError("process_error", active, check);
    if (check.timedOut) return limit("check_time", checkBudget, false, false);
    if (check.exitCode !== 0) {
      return {
        kind: "type_error",
        diagnostics: typeDiagnostics(check.stderr),
        transient: false,
        mayHaveRun: false,
      };
    }

    const runBudget = workDeadlineAt(active) - this.now();
    if (runBudget <= 0) return coldStart(active, 0);
    try {
      const output = await this.launch(
        active,
        hubRunArgv(),
        runBudget,
        { [HUB_NONCE_ENV]: active.nonce },
      );
      if (active.cancelled) throw new HubExecutionAbortedError();
      if (this.now() >= workDeadlineAt(active)) return wallClockLimit(active);
      if (output.failed) return runtimeError("process_error", active, output);
      if (output.timedOut) return wallClockLimit(active);

      const envelope = await this.within(
        active,
        () => this.supervisor.readRunFile(HUB_RUN_FILE.result, HUB_RESULT_MAX_BYTES + 4_096),
      );
      if (envelope === null) return runtimeError("no_result", active, output);
      return classifyEnvelope(envelope, active, output)
        ?? runtimeError("invalid_result", active, output);
    } catch (thrown) {
      if (thrown instanceof HubDeadlineExceededError) return wallClockLimit(active);
      throw thrown;
    }
  }

  /** Launches and observes one process through the earlier per-launch or execution deadline. */
  private async launch(
    active: ActiveExecution,
    argv: readonly string[],
    timeoutMs: number,
    env: Record<string, string> | undefined,
  ): Promise<HubProcessOutput & {
    readonly exitCode: number;
    readonly timedOut: boolean;
    readonly failed: boolean;
  }> {
    const launchDeadlineAt = Math.min(workDeadlineAt(active), this.now() + timeoutMs);
    if (active.cancelled) throw new HubExecutionAbortedError();
    const process = await this.within(
      active,
      () => this.supervisor.spawn(argv, { timeoutMs, env }),
      launchDeadlineAt,
      true,
    );
    active.process = process;
    if (active.cancelled) {
      await this.terminate(active);
      throw new HubExecutionAbortedError();
    }
    try {
      const exit = await this.within(active, () => process.wait(), launchDeadlineAt);
      const output = await this.within(active, () => process.output(), launchDeadlineAt);
      return { ...exit, ...output };
    } finally {
      active.process = null;
    }
  }

  /** The single bounded retry, only for proven pre-launch unavailability. */
  private async attempt<T>(active: ActiveExecution, operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (thrown) {
      if (!(thrown instanceof HubContainerUnavailableError) || active.retried) throw thrown;
      if (this.now() + this.retryBackoffMs >= workDeadlineAt(active)) throw thrown;
      active.retried = true;
      await sleep(this.retryBackoffMs);
      return await operation();
    }
  }

  /** Deletes the run directory, destroying the container when deletion is not proven. */
  private async cleanup(active: ActiveExecution, deadlineAt: number): Promise<boolean> {
    if (active.cleanupStarted) return active.cleanupReplaced;
    active.cleanupStarted = true;
    const remaining = Math.max(0, deadlineAt - this.now());
    const removal = await settleWithin(
      this.track(active, this.supervisor.removeRunDirectory()),
      remaining,
    );
    if (removal.settled && removal.value) return false;
    active.cleanupReplaced = true;
    await this.destroyWithin(active, deadlineAt);
    return true;
  }

  /** Starts hard destruction immediately and bounds only how long this run waits for it. */
  private async destroyWithin(active: ActiveExecution, deadlineAt: number): Promise<boolean> {
    const remaining = Math.max(0, deadlineAt - this.now());
    return (await settleWithin(
      this.track(active, this.supervisor.destroyContainer()),
      remaining,
    )).settled;
  }

  /** Terminates the process group, escalating through SIGTERM, SIGKILL, and destroy. */
  private async terminate(active: ActiveExecution): Promise<void> {
    const process = active.process;
    if (process === null) {
      await this.destroyWithin(active, active.deadlineAt);
      return;
    }
    const settled = this.track(active, process.wait()).then(
      () => true,
      () => true,
    );
    const grace = (): number =>
      Math.min(this.abortGraceMs, Math.max(0, active.deadlineAt - this.now()));
    await settleWithin(this.track(active, process.kill(15)), grace());
    if (await Promise.race([settled, sleep(grace()).then(() => false)])) return;
    await settleWithin(this.track(active, process.kill(9)), grace());
    if (await Promise.race([settled, sleep(grace()).then(() => false)])) return;
    await this.destroyWithin(active, active.deadlineAt);
  }

  /**
   * Runs one SDK promise inside the deadline. If a mutating call times out, destruction is
   * sequenced after its eventual settlement and the token stays quarantined through both.
   */
  private async within<T>(
    active: ActiveExecution,
    operation: () => Promise<T>,
    deadlineAt = active.deadlineAt,
    destroyAfterLateSettlement = false,
    releaseInFlightOnSettlement = false,
  ): Promise<T> {
    const remaining = deadlineAt - this.now();
    if (remaining <= 0) {
      if (releaseInFlightOnSettlement) active.inFlight -= 1;
      throw new HubDeadlineExceededError();
    }
    let work: Promise<T>;
    try {
      work = operation();
    } catch (thrown) {
      if (releaseInFlightOnSettlement) active.inFlight -= 1;
      throw thrown;
    }
    const pending = this.track(active, work);
    if (releaseInFlightOnSettlement) {
      void pending.then(
        () => { active.inFlight -= 1; },
        () => { active.inFlight -= 1; },
      );
    }
    try {
      return await valueWithin(pending, remaining);
    } catch (thrown) {
      if (destroyAfterLateSettlement && thrown instanceof HubDeadlineExceededError) {
        const quarantine = pending.then(
          () => this.supervisor.destroyContainer(),
          () => this.supervisor.destroyContainer(),
        ).then(
          () => undefined,
          () => undefined,
        );
        this.track(active, quarantine);
      }
      throw thrown;
    }
  }

  /** Adds a promise to the generation's quarantine barrier without changing its result. */
  private track<T>(active: ActiveExecution, operation: Promise<T>): Promise<T> {
    active.pending.add(operation);
    void operation.then(
      () => active.pending.delete(operation),
      () => active.pending.delete(operation),
    );
    return operation;
  }

  /** Releases the token only after late operations can no longer affect a successor. */
  private async releaseWhenQuiescent(active: ActiveExecution): Promise<void> {
    if (active.pending.size === 0) {
      if (this.active === active) this.active = null;
      return;
    }
    await Promise.allSettled([...active.pending]);
    await this.releaseWhenQuiescent(active);
  }
}
/** Leaves a bounded tail of the caller's budget for the mandatory publication re-check. */
function workDeadlineAt(active: ActiveExecution): number {
  const admitted = Math.max(0, active.deadlineAt - active.startedAt);
  const reserve = Math.min(HUB_FINAL_REAUTH_RESERVE_MS, Math.floor(admitted / 2));
  return active.deadlineAt - reserve;
}


/** §23.11's transient pre-launch refusal: no program or inner operation ran. */
function coldStart(active: ActiveExecution, remainingMs: number): HubExecutionResult {
  return {
    kind: "limit_exceeded",
    limit: "cold_start",
    observed: Math.max(0, Math.floor(remainingMs)),
    transient: true,
    mayHaveRun: false,
  };
}

/** The outer deadline consumed its admitted wall-clock budget. */
function wallClockLimit(active: ActiveExecution): HubExecutionResult {
  return limit(
    "wall_clock",
    Math.max(0, active.deadlineAt - active.startedAt),
    false,
    active.dispatched > 0,
  );
}

/** §23.11's named deterministic limit: never transient, and `mayHaveRun` is exactly
 *  "an inner operation was admitted for dispatch". */
function limit(name: string, observed: number, transient: boolean, mayHaveRun: boolean): HubExecutionResult {
  return { kind: "limit_exceeded", limit: name, observed: Math.max(0, Math.floor(observed)), transient, mayHaveRun };
}

/** §23.11's post-launch failure: always non-transient (nothing after a possible launch is
 *  safely replayable) and always `mayHaveRun` when the run could have dispatched. */
function runtimeError(
  cause: string,
  active: ActiveExecution,
  output: HubProcessOutput,
): Extract<HubExecutionResult, { readonly kind: "runtime_error" }> {
  return {
    kind: "runtime_error",
    cause,
    stdout: output.stdout,
    stderr: output.stderr,
    stdoutTruncated: output.stdoutTruncated,
    stderrTruncated: output.stderrTruncated,
    transient: false,
    mayHaveRun: active.dispatched > 0,
    containerReplaced: false,
  };
}

/** The parent's envelope, parsed and classified. `null` means the text was not a shape this
 *  contract knows — the caller reports `invalid_result` rather than guessing. */
function classifyEnvelope(envelope: string, active: ActiveExecution, output: HubProcessOutput): HubExecutionResult | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(envelope);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const record = parsed as Record<string, unknown>;
  if (record.status === "completed" && "value" in record) {
    return {
      kind: "completed",
      value: record.value,
      stdout: output.stdout,
      stderr: output.stderr,
      stdoutTruncated: output.stdoutTruncated,
      stderrTruncated: output.stderrTruncated,
      operations: { calls: active.calls, reads: active.reads },
    };
  }
  if (record.status === "error") {
    const limitInfo = record.limit;
    if (limitInfo !== null && typeof limitInfo === "object") {
      const name = (limitInfo as Record<string, unknown>).name;
      const observed = (limitInfo as Record<string, unknown>).observed;
      if (typeof name === "string" && typeof observed === "number" && Number.isFinite(observed)) {
        return limit(name, observed, false, active.dispatched > 0);
      }
    }
    const error = record.error;
    const name = error !== null && typeof error === "object" ? (error as Record<string, unknown>).name : undefined;
    const cause = typeof name === "string" && /^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(name) ? `program_error:${name}` : "program_error";
    return runtimeError(cause, active, output);
  }
  return null;
}

/** §23.8 — the sanitized checker diagnostics. `deno check` writes the offending SOURCE
 *  LINE beside each error; that line is exactly what §23.11 forbids ("never source text
 *  from the program"), so only the `TS<code> [ERROR]:` head and its `at <file>` location
 *  survive, with the run directory path flattened to the file's bare name. Bounded by both
 *  line count and bytes; an empty or unparseable stream becomes one generic line rather
 *  than an empty answer. */
export function typeDiagnostics(stderr: string): string[] {
  const lines = stderr.split(/\r?\n/);
  const kept: string[] = [];
  let bytes = 0;
  const push = (text: string): boolean => {
    const size = utf8Length(text);
    if (bytes + size > HUB_TYPE_DIAGNOSTIC_MAX_BYTES) return false;
    bytes += size;
    kept.push(text);
    return true;
  };
  for (const raw of lines) {
    if (kept.length >= HUB_TYPE_DIAGNOSTIC_MAX_LINES) break;
    const line = raw.trim();
    const head = /^(TS\d+ \[ERROR\]: .*)$/.exec(line);
    if (head !== null) {
      if (!push(head[1])) break;
      continue;
    }
    const location = /^at file:\/\/.*\/([^/]+:\d+:\d+)$/.exec(line);
    if (location !== null && kept.length > 0) push(`  at ${location[1]}`);
  }
  return kept.length === 0 ? ["the TypeScript checker rejected the module"] : kept;
}

/** §23.11 — the bridge's error mapping, mirroring the gateway's wire mapping field for
 *  field (that function is not exported, and a second, different mapping is the thing this
 *  must never become). */
function seamError(thrown: unknown): { code: number; message: string; data?: unknown } {
  if (thrown instanceof HubError) {
    return thrown.data === undefined
      ? { code: thrown.code, message: thrown.message }
      : { code: thrown.code, message: thrown.message, data: thrown.data };
  }
  return { code: CODES.internal, message: "internal error" };
}

/** One already-shaped wire error, copied into the bridge's envelope. */
function wireError(error: { code: number; message: string; data?: unknown }): { code: number; message: string; data?: unknown } {
  return error.data === undefined
    ? { code: error.code, message: error.message }
    : { code: error.code, message: error.message, data: error.data };
}

/** §23.9 — validates the bridge body's shape per kind. A call needs a canonical tool name
 *  and (optionally) object arguments; a read needs a raw URI. The app id is required on
 *  both, because the snapshot pin is what a slug-reuse attack has to defeat. */
function bridgeTarget(parsed: unknown, kind: "call" | "read"): BridgeTarget | null {
  if (parsed === null || typeof parsed !== "object") return null;
  const record = parsed as Record<string, unknown>;
  if (typeof record.service !== "string" || record.service.length === 0) return null;
  if (typeof record.appId !== "string" || record.appId.length === 0) return null;
  if (kind === "read") {
    if (typeof record.uri !== "string") return null;
    return { kind: "read", service: record.service, appId: record.appId, uri: record.uri };
  }
  if (typeof record.tool !== "string" || record.tool.length === 0) return null;
  if (record.args !== undefined && (record.args === null || typeof record.args !== "object" || Array.isArray(record.args))) {
    return null;
  }
  const args = record.args === undefined ? undefined : (record.args as Record<string, unknown>);
  return { kind: "call", service: record.service, appId: record.appId, tool: record.tool, ...(args === undefined ? {} : { args }) };
}

/** The bridge answer as the parent reads it: HTTP 200 with the envelope, always — the
 *  program's typed error and a limit refusal are both answers, not transport failures. */
function answerResponse(answer: HubBridgeAnswer, mayHaveRun = false): Response {
  const serialized = JSON.stringify(answer);
  if (utf8Length(serialized) <= HUB_BRIDGE_RESPONSE_MAX_BYTES) return json(serialized);
  const refusal: HubBridgeAnswer = {
    ok: false,
    error: { code: CODES.unavailable, message: "hub limit exceeded: bridge_response" },
    limit: {
      name: "bridge_response",
      observed: utf8Length(serialized),
      transient: false,
      mayHaveRun,
    },
  };
  return json(JSON.stringify(refusal));
}

/** A protocol-level refusal the parent reports as a failed run (it is not a program-visible
 *  error): wrong method, wrong nonce, cancelled execution, unknown path. */
function bridgeRefusal(status: number, message: string): Response {
  return json(JSON.stringify({ error: message }), status);
}

function json(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "application/json" } });
}

/** Reads a request body up to `maxBytes`, or `null` when it is larger — the body is never
 *  buffered past the cap, so an oversized bridge call cannot make the DO allocate it. */
async function readBoundedBody(request: Request, maxBytes: number): Promise<string | null> {
  if (request.body === null) return "";
  const reader = request.body.getReader();
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
}

/** UTF-8 byte length, the unit every §23.11 cap is measured in. */
function utf8Length(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

/** Internal deadline signal; callers translate it to the public structured result. */
class HubDeadlineExceededError extends Error {
  constructor() {
    super("hub execution deadline exceeded");
    this.name = "HubDeadlineExceededError";
  }
}

/** Preserves a promise's value/rejection but stops waiting at the local deadline. */
async function valueWithin<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: Parameters<typeof clearTimeout>[0];
  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new HubDeadlineExceededError()), timeoutMs);
    });
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Observes a promise to settlement or a local deadline without leaving a later rejection
 * unhandled. Timing out does not claim the remote operation was cancelled. */
async function settleWithin<T>(
  work: Promise<T>,
  timeoutMs: number,
): Promise<{ readonly settled: true; readonly value: T } | { readonly settled: false }> {
  const observed = work.then(
    (value) => ({ settled: true as const, value }),
    () => ({ settled: false as const }),
  );
  if (timeoutMs <= 0) {
    void observed;
    return { settled: false };
  }
  return await Promise.race([
    observed,
    sleep(timeoutMs).then(() => ({ settled: false as const })),
  ]);
}

function sleep(ms: number): Promise<void> {
  // `Promise.withResolvers` is an ES2024 lib member and this repo compiles against ES2022;
  // the executor form is the one the compiler knows.
  return new Promise((resolve) => setTimeout(resolve, ms));
}
