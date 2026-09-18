// runner.ts — the trusted parent process, immutable image code (§23.9).
//
// HOW IT IS LAUNCHED, exactly (hub-runtime.ts's `hubRunArgv` builds this line, and the
// config test keeps the two in step):
//
//   /usr/bin/deno run --unstable-worker-options --no-prompt --frozen --cached-only
//     --no-remote --no-npm --allow-net=mcp.internal:80 --allow-read=/workspace/pmcp-exec
//     --allow-write=/workspace/pmcp-exec/result.json --allow-env=PMCP_EXECUTION_ID runner.ts
//
// THE PERMISSION SPLIT: this process is the ONLY thing in the container with any
// permission at all — read access to the fresh run directory, write access to exactly one
// result-envelope path, network access to exactly `mcp.internal:80`, and the single
// environment variable carrying the generation nonce. The module worker it creates
// (`worker.ts`) runs with `deno.permissions: "none"`, so the untrusted program inside it
// cannot read files, dial anything, spawn a process, or write the envelope directly. It
// may forge worker messages, so every message is treated as untrusted input below.
//
// WHAT THIS PARENT IS TRUSTED TO DO, and only this: resolve the program's TypeScript names
// through the immutable map built from `snapshot.json`, shape one bounded JSON body per
// bridge request, present the nonce, and serialize the program's default export into the
// envelope under its byte cap. It never sees a credential (the nonce is not one), never
// logs anything, and writes nothing to stdout/stderr — the captured streams belong to the
// program alone.
//
// The files here are image code copied into each fresh run directory before the run; this
// file never reads `program.ts` or `program.d.ts` — the checker and the worker's module
// graph do that.

/** §23.11 — the JSON serialization cap for the default export. */
const RESULT_MAX_BYTES = 262_144;
/** §23.11 — the same inner-operation caps the DO enforces; this parent fails fast rather
 *  than sending a request it knows will be refused. */
const INNER_OPERATIONS_MAX = 32;
const INNER_CONCURRENCY_MAX = 4;
/** §23.11 — the most bytes one serialized bridge request body may have. */
const BRIDGE_ARGUMENTS_MAX_BYTES = 262_144;
/** The deepest nesting a default export may have before it is refused as unshippable;
 *  a JSON document that deep cannot be a useful result and would risk the serializer's
 *  own stack. */
const RESULT_MAX_DEPTH = 128;
/** The most values a default export may contain before the refusal is a limit rather than
 *  a shape error. */
const RESULT_MAX_NODES = 200_000;
/** Limit names the trusted worker/bridge may report. A forged message cannot invent a
 * result classification or make the parent serialize an unbounded name. */
const WORKER_LIMIT_NAMES = new Set([
  "bridge_arguments",
  "bridge_response",
  "inner_concurrency",
  "inner_operations",
  "result_bytes",
]);

const nonce = Deno.env.get("PMCP_EXECUTION_ID") ?? "";
const resultUrl = new URL("./result.json", import.meta.url);
const snapshotUrl = new URL("./snapshot.json", import.meta.url);

type SnapshotTool = { readonly canonicalName: string; readonly typescriptName: string | null };
type SnapshotService = {
  readonly service: string;
  readonly appId: string;
  readonly typescriptName: string | null;
  readonly tools: readonly SnapshotTool[];
};
type Snapshot = { readonly services: readonly SnapshotService[] };

/** The explicit mapping, resolved once from the same snapshot the program was declared
 *  against. A name that is not in here is refused: caller-supplied canonical targets are
 *  never forwarded, whatever a crafted worker message claims. */
const serviceMap = new Map<string, { readonly canonical: string; readonly appId: string; readonly tools: Map<string, string> }>();

const snapshotText = await Deno.readTextFile(snapshotUrl);
const snapshot = JSON.parse(snapshotText) as Snapshot;
for (const service of snapshot.services) {
  if (service.typescriptName === null) continue;
  const tools = new Map<string, string>();
  for (const tool of service.tools) {
    if (tool.typescriptName !== null) tools.set(tool.typescriptName, tool.canonicalName);
  }
  serviceMap.set(service.typescriptName, { canonical: service.service, appId: service.appId, tools });
}

let inFlight = 0;
let dispatched = 0;
let settled = false;

const worker = new Worker(new URL("./worker.ts", import.meta.url), {
  type: "module",
  deno: { permissions: "none" },
});
const channel = new MessageChannel();
const bridge = channel.port1;

/** Writes the one envelope, terminates the worker, and ends the process. The envelope is
 *  built by concatenation so the bounded value text is never re-serialized. */
async function finish(envelope: string): Promise<void> {
  if (settled) return;
  settled = true;
  // Completed values are capped by the serializer and error envelopes are constructed
  // from allowlisted bounded fields; this final guard keeps that invariant local.
  if (utf8Bytes(envelope) > RESULT_MAX_BYTES + 4_096) Deno.exit(1);
  try {
    await Deno.writeTextFile(resultUrl, envelope);
  } catch {
    // No envelope means no result: the DO reads that as a failed run, never a fabricated
    // value. A nonzero exit makes the same point at the process level.
    Deno.exit(1);
  }
  worker.terminate();
  Deno.exit(0);
}

