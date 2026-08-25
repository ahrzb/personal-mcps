/**
 * tunnel/pipeline-tunnel.test.ts — §16's core integration test: a consumer POSTs into
 * the real worker entry, a fake service answers over a real WebSocket through the real
 * ServiceConnection DO, and everything in between is production code. Four green unit
 * tests compose into a wrong pipeline; only the pipeline exhibits the pipeline's bugs
 * (strategy §1), so this file is where both endpoint shapes, role filtering, `_meta`
 * hygiene and the audit chokepoint are pinned END TO END rather than per function.
 *
 * WHAT THIS SUITE PINS. That both endpoint shapes are ONE pipeline — the same call
 * reaches the same tool with the same params through `/<user>/mcp` and
 * `/<user>/mcp/<slug>`, prefixed and unprefixed; role filtering bounding both the
 * listing and the call; `_meta` hygiene as the SERVICE observes it (consumer-supplied
 * `hub/*` keys stripped then the hub's own set — overwrite, never merge; the consumer's
 * clientCapabilities mirrored, `{}` when absent; everything else untouched); that
 * JSON-RPC ids never cross the socket in either direction; that `writeOnly` is stripped
 * from served outputSchemas while inputSchemas keep theirs; the 30 s call deadline
 * mapping to -32000; and the audit chokepoint — every tools/call resolves into exactly
 * one awaited row carrying hub-measured duration_ms, while tools/list produces none.
 *
 * WHAT IT DOES NOT PIN. The check ORDER table (filter → archived → approval →
 * availability) is worker/order.table.test.ts's, socket-free and exhaustive there; this
 * file assumes it. The approval gate itself is approval-e2e.test.ts's. Redaction
 * *grammar* is unit/redact.test.ts's, and the audit body TABLE is
 * worker/hygiene.test.ts's — here the only body claim is the direction one: what the
 * consumer receives is never redacted, while the row written for that same call is.
 *
 * Durable vs incidental (§7): the `hub/*` reservation, strip-then-set, the prefix
 * split, id non-crossing, and "a resolved call is audited exactly once" are durable.
 * Incidental and unasserted: audit `detail` layout, the ttlMs/cacheScope values, listing
 * order, and every timeout literal — the deadline case reads limits.CALL_TIMEOUT_MS
 * (shrunk for the run) and pins THAT a deadline is enforced, never how long it is.
 *
 * Project: `tunnel` — workerd, serial (`--max-workers=1 --no-isolate`): a live socket
 * and a real DO on every case (strategy §2). The consumer side is driven through
 * `exports.default.fetch` from `cloudflare:workers` — SELF is deprecated — so the
 * request crosses the same router, auth and handler wiring production uses.
 *
 * Isolation and ordering, load-bearing: smoke.test.ts green first, then protocol and
 * lifecycle, which own the handshake and the close codes this file merely relies on.
 * D1 migrations are applied once by the project setup file (read Node-side with
 * readD1Migrations, applied with applyD1Migrations — idempotent); with --no-isolate the
 * database is shared across this project's files, so every case seeds its own owner,
 * service, account and tokens, and asserts on rows it created rather than on counts.
 * Nothing sleeps: the never-answering service reaches the deadline against a shrunk
 * constant, and the fake service's release gates make ordering explicit.
 */

// deps: harness/seed · harness/fake-service · cloudflare:workers (exports.default.fetch) · cloudflare:test (env.SERVICE_CONNECTION, runInDurableObject) · src/gateway (JsonRpcRequest, JsonRpcResponse, Tool) · src/tunnel (tunnelBackend, ServiceConnection) · src/audit (query) · src/registry (Registry, buildToolFilter) · src/limits (CALL_TIMEOUT_MS)

import { describe, it } from "vitest";
import type { JsonRpcRequest } from "../../src/gateway";

/**
 * The consumer request each hygiene row sends: an ordinary tools/call whose
 * `params._meta` is the row's `sent` map. Spelled from {@link JsonRpcRequest} so the
 * table describes the message the gateway actually parses, and so `params` narrows to
 * the three keys §7 contracts this module to touch.
 */
export type ConsumerCall = JsonRpcRequest & {
  method: "tools/call";
  params: { name: string; arguments?: Record<string, unknown>; _meta?: Record<string, unknown> };
};

/**
 * One row of the `_meta` hygiene table — the §7 reservation as data, always observed AT
 * THE SERVICE (the fake service records the frame it received) rather than by
 * inspecting the gateway, because "a consumer cannot inject `hub/*`" is a claim about
 * what a service sees.
 *
 * Three columns, because §7 makes exactly three promises about a forwarded `_meta`:
 * `absent` — keys the service must not see at all (every consumer-supplied `hub/*`
 * copy); `passthrough` — keys that must arrive byte-identical to what the consumer sent
 * (progressToken, vendor keys, MRTR inputResponses/requestState); `written` — keys the
 * hub sets itself, whose values are the hub's own resolution (hub/principal, hub/roles,
 * the mirrored clientCapabilities) and never the consumer's.
 */
