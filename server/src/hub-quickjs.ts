// hub-quickjs.ts — §23.8–§23.11's in-Worker execution boundary.
//
// One release-sync QuickJS WebAssembly module is instantiated lazily per Worker isolate.
// Every submitted program gets a fresh runtime and context inside that module; the context
// receives only a frozen `mcp` tree and captured `console`, and the whole runtime is disposed
// after the result. Host callables close over canonical snapshot identities, so guest input
// can provide arguments but can never choose the service, app id, or tool being dispatched.
//
// Guest promises, not Asyncify, cross the asynchronous boundary. A host operation returns a
// QuickJS deferred promise immediately; its Worker promise later settles the deferred and
// wakes the executor to pump pending QuickJS jobs. Nothing here logs source, guest values,
// dispatch bodies, runtime errors, or credentials.

import baseVariant from "@jitl/quickjs-wasmfile-release-sync";
import { Validator, type OutputUnit, type Schema } from "@cfworker/json-schema";
// Wrangler only recognizes deployable Wasm modules imported relative to Worker source. This
// checked-in copy is byte-for-byte the pinned package's dist/emscripten-module.wasm artifact.
import wasmModule from "./quickjs-release-sync.wasm";
import { env } from "cloudflare:workers";
import {
  DefaultIntrinsics,
  newQuickJSWASMModuleFromVariant,
  newVariant,
  type QuickJSContext,
  type QuickJSDeferredPromise,
  type QuickJSHandle,
  type QuickJSRuntime,
  type QuickJSWASMModule,
} from "quickjs-emscripten-core";
import {
  HubCredentialRevokedError,
  HubExecutionAbortedError,
  hubSearchTypes,
  type HubExecutionRequest,
  type HubExecutor,
} from "./hub-backend";
import type { CatalogService, CatalogSnapshot, CatalogTool } from "./hub-catalog";
import type { HubExecutionDiagnostic, HubExecutionResult } from "./hub-contract";
import { CODES, HubError } from "./errors";
import {
  dispatchResourceRead,
  dispatchTool,
  reauthorizeCaller,
  type JsonRpcResponse,
  type ResourceDispatch,
  type ToolDispatch,
} from "./gateway";
import type { Env } from "./index";
import { compileHubProgram } from "./hub-typescript";
import {
  HUB_DIAGNOSTIC_MESSAGE_MAX_BYTES,
  HUB_FINAL_REAUTH_RESERVE_MS,
  HUB_HOST_ARGUMENTS_MAX_BYTES,
  HUB_HOST_RESPONSE_MAX_BYTES,
  HUB_INNER_CONCURRENCY_MAX,
  HUB_INNER_OPERATIONS_MAX,
  HUB_INNER_OPERATION_TIMEOUT_MS,
  HUB_QUICKJS_MEMORY_MAX_BYTES,
  HUB_QUICKJS_INTERRUPT_MAX,
  HUB_QUICKJS_STACK_MAX_BYTES,
  HUB_RESULT_MAX_BYTES,
  HUB_STDERR_MAX_BYTES,
  HUB_STDOUT_MAX_BYTES,
  HUB_RUNTIME_STACK_MAX_BYTES,
} from "./limits";
import { truncateUtf8, utf8Bytes } from "./hub-types";

/** Runtime seams injected by the composition root or a workerd test. They preserve the
 * gateway's one dispatch path while keeping execution tests independent of real apps. */
export type HubQuickJsDependencies = {
  /** The existing scoped `tools/call` pipeline. */
  readonly dispatchTool: (input: ToolDispatch) => Promise<JsonRpcResponse>;
  /** The existing scoped `resources/read` pipeline. */
  readonly dispatchResourceRead: (input: ResourceDispatch) => Promise<JsonRpcResponse>;
  /** Credential liveness check used immediately before publication. */
  readonly reauthorize: (caller: HubExecutionRequest["caller"]) => Promise<boolean>;
  /** Clock injection for deterministic deadlines; production uses `Date.now`. */
  readonly now?: () => number;
  /** Runtime-module injection for tests; production uses the pinned module-level loader. */
  readonly loadModule?: () => Promise<QuickJSWASMModule>;
};

/** One bounded captured stream. `bytes` avoids repeatedly measuring the retained prefix. */
type CapturedOutput = {
  /** Retained whole-code-point text. */
  text: string;
  /** UTF-8 bytes currently retained. */
  bytes: number;
  /** True after any bytes were dropped. */
  truncated: boolean;
};

/** A host-imposed limit error retained by identity so guest code cannot forge the outer
 * `limit_exceeded` classification by throwing a similarly shaped object. */
type GuestLimitError = {
  /** Duplicate handle to the exact guest Error rejected by a host callable. */
  readonly handle: QuickJSHandle;
  /** Public limit result if this exact Error escapes the program. */
  readonly result: Extract<HubExecutionResult, { readonly kind: "limit_exceeded" }>;
};