const safeErrorName = (value: unknown): string =>
  typeof value === "string" && /^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(value) ? value : "Error";

const errorEnvelope = (name: string, limit?: { readonly name: string; readonly observed: number }): string =>
  `{"status":"error","error":{"name":${JSON.stringify(safeErrorName(name))}}` +
  (limit === undefined ? "" : `,"limit":{"name":${JSON.stringify(limit.name)},"observed":${Math.max(0, Math.floor(limit.observed))}}`) +
  "}";

const limitEnvelope = (name: string, observed: number): string => errorEnvelope("LimitRefused", { name, observed });

/** One POST to the fixed bridge path, with the nonce header. A non-200 answer is a
 *  protocol refusal (bad nonce, cancelled execution, unknown path): the program receives a
 *  typed error, and the DO discards the run either way. */
async function bridgePost(path: string, payload: unknown): Promise<{ ok: boolean; answer: Record<string, unknown> }> {
  const body = JSON.stringify(payload);
  if (utf8Bytes(body) > BRIDGE_ARGUMENTS_MAX_BYTES) {
    return { ok: false, answer: { ok: false, error: { code: -32000, message: "hub limit exceeded: bridge_arguments" }, limit: { name: "bridge_arguments", observed: utf8Bytes(body), transient: false, mayHaveRun: dispatched > 0 } } };
  }
  const response = await fetch(`http://mcp.internal:80${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-pmcp-nonce": nonce },
    body,
  });
  if (!response.ok) {
    return { ok: false, answer: { ok: false, error: { code: -32000, message: "bridge refused" } } };
  }
  const answer = (await response.json()) as Record<string, unknown>;
  return { ok: answer.ok === true, answer };
}

/** One message from the wrapper's private port: a bridge request or the run's outcome.
 * User code shares the Worker global but never receives this port, so direct
 * `self.postMessage` calls cannot forge requests or completion. */
bridge.onmessage = (event: MessageEvent) => {
  void (async () => {
    const message = event.data as Record<string, unknown>;
    const id = typeof message.id === "string" ? message.id : null;
    const kind = message.kind;
    if (kind === "done") {
      const serialized = serializeBounded(message.value);
      if (serialized.ok) await finish(`{"status":"completed","value":${serialized.text}}`);
      else if (serialized.error === "limit") await finish(limitEnvelope(serialized.limit.name, serialized.limit.observed));
      else await finish(errorEnvelope("InvalidResult"));
      return;
    }
    if (kind === "error") {
      const error = message.error;
      const name =
        error !== null && typeof error === "object" && "name" in error
          ? safeErrorName(error.name)
          : "Error";
      const limit = message.limit;
      let boundedLimit: { name: string; observed: number } | undefined;
      if (limit !== null && typeof limit === "object" && "name" in limit && "observed" in limit) {
        const observed = limit.observed;
        if (
          typeof limit.name === "string" &&
          WORKER_LIMIT_NAMES.has(limit.name) &&
          typeof observed === "number" &&
          Number.isSafeInteger(observed) &&
          observed >= 0
        ) {
          boundedLimit = { name: limit.name, observed };
        }
      }
      await finish(errorEnvelope(name, boundedLimit));
      return;
    }
    // From here on it is a bridge request; without an id there is nobody to answer.
    if (id === null) return;
    const operation = message.op;
    if (operation === "call") {
      await handleCall(id, message);
      return;
    }
    if (operation === "read") {
      await handleRead(id, message);
      return;
    }
    reply(id, { ok: false, error: { code: -32601, message: "method not found" } });
  })();
};

worker.onerror = () => {
  // An uncaught error escaped the worker (module evaluation, an unhandled rejection, a
  // postMessage failure). Only the class leaves; the program's own output stays in the
  // captured streams.
  void finish(errorEnvelope("Error"));
};

/** `mcp.<service>.<tool>(input)` — resolve both TypeScript names, enforce the local
 *  counters, then one bounded bridge POST carrying canonical identities. */
async function handleCall(id: string, message: Record<string, unknown>): Promise<void> {
  const service = typeof message.service === "string" ? serviceMap.get(message.service) : undefined;
  const tool = service === undefined || typeof message.tool !== "string" ? undefined : service.tools.get(message.tool);
  if (service === undefined || tool === undefined) {
    reply(id, { ok: false, error: { code: -32001, message: "tool not permitted" } });
    return;
  }
  const input = message.input;
  if (input !== undefined && (input === null || typeof input !== "object" || Array.isArray(input))) {
    reply(id, { ok: false, error: { code: -32602, message: "invalid params" } });
    return;
  }
  if (inFlight >= INNER_CONCURRENCY_MAX) {
    reply(id, limitAnswer("inner_concurrency", inFlight));
    return;
  }
  if (dispatched >= INNER_OPERATIONS_MAX) {
    reply(id, limitAnswer("inner_operations", dispatched));
    return;
  }
  inFlight += 1;
  dispatched += 1;
  try {
    const result = await bridgePost("/bridge/call", { service: service.canonical, appId: service.appId, tool, args: input });
    reply(id, result.answer);
  } catch {
    reply(id, { ok: false, error: { code: -32000, message: "app unavailable" } });
  } finally {
    inFlight -= 1;
  }
}

/** `mcp.<service>.resources.read(rawUri)` — the service name is resolved, the URI stays
 *  exactly as the program wrote it (the gateway matches raw URIs against current grants). */
async function handleRead(id: string, message: Record<string, unknown>): Promise<void> {
  const service = typeof message.service === "string" ? serviceMap.get(message.service) : undefined;
  if (service === undefined || typeof message.uri !== "string") {
    reply(id, { ok: false, error: { code: -32001, message: "tool not permitted" } });
    return;
  }
  if (inFlight >= INNER_CONCURRENCY_MAX) {
    reply(id, limitAnswer("inner_concurrency", inFlight));
    return;
  }
  if (dispatched >= INNER_OPERATIONS_MAX) {
    reply(id, limitAnswer("inner_operations", dispatched));
    return;
  }
  inFlight += 1;
  dispatched += 1;
  try {
    const result = await bridgePost("/bridge/read", { service: service.canonical, appId: service.appId, uri: message.uri });
    reply(id, result.answer);
  } catch {
    reply(id, { ok: false, error: { code: -32000, message: "app unavailable" } });
  } finally {
    inFlight -= 1;
  }
}

function reply(id: string, answer: Record<string, unknown>): void {
  bridge.postMessage({ id, ...answer });
}

function limitAnswer(name: string, observed: number): Record<string, unknown> {
  return {
    ok: false,
    error: { code: -32000, message: `hub limit exceeded: ${name}` },
    limit: { name, observed, transient: false, mayHaveRun: dispatched > 0 },
  };
}

type BoundedResult =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly error: "invalid" }
  | { readonly ok: false; readonly error: "limit"; readonly limit: { readonly name: string; readonly observed: number } };

/**
 * §23.11 — bounded, acyclic-JSON serialization for the default export. Accepts null,
 * booleans, strings, finite numbers, arrays, and plain string-keyed objects; refuses every
 * non-JSON type, non-plain prototype, and cycle. It stops once serialized bytes exceed the
 * cap. Accessors are rejected by the trusted wrapper before its private-port structured
 * clone; these checks remain authoritative for the value that arrived.
 */
function serializeBounded(value: unknown): BoundedResult {
  const out: string[] = [];
  const seen = new Set<object>();
  let bytes = 0;
  let nodes = 0;
  const append = (text: string): boolean => {
    bytes += utf8Bytes(text);
    if (bytes > RESULT_MAX_BYTES) return false;
    out.push(text);
    return true;
  };
  const walk = (node: unknown, depth: number): "ok" | "invalid" | "limit" => {
    if (depth > RESULT_MAX_DEPTH) return "invalid";
    nodes += 1;
    if (nodes > RESULT_MAX_NODES) return "limit";
    if (node === null) return append("null") ? "ok" : "limit";
    switch (typeof node) {
      case "boolean":
        return append(node ? "true" : "false") ? "ok" : "limit";
      case "number":
        return Number.isFinite(node) ? (append(JSON.stringify(node)) ? "ok" : "limit") : "invalid";
      case "string":
        return append(JSON.stringify(node)) ? "ok" : "limit";
      case "undefined":
      case "bigint":
      case "function":
      case "symbol":
        return "invalid";
      default:
        break;
    }
    if (Array.isArray(node)) {
      if (seen.has(node)) return "invalid";
      seen.add(node);
      try {
        if (!append("[")) return "limit";
        for (let at = 0; at < node.length; at += 1) {
          if (at > 0 && !append(",")) return "limit";
          const step = walk(node[at], depth + 1);
          if (step !== "ok") return step;
        }
        return append("]") ? "ok" : "limit";
      } finally {
        seen.delete(node);
      }
    }
    const record = node as Record<string, unknown>;
    const prototype = Object.getPrototypeOf(record);
    if (prototype !== Object.prototype && prototype !== null) return "invalid";
    if (seen.has(record)) return "invalid";
    seen.add(record);
    try {
      if (!append("{")) return "limit";
      let first = true;
      for (const key of Object.keys(record)) {
        const member = record[key];
        if (member === undefined) return "invalid";
        if (!first && !append(",")) return "limit";
        first = false;
        if (!append(JSON.stringify(key)) || !append(":")) return "limit";
        const step = walk(member, depth + 1);
        if (step !== "ok") return step;
      }
      return append("}") ? "ok" : "limit";
    } finally {
      seen.delete(record);
    }
  };
  const verdict = walk(value, 0);
  if (verdict === "ok") return { ok: true, text: out.join("") };
  if (verdict === "limit") return { ok: false, error: "limit", limit: { name: "result_bytes", observed: bytes } };
  return { ok: false, error: "invalid" };
}

function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

// §23.9 — the snapshot and private bridge port go to the wrapper before program import.
worker.postMessage({ snapshot, bridge: channel.port2 }, [channel.port2]);