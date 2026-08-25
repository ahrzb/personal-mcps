// admin-pipeline.test.ts — the builtin `pmcp` service through the REAL endpoint (§8, §7).
//
// What this suite pins: that admin is not a special case. §8 makes the builtin a third
// ServiceBackend riding the same pipeline as tunnel and upstream, and the only way to
// pin "no special case" is to reach it the way a consumer does — `POST /<user>/mcp` and
// `POST /<user>/mcp/pmcp` — rather than by calling `ops` directly. The pins: an owner
// sees every op as a `pmcp_<op>` tool on the aggregated endpoint and unprefixed on the
// scoped one; a service account sees NO `pmcp_*` tool anywhere and is refused with the
// ordinary indistinguishable answers, structurally — the reservation means no `service`
// row exists, so no grant can reference it (§8: "structural rather than checked"); an
// owner is never approval-gated (["all"] resolves allow, so the gate is never entered);
// `service_list` carries the virtual `builtin: true` row that no D1 row backs; and §7's
// asymmetry between reply and record — the CALLER's response is never redacted, while
// what is persisted always is.
//
// Parity direction A (§8's parity invariant) is OWNED by admin-ops.test.ts, which proves
// the totality `Object.keys(ops)` ↔ the tools adminBackend renders from each op's one
// schema. What this file adds is the endpoint face of it: that the same set arrives at a
// consumer, correctly prefixed per endpoint shape. Direction B — the web form's fields
// against that same schema — is web-pages.test.ts's.
//
// Project: `worker` — real D1, every sibling real, driven through
// `exports.default.fetch`; no sockets, and the builtin needs none (it is the one backend
// with nothing to dial, which also makes it this project's cheapest dispatch-reaching
// allow-twin). Per-file storage isolation applies; no case here depends on another's
// state.
//
// Not pinned here: the ops themselves — validation, cascades, per-op audit rows
// (admin-ops.test.ts); authentication in front of the endpoint (auth-matrix.test.ts); the
// check order this traffic rides (order.table.test.ts); and the sentinel sweep proving no
// column ever holds a token (hygiene.test.ts), which owns the ledger half of the
// reply-vs-record pin below.
//
// deps: harness/seed (owner + one service account holding grants on a real service, so
//   "sees no pmcp tools" is asserted against an account that demonstrably sees something)
//   · ../../src/index (default.fetch) · ../../src/admin (ops, adminBackend) ·
//   ../../src/gateway · ../../src/audit (query) · applyD1Migrations (setup) · env.DB

import { describe, it } from "vitest";

describe("§8 — the builtin rides the ordinary pipeline", () => {
  it.todo("§8 · the owner's aggregated tools/list carries a `pmcp_<op>` tool for every ops key — the endpoint face of parity direction A");
  it.todo("§8 · the scoped /mcp/pmcp list carries the same tools with bare names, no prefix");
  it.todo("§7 · a scoped `pmcp` call runs the same filter → archived → approval → availability order as any service");
  it.todo("§8 · `pmcp` is never archived and never reports a connection status — the virtual row has neither");
  it.todo("§15 · the builtin's log_bodies is fixed ON: its schemas are the hub's own");
});

describe("§8 — service accounts and the builtin, structurally", () => {
  it.todo("§8 · an account holding grants elsewhere sees no `pmcp_*` tool in its aggregated list");
  it.todo("§8 · the same account's aggregated list does carry its granted service's tools (the allow-twin)");
  it.todo("§8 · an account calling `pmcp_service_list` gets -32001, indistinguishable from an unknown tool");
  it.todo("§7 step 2 · an account on scoped /mcp/pmcp gets 404, the same answer as a slug it holds no grants on");
  it.todo("§8 · no grant can ever name `pmcp`: there is no service id to reference (the op-level refusal is admin-ops.test.ts's)");
});

describe("§7 — the owner is never approval-gated", () => {
  it.todo("§7 · an owner's mutating `pmcp` call executes with no approval row created and no push sent");
  it.todo("§7 · the owner's roles forward literally as [\"all\"], never expanded into declared role names");
});

describe("§8 — service_list's virtual row", () => {
  it.todo("§8 · service_list includes `pmcp` flagged `builtin: true` while no `service` row exists for it");
  it.todo("§8 · the real services in the same listing carry their row fields and no builtin flag (the twin)");
  it.todo("§8 · service_get('pmcp') is refused here too — the builtin surfaces only through service_list");
});

describe("§7/§15 — what the caller sees versus what is stored", () => {
  it.todo("§7 · token_issue's plaintext key is present in the CALLER's reply: masking exists for persistence only");
  it.todo("§15 · the same call's recorded result masks that key by the uniform body rule — no pmcp-specific rule exists (the ledger sweep is hygiene.test.ts's)");
  it.todo("§15 · one admin call writes two rows: the gateway's `tools/call` (with duration_ms) and the handler's `admin.<op>`");
  it.todo("§7 · a HubError from a handler leaves through the ONE wire mapping — pinned code, no stack, no echo of the input");
});

// No rows and no runner: this suite is cases, not a matrix — the tables it would
// otherwise duplicate belong to admin-ops.test.ts (the ops table) and
// order.table.test.ts (the check order). The empty export keeps the file a module.
export {};