/** Mutable facts owned by one fresh runtime. No member survives `executeProgram`. */
type ExecutionState = {
  /** False once the program has returned, failed, timed out, or disconnected. */
  alive: boolean;
  /** Host operations admitted for dispatch, including those that later refuse. */
  dispatched: number;
  /** Host operations whose Worker promise has not settled. */
  inFlight: number;
  /** Admitted tool calls. */
  calls: number;
  /** Admitted resource reads. */
  reads: number;
  /** QuickJS interrupt callbacks consumed by compilation and execution. */
  interrupts: number;
  /** Host reason the interrupt handler most recently stopped guest bytecode. */
  interruptReason: "aborted" | "wall_clock" | "cpu" | null;
  /** Captured console.log/info output. */
  readonly stdout: CapturedOutput;
  /** Captured console.warn/error output. */
  readonly stderr: CapturedOutput;
  /** Deferred guest promises that must be invalidated before runtime disposal. */
  readonly deferreds: Set<QuickJSDeferredPromise>;
  /** Worker operations that may outlive an un-awaited guest promise. */
  readonly pendingWork: Set<Promise<unknown>>;
  /** Identity-pinned limit Errors still owned by this runtime. */
  readonly limitErrors: GuestLimitError[];
  /** Coalesced wake notification for the pending-job pump. */
  wakePending: boolean;
  /** Resolver installed while the pump is asleep. */
  wakeResolver: (() => void) | null;
};

/** A validated JSON copy plus its canonical text and byte count. */
type JsonCopy = {
  /** Deep JSON copy sharing no object with the source. */
  readonly value: unknown;
  /** Canonical JSON text used to construct the guest value. */
  readonly text: string;
  /** UTF-8 byte count of `text`. */
  readonly bytes: number;
};

/** Internal signal that the program consumed its execution window. */
class WorkDeadlineExceededError extends Error {
  constructor() {
    super("execution deadline exceeded");
    this.name = "WorkDeadlineExceededError";
  }
}

const EMPTY_OUTPUT = (): CapturedOutput => ({ text: "", bytes: 0, truncated: false });
const RELEASE_VARIANT = newVariant(baseVariant, { wasmModule });
let quickJsModulePromise: Promise<QuickJSWASMModule> | null = null;

/** Loads the pinned release-sync module once per Worker isolate. A failed initialization is
 * not memoized: a later request may retry a transient platform failure. */
async function loadQuickJsModule(): Promise<QuickJSWASMModule> {
  quickJsModulePromise ??= newQuickJSWASMModuleFromVariant(RELEASE_VARIANT);
  try {
    return await quickJsModulePromise;
  } catch (thrown) {
    quickJsModulePromise = null;
    throw thrown;
  }
}

/** Creates the production executor without starting QuickJS. The ambient Worker env is read
 * only when an execution actually dispatches an MCP operation. */
export function createHubExecutor(): HubExecutor {
  return createHubQuickJsExecutor({
    dispatchTool: (input) => dispatchTool(env as Env, input),
    dispatchResourceRead: (input) => dispatchResourceRead(env as Env, input),
    reauthorize: reauthorizeCaller,
  });
}

/** Binds one set of trusted host seams into an executor. Each invocation still receives its
 * own runtime, counters, output buffers, deadline, and guest globals. */
export function createHubQuickJsExecutor(dependencies: HubQuickJsDependencies): HubExecutor {
  const now = dependencies.now ?? Date.now;
  const loadModule = dependencies.loadModule ?? loadQuickJsModule;
  return async (request) => {
    const startedAt = now();
    const workDeadlineAt = deadlineBeforePublication(request.deadlineAt, startedAt);
    let result: HubExecutionResult;
    try {
      const compilation = compileHubProgram(request.snapshot, request.code);
      if (!compilation.ok) {
        result = typeError(compilation.diagnostics);
      } else {
        const module = await withinExecution(loadModule(), workDeadlineAt, request.lifecycle.signal, now);
        result = await executeProgram(
          module,
          compilation.javascript,
          request,
          dependencies,
          workDeadlineAt,
          startedAt,
          now,
        );
      }
    } catch (thrown) {
      if (thrown instanceof HubExecutionAbortedError) throw thrown;
      result = thrown instanceof WorkDeadlineExceededError
        ? limitResult("wall_clock", request.deadlineAt - startedAt, false)
        : runtimeError("runtime_initialization", "", "", false, false, EMPTY_OUTPUT(), EMPTY_OUTPUT());
    }
    await authorizePublication(request, dependencies.reauthorize, now);
    return result;
  };
}

/** Runs one program from runtime creation through bounded JSON extraction and guaranteed
 * disposal. Guest source and values never leave this function except as the public result. */