export type MetaHygieneRow = {
  /** Test title, in the doc's convention: "§7 · <what this row pins>". */
  name: string;
  /** Who calls — owners forward roles ["all"] literally; accounts forward what they hold. */
  caller: "owner" | "service_account";
  sent: Record<string, unknown>;
  absent: readonly string[];
  passthrough: readonly string[];
  written: Record<string, unknown>;
};

/**
 * The `_meta` hygiene table. Rows are OWNER-AUTHORED in a separate commit before
 * implementation (strategy §9 rule 1) — agents never fill them. Every stripping row
 * carries its passthrough twin in the same row (§9 rule 2): a suite that only proved
 * deletion is satisfied by forwarding no `_meta` at all.
 */
export const metaHygieneRows: readonly MetaHygieneRow[] = [];

/**
 * Runs one hygiene row: seeds the caller, sends the row's ConsumerCall through
 * `exports.default.fetch`, and asserts the three columns against the frame the fake
 * service recorded — plus, always, that the response the consumer receives bears the
 * consumer's own id.
 */
export async function runMetaHygieneCase(row: MetaHygieneRow): Promise<void> {
  // deps: harness/seed · harness/fake-service · cloudflare:workers exports.default.fetch
  throw new Error("unimplemented");
}

describe("§7 both endpoint shapes, one pipeline", () => {
  it.todo("1. §7 · scoped tools/list serves the caller's filtered catalog with unprefixed names");
  it.todo("2. §7 · aggregated tools/list prefixes `<slug>_` and spans only services the caller holds a grant on");
  it.todo("3. §7 · the same tool called through both shapes reaches the service with identical params — the prefix is split before anything else runs");
  it.todo("4. §7 · role filtering bounds both surfaces: a tool outside the granted patterns is absent from the listing and answers -32001 on call, while a matched tool lists and executes (the refusal and its allow-twin in one pair)");
  it.todo("5. §7 · a granted role the service has not declared yields an empty listing and -32001 — not a 404: the account still holds a grant");
  it.todo("6. §7 · served outputSchemas carry no `writeOnly` while inputSchemas keep theirs, and the DO's cached catalog still holds both verbatim (stripping is serving-time, never storage-time)");
});

describe("§7 `_meta` hygiene, observed at the service", () => {
  it.todo("7. §7 · hygiene table — one case per row of `metaHygieneRows`, driven by runMetaHygieneCase");
  it.todo("8. §7 · a forged consumer `hub/roles` never reaches the service; the hub's own resolution arrives in its place (strip-then-set, overwrite never merge)");
  it.todo("9. §7 · progressToken and unrecognized vendor `_meta` keys arrive untouched — the allow-twin of case 8");
  it.todo("10. §7 · the consumer's clientCapabilities are mirrored onto the forwarded request, and a consumer that declared none forwards `{}` so the service refrains from elicitation");
  it.todo("11. §7 · an owner's call forwards hub/roles [\"all\"] literally, never expanded into the service's declared role names");
  it.todo("12. §6 · ids never cross: the consumer's JSON-RPC id never appears on the socket, and the response the consumer receives bears the consumer's id, not the wire id");
});

describe("§15 deadline, disconnect, and the audit chokepoint", () => {
  it.todo("13. §15 · a service that never answers fails -32000 at limits.CALL_TIMEOUT_MS — asserted against the constant with the run's value shrunk, never waited out");
  it.todo("14. §15 · a disconnect mid-call fails the waiting consumer -32000 immediately rather than at the deadline (the allow-twin: a service that answers in time resolves)");
  it.todo("15. §15 · an offline service fails -32000 on call while its cached tools/list still lists tools — the pair that keeps \"unavailable\" from meaning \"invisible\"");
  it.todo("16. §15 · every resolved tools/call writes exactly one audit row carrying a hub-measured duration_ms");
  it.todo("17. §15 · a denied tools/call writes one row too, with its refusal code as outcome — denials are just fast (the twin of case 16)");
  it.todo("18. §15 · tools/list writes no audit row on either endpoint shape — kept out by vocabulary, not by filtering");
  it.todo("19. §15 · a failed audit write fails the call: the ledger is chosen over availability");
  it.todo("20. §7 · the consumer's relayed result is never masked, while the audit row written for that same call is — masking exists for persistence, not for the wire");
});
