/// <reference lib="webworker" />
// worker.ts — the fixed Worker entry, immutable image code (§23.8/§23.9).
//
// WHAT RUNS WHERE: this module is the user program's module worker. It is created by the
// trusted parent (`runner.ts`) with `deno.permissions: "none"`, so it cannot read the
// environment, dial the network, touch the filesystem, or spawn anything — the only
// channel out of it is `postMessage` to the parent, and the parent is what talks to the
// bridge. The submitted program is UNTRUSTED code evaluated in here, which is why every
// value that leaves this module is re-validated by the parent and by the DO.
//
// ORDERING: the snapshot must be installed before `program.ts` evaluates, so this entry
// awaits the parent's first message and then dynamically imports the program. A static
// `import "./installer"; import "./program.ts"` pair does NOT give that order in Deno:
// module evaluation does not wait for a dependency's top-level `await` (verified against
// Deno 2.9.6 — the importing module's later imports evaluate while the awaited dependency
// is still pending), so the program would see `mcp` as undefined. The dynamic import after
// installation is the guarantee, not a convenience.
//
// WHY THE PARENT OWNS THE BRIDGE: the program can craft messages. It can post a call for
// any service or tool name it likes, so the parent resolves names through its own immutable
// map and rejects everything else; and the DO re-checks the canonical target against the
// execution's snapshot, so neither side is a single point of trust.

/** One catalog entry as the snapshot serves it: the minimum this module needs. */
type SnapshotTool = {
  readonly canonicalName: string;
  readonly typescriptName: string | null;
  readonly signature: string;
  readonly declarationUri: string;
  readonly description: string;
  readonly diagnostics: readonly string[];
};

type SnapshotResource = {
  readonly uri: string;
  readonly description: string;
  readonly signature: string;
  readonly declarationUri: string;
  readonly diagnostics: readonly string[];
};

type SnapshotTemplate = {
  readonly uriTemplate: string;
  readonly description: string;
  readonly signature: string;
  readonly declarationUri: string;
  readonly diagnostics: readonly string[];
};

type SnapshotService = {
  readonly service: string;
  readonly typescriptName: string | null;
  readonly tools: readonly SnapshotTool[];
  readonly resources: readonly SnapshotResource[];
  readonly resourceTemplates: readonly SnapshotTemplate[];
  readonly diagnostics: readonly string[];
};

type Snapshot = {
  readonly services: readonly SnapshotService[];
  readonly diagnostics: readonly string[];
  readonly truncated: boolean;
  readonly overflow: string | null;
};

/** §23.11 — the search bounds the in-program helper honors; the wire `search_types` tool
 *  enforces the same numbers at the hub boundary. */
const SEARCH_QUERY_MAX_BYTES = 256;
const SEARCH_LIMIT_DEFAULT = 10;
const SEARCH_LIMIT_MAX = 50;
const SEARCH_RESPONSE_MAX_BYTES = 262_144;

/** §23.2's tie order, mirrored from the hub's catalog search so a program's local search
 *  ranks exactly like the wire tool's. */
const KIND_ORDER: Readonly<Record<string, number>> = { tool: 0, resource: 1, resourceTemplate: 2, hubTool: 3 };

/** The parent's answer to one bridge request, as it arrives here. */
type BridgeAnswer = {
  readonly id: string;
  readonly ok: boolean;
  readonly result?: unknown;
  readonly error?: { readonly code?: number; readonly message?: string; readonly data?: unknown };
  readonly limit?: { readonly name: string; readonly observed: number; readonly transient: boolean; readonly mayHaveRun: boolean };
};

/** The typed error an inner operation rejects with: a real `Error`, plus the JSON-RPC
 *  code and data the hub's error vocabulary carries, plus the hub limit when the refusal
 *  was a limit — that last field is what lets an uncaught limit classify the whole run. */
class HubOperationError extends Error {
  readonly code: number;
  readonly data: unknown;
  readonly limit: BridgeAnswer["limit"];

  constructor(code: number, message: string, data: unknown, limit: BridgeAnswer["limit"]) {
    super(message);
    this.name = "HubOperationError";
    this.code = code;
    this.data = data;
    this.limit = limit;
  }
}