async function executeProgram(
  module: QuickJSWASMModule,
  javascript: string,
  request: HubExecutionRequest,
  dependencies: HubQuickJsDependencies,
  workDeadlineAt: number,
  startedAt: number,
  now: () => number,
): Promise<HubExecutionResult> {
  const state: ExecutionState = {
    alive: true,
    dispatched: 0,
    inFlight: 0,
    calls: 0,
    reads: 0,
    interrupts: 0,
    interruptReason: null,
    stdout: EMPTY_OUTPUT(),
    stderr: EMPTY_OUTPUT(),
    deferreds: new Set(),
    pendingWork: new Set(),
    limitErrors: [],
    wakePending: false,
    wakeResolver: null,
  };
  const runtime = module.newRuntime();
  runtime.setMemoryLimit(HUB_QUICKJS_MEMORY_MAX_BYTES);
  runtime.setMaxStackSize(HUB_QUICKJS_STACK_MAX_BYTES);
  runtime.setInterruptHandler(() => {
    state.interrupts += 1;
    if (request.lifecycle.signal.aborted) {
      state.interruptReason = "aborted";
      return true;
    }
    if (now() >= workDeadlineAt) {
      state.interruptReason = "wall_clock";
      return true;
    }
    if (state.interrupts >= HUB_QUICKJS_INTERRUPT_MAX) {
      state.interruptReason = "cpu";
      return true;
    }
    return false;
  });
  const vm = runtime.newContext({ intrinsics: DefaultIntrinsics });
  let programHandle: QuickJSHandle | null = null;
  try {
    installConsole(vm, state);
    installMcp(vm, runtime, state, request, dependencies, workDeadlineAt, now);

    const compiled = vm.evalCode(javascript, "program.js");
    if (compiled.error !== undefined) {
      const result = classifyGuestError(vm, compiled.error, state, request, workDeadlineAt, startedAt, now);
      compiled.error.dispose();
      return result;
    }
    const callable = compiled.value;
    try {
      hardenGuestSurface(vm);
      const invoked = vm.callFunction(callable, vm.undefined);
      if (invoked.error !== undefined) {
        const result = classifyGuestError(vm, invoked.error, state, request, workDeadlineAt, startedAt, now);
        invoked.error.dispose();
        return result;
      }
      programHandle = invoked.value;
    } finally {
      callable.dispose();
    }
    const settled = await settleProgram(vm, runtime, programHandle, state, request.lifecycle.signal, workDeadlineAt, now);
    if (settled.kind === "error") {
      const result = classifyGuestError(vm, settled.handle, state, request, workDeadlineAt, startedAt, now);
      settled.handle.dispose();
      return result;
    }
    const value = vm.dump(settled.handle);
    settled.handle.dispose();
    const copied = copyJson(value, HUB_RESULT_MAX_BYTES);
    if (copied === null) {
      return runtimeError("invalid_result", "program returned a non-JSON value", "", false, state.dispatched > 0, state.stdout, state.stderr);
    }
    return {
      kind: "completed",
      value: copied.value,
      stdout: state.stdout.text,
      stderr: state.stderr.text,
      stdoutTruncated: state.stdout.truncated,
      stderrTruncated: state.stderr.truncated,
      operations: { calls: state.calls, reads: state.reads },
    };
  } catch (thrown) {
    if (request.lifecycle.signal.aborted) throw new HubExecutionAbortedError();
    if (thrown instanceof WorkDeadlineExceededError || now() >= workDeadlineAt) {
      return limitResult("wall_clock", request.deadlineAt - startedAt, state.dispatched > 0);
    }
    return runtimeError("runtime_error", "execution failed inside the QuickJS host", "", false, state.dispatched > 0, state.stdout, state.stderr);
  } finally {
    state.alive = false;
    state.wakeResolver?.();
    state.wakeResolver = null;
    for (const deferred of state.deferreds) deferred.dispose();
    for (const error of state.limitErrors) error.handle.dispose();
    if (state.pendingWork.size > 0) {
      const quiescence = Promise.allSettled([...state.pendingWork]);
      request.lifecycle.waitUntil?.(quiescence);
      if (request.lifecycle.waitUntil === undefined) void quiescence;
    }
    programHandle?.dispose();
    vm.dispose();
    runtime.dispose();
  }
}

/** Installs captured console methods. Formatting happens in the guest's isolated values and
 * the retained text is returned only to the authenticated caller. */
function installConsole(vm: QuickJSContext, state: ExecutionState): void {
  const consoleHandle = vm.newObject();
  for (const [name, target] of [
    ["log", state.stdout],
    ["info", state.stdout],
    ["warn", state.stderr],
    ["error", state.stderr],
  ] as const) {
    const method = vm.newFunction(name, (...arguments_) => {
      const line = arguments_.map((argument) => printable(vm.dump(argument))).join(" ") + "\n";
      appendOutput(target, line, target === state.stdout ? HUB_STDOUT_MAX_BYTES : HUB_STDERR_MAX_BYTES);
    });
    vm.setProp(consoleHandle, name, method);
    method.dispose();
  }
  vm.defineProp(vm.global, "console", {
    value: consoleHandle,
    configurable: false,
    enumerable: true,
  });
  consoleHandle.dispose();
}

/** Installs the snapshot-derived `mcp` tree and freezes it recursively before user source
 * is parsed. Every dispatch function closes over canonical identity from the snapshot. */
function installMcp(
  vm: QuickJSContext,
  runtime: QuickJSRuntime,
  state: ExecutionState,
  request: HubExecutionRequest,
  dependencies: HubQuickJsDependencies,
  workDeadlineAt: number,
  now: () => number,
): void {
  const root = vm.newObject();
  for (const service of request.snapshot.services) {
    if (service.typescriptName === null) continue;
    const namespace = vm.newObject();
    for (const tool of service.tools) {
      if (tool.typescriptName === null) continue;
      const callable = toolCallable(vm, runtime, state, request, dependencies, service, tool, workDeadlineAt, now);
      setJsonProperty(vm, callable, "inputSchema", tool.inputSchema);
      setJsonProperty(vm, callable, "outputSchema", tool.outputSchema);
      vm.setProp(namespace, tool.typescriptName, callable);
      callable.dispose();
    }
    const resources = resourceNamespace(vm, runtime, state, request, dependencies, service, workDeadlineAt, now);
    vm.setProp(namespace, "resources", resources);
    resources.dispose();
    vm.setProp(root, service.typescriptName, namespace);
    namespace.dispose();
  }
  const hub = vm.newObject();
  const searchTypes = vm.newFunction("searchTypes", (inputHandle) => {
    let result: unknown;
    try {
      const input = inputHandle === undefined || vm.typeof(inputHandle) === "undefined" ? {} : vm.dump(inputHandle);
      result = hubSearchTypes(request.snapshot, input);
    } catch (thrown) {
      return rejectedPromise(vm, runtime, state, seamError(thrown));
    }
    return resolvedPromise(vm, runtime, state, result);
  });
  vm.setProp(hub, "searchTypes", searchTypes);
  searchTypes.dispose();
  vm.setProp(root, "hub", hub);
  hub.dispose();
  vm.defineProp(vm.global, "mcp", {
    value: root,
    configurable: false,
    enumerable: true,
  });
  root.dispose();

}

/** Creates one tool function whose target cannot be influenced by its guest argument. */
function toolCallable(
  vm: QuickJSContext,
  runtime: QuickJSRuntime,
  state: ExecutionState,
  request: HubExecutionRequest,
  dependencies: HubQuickJsDependencies,
  service: CatalogService,
  tool: CatalogTool,
  workDeadlineAt: number,
  now: () => number,
): QuickJSHandle {
  const validateInput = inputValidator(tool.inputSchema);
  return vm.newFunction(tool.typescriptName ?? "tool", (inputHandle) => {
    const input = inputHandle === undefined || vm.typeof(inputHandle) === "undefined" ? undefined : vm.dump(inputHandle);
    const validationMessage = validateInput?.(input) ?? null;
    if (validationMessage !== null) {
      return rejectedPromise(vm, runtime, state, { code: CODES.invalidParams, message: validationMessage });
    }
    const arguments_ = input === undefined ? undefined : objectArguments(input);
    if (arguments_ === null) {
      return rejectedPromise(vm, runtime, state, { code: CODES.invalidParams, message: "input: expected an object" });
    }
    return dispatchPromise(vm, runtime, state, request, dependencies, workDeadlineAt, now, "call", async (deadlineAt) => {
      const response = await dependencies.dispatchTool({
        caller: request.caller,
        slug: service.service,
        tool: tool.canonicalName,
        ...(arguments_ === undefined ? {} : { args: arguments_ }),
        clientMeta: request.clientMeta,
        deadlineAt,
        expectAppId: service.appId,
        reauthorizeCredential: true,
      });
      return responseAnswer(response);
    });
  });
}

/** Builds one Worker-safe JSON Schema validator. A malformed schema fails closed at the
 * callable boundary without dispatching; absent schemas retain the ordinary object gate. */
function inputValidator(schema: unknown | null): ((input: unknown) => string | null) | null {
  if (schema === null) return null;
  let validator: Validator;
  try {
    validator = new Validator(structuredClone(schema) as Schema | boolean, "2020-12", false);
  } catch {
    return () => "input: the tool input schema is invalid";
  }
  return (input) => {
    try {
      const result = validator.validate(input);
      if (result.valid) return null;
      const mostSpecific = [...result.errors].sort(
        (left, right) => right.instanceLocation.length - left.instanceLocation.length,
      )[0];
      return validationMessage(mostSpecific);
    } catch {
      return "input: the tool input schema could not be evaluated";
    }
  };
}

/** Renders one validator failure as a bounded guest-facing path and reason. */
function validationMessage(error: OutputUnit | undefined): string {
  if (error === undefined) return "input: does not match the tool input schema";
  const pointer = error.instanceLocation.replace(/^#\/?/, "");
  const path = pointer.length === 0
    ? "input"
    : pointer.split("/").reduce((current, encoded) => {
      const segment = encoded.replace(/~1/g, "/").replace(/~0/g, "~");
      return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(segment)
        ? `${current}.${segment}`
        : `${current}[${JSON.stringify(segment)}]`;
    }, "input");
  return safeDiagnosticText(`${path}: ${error.error}`, HUB_DIAGNOSTIC_MESSAGE_MAX_BYTES);
}

/** Creates one service's local list/template copies and canonical-identity read callable. */
function resourceNamespace(
  vm: QuickJSContext,
  runtime: QuickJSRuntime,
  state: ExecutionState,
  request: HubExecutionRequest,
  dependencies: HubQuickJsDependencies,
  service: CatalogService,
  workDeadlineAt: number,
  now: () => number,
): QuickJSHandle {
  const resources = vm.newObject();
  const list = vm.newFunction("list", () => jsonHandle(vm, service.resources.map(({ uri, description }) => ({ uri, description }))));
  const templates = vm.newFunction("templates", () =>
    jsonHandle(vm, service.resourceTemplates.map(({ uriTemplate, description }) => ({ uriTemplate, description }))));
  const read = vm.newFunction("read", (uriHandle) => {
    if (uriHandle === undefined || vm.typeof(uriHandle) !== "string") {
      return rejectedPromise(vm, runtime, state, { code: CODES.invalidParams, message: "invalid params" });
    }
    const uri = vm.getString(uriHandle);
    return dispatchPromise(vm, runtime, state, request, dependencies, workDeadlineAt, now, "read", async (deadlineAt) => {
      const response = await dependencies.dispatchResourceRead({
        caller: request.caller,
        slug: service.service,
        uri,
        clientMeta: request.clientMeta,
        deadlineAt,
        expectAppId: service.appId,
        reauthorizeCredential: true,
      });
      return responseAnswer(response);
    });
  });
  vm.setProp(resources, "list", list);
  vm.setProp(resources, "templates", templates);
  vm.setProp(resources, "read", read);
  list.dispose();
  templates.dispose();
  read.dispose();
  return resources;
}

/** Admits one asynchronous host operation under count, concurrency, argument, response,
 * abort, and deadline caps, then returns its guest promise immediately. */
function dispatchPromise(
  vm: QuickJSContext,
  runtime: QuickJSRuntime,
  state: ExecutionState,
  request: HubExecutionRequest,
  dependencies: HubQuickJsDependencies,
  workDeadlineAt: number,
  now: () => number,
  kind: "call" | "read",
  dispatch: (deadlineAt: number) => Promise<{ readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: GuestError }>,
): QuickJSHandle {
  if (!state.alive || request.lifecycle.signal.aborted || now() >= workDeadlineAt) {
    return rejectedPromise(vm, runtime, state, { code: CODES.unavailable, message: "execution no longer active" });
  }
  if (state.inFlight >= HUB_INNER_CONCURRENCY_MAX) {
    return rejectedLimitPromise(vm, runtime, state, "inner_concurrency", state.inFlight, state.dispatched > 0);
  }
  if (state.dispatched >= HUB_INNER_OPERATIONS_MAX) {
    return rejectedLimitPromise(vm, runtime, state, "inner_operations", state.dispatched, state.dispatched > 0);
  }

  const deadlineAt = Math.min(workDeadlineAt, now() + HUB_INNER_OPERATION_TIMEOUT_MS);
  state.inFlight += 1;
  state.dispatched += 1;
  if (kind === "call") state.calls += 1;
  else state.reads += 1;

  const deferred = vm.newPromise();
  state.deferreds.add(deferred);
  const work = withinExecution(dispatch(deadlineAt), deadlineAt, request.lifecycle.signal, now)
    .then((answer) => {
      if (!state.alive) return;
      if (!answer.ok) {
        settleRejected(vm, state, deferred, answer.error);
        return;
      }
      const copied = copyJson(answer.value, HUB_HOST_RESPONSE_MAX_BYTES);
      if (copied === null) {
        settleLimitRejected(vm, state, deferred, "host_response", HUB_HOST_RESPONSE_MAX_BYTES + 1, true);
        return;
      }
      const handle = jsonHandleFromText(vm, copied.text);
      deferred.resolve(handle);
      handle.dispose();
    })
    .catch((thrown: unknown) => {
      if (!state.alive) return;
      const error = thrown instanceof WorkDeadlineExceededError
        ? { code: CODES.unavailable, message: "timeout" }
        : seamError(thrown);
      settleRejected(vm, state, deferred, error);
    })
    .finally(() => {
      state.inFlight -= 1;
      state.deferreds.delete(deferred);
      state.pendingWork.delete(work);
      wake(state);
    });
  state.pendingWork.add(work);
  return deferred.handle;
}

/** Guest-visible error fields copied from the six-code wire vocabulary. */
type GuestError = {
  /** JSON-RPC error code. */
  readonly code: number;
  /** Stable public message. */
  readonly message: string;
  /** Optional bounded public data. */
  readonly data?: unknown;
};

/** Extracts a dispatch response without changing its wire error. */
function responseAnswer(response: JsonRpcResponse): { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: GuestError } {
  return response.error === undefined
    ? { ok: true, value: response.result }
    : { ok: false, error: response.error.data === undefined
      ? { code: response.error.code, message: response.error.message }
      : { code: response.error.code, message: response.error.message, data: response.error.data } };
}

/** Maps thrown host failures to the same public error fields as direct dispatch. */
function seamError(thrown: unknown): GuestError {
  if (thrown instanceof HubError) {
    return thrown.data === undefined
      ? { code: thrown.code, message: thrown.message }
      : { code: thrown.code, message: thrown.message, data: thrown.data };
  }
  return { code: CODES.internal, message: "internal error" };
}

/** Creates an already-fulfilled guest promise for local search. */
function resolvedPromise(vm: QuickJSContext, runtime: QuickJSRuntime, state: ExecutionState, value: unknown): QuickJSHandle {
  const copied = copyJson(value, HUB_HOST_RESPONSE_MAX_BYTES);
  if (copied === null) return rejectedLimitPromise(vm, runtime, state, "host_response", HUB_HOST_RESPONSE_MAX_BYTES + 1, state.dispatched > 0);
  const deferred = vm.newPromise();
  const handle = jsonHandleFromText(vm, copied.text);
  deferred.resolve(handle);
  handle.dispose();
  queueMicrotask(() => wake(state));
  return deferred.handle;
}

/** Creates an already-rejected guest promise for a host refusal. */
function rejectedPromise(vm: QuickJSContext, _runtime: QuickJSRuntime, state: ExecutionState, error: GuestError): QuickJSHandle {
  const deferred = vm.newPromise();
  settleRejected(vm, state, deferred, error);
  queueMicrotask(() => wake(state));
  return deferred.handle;
}

/** Creates an already-rejected guest promise whose exact Error identity carries a limit. */
function rejectedLimitPromise(
  vm: QuickJSContext,
  _runtime: QuickJSRuntime,
  state: ExecutionState,
  name: string,
  observed: number,
  mayHaveRun: boolean,
): QuickJSHandle {
  const deferred = vm.newPromise();
  settleLimitRejected(vm, state, deferred, name, observed, mayHaveRun);
  queueMicrotask(() => wake(state));
  return deferred.handle;
}

/** Rejects one deferred with the closed guest error shape. */
function settleRejected(vm: QuickJSContext, state: ExecutionState, deferred: QuickJSDeferredPromise, error: GuestError): void {
  const handle = guestErrorHandle(vm, error);
  deferred.reject(handle);
  handle.dispose();
  wake(state);
}

/** Rejects one deferred and retains a duplicate of its Error for exact outer classification. */
function settleLimitRejected(
  vm: QuickJSContext,
  state: ExecutionState,
  deferred: QuickJSDeferredPromise,
  name: string,
  observed: number,
  mayHaveRun: boolean,
): void {
  const result = limitResult(name, observed, mayHaveRun);
  const handle = guestErrorHandle(vm, {
    code: CODES.unavailable,
    message: `hub limit exceeded: ${name}`,
    data: { limit: result },
  });
  state.limitErrors.push({ handle: handle.dup(), result });
  deferred.reject(handle);
  handle.dispose();
  wake(state);
}

/** Builds one guest Error with data properties beside, not inside, its public message. */
function guestErrorHandle(vm: QuickJSContext, error: GuestError): QuickJSHandle {
  const handle = vm.newError({ name: "HubOperationError", message: error.message });
  const code = vm.newNumber(error.code);
  vm.setProp(handle, "code", code);
  code.dispose();
  if (error.data !== undefined) {
    const data = jsonHandle(vm, error.data);
    vm.setProp(handle, "data", data);
    data.dispose();
  }
  return handle;
}

/** Pumps QuickJS jobs until the program promise settles or execution stops. */
async function settleProgram(
  vm: QuickJSContext,
  runtime: QuickJSRuntime,
  program: QuickJSHandle,
  state: ExecutionState,
  signal: AbortSignal,
  deadlineAt: number,
  now: () => number,
): Promise<{ readonly kind: "value"; readonly handle: QuickJSHandle } | { readonly kind: "error"; readonly handle: QuickJSHandle }> {
  for (;;) {
    if (signal.aborted) throw new HubExecutionAbortedError();
    if (now() >= deadlineAt) throw new WorkDeadlineExceededError();
    const jobs = runtime.executePendingJobs();
    if (jobs.error !== undefined) return { kind: "error", handle: jobs.error };
    const promiseState = vm.getPromiseState(program);
    if (promiseState.type === "fulfilled") return { kind: "value", handle: promiseState.value };
    if (promiseState.type === "rejected") return { kind: "error", handle: promiseState.error };
    await withinExecution(waitForWake(state), deadlineAt, signal, now);
  }
}

/** Classifies a guest error while returning only bounded caller-visible fields. */
function classifyGuestError(
  vm: QuickJSContext,
  error: QuickJSHandle,
  state: ExecutionState,
  request: HubExecutionRequest,
  workDeadlineAt: number,
  startedAt: number,
  now: () => number,
): HubExecutionResult {
  for (const limited of state.limitErrors) {
    if (vm.sameValue(error, limited.handle)) return limited.result;
  }
  if (request.lifecycle.signal.aborted || state.interruptReason === "aborted") throw new HubExecutionAbortedError();
  let name = "Error";
  let message = "";
  let stack = "";
  let nameHandle: QuickJSHandle | null = null;
  let messageHandle: QuickJSHandle | null = null;
  let stackHandle: QuickJSHandle | null = null;
  try {
    const type = vm.typeof(error);
    if ((type === "object" && !vm.sameValue(error, vm.null)) || type === "function") {
      nameHandle = vm.getProp(error, "name");
      messageHandle = vm.getProp(error, "message");
      stackHandle = vm.getProp(error, "stack");
      if (vm.typeof(nameHandle) === "string") name = vm.getString(nameHandle);
      if (vm.typeof(messageHandle) === "string") message = vm.getString(messageHandle);
      if (vm.typeof(stackHandle) === "string") stack = vm.getString(stackHandle);
    }
  } catch {
    name = "Error";
    message = "";
    stack = "";
  } finally {
    nameHandle?.dispose();
    messageHandle?.dispose();
    stackHandle?.dispose();
  }
  if (state.interruptReason === "cpu") {
    return limitResult("cpu", state.interrupts, state.dispatched > 0);
  }
  if (state.interruptReason === "wall_clock" || now() >= workDeadlineAt) {
    return limitResult("wall_clock", request.deadlineAt - startedAt, state.dispatched > 0);
  }
  if (message === "out of memory") return limitResult("memory", HUB_QUICKJS_MEMORY_MAX_BYTES, state.dispatched > 0);
  if (message === "stack overflow") return limitResult("stack", HUB_QUICKJS_STACK_MAX_BYTES, state.dispatched > 0);
  const safeName = /^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(name) ? name : "Error";
  const cause = safeName === "SyntaxError" ? "syntax_error" : `program_error:${safeName}`;
  return runtimeError(
    cause,
    safeDiagnosticText(message, HUB_DIAGNOSTIC_MESSAGE_MAX_BYTES),
    publicStack(stack),
    false,
    state.dispatched > 0,
    state.stdout,
    state.stderr,
  );
}

/** Removes terminal-control bytes and truncates one caller-visible failure string. */
function safeDiagnosticText(text: string, maxBytes: number): string {
  const printable = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "�");
  return truncateUtf8(printable, maxBytes).text;
}

/** Bounds a QuickJS stack and translates generated wrapper locations to submitted lines. */
function publicStack(stack: string): string {
  const remapped = stack.replace(/program\.js:(\d+):(\d+)/g, (_match, line: string, column: string) =>
    `program.ts:${Math.max(1, Number(line) - 2)}:${column}`);
  return safeDiagnosticText(remapped, HUB_RUNTIME_STACK_MAX_BYTES);
}

/** Leaves a bounded tail of the admitted budget for final credential reauthorization. */
function deadlineBeforePublication(deadlineAt: number, startedAt: number): number {
  const admitted = Math.max(0, deadlineAt - startedAt);
  return deadlineAt - Math.min(HUB_FINAL_REAUTH_RESERVE_MS, Math.floor(admitted / 2));
}

/** Fails closed unless the invoking credential remains live inside the reserved tail. */
async function authorizePublication(
  request: HubExecutionRequest,
  reauthorize: HubQuickJsDependencies["reauthorize"],
  now: () => number,
): Promise<void> {
  try {
    if (!(await withinExecution(reauthorize(request.caller), request.deadlineAt, request.lifecycle.signal, now))) {
      throw new HubCredentialRevokedError();
    }
  } catch (thrown) {
    if (thrown instanceof HubExecutionAbortedError) throw thrown;
    if (thrown instanceof HubCredentialRevokedError) throw thrown;
    throw new HubCredentialRevokedError();
  }
}