// §23.9 — the parent transfers a private bridge port before program import. The lexical
// reference is never exposed through `globalThis`, so user calls to `self.postMessage`
// cannot forge bridge traffic or the final outcome.
const setup = await new Promise<{ readonly snapshot: Snapshot; readonly bridge: MessagePort }>((resolve) => {
  self.onmessage = (event: MessageEvent) => {
    resolve(event.data as { readonly snapshot: Snapshot; readonly bridge: MessagePort });
  };
});
const snapshot = setup.snapshot;
const parentPort = setup.bridge;
const sendParent = parentPort.postMessage.bind(parentPort);
const getOwnPropertyDescriptors = Object.getOwnPropertyDescriptors.bind(Object);
const getPrototypeOf = Object.getPrototypeOf.bind(Object);
const ownKeys = Reflect.ownKeys.bind(Reflect);
const plainObjectPrototype = Object.prototype;

const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: unknown) => void }>();
let nextRequestId = 0;

// From here on every private-port inbound message is a bridge answer.
parentPort.onmessage = (event: MessageEvent) => {
  const answer = event.data as BridgeAnswer;
  const waiter = pending.get(answer.id);
  if (waiter === undefined) return;
  pending.delete(answer.id);
  if (answer.ok) {
    waiter.resolve(answer.result);
    return;
  }
  const error = answer.error ?? {};
  waiter.reject(
    new HubOperationError(
      typeof error.code === "number" ? error.code : -32603,
      typeof error.message === "string" ? error.message : "internal error",
      error.data ?? (answer.limit === undefined ? undefined : { limit: answer.limit }),
      answer.limit,
    ),
  );
};

/** One request to the parent; the promise settles when the answer arrives. */
function request(message: Record<string, unknown>): Promise<unknown> {
  const id = `r${++nextRequestId}`;
  const { promise, resolve, reject } = Promise.withResolvers<unknown>();
  pending.set(id, { resolve, reject });
  sendParent({ id, ...message });
  return promise;
}

/** §23.7 — `mcp.<service>.<tool>(input)`: a call through the trusted bridge, resolved from
 *  TypeScript names by the parent and re-checked against the snapshot by the DO. */
function callTool(service: string, tool: string, input: unknown): Promise<unknown> {
  return request({ op: "call", service, tool, input });
}

/** §23.7 — `mcp.<service>.resources.read(rawUri)`: the URI stays raw; the gateway matches
 *  it against the caller's CURRENT resource grants. */
function readResource(service: string, uri: string): Promise<unknown> {
  return request({ op: "read", service, uri });
}

/** §23.7 — `mcp.hub.searchTypes(input)`: a local search over the immutable snapshot, with
 *  no bridge call and no audit row. */
function searchTypes(snapshot: Snapshot, input: unknown): Record<string, unknown> {
  const record = input !== null && typeof input === "object" ? (input as Record<string, unknown>) : {};
  if (typeof record.query !== "string") throw new TypeError("invalid search query");
  if (new TextEncoder().encode(record.query).byteLength > SEARCH_QUERY_MAX_BYTES) {
    throw new TypeError("invalid search query");
  }
  const query = record.query.trim().toLowerCase();
  const rawLimit = record.limit ?? SEARCH_LIMIT_DEFAULT;
  if (typeof rawLimit !== "number" || !Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > SEARCH_LIMIT_MAX) {
    throw new TypeError("invalid search limit");
  }
  const limit = rawLimit;
  if (query.length === 0) throw new TypeError("invalid search query");

  type Candidate = {
    readonly match: Record<string, unknown>;
    readonly haystack: readonly string[];
    readonly description: string;
  };
  const candidates: Candidate[] = [];
  for (const service of snapshot.services) {
    if (service.typescriptName === null) continue;
    for (const tool of service.tools) {
      if (tool.typescriptName === null) continue;
      const path = `mcp.${service.typescriptName}.${tool.typescriptName}`;
      candidates.push({
        match: {
          kind: "tool",
          surface: "program",
          path,
          service: service.service,
          subject: tool.canonicalName,
          signature: tool.signature,
          uri: tool.declarationUri,
          ...(mergeDiagnostics(service.diagnostics, tool.diagnostics).length === 0
            ? {}
            : { diagnostics: mergeDiagnostics(service.diagnostics, tool.diagnostics) }),
        },
        haystack: [path.toLowerCase(), service.service.toLowerCase(), tool.canonicalName.toLowerCase()],
        description: tool.description.toLowerCase(),
      });
    }
    for (const resource of service.resources) {
      candidates.push({
        match: {
          kind: "resource",
          surface: "program",
          path: `mcp.${service.typescriptName}.resources.read`,
          service: service.service,
          subject: resource.uri,
          signature: resource.signature,
          uri: resource.declarationUri,
          ...(service.diagnostics.length === 0 ? {} : { diagnostics: service.diagnostics }),
        },
        haystack: [`mcp.${service.typescriptName}.resources.read`.toLowerCase(), service.service.toLowerCase(), resource.uri.toLowerCase()],
        description: resource.description.toLowerCase(),
      });
    }
    for (const template of service.resourceTemplates) {
      candidates.push({
        match: {
          kind: "resourceTemplate",
          surface: "program",
          path: `mcp.${service.typescriptName}.resources.read`,
          service: service.service,
          subject: template.uriTemplate,
          signature: template.signature,
          uri: template.declarationUri,
          ...(service.diagnostics.length === 0 ? {} : { diagnostics: service.diagnostics }),
        },
        haystack: [
          `mcp.${service.typescriptName}.resources.read`.toLowerCase(),
          service.service.toLowerCase(),
          template.uriTemplate.toLowerCase(),
        ],
        description: template.description.toLowerCase(),
      });
    }
  }
  // The one hub-owned tool a PROGRAM can call; the client facade's `execute` is
  // deliberately absent from this surface.
  candidates.push({
    match: {
      kind: "hubTool",
      surface: "program",
      path: "mcp.hub.searchTypes",
      service: "hub",
      subject: "search_types",
      signature: "searchTypes(input?: unknown): Promise<HubSearchResult>",
      uri: "pmcp://hub/types/program.d.ts",
    },
    haystack: ["mcp.hub.searchtypes", "hub", "search_types"],
    description: "search the caller-visible TypeScript declaration surface",
  });

  const tierOf = (candidate: Candidate): number | null => {
    if (candidate.haystack.some((value) => value === query)) return 0;
    if (candidate.haystack.some((value) => value.startsWith(query))) return 1;
    if (candidate.haystack.some((value) => value.includes(query))) return 2;
    if (candidate.description.includes(query)) return 3;
    return null;
  };
  const ranked = candidates
    .flatMap((candidate) => {
      const tier = tierOf(candidate);
      return tier === null ? [] : [{ candidate, tier }];
    })
    .sort(
      (left, right) =>
        left.tier - right.tier ||
        (KIND_ORDER[String(left.candidate.match.kind)] ?? 9) - (KIND_ORDER[String(right.candidate.match.kind)] ?? 9) ||
        compare(String(left.candidate.match.service), String(right.candidate.match.service)) ||
        compare(String(left.candidate.match.subject), String(right.candidate.match.subject)),
    );

  const notes: string[] = [];
  if (snapshot.overflow !== null) notes.push(snapshot.overflow);
  const limited = ranked.slice(0, limit);
  if (limited.length < ranked.length) notes.push(`more than ${limit} matches; the ranked prefix is returned`);
  const serialize = (chosenMatches: readonly Record<string, unknown>[], chosenDiagnostics: readonly string[]): string =>
    JSON.stringify({
      matches: chosenMatches,
      incomplete: false,
      ...(chosenDiagnostics.length === 0 ? {} : { diagnostics: chosenDiagnostics }),
    });
  const fits = (chosenMatches: readonly Record<string, unknown>[], chosenDiagnostics: readonly string[]): boolean =>
    utf8Bytes(serialize(chosenMatches, chosenDiagnostics)) <= SEARCH_RESPONSE_MAX_BYTES;

  const matches: Record<string, unknown>[] = [];
  for (const entry of limited) {
    const next = [...matches, entry.candidate.match];
    if (!fits(next, [])) break;
    matches.push(entry.candidate.match);
  }
  const byteCut = matches.length < limited.length;
  if (byteCut) notes.push(`the serialized response cap ${SEARCH_RESPONSE_MAX_BYTES} bytes cut the ranked matches`);

  const allDiagnostics = mergeDiagnostics(notes, snapshot.diagnostics);
  const diagnostics: string[] = [];
  for (const diagnostic of allDiagnostics) {
    const next = [...diagnostics, diagnostic];
    if (!fits(matches, next)) break;
    diagnostics.push(diagnostic);
  }
  if (diagnostics.length < allDiagnostics.length) {
    const marker = "additional diagnostics omitted";
    while (diagnostics.length > 0 && !fits(matches, [...diagnostics, marker])) diagnostics.pop();
    if (fits(matches, [...diagnostics, marker])) diagnostics.push(marker);
  }
  const incomplete = snapshot.truncated || limited.length < ranked.length || byteCut;
  return diagnostics.length === 0 ? { matches, incomplete } : { matches, incomplete, diagnostics };
}