/** Races work against the admitted deadline and request disconnect without claiming the
 * underlying Worker operation was cancelled. */
async function withinExecution<T>(
  work: Promise<T>,
  deadlineAt: number,
  signal: AbortSignal,
  now: () => number,
): Promise<T> {
  if (signal.aborted) throw new HubExecutionAbortedError();
  const remaining = deadlineAt - now();
  if (remaining <= 0) throw new WorkDeadlineExceededError();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new WorkDeadlineExceededError()), remaining);
  });
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new HubExecutionAbortedError());
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([work, deadline, aborted]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
  }
}

/** Waits for at least one host promise settlement; multiple settlements coalesce. */
function waitForWake(state: ExecutionState): Promise<void> {
  if (state.wakePending) {
    state.wakePending = false;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    state.wakeResolver = resolve;
  });
}

/** Wakes the pending-job pump or records one coalesced wake for its next sleep. */
function wake(state: ExecutionState): void {
  if (state.wakeResolver !== null) {
    const resolve = state.wakeResolver;
    state.wakeResolver = null;
    resolve();
    return;
  }
  state.wakePending = true;
}


/** Freezes the host surface and removes every guest-reachable dynamic source compiler after
 * the submitted function has been compiled but before any of its statements can run. */
function hardenGuestSurface(vm: QuickJSContext): void {
  const hardened = vm.evalCode(`(() => {
    const constructors = [
      Function,
      Object.getPrototypeOf(async function () {}).constructor,
      Object.getPrototypeOf(function* () {}).constructor,
      Object.getPrototypeOf(async function* () {}).constructor,
    ];
    for (const constructor of constructors) {
      Object.defineProperty(constructor.prototype, "constructor", {
        value: undefined,
        writable: false,
        configurable: false,
      });
    }
    Object.defineProperty(globalThis, "Function", {
      value: undefined,
      writable: false,
      configurable: false,
    });
    Object.defineProperty(globalThis, "eval", {
      value: undefined,
      writable: false,
      configurable: false,
    });
    const seen = new Set();
    const freeze = (value) => {
      if ((typeof value !== "object" && typeof value !== "function") || value === null || seen.has(value)) return value;
      seen.add(value);
      for (const key of Reflect.ownKeys(value)) freeze(value[key]);
      return Object.freeze(value);
    };
    freeze(mcp);
    Object.freeze(console);
  })()`, "guest-surface.js");
  if (hardened.error !== undefined) {
    hardened.error.dispose();
    throw new Error("guest surface initialization failed");
  }
  hardened.value.dispose();
}

/** Adds one JSON property to a guest object from an already bounded snapshot copy. */
function setJsonProperty(vm: QuickJSContext, target: QuickJSHandle, name: string, value: unknown): void {
  const handle = jsonHandle(vm, value);
  vm.setProp(target, name, handle);
  handle.dispose();
}

/** Creates a guest JSON value after validating a host value. */
function jsonHandle(vm: QuickJSContext, value: unknown): QuickJSHandle {
  const copied = copyJson(value, HUB_HOST_RESPONSE_MAX_BYTES);
  if (copied === null) return vm.null;
  return jsonHandleFromText(vm, copied.text);
}

/** Parses trusted canonical JSON text inside the guest. The text was produced only after
 * plain-JSON validation, so this evaluation cannot inject executable source. */
function jsonHandleFromText(vm: QuickJSContext, text: string): QuickJSHandle {
  const evaluated = vm.evalCode(`(${text})`, "host-value.json");
  if (evaluated.error !== undefined) {
    evaluated.error.dispose();
    throw new Error("host JSON conversion failed");
  }
  return evaluated.value;
}

/** Accepts only acyclic plain JSON, bounds depth and node count, and returns a deep copy. */
function copyJson(value: unknown, maxBytes: number): JsonCopy | null {
  const ancestors = new Set<object>();
  let nodes = 0;
  const validate = (node: unknown, depth: number): boolean => {
    nodes += 1;
    if (nodes > 200_000 || depth > 128) return false;
    if (node === null || typeof node === "boolean" || typeof node === "string") return true;
    if (typeof node === "number") return Number.isFinite(node);
    if (Array.isArray(node)) {
      if (ancestors.has(node)) return false;
      ancestors.add(node);
      const valid = node.every((member) => validate(member, depth + 1));
      ancestors.delete(node);
      return valid;
    }
    if (typeof node !== "object") return false;
    const prototype = Object.getPrototypeOf(node);
    if (prototype !== Object.prototype && prototype !== null) return false;
    if (ancestors.has(node) || Object.getOwnPropertySymbols(node).length > 0) return false;
    ancestors.add(node);
    for (const key of Object.keys(node)) {
      const descriptor = Object.getOwnPropertyDescriptor(node, key);
      if (descriptor === undefined || !("value" in descriptor) || !validate(descriptor.value, depth + 1)) {
        ancestors.delete(node);
        return false;
      }
    }
    ancestors.delete(node);
    return true;
  };
  if (!validate(value, 0)) return null;
  let text: string;
  try {
    text = JSON.stringify(value);
  } catch {
    return null;
  }
  if (text === undefined) return null;
  const bytes = utf8Bytes(text);
  if (bytes > maxBytes) return null;
  return { value: JSON.parse(text), text, bytes };
}

/** Requires tool arguments to be a bounded plain JSON object. */
function objectArguments(value: unknown): Record<string, unknown> | null {
  const copied = copyJson(value, HUB_HOST_ARGUMENTS_MAX_BYTES);
  if (copied === null || copied.value === null || typeof copied.value !== "object" || Array.isArray(copied.value)) return null;
  return copied.value as Record<string, unknown>;
}

/** Formats one console argument without invoking any host logger. */
function printable(value: unknown): string {
  if (typeof value === "string") return value;
  const copied = copyJson(value, HUB_STDOUT_MAX_BYTES);
  if (copied !== null) return copied.text;
  return Object.prototype.toString.call(value);
}

/** Appends a whole-code-point prefix under one stream's UTF-8 cap. */
function appendOutput(output: CapturedOutput, text: string, maxBytes: number): void {
  const room = maxBytes - output.bytes;
  if (room <= 0) {
    output.truncated = true;
    return;
  }
  const retained = truncateUtf8(text, room);
  output.text += retained.text;
  output.bytes += utf8Bytes(retained.text);
  output.truncated ||= retained.truncated;
}

/** Closed constructor for deterministic named limits. */
function limitResult(name: string, observed: number, mayHaveRun: boolean): Extract<HubExecutionResult, { readonly kind: "limit_exceeded" }> {
  return {
    kind: "limit_exceeded",
    limit: name,
    observed: Math.max(0, Math.floor(observed)),
    transient: false,
    mayHaveRun,
  };
}

/** Closed constructor for bounded runtime failures. */
function runtimeError(
  cause: string,
  message: string,
  stack: string,
  transient: boolean,
  mayHaveRun: boolean,
  stdout: CapturedOutput,
  stderr: CapturedOutput,
): Extract<HubExecutionResult, { readonly kind: "runtime_error" }> {
  return {
    kind: "runtime_error",
    cause,
    message,
    stack,
    stdout: stdout.text,
    stderr: stderr.text,
    stdoutTruncated: stdout.truncated,
    stderrTruncated: stderr.truncated,
    transient,
    mayHaveRun,
  };
}

/** Closed constructor for compiler failures that occur before guest evaluation. */
function typeError(
  diagnostics: readonly HubExecutionDiagnostic[],
): Extract<HubExecutionResult, { readonly kind: "type_error" }> {
  return { kind: "type_error", diagnostics, transient: false, mayHaveRun: false };
}