function mergeDiagnostics(...groups: readonly (readonly string[])[]): string[] {
  return [...new Set(groups.flat())];
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

/** §23.7 — installs the frozen `mcp` global: one namespace per resolved service, the
 *  structured resource API, and the local hub search helper. Read-only and
 *  non-configurable, so the program cannot swap the surface the declarations describe. */
function installMcp(snapshot: Snapshot): void {
  const root: Record<string, unknown> = {};
  for (const service of snapshot.services) {
    if (service.typescriptName === null) continue;
    const namespace: Record<string, unknown> = {};
    for (const tool of service.tools) {
      if (tool.typescriptName === null) continue;
      const serviceAlias = service.typescriptName;
      const toolAlias = tool.typescriptName;
      namespace[toolAlias] = (input?: unknown) => callTool(serviceAlias, toolAlias, input);
    }
    const serviceAlias = service.typescriptName;
    namespace.resources = Object.freeze({
      list: () => service.resources.map((resource) => ({ uri: resource.uri, description: resource.description })),
      templates: () => service.resourceTemplates.map((template) => ({ uriTemplate: template.uriTemplate, description: template.description })),
      read: (uri: string) => readResource(serviceAlias, uri),
    });
    root[serviceAlias] = Object.freeze(namespace);
  }
  root.hub = Object.freeze({ searchTypes: (input?: unknown) => Promise.resolve(searchTypes(snapshot, input)) });
  Object.defineProperty(globalThis, "mcp", { value: Object.freeze(root), writable: false, configurable: false });
}

/** The sanitized failure class a postMessage can carry; never a message, never a stack. */
function errorName(thrown: unknown): string {
  const name = thrown instanceof Error ? thrown.name : "Error";
  return /^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(name) ? name : "Error";
}

/** Rejects accessors and non-JSON shapes before structured clone can flatten them. The
 * captured intrinsics cannot be replaced by the imported program, and the ancestor set
 * permits repeated acyclic references while still refusing cycles. */
function validResult(
  node: unknown,
  ancestors = new Set<object>(),
  depth = 0,
): boolean {
  if (depth > 128) return false;
  if (node === null || typeof node === "boolean" || typeof node === "string") return true;
  if (typeof node === "number") return Number.isFinite(node);
  if (typeof node !== "object") return false;
  if (ancestors.has(node)) return false;
  ancestors.add(node);
  try {
    const descriptors = getOwnPropertyDescriptors(node);
    for (const key of ownKeys(descriptors)) {
      const descriptor = descriptors[key as keyof typeof descriptors];
      if (descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined) {
        return false;
      }
    }
    if (Array.isArray(node)) {
      for (let at = 0; at < node.length; at += 1) {
        const descriptor = descriptors[String(at)];
        if (descriptor === undefined || !("value" in descriptor) ||
            !validResult(descriptor.value, ancestors, depth + 1)) return false;
      }
      return true;
    }
    const prototype = getPrototypeOf(node);
    if (prototype !== plainObjectPrototype && prototype !== null) return false;
    for (const key of ownKeys(descriptors)) {
      if (typeof key !== "string") return false;
      const descriptor = descriptors[key];
      if (descriptor?.enumerable === true &&
          (!("value" in descriptor) || !validResult(descriptor.value, ancestors, depth + 1))) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  } finally {
    ancestors.delete(node);
  }
}

installMcp(snapshot);

// §23.7/§23.8 — the program is imported only AFTER `mcp` exists. A static import cannot
// preserve that ordering because dependencies evaluate before this module body. Top-level
// await in the submitted program remains legal through this deliberately dynamic boundary.
try {
  const program = (await import("./program.ts")) as { default?: unknown };
  if (program.default === undefined) throw new TypeError("the module has no default export");
  const value = await program.default;
  if (!validResult(value)) {
    sendParent({ kind: "error", error: { name: "InvalidResult" } });
  } else {
    try {
      sendParent({ kind: "done", value });
    } catch {
      sendParent({ kind: "error", error: { name: "InvalidResult" } });
    }
  }
} catch (thrown) {
  const limit = thrown instanceof HubOperationError ? thrown.limit : undefined;
  sendParent({
    kind: "error",
    error: { name: errorName(thrown) },
    ...(limit === undefined ? {} : { limit }),
  });
}
