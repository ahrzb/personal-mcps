// order.table.test.ts — §7's check order as the table it already is (~16 rows).
//
// What this suite pins: that the pipeline's four checks run in the ONE pinned order —
// filter (-32001) → archived (-32002) → the approval gate (-32003, availability-first) →
// availability (-32000) — and that the order is observable, because only the order
// decides which code a request that fails several checks receives. The regressions that
// give the table its shape: ungranted + archived answers -32001, never -32002 (an
// ungranted account must not learn a service is archived); an unknown aggregated prefix
// and a name with no `_` at all both answer -32001, indistinguishable from
// not-permitted; the aggregated name splits at the FIRST `_` (slugs contain no
// underscore, §7); `server/discover` is answered by the hub itself, and every other method
// is -32601. Plus the 2026-08-25 availability-first
// decision: a service the hub already knows cannot execute fails -32000 with no pending
// row, no push, and no pass consumed. §7's 2026-08-26 amendment (`initialize` and the
// `notifications/initialized` behind it) is pinned by two cases BESIDE the table — neither
// message is ordered against anything the table ranks, and what a client needs from the
// handshake is the answer's content, which no row column can hold.
//
// Why a table: four green unit tests compose into a wrong order. The order is one spec
// sentence, and a suite that spends sixteen hand-written tests on it amplifies every edit
// to that sentence sixteenfold. Rows are data; the runner is the only assertion logic;
// each row names the STAGE that produced its answer, so the §9 rule 3 mutation ("swap two
// check-order stages") goes red naming the row whose stage it broke rather than failing
// an anonymous heap of tests.
//
// Project: `worker` — the pipeline driven through `exports.default.fetch` against real
// D1, no sockets. That bounds the table honestly: the tunnel side is reachable here only
// in its OFFLINE state (a DO that has never had a socket), which is exactly what the
// -32000 and availability-first rows need. Rows where a tunneled call must actually reach
// a live service belong to tunnel/pipeline-tunnel.test.ts; the dispatch-reaching
// allow-twins in THIS table ride the `pmcp` builtin (always available, no fake at all)
// and a connected proxied service on the fake upstream. See the `backend` column.
//
// Not pinned here: authentication in front of the pipeline (auth-matrix.test.ts), the
// approval machine's internals — dedup, the CAS claim, MRTR settlement, lazy expiry
// (approvals.test.ts, tunnel/approval-e2e.test.ts) — and the upstream failure classes
// behind a -32000 (upstream-proxy.test.ts). This table pins WHICH answer, and which stage
// produced it; the machinery behind each answer is its own file's.
//
// deps: harness/seed (owner + one account; one tunneled service never connected, one
//   proxied service, plus grants in each mode) · harness/fake-upstream
//   (miniflare.outboundService) · harness/push-service (one subscribed browser, because
//   the transport under this table is the real one) · ../../src/index (default.fetch) · ../../src/gateway ·
//   ../../src/registry · ../../src/approvals · applyD1Migrations (setup) · env.DB

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../../src/index";
import type { Env } from "../../src/index";
import { Approvals } from "../../src/approvals";
import type { JsonRpcResponse } from "../../src/gateway";
import { APPROVAL_WINDOW_MS } from "../../src/limits";
import { Registry } from "../../src/registry";
import type { GrantEntry, GrantMode, Service } from "../../src/registry";
import type { Principal } from "../../src/identity";
import { setHeaders } from "../../src/upstream";
import type { UpstreamConnectionStatus } from "../../src/upstream";
import { readObservations, upstreamUrlFor } from "../harness/fake-upstream";
import type { UpstreamScenario } from "../harness/fake-upstream";
import { subscribeFakeBrowser } from "../harness/push-service";
import { seedNamespace, seedOwnerSession, uniqueSlug } from "../harness/seed";
import type { SeededNamespace } from "../harness/seed";

/**
 * The stage that produced a row's answer — the column that turns "the order is right"
 * from an inference into an assertion. `dispatch` means every check passed and the call
 * reached a backend; `hub` means the hub answered the method itself (`server/discover`)
 * or refused the method outright (-32601), before any service was resolved.
 *
 * `filter` is the one stage that can produce a SUCCESS as well as a refusal: on
 * `tools/call` it is -32001, while on `tools/list` an empty pattern set produces an empty
 * list and no error at all (§7 step 2) — same stage, same cause, two methods. The runner's
 * stage-vs-code consistency check reads `expect.list` to tell the two apart.
 */
export type CheckStage = "hub" | "filter" | "archived" | "approval" | "availability" | "dispatch";

/**
 * The caller's access to the service, exactly as §7 step 2 resolves it. `GrantMode` is
 * the registry's own vocabulary (grants store `allow` or `approval`, never `deny`);
 * "ungranted" is the unmatched case and "granted-undeclared" is the distinct, normal
 * state where a granted role has vanished from the declaration — it still counts as a
 * grant (empty tools/list and -32001, never a 404).
 */
export type RowAccess = GrantMode | "ungranted" | "granted-undeclared";

/**
 * Which backend the row's service resolves to, and in what state the hub already KNOWS it
 * to be — the availability-first input (§7). `tunnel` appears here only as `offline`: a
 * live registered socket cannot exist in this project, and the online rows are
 * tunnel/pipeline-tunnel.test.ts's. `proxy` carries upstream's own status vocabulary, so
 * the two modules cannot disagree about what "known unavailable" means. `pmcp` is always
 * available and needs no fixture — the cheapest allow-twin in the file.
 */
export type RowBackend =
  | { kind: "tunnel"; status: "offline" }
  | { kind: "proxy"; status: UpstreamConnectionStatus }
  | { kind: "pmcp" };

/**
 * The answer, as the durable contract states it: a code from §7's pinned five, or `null`
 * for the rows that must succeed. `dataKeys` lists the keys `data` must carry — presence
 * only, never prose (§7 of the strategy: error prose is incidental, `approvalUrl`'s
 * presence is not). Empty on every code but -32003, where it is the whole point.
 */
export type OrderOutcome = {
  code: -32000 | -32001 | -32002 | -32003 | -32601 | null;
  dataKeys: readonly ("approvalId" | "approvalUrl" | "expiresAt")[];
  /**
   * `tools/list` rows only: whether the served list must be EMPTY or carry tools. §7
   * step 2 answers a granted-undeclared role with "an empty `tools/list` and `-32001`,
   * not a 404" — two answers to two methods, and `code: null` alone cannot tell an empty
   * list from a full one. Absent on every `tools/call` row, where it carries no meaning.
   */
  list?: "empty" | "nonempty";
};

/**
 * What the row must leave behind. These columns are why availability-first is testable at
 * all: "-32000 with no pending row, no push, and an existing pass untouched" is four
 * assertions about side effects, and a code-only table would call the wrong behavior
 * green.
 */
export type OrderEffects = {
  /** The backend was actually reached (the fake service/upstream counted an invocation). */
  dispatched: boolean;
  /** A fresh `pending` approval row was inserted (dedup means a retry inserts none). */
  pendingCreated: boolean;
  /** An `approved` row was consumed by the claim (exactly-once's observable half). */
  passConsumed: boolean;
  /** A Web Push was attempted to the owner (the fake push endpoint counted it). */
  pushSent: boolean;
};

/**
 * One row of the check-order table.
 *
 * `toolName` is spelled as the CONSUMER spells it — prefixed on the aggregated endpoint,
 * bare on the scoped one — because the split itself is under test. `pass` is the state of
 * any existing approval row for this exact (account, service, tool, args) binding.
 * `twin` names the allow row this refusal sits beside (§9 rule 2): for most rows it is
 * the same row with one column flipped, which is precisely what makes the order
 * observable rather than merely asserted.
 */
export type OrderRow = {
  /** e.g. "§7 step 3 · ungranted + archived → -32001, not -32002". */
  title: string;
  endpoint: "aggregated" | "scoped";
  /**
   * `other` stands for any method outside the served set — the -32601 rows. The 2026-08-26
   * amendment's two messages are absent by design: `initialize` is ordered against nothing
   * this table ranks, and `notifications/initialized` is absorbed 202 with no body, which
   * is not a JSON-RPC answer at all. Both have their own cases beside the table.
   */
  method: "tools/call" | "tools/list" | "server/discover" | "other";
  toolName: string;
  principal: "owner" | "account";
  access: RowAccess;
  archived: boolean;
  backend: RowBackend;
  /** Tunneled only: whether the tool is present in the DO's cached catalog (a miss → -32001). */
  inCatalog: boolean;
  pass: "none" | "pending" | "approved" | "rejected" | "expired" | "used";
  /**
   * Which endpoint shape OPENED the stored pass, when that differs from the shape this
   * row calls on. Absent means "the same shape as this row" — the ordinary case. It
   * exists for one claim §7 step 2 makes and no other column can hold: `approval.tool`
   * stores the unprefixed name, so a pass opened as `notion_search` on the aggregated
   * shape is the row a bare `search` on the scoped shape must find. Without it that row
   * is column-identical to the plain pending-dedup row and asserts nothing extra.
   */
  openedVia?: "aggregated" | "scoped";
  stage: CheckStage;
  expect: OrderOutcome;
  effects: OrderEffects;
  twin: string;
};

/**
 * The rows are OWNER-AUTHORED, in a separate commit before implementation (strategy §9
 * rule 1), transcribed from §7 alone. Agents never fill them: this table IS the spec
 * sentence, and an agent filling it from an implementation would freeze whatever order
 * that implementation happens to have.
 */
export const ORDER_ROWS: readonly OrderRow[] = [
  // The fixture these rows are written against, named once: a tunneled service `news`
  // (never connected — so offline, with an empty cached catalog), a proxied service
  // `notion` on the fake upstream serving `search` and `search_pages`, one account holding
  // grants in each mode, and the `pmcp` builtin, which needs no fixture at all. `notion`'s
  // availability is a per-row input (the `backend` column carries upstream's own status
  // vocabulary), so one proxied slug serves both the available and the known-unavailable
  // rows rather than two fixtures drifting apart.
  //
  // Three conventions, so no row repeats them:
  // · `inCatalog` is meaningful on tunnel rows only; it is `false` everywhere here, because
  //   no row of this project can carry `true` — warming a catalog needs a registration over
  //   a socket, which is tunnel/pipeline-tunnel.test.ts's project, not this one. Since the
  //   catalog-miss row moved to tunnel/approval-e2e.test.ts (see below) no row's ANSWER
  //   turns on it either; the column stays as the honest record of an input this project
  //   holds constant, not as coverage it claims.
  // · On hub-answered rows (`stage: "hub"`) no service is resolved at all, so `access`,
  //   `archived`, `backend` and `inCatalog` carry no expectation — they are set to the
  //   cheapest neutral values and the row is about `method` alone.
  // · Rows whose `code` is null name THEMSELVES in `twin`, so the runner's §9 rule 2 check
  //   is total over the table without a nullable column.

  // ── §7 step 3: the fixed order, filter first ──────────────────────────────────────────
  // §7 step 3: "**filter first** (`-32001` "tool not permitted" — so an ungranted account
  // can't even learn a service is archived), then **archived** (`-32002`)". The row is
  // spelled on the aggregated endpoint deliberately: the scoped answer for a service an
  // account holds no grants on is 404 (§7 step 2, auth-matrix.test.ts's row), so the
  // aggregated shape is where an ungranted call has a JSON-RPC code to be wrong about.
  {
    title: "§7 step 3 · ungranted + archived → -32001, never -32002 (filter runs before archived)",
    endpoint: "aggregated",
    method: "tools/call",
    toolName: "news_get",
    principal: "account",
    access: "ungranted",
    archived: true,
    backend: { kind: "tunnel", status: "offline" },
    inCatalog: false,
    pass: "none",
    stage: "filter",
    expect: { code: -32001, dataKeys: [] },
    effects: { dispatched: false, pendingCreated: false, passConsumed: false, pushSent: false },
    twin: "§7 step 3 · granted-allow + available → dispatch (the anchor allow-twin of the whole table)",
  },
  // The same sentence against the LAST check instead of the second: an ungranted account
  // learns nothing about whether the service is reachable either.
  {
    title: "§7 step 3 · ungranted + known-offline → -32001 (filter runs before availability)",
    endpoint: "aggregated",
    method: "tools/call",
    toolName: "news_get",
    principal: "account",
    access: "ungranted",
    archived: false,
    backend: { kind: "tunnel", status: "offline" },
    inCatalog: false,
    pass: "none",
    stage: "filter",
    expect: { code: -32001, dataKeys: [] },
    effects: { dispatched: false, pendingCreated: false, passConsumed: false, pushSent: false },
    twin: "§7 step 3 · granted-allow + available → dispatch (the anchor allow-twin of the whole table)",
  },
  // §7 step 2: "A granted role no longer present in `roles_json` resolves to the empty
  // pattern set — it still counts as a grant (the account gets an empty `tools/list` and
  // `-32001`, not a 404)." The distinction that makes this a row rather than a duplicate of
  // the one above: the grant EXISTS, so the scoped endpoint owes a code, not a 404.
  {
    title: "§7 step 3 · granted-undeclared role → -32001, and an empty tools/list, not a 404",
    endpoint: "scoped",
    method: "tools/call",
    toolName: "get",
    principal: "account",
    access: "granted-undeclared",
    archived: false,
    backend: { kind: "tunnel", status: "offline" },
    inCatalog: false,
    pass: "none",
    stage: "filter",
    expect: { code: -32001, dataKeys: [] },
    effects: { dispatched: false, pendingCreated: false, passConsumed: false, pushSent: false },
    twin: "§7 · approval-mode, approved pass, available service → dispatch, pass consumed exactly once",
  },
  // The OTHER half of the sentence above, which the `tools/call` row cannot reach: "the
  // account gets an empty `tools/list` and `-32001`, not a 404". Same request, one column
  // (`method`) flipped — the grant exists, so the scoped list answers, and what it answers
  // is nothing. The tunnel is offline on purpose: §7 serves tunneled lists from the DO's
  // cache ("a service that has never connected lists no tools"), so an offline tunnel owes
  // an empty list, never a -32000 — the proxied unreachable case is upstream-proxy's.
  {
    title: "§7 step 2 · granted-undeclared role · the scoped tools/list is EMPTY and succeeds — never a 404, never a refusal code",
    endpoint: "scoped",
    method: "tools/list",
    toolName: "",
    principal: "account",
    access: "granted-undeclared",
    archived: false,
    backend: { kind: "tunnel", status: "offline" },
    inCatalog: false,
    pass: "none",
    stage: "filter",
    expect: { code: null, dataKeys: [], list: "empty" },
    effects: { dispatched: false, pendingCreated: false, passConsumed: false, pushSent: false },
    twin: "§7 step 2 · granted-undeclared role · the scoped tools/list is EMPTY and succeeds — never a 404, never a refusal code",
  },
  // §7 step 3: "The scoped endpoint is where that failure surfaces: … an archived service
  // fails with `-32002` like every other request to it." One column (`archived`) off the row
  // above, and the only place in the repo that pins -32002 for a LIST rather than a call —
  // the aggregated shape merely skips archived services, so this shape is where the code is
  // owed. Its twin is the row above: same request, unarchived.
  {
    title: "§7 step 3 · a scoped tools/list against an archived service → -32002, like every other request to it",
    endpoint: "scoped",
    method: "tools/list",
    toolName: "",
    principal: "account",
    access: "granted-undeclared",
    archived: true,
    backend: { kind: "tunnel", status: "offline" },
    inCatalog: false,
    pass: "none",
    stage: "archived",
    expect: { code: -32002, dataKeys: [] },
    effects: { dispatched: false, pendingCreated: false, passConsumed: false, pushSent: false },
    twin: "§7 step 2 · granted-undeclared role · the scoped tools/list is EMPTY and succeeds — never a 404, never a refusal code",
  },
  // §6/§7: an archived service fails `-32002` for a caller who may otherwise use it. The
  // service is CONNECTED here, so archived is the only possible reason for the refusal —
  // an implementation that checked availability first would still answer -32002, and one
  // that checked archived last would answer null.
  {
    title: "§7 step 3 · granted-allow + archived → -32002 (archived runs before the approval gate)",
    endpoint: "scoped",
    method: "tools/call",
    toolName: "search",
    principal: "account",
    access: "allow",
    archived: true,
    backend: { kind: "proxy", status: "connected" },
    inCatalog: false,
    pass: "none",
    stage: "archived",
    expect: { code: -32002, dataKeys: [] },
    effects: { dispatched: false, pendingCreated: false, passConsumed: false, pushSent: false },
    twin: "§7 step 3 · granted-allow + available → dispatch (the anchor allow-twin of the whole table)",
  },
  // The ordering claim stated where it costs the owner something: an archived service must
  // not generate approval requests. `pendingCreated: false` + `pushSent: false` is the whole
  // point — a code-only table would call a gate-then-archived implementation green.
  {
    title: "§7 step 3 · granted-approval + archived → -32002 with no pending row (same ordering, gate never entered)",
    endpoint: "scoped",
    method: "tools/call",
    toolName: "search",
    principal: "account",
    access: "approval",
    archived: true,
    backend: { kind: "proxy", status: "connected" },
    inCatalog: false,
    pass: "none",
    stage: "archived",
    expect: { code: -32002, dataKeys: [] },
    effects: { dispatched: false, pendingCreated: false, passConsumed: false, pushSent: false },
    twin: "§7 · approval-mode, approved pass, available service → dispatch, pass consumed exactly once",
  },
  // The one adjacent pair the two rows above cannot state: both carry a CONNECTED backend,
  // so an implementation that ran availability before archived would still answer -32002 on
  // them. This row flips exactly that one column off the first archived row — archived AND
  // known-unavailable — so stage 2 and stage 4 can no longer be swapped with the table
  // green (§7 step 3's order; §15: "archived services return `-32002` instead").
  {
    title: "§7 step 3 · granted-allow + archived + known-offline → -32002, never -32000 (archived runs before availability)",
    endpoint: "scoped",
    method: "tools/call",
    toolName: "search",
    principal: "account",
    access: "allow",
    archived: true,
    backend: { kind: "proxy", status: "not_connected" },
    inCatalog: false,
    pass: "none",
    stage: "archived",
    expect: { code: -32002, dataKeys: [] },
    effects: { dispatched: false, pendingCreated: false, passConsumed: false, pushSent: false },
    twin: "§7 step 3 · granted-allow + available → dispatch (the anchor allow-twin of the whole table)",
  },
  // §7 step 3: "Passing all four, the call is forwarded". The anchor: every refusal above is
  // this row with one column flipped, which is what makes the ORDER observable rather than
  // merely asserted.
  {
    title: "§7 step 3 · granted-allow + available → dispatch (the anchor allow-twin of the whole table)",
    endpoint: "aggregated",
    method: "tools/call",
    toolName: "notion_search",
    principal: "account",
    access: "allow",
    archived: false,
    backend: { kind: "proxy", status: "connected" },
    inCatalog: false,
    pass: "none",
    stage: "dispatch",
    expect: { code: null, dataKeys: [] },
    effects: { dispatched: true, pendingCreated: false, passConsumed: false, pushSent: false },
    twin: "§7 step 3 · granted-allow + available → dispatch (the anchor allow-twin of the whole table)",
  },

  // ── §7: availability-first inside the approval gate (decided 2026-08-25) ──────────────
  // §7: "The gate consults **known availability first**: a service the hub already knows
  // cannot execute — tunneled with no live registered connection, proxied flagged
  // `not_connected` or `needs_reconnect` — fails `-32000` before any approval row is read,
  // created, or consumed."
  //
  // These two rows ride the PROXIED `not_connected` state rather than the offline tunnel,
  // for a reason worth recording: a never-connected tunnel also has no cached catalog, so a
  // tunneled row here would confound availability-first with §7 step 2's catalog-miss rule
  // (the row below) and neither could be read alone. `not_connected` is §7's own second
  // spelling of "known unavailable", and it isolates the availability decision completely.
  {
    title: "§7 · approval-mode, no pass, known-offline service → -32000: no pending row, no push, nothing read",
    endpoint: "scoped",
    method: "tools/call",
    toolName: "search",
    principal: "account",
    access: "approval",
    archived: false,
    backend: { kind: "proxy", status: "not_connected" },
    inCatalog: false,
    pass: "none",
    stage: "availability",
    expect: { code: -32000, dataKeys: [] },
    effects: { dispatched: false, pendingCreated: false, passConsumed: false, pushSent: false },
    twin: "§7 · approval-mode, approved pass, available service → dispatch, pass consumed exactly once",
  },
  // §7: "an existing approved pass survives untouched; the agent's retry once the service
  // returns is what opens the pending" — so the owner never re-approves because a bot was
  // mid-reconnect. `passConsumed: false` is the entire assertion.
  {
    title: "§7 · approval-mode, approved pass, known-offline service → -32000 with the pass NOT consumed",
    endpoint: "scoped",
    method: "tools/call",
    toolName: "search",
    principal: "account",
    access: "approval",
    archived: false,
    backend: { kind: "proxy", status: "not_connected" },
    inCatalog: false,
    pass: "approved",
    stage: "availability",
    expect: { code: -32000, dataKeys: [] },
    effects: { dispatched: false, pendingCreated: false, passConsumed: false, pushSent: false },
    twin: "§7 · approval-mode, approved pass, available service → dispatch, pass consumed exactly once",
  },
  // §7 step 2: "reply with JSON-RPC error **`-32003`** ("approval required"), whose `data`
  // carries `{ approvalId, approvalUrl, expiresAt }`", and §7's push clause. Presence only —
  // the prose is incidental (strategy §7), the three keys are not.
  {
    title: "§7 · approval-mode, no pass, available service → -32003 carrying approvalId + approvalUrl + expiresAt",
    endpoint: "scoped",
    method: "tools/call",
    toolName: "search",
    principal: "account",
    access: "approval",
    archived: false,
    backend: { kind: "proxy", status: "connected" },
    inCatalog: false,
    pass: "none",
    stage: "approval",
    expect: { code: -32003, dataKeys: ["approvalId", "approvalUrl", "expiresAt"] },
    effects: { dispatched: false, pendingCreated: true, passConsumed: false, pushSent: true },
    twin: "§7 · approval-mode, approved pass, available service → dispatch, pass consumed exactly once",
  },
  // §7 step 1: "the Worker **claims the row atomically** before dispatching … and dispatches
  // only if the claim changed a row." The gate's own allow-twin, and the only row of this
  // table where `passConsumed` is true.
  {
    title: "§7 · approval-mode, approved pass, available service → dispatch, pass consumed exactly once",
    endpoint: "scoped",
    method: "tools/call",
    toolName: "search",
    principal: "account",
    access: "approval",
    archived: false,
    backend: { kind: "proxy", status: "connected" },
    inCatalog: false,
    pass: "approved",
    stage: "dispatch",
    expect: { code: null, dataKeys: [] },
    effects: { dispatched: true, pendingCreated: false, passConsumed: true, pushSent: false },
    twin: "§7 · approval-mode, approved pass, available service → dispatch, pass consumed exactly once",
  },
  // §7 step 2: "no new row is inserted and no new `approval.requested` audit row is written
  // — the reply is `-32003` carrying that row's existing `approvalId`/`expiresAt`, so
  // retries see a stable id and link." Pinned here as an effect of the pipeline; the row
  // mechanics beneath it are approvals.test.ts's.
  {
    title: "§7 step 2 · approval-mode, pending pass, retried → -32003 with the same approvalId and no new row",
    endpoint: "scoped",
    method: "tools/call",
    toolName: "search",
    principal: "account",
    access: "approval",
    archived: false,
    backend: { kind: "proxy", status: "connected" },
    inCatalog: false,
    pass: "pending",
    stage: "approval",
    expect: { code: -32003, dataKeys: ["approvalId", "approvalUrl", "expiresAt"] },
    effects: { dispatched: false, pendingCreated: false, passConsumed: false, pushSent: false },
    twin: "§7 · approval-mode, approved pass, available service → dispatch, pass consumed exactly once",
  },
  // §7 step 4: "rejected or expired → `-32003` again with a fresh pending record and link."
  // Expiry is the lazy kind (§7): the stored row is past `expires_at`, and reading it is
  // what retires it.
  {
    title: "§7 step 4 · approval-mode, expired pass → -32003 with a fresh pending row",
    endpoint: "scoped",
    method: "tools/call",
    toolName: "search",
    principal: "account",
    access: "approval",
    archived: false,
    backend: { kind: "proxy", status: "connected" },
    inCatalog: false,
    pass: "expired",
    stage: "approval",
    expect: { code: -32003, dataKeys: ["approvalId", "approvalUrl", "expiresAt"] },
    effects: { dispatched: false, pendingCreated: true, passConsumed: false, pushSent: true },
    twin: "§7 · approval-mode, approved pass, available service → dispatch, pass consumed exactly once",
  },
  // The other half of the same sentence: a rejection is not a permanent no — the agent may
  // ask again, and the owner is asked again (a fresh row, a fresh push).
  {
    title: "§7 step 4 · approval-mode, rejected pass → -32003 with a fresh pending row",
    endpoint: "scoped",
    method: "tools/call",
    toolName: "search",
    principal: "account",
    access: "approval",
    archived: false,
    backend: { kind: "proxy", status: "connected" },
    inCatalog: false,
    pass: "rejected",
    stage: "approval",
    expect: { code: -32003, dataKeys: ["approvalId", "approvalUrl", "expiresAt"] },
    effects: { dispatched: false, pendingCreated: true, passConsumed: false, pushSent: true },
    twin: "§7 · approval-mode, approved pass, available service → dispatch, pass consumed exactly once",
  },
  // The catalog-miss refusal (§7 step 2: "for tunneled services a pending row is only
  // created for a tool present in the cached catalog … refuse with `-32001` instead") was a
  // row here and is NOT one any more — the JUDGMENT CALL this row carried has been decided
  // the way the row's own escape hatch predicted. §7's availability-first sentence outranks
  // it ("a service the hub already knows cannot execute … fails `-32000` before any
  // approval row is read, created, or consumed", restated verbatim in gateway.callTool's
  // contract header), and the only tunnel this project can seed is a never-connected one —
  // both catalog-less AND known-unavailable, so -32000 is its answer and the catalog check
  // is never reached. Isolating the catalog miss needs a CONNECTED tunnel, which is
  // tunnel/approval-e2e.test.ts's project; its case 22 already pins it, code and
  // no-pending-row alike. Nothing moved here except the row that could not be true.
  //
  // §7 step 2: "owner → all tools (sees everything in their namespace)", and §7's identity
  // clause: "owners get `["all"]`". `access: "approval"` is the state of the namespace's
  // GRANT rows, which §7 step 2 never consults for an owner — that mismatch is the row's
  // whole point, and without an approval-mode grant present the "never routed into the gate"
  // mutation would have nothing to be caught by.
  {
    title: "§7 · an owner is never routed into the gate at all — [\"all\"] resolves allow, whatever the grants say",
    endpoint: "scoped",
    method: "tools/call",
    toolName: "search",
    principal: "owner",
    access: "approval",
    archived: false,
    backend: { kind: "proxy", status: "connected" },
    inCatalog: false,
    pass: "none",
    stage: "dispatch",
    expect: { code: null, dataKeys: [] },
    effects: { dispatched: true, pendingCreated: false, passConsumed: false, pushSent: false },
    twin: "§7 · an owner is never routed into the gate at all — [\"all\"] resolves allow, whatever the grants say",
  },

  // ── §7: name splitting and methods ────────────────────────────────────────────────────
  // §7: "Slugs contain no `_`, so the first `_` splits the name unambiguously" — a name with
  // no `_` at all names no service. The caller here holds a real allow grant on `notion` and
  // the bare tool name is one it may use: only the NAME is defective, and the answer is
  // still the not-permitted code, never a distinct "malformed name" signal.
  {
    title: "§7 · an aggregated name with no `_` at all → -32001, indistinguishable from not-permitted",
    endpoint: "aggregated",
    method: "tools/call",
    toolName: "search",
    principal: "account",
    access: "allow",
    archived: false,
    backend: { kind: "proxy", status: "connected" },
    inCatalog: false,
    pass: "none",
    stage: "filter",
    expect: { code: -32001, dataKeys: [] },
    effects: { dispatched: false, pendingCreated: false, passConsumed: false, pushSent: false },
    twin: "§7 step 3 · granted-allow + available → dispatch (the anchor allow-twin of the whole table)",
  },
  // §7 step 3: "a prefix matching no service → `-32001`, indistinguishable from
  // not-permitted." A namespace's service list is not enumerable through tool names.
  {
    title: "§7 · an aggregated prefix matching no visible service → the same -32001",
    endpoint: "aggregated",
    method: "tools/call",
    toolName: "ghost_search",
    principal: "account",
    access: "ungranted",
    archived: false,
    backend: { kind: "proxy", status: "connected" },
    inCatalog: false,
    pass: "none",
    stage: "filter",
    expect: { code: -32001, dataKeys: [] },
    effects: { dispatched: false, pendingCreated: false, passConsumed: false, pushSent: false },
    twin: "§7 step 3 · granted-allow + available → dispatch (the anchor allow-twin of the whole table)",
  },
  // §7: "the first `_` splits the name unambiguously". The tool's OWN name contains `_`, so
  // a greedy or last-`_` split resolves a service that does not exist — this row is green
  // only if the split is first-`_` and the remainder is forwarded intact.
  {
    title: "§7 · an aggregated name splits at the FIRST `_` — a tool whose own name contains `_` survives intact",
    endpoint: "aggregated",
    method: "tools/call",
    toolName: "notion_search_pages",
    principal: "account",
    access: "allow",
    archived: false,
    backend: { kind: "proxy", status: "connected" },
    inCatalog: false,
    pass: "none",
    stage: "dispatch",
    expect: { code: null, dataKeys: [] },
    effects: { dispatched: true, pendingCreated: false, passConsumed: false, pushSent: false },
    twin: "§7 · an aggregated name splits at the FIRST `_` — a tool whose own name contains `_` survives intact",
  },
  // §7 step 2: "`approval.tool` stores the **unprefixed** tool name (aggregated calls split
  // off the slug prefix before the gate), so retries through either endpoint shape match the
  // same row." Stated as an effect: the pending row this scoped call meets was opened by the
  // PREFIXED call — that is what `openedVia: "aggregated"` seeds, and without it this row is
  // column-identical to the pending-dedup row above and asserts nothing it does not. A hub
  // that stored `notion_search` in `approval.tool` opens a second row here and goes red on
  // `pendingCreated`.
  {
    title: "§7 · the scoped endpoint takes the bare name and binds the same approval row as the prefixed call",
    endpoint: "scoped",
    method: "tools/call",
    toolName: "search",
    principal: "account",
    access: "approval",
    archived: false,
    backend: { kind: "proxy", status: "connected" },
    inCatalog: false,
    pass: "pending",
    openedVia: "aggregated",
    stage: "approval",
    expect: { code: -32003, dataKeys: ["approvalId", "approvalUrl", "expiresAt"] },
    effects: { dispatched: false, pendingCreated: false, passConsumed: false, pushSent: false },
    twin: "§7 · approval-mode, approved pass, available service → dispatch, pass consumed exactly once",
  },
  // §7 step 3: "`server/discover` → answered by the Worker (hub capabilities)." Spelled on
  // the SCOPED shape, which is the half that can break: a slug sits in the URL and must not
  // be resolved, dialed, or filtered — the aggregated half has no service to be tempted by.
  {
    title: "§7 · `server/discover` is answered by the hub on both endpoint shapes, no service resolved",
    endpoint: "scoped",
    method: "server/discover",
    toolName: "",
    principal: "account",
    access: "allow",
    archived: false,
    backend: { kind: "pmcp" },
    inCatalog: false,
    pass: "none",
    stage: "hub",
    expect: { code: null, dataKeys: [] },
    effects: { dispatched: false, pendingCreated: false, passConsumed: false, pushSent: false },
    twin: "§7 · `server/discover` is answered by the hub on both endpoint shapes, no service resolved",
  },
  // The aggregated half of the row above, without which its title states a coverage the
  // table does not have: §7 lists the dispatch rules under one "Dispatch:" heading that
  // L530 pins as "identical on both endpoint shapes", so a hub answering `server/discover`
  // on one shape and resolving a service on the other satisfies neither sentence.
  {
    title: "§7 · `server/discover` is answered by the hub on the aggregated shape too — the other half of the pair",
    endpoint: "aggregated",
    method: "server/discover",
    toolName: "",
    principal: "account",
    access: "allow",
    archived: false,
    backend: { kind: "pmcp" },
    inCatalog: false,
    pass: "none",
    stage: "hub",
    expect: { code: null, dataKeys: [] },
    effects: { dispatched: false, pendingCreated: false, passConsumed: false, pushSent: false },
    twin: "§7 · `server/discover` is answered by the hub on the aggregated shape too — the other half of the pair",
  },
  // §7 step 3: "anything else → `-32601`." The refusal belongs to the hub, before any
  // service is resolved — which is why an unknown method leaks nothing about the namespace.
  {
    title: "§7 · any other method → -32601",
    endpoint: "aggregated",
    method: "other",
    toolName: "",
    principal: "account",
    access: "allow",
    archived: false,
    backend: { kind: "pmcp" },
    inCatalog: false,
    pass: "none",
    stage: "hub",
    expect: { code: -32601, dataKeys: [] },
    effects: { dispatched: false, pendingCreated: false, passConsumed: false, pushSent: false },
    twin: "§7 · `server/discover` is answered by the hub on both endpoint shapes, no service resolved",
  },
  // The same refusal on the shape that carries a slug in its URL — the half where "leaks
  // nothing about the namespace" is a claim rather than a tautology: an unknown method must
  // be refused before the slug is resolved, so the answer is identical for a granted slug,
  // an ungranted one, and one that does not exist.
  {
    title: "§7 · any other method → -32601 on the scoped shape too, before the slug is ever resolved",
    endpoint: "scoped",
    method: "other",
    toolName: "",
    principal: "account",
    access: "allow",
    archived: false,
    backend: { kind: "pmcp" },
    inCatalog: false,
    pass: "none",
    stage: "hub",
    expect: { code: -32601, dataKeys: [] },
    effects: { dispatched: false, pendingCreated: false, passConsumed: false, pushSent: false },
    twin: "§7 · `server/discover` is answered by the hub on both endpoint shapes, no service resolved",
  },
  // §7's 2026-08-26 amendment (`initialize`, and the `notifications/initialized` that
  // follows it) is NOT in this table: neither message is ordered against filter, archived,
  // the gate or availability, which is the only thing a row here can express. Both are
  // pinned by their own cases below, where the answer's CONTENT is readable.
];

/**
 * The one assertion path for the check order: build the row's request, drive it through
 * `exports.default.fetch`, and check the code, the `data` keys, and all four effect
 * columns. Effects are checked on EVERY row, not only the approval ones — "no pending row
 * was created" is a claim a refusal row makes just as strongly as an approval row makes
 * the opposite.
 *
 * Two laws hold for EVERY row rather than varying by column, and both are asserted HERE,
 * inside the row's own case, because the evidence is already in hand at that point:
 * `data` rides -32003 and nothing else, and — §15 — a refusal records no audit body
 * (`args_json` and `result_json` absent on the audit row of every row whose
 * `effects.dispatched` is false, whatever the service's `log_bodies` says). That second
 * law is why a `-32003` or a catalog-miss cannot persist unmasked arguments (no redaction
 * map exists yet at that point, §7), and this table is the only place it is reachable —
 * hygiene's AuditBodyRow drives dispatched calls exclusively. Asserting them per row is
 * what keeps a filtered run, or one failing row, from turning either law into a failure
 * that names the wrong problem.
 *
 * What the runner does NOT own is the two properties of the TABLE — every refusal row's
 * twin resolving to an allow row (§9 rule 2), and every row's stage being consistent with
 * its code (§9 rule 3) — plus the one genuinely cross-row property: the -32001 rows
 * answering byte-identically to one another. Those live in the table's own describe.
 */
export function runOrderTable(rows: readonly OrderRow[]): void {
  // deps: harness/seed · harness/fake-upstream · ../../src/index (default.fetch) · env.DB
  for (const row of rows) {
    it(row.title, async () => {
      const observed = await driveRow(row);

      // Every refusal in this table is a PAYLOAD: the HTTP layer said its piece at the
      // door (auth-matrix's table), and the pipeline answers 200 either way.
      expect(observed.status, `${row.title}: the pipeline answers 200, refusal or not`).toBe(200);

      const error = observed.body.error;
      if (row.expect.code === null) {
        expect(error, `${row.title}: expected success, got ${JSON.stringify(error)}`).toBeUndefined();
        expect(observed.body.result, `${row.title}: a successful answer carries a result`).toBeDefined();
      } else {
        expect(error?.code, `${row.title}: wrong answer ${JSON.stringify(error ?? observed.body.result)}`).toBe(
          row.expect.code,
        );
      }

      // Presence only, key by key — the prose is incidental, `approvalUrl` is not.
      const data = error?.data as Record<string, unknown> | undefined;
      for (const key of row.expect.dataKeys) {
        expect(data?.[key], `${row.title}: -32003 data is missing "${key}"`).toBeDefined();
      }
      // §7: `data` rides -32003 and nothing else — stated against this row's own answer,
      // whichever code it carries.
      expect(
        data !== undefined,
        `${row.title}: data rides -32003 and nothing else (${JSON.stringify(error)})`,
      ).toBe(error?.code === -32003);

      if (row.expect.list !== undefined) {
        const tools = (observed.body.result as { tools?: unknown[] } | undefined)?.tools ?? [];
        expect(tools.length === 0 ? "empty" : "nonempty", `${row.title}: ${JSON.stringify(tools)}`).toBe(
          row.expect.list,
        );
      }

      // All four columns at once: a wrong one prints beside the three that were right.
      expect(observed.effects, row.title).toEqual(row.effects);

      // §15: a refusal row NEVER carries bodies. Both seeded services have log_bodies ON
      // (buildFixture), so a row that recorded one recorded it in spite of the rule rather
      // than because of a default.
      if (!row.effects.dispatched) {
        for (const stored of observed.auditBodies) {
          expect(stored.args_json, `${row.title}: a refusal recorded arguments`).toBeNull();
          expect(stored.result_json, `${row.title}: a refusal recorded a result`).toBeNull();
        }
      }
    });
  }
}

// ── one row → one request → four effects ──────────────────────────────────────────────

/** What one row's request left behind — read by the row's own case, and by nothing else. */
type Observed = {
  status: number;
  body: JsonRpcResponse;
  effects: OrderEffects;
  /** The `tools/call` audit rows THIS request wrote, as the columns store them (§15). */
  auditBodies: { args_json: string | null; result_json: string | null }[];
};

/**
 * Seed the row's world, take the four counters, drive the request through
 * `exports.default.fetch`, take them again. Every effect is a DELTA around the row's own
 * request, so whatever the fixture had to do to reach the row's state (opening a pending
 * row through the other endpoint shape, for one) is never mistaken for the row's answer.
 */
async function driveRow(row: OrderRow): Promise<Observed> {
  const fixture = await buildFixture(row);
  const before = await snapshot(fixture);
  const response = await worker.fetch(fixture.request(), env as unknown as Env);
  const status = response.status;
  const body = (await response.json()) as JsonRpcResponse;
  const after = await snapshot(fixture);
  return {
    status,
    body,
    effects: {
      dispatched: after.dispatches > before.dispatches,
      pendingCreated: after.approvals > before.approvals,
      passConsumed: before.passStatus === "approved" && after.passStatus === "used",
      pushSent: after.pushes > before.pushes,
    },
    auditBodies: after.auditCalls.slice(before.auditCalls.length),
  };
}

/** The four counters, read the same way before and after. */
async function snapshot(fixture: Fixture) {
  return {
    dispatches: (await readObservations(fixture.upstreamId)).length,
    pushes: (await readObservations(fixture.pushId)).length,
    approvals:
      (
        await db()
          .prepare(`SELECT COUNT(*) AS n FROM approval WHERE owner_id = ?`)
          .bind(fixture.ownerId)
          .first<{ n: number }>()
      )?.n ?? 0,
    passStatus: fixture.passId === undefined
      ? undefined
      : (
          await db()
            .prepare(`SELECT status FROM approval WHERE id = ?`)
            .bind(fixture.passId)
            .first<{ status: string }>()
        )?.status,
    auditCalls: (
      await db()
        .prepare(
          `SELECT args_json, result_json FROM audit
            WHERE owner_id = ? AND event = 'tools/call' ORDER BY id`,
        )
        .bind(fixture.ownerId)
        .all<{ args_json: string | null; result_json: string | null }>()
    ).results,
  };
}

/** One row's seeded world plus the request it is about. */
type Fixture = {
  ownerId: string;
  /** The fake-upstream scenario `notion` points at — its observation log IS `dispatched`. */
  upstreamId: string;
  /** The scenario the owner's push subscription points at — its log IS `pushSent`. */
  pushId: string;
  /** The approval row the row's `pass` column named, when it named one. */
  passId?: string;
  /** Built fresh per call: a Request body can only be read once. */
  request(): Request;
};

/**
 * The fixture named in the table's own preamble, built per row: a tunneled `news` that
 * has never connected, a proxied `notion` on the fake upstream, one account with the
 * row's grants, and a push subscription for the owner — the last so a `pushSent: false`
 * row proves nothing was SENT rather than that nobody was listening.
 */
async function buildFixture(row: OrderRow): Promise<Fixture> {
  const upstream: UpstreamScenario = { id: uniqueSlug("up"), mode: { kind: "ok" }, tools: UPSTREAM_TOOLS };
  // A push service, not an MCP upstream: `sink` is the mode that says so, and 201 is what
  // a real one answers a delivered notification with.
  const push: UpstreamScenario = { id: uniqueSlug("push"), mode: { kind: "sink", status: 201 } };
  const home = homeSlug(row);
  const ns = await seedNamespace(env.DB, {
    services: [
      { slug: NEWS, kind: "tunnel", logBodies: true, archived: row.archived && home === NEWS },
      {
        slug: NOTION,
        kind: "proxy",
        upstreamUrl: upstreamUrlFor(upstream),
        upstreamAuthMode: "headers",
        roles: { [ROLE]: [TOOL, `${TOOL}_pages`] },
        // §15's "whatever log_bodies says": bodies are ON for both services, so a refusal
        // row that recorded one would be caught rather than excused by the default.
        logBodies: true,
        archived: row.archived && home === NOTION,
      },
    ],
    accounts: [{ slug: AGENT, grants: grantsFor(row, home), tokens: [{ as: TOKEN }] }],
  });

  // `connected` means "a credential envelope this hub can open is stored"
  // (upstream.connectionStatus), so it is written through `upstream.setHeaders` — the seam
  // that owns the column — and never as raw SQL. Nothing in this file reads it back.
  if (row.backend.kind === "proxy" && row.backend.status === "connected") {
    const notion = await new Registry(env.DB).getService(ns.owner.userId, NOTION);
    if (notion === null) throw new Error(`${row.title}: the fixture's proxied service vanished`);
    await setHeaders(notion, FAKE_UPSTREAM_HEADERS);
  }
  if (row.backend.kind === "proxy" && row.backend.status === "needs_reconnect") {
    throw new Error(
      `${row.title}: needs_reconnect is upstream-credentials.test.ts's — reaching it here would ` +
        `mean running a whole connect flow, which is that file's subject and not this table's`,
    );
  }

  // A real (throwaway) subscription keypair, not a placeholder string: the worker under
  // this table runs the REAL push transport, which encrypts for these keys and would fail
  // to send at all against a fake — turning every `pushSent: true` row into a silent false.
  const browser = await subscribeFakeBrowser(upstreamUrlFor(push));
  await seedingGate(Date.now).subscribePush(ns.owner.userId, browser.subscription);

  const credential = row.principal === "owner"
    ? (await seedOwnerSession(ns.owner)).token
    : ns.tokens[TOKEN].token;
  const url = row.endpoint === "aggregated"
    ? `${ORIGIN}/${ns.owner.username}/mcp`
    : `${ORIGIN}/${ns.owner.username}/mcp/${scopedSlug(row)}`;
  const request = () =>
    new Request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${credential}` },
      body: JSON.stringify(messageFor(row)),
    });

  return {
    ownerId: ns.owner.userId,
    upstreamId: upstream.id,
    pushId: push.id,
    passId: await seedPass(row, ns),
    request,
  };
}

/**
 * The row's `pass` column, reached the way the production code reaches it: check() opens
 * the pending row, decide() settles it, and an EXPIRED one is check() under a backdated
 * clock (limits.APPROVAL_WINDOW_MS ago), never a hand-written row.
 *
 * `openedVia` is the exception, and the reason it exists: that row's pending must have
 * been opened by a real call on the OTHER endpoint shape, because what it pins is that
 * `approval.tool` stored the unprefixed name.
 */
async function seedPass(row: OrderRow, ns: SeededNamespace): Promise<string | undefined> {
  if (row.pass === "none") return undefined;
  if (row.openedVia !== undefined) return openViaEndpoint(row, ns);

  const backdated = row.pass === "expired";
  const gate = seedingGate(backdated ? () => Date.now() - 2 * APPROVAL_WINDOW_MS : Date.now);
  const opened = await gate.check(accountPrincipal(ns), serviceRow(ns), TOOL, ARGS, []);
  if (opened.outcome !== "required") {
    throw new Error(`${row.title}: seeding expected a fresh pending row, got "${opened.outcome}"`);
  }
  if (row.pass === "approved" || row.pass === "used") {
    await gate.decide(ns.owner.userId, opened.approvalId, "approve");
  }
  if (row.pass === "rejected") await gate.decide(ns.owner.userId, opened.approvalId, "reject");
  if (row.pass === "used") await gate.claim(opened.approvalId);
  return opened.approvalId;
}

/** The pending row opened by a real call on the endpoint shape `openedVia` names. */
async function openViaEndpoint(row: OrderRow, ns: SeededNamespace): Promise<string> {
  const aggregated = row.openedVia === "aggregated";
  const url = aggregated
    ? `${ORIGIN}/${ns.owner.username}/mcp`
    : `${ORIGIN}/${ns.owner.username}/mcp/${NOTION}`;
  const response = await worker.fetch(
    new Request(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ns.tokens[TOKEN].token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: aggregated ? `${NOTION}_${TOOL}` : TOOL, arguments: ARGS },
      }),
    }),
    env as unknown as Env,
  );
  const body = (await response.json()) as JsonRpcResponse;
  const approvalId = (body.error?.data as { approvalId?: string } | undefined)?.approvalId;
  if (approvalId === undefined) {
    throw new Error(`${row.title}: opening the pass via ${row.openedVia} did not answer -32003: ${JSON.stringify(body)}`);
  }
  return approvalId;
}

// ── the handshake's own world ─────────────────────────────────────────────────────────

/** The smallest namespace the two handshake cases need: one account holding a grant on one
 *  tunneled slug, so the DOOR admits the scoped shape too (§7 step 2's 404 is decided before
 *  the body is read). No upstream and no push subscription — `initialize` resolves no
 *  service and can reach neither. */
async function seedHandshakeNamespace(): Promise<SeededNamespace> {
  return seedNamespace(env.DB, {
    services: [{ slug: NEWS, kind: "tunnel" }],
    accounts: [{ slug: AGENT, grants: { [NEWS]: [{ role: ROLE, mode: "allow" }] }, tokens: [{ as: TOKEN }] }],
  });
}

/** One JSON-RPC message at one URL, through the real worker entry. */
async function rpc(url: string, token: string, message: Record<string, unknown>): Promise<JsonRpcResponse> {
  const response = await worker.fetch(
    new Request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(message),
    }),
    env as unknown as Env,
  );
  return (await response.json()) as JsonRpcResponse;
}

// ── the fixture's vocabulary ──────────────────────────────────────────────────────────

/** The hub's own origin, as the worker under test knows it. */
const ORIGIN = (env as unknown as Env).PUBLIC_ORIGIN;

/** The two seeded services and the one account, named once. Neither slug contains `_`. */
const NEWS = "news";
const NOTION = "notion";
const AGENT = "agent";
/** The fixture-local handle the account's `pmcp_sa_` key appears under. */
const TOKEN = "key";
/** The one role name the table needs: declared on `notion`, never on the tunnel. */
const ROLE = "reader";
/** The tool every proxied row calls, unprefixed — `search_pages` is its `_`-carrying twin. */
const TOOL = "search";
/** The arguments every call carries; the approval binding is over exactly these. */
const ARGS = { q: "hello" };

/** What the fake upstream serves; no row of this table lists it, but a mute upstream would
 *  be a poor allow-twin for one that does. */
const UPSTREAM_TOOLS = [
  { name: TOOL, inputSchema: { type: "object" } },
  { name: `${TOOL}_pages`, inputSchema: { type: "object" } },
];

/** The obviously-fake headers sealed into the credential envelope — see buildFixture. */
const FAKE_UPSTREAM_HEADERS = { "X-Fixture-Token": "FAKE0000-upstream-header" };

/** A method the hub serves on neither shape — the -32601 rows' `other`. */
const UNSERVED_METHOD = "resources/list";

/** The handshake params a compliant client opens with. Obviously-fake client identity; the
 *  params the hub is free to ignore are still the ones it will actually receive, and a
 *  fixture that sent `{}` would let an implementation that reads them wrongly pass. */
const CLIENT_HANDSHAKE = {
  protocolVersion: "2026-07-28",
  capabilities: {},
  clientInfo: { name: "pmcp-fixture-client", version: "0.0.0-FAKE0000" },
};

/** `env.DB` is typed `unknown` (test/env.d.ts); this names the sliver the runner uses. */
type D1Like = {
  prepare(sql: string): {
    bind(...values: unknown[]): {
      run(): Promise<unknown>;
      first<T>(): Promise<T | null>;
      all<T>(): Promise<{ results: T[] }>;
    };
  };
};
function db(): D1Like {
  return env.DB as D1Like;
}

/** The approvals seam, wired for SEEDING: a real clock or a backdated one, no push
 *  transport (so nothing the fixture opens can be mistaken for the row's own push) and no
 *  audit sink (the worker under test writes the rows this table reads). */
function seedingGate(now: () => number): Approvals {
  return new Approvals({
    db: env.DB,
    publicOrigin: ORIGIN,
    audit: { record: async () => {} },
    retentionDays: 7,
    now,
  });
}

function accountPrincipal(ns: SeededNamespace): Principal {
  return {
    kind: "service_account",
    accountId: ns.accounts[AGENT].id,
    ownerId: ns.owner.userId,
    slug: AGENT,
  };
}

/** The proxied service as the approvals seam takes it — every seeded pass is on `notion`. */
function serviceRow(ns: SeededNamespace): Service {
  return {
    id: ns.services[NOTION].id,
    ownerId: ns.owner.userId,
    slug: NOTION,
    kind: "proxy",
    archived: false,
    logBodies: true,
  };
}

/**
 * The service a row is ABOUT — the one its archived flag and its grants apply to. On the
 * scoped shape the URL names it; on the aggregated shape the tool-name prefix does, except
 * where the prefix is the defect under test (`ghost_`, or no `_` at all), in which case
 * the caller's real service is `notion` and the name is simply wrong about it.
 */
function homeSlug(row: OrderRow): string {
  if (row.endpoint === "scoped") return scopedSlug(row);
  return row.toolName.split("_")[0] === NEWS ? NEWS : NOTION;
}

/**
 * The slug in a scoped row's URL. `pmcp` backends appear only on hub-answered rows, where
 * §7 resolves no service at all — but the DOOR still resolves visibility (auth-matrix's
 * §7 step 2 404), and a service account can never see `/mcp/pmcp`, so those rows ride the
 * granted `notion` slug. Their point is the method, not the service.
 */
function scopedSlug(row: OrderRow): string {
  return row.backend.kind === "tunnel" ? NEWS : NOTION;
}

/** The row's grants: on its home service, in the mode its `access` column names. */
function grantsFor(row: OrderRow, home: string): Record<string, GrantEntry[]> {
  switch (row.access) {
    case "ungranted":
      return {};
    case "allow":
    case "approval":
      return { [home]: [{ role: ROLE, mode: row.access }] };
    case "granted-undeclared":
      // The tunneled `news` declares nothing until it first registers, so a grant on it IS
      // §7 step 2's "a granted role no longer present in roles_json" — a real grant that
      // resolves to the empty pattern set.
      return { [home]: [{ role: ROLE, mode: "allow" }] };
  }
}

/** The row's JSON-RPC message, spelled as the CONSUMER spells it. */
function messageFor(row: OrderRow): Record<string, unknown> {
  const envelope = { jsonrpc: "2.0", id: 1 };
  switch (row.method) {
    case "tools/call":
      return { ...envelope, method: "tools/call", params: { name: row.toolName, arguments: ARGS } };
    case "tools/list":
      return { ...envelope, method: "tools/list", params: {} };
    case "server/discover":
      return { ...envelope, method: "server/discover", params: {} };
    case "other":
      return { ...envelope, method: UNSERVED_METHOD, params: {} };
  }
}

/** Which codes each stage is able to produce — §9 rule 3's mutation, as a lookup. */
const STAGE_CODES: Record<CheckStage, readonly OrderOutcome["code"][]> = {
  // The hub answers `server/discover` itself and refuses every unserved method.
  hub: [null, -32601],
  // On tools/call the filter refuses; on tools/list the same empty pattern set is simply
  // an empty list and no error at all (§7 step 2).
  filter: [-32001, null],
  archived: [-32002],
  approval: [-32003],
  availability: [-32000],
  dispatch: [null],
};

/** The section boundaries, as the first title of each — the describes below are the table
 *  in order, and this is the smallest thing that has to stay in step with it. */
const SECTIONS = sections([
  "§7 step 3 · ungranted + archived → -32001, never -32002 (filter runs before archived)",
  "§7 · approval-mode, no pass, known-offline service → -32000: no pending row, no push, nothing read",
  "§7 · an aggregated name with no `_` at all → -32001, indistinguishable from not-permitted",
]);

function sections(starts: readonly string[]): readonly (readonly OrderRow[])[] {
  const bounds = starts.map((title) => {
    const at = ORDER_ROWS.findIndex((row) => row.title === title);
    if (at < 0) throw new Error(`no row titled "${title}" starts a section`);
    return at;
  });
  return bounds.map((start, index) => ORDER_ROWS.slice(start, bounds[index + 1] ?? ORDER_ROWS.length));
}

describe("§7 step 3 — the fixed order, filter first", () => {
  runOrderTable(SECTIONS[0]);
});

describe("§7 — availability-first inside the approval gate (decided 2026-08-25)", () => {
  // One half of the decision is NOT in this file: §7's availability-first sentence
  // outranks the catalog check, and this project can seed no connected tunnel, so that
  // case is tunnel/approval-e2e.test.ts's case 23 — a service whose catalog is cold and
  // whose socket is gone, answered -32000 and not case 22's catalog-miss -32001, over a
  // real socket. (Case 22 itself is the ONLINE catalog miss and makes no availability
  // claim; it was the wrong pointer here until D7's oracle stage.)
  runOrderTable(SECTIONS[1]);
});

describe("§7 — name splitting and methods", () => {
  runOrderTable(SECTIONS[2]);
});

describe("§7's dispatch table, amended 2026-08-26 — the MCP handshake", () => {
  // Beside the table rather than in it: an OrderRow can observe four things (200, error-vs-
  // result, the `data` keys, the four effect deltas), so a row could say "not -32601" and
  // nothing about protocolVersion, capabilities or serverInfo — the whole point of the
  // amendment, and what every standards-compliant client actually reads. These two cases
  // read the answer instead.
  //
  // What they do NOT reach: the door. index.mcpEntry decides Content-Type, the Origin rule,
  // the principal and scoped visibility before the body is read, so "the amendment moved
  // `initialize` out of -32601 and not out from behind the door" is auth-matrix.test.ts's —
  // its `bodyFor` sends `tools/list` on every /mcp* row, leaving the door table
  // method-monomorphic and that gap real.
  it("§7 · `initialize` answers protocolVersion, capabilities and serverInfo — the same answer on both endpoint shapes", async () => {
    const ns = await seedHandshakeNamespace();
    const token = ns.tokens[TOKEN].token;
    const aggregated = `${ORIGIN}/${ns.owner.username}/mcp`;

    // The revision the hub is on, read off its own `server/discover` the way
    // contracts.test.ts's `wireRevision` reads it — never transcribed here, so a bump
    // reaches this assertion through the hub instead of through an edit.
    const discovered = await rpc(aggregated, token, { jsonrpc: "2.0", id: 1, method: "server/discover", params: {} });
    const revision = (discovered.result as { supportedVersions: string[] }).supportedVersions[0];

    for (const url of [aggregated, `${aggregated}/${NEWS}`]) {
      const answer = await rpc(url, token, { jsonrpc: "2.0", id: 1, method: "initialize", params: CLIENT_HANDSHAKE });
      expect(answer.error, `${url}: the handshake was refused`).toBeUndefined();
      const result = answer.result as {
        protocolVersion?: unknown;
        capabilities?: unknown;
        serverInfo?: { name?: unknown };
      };
      expect(result.protocolVersion, `${url}: protocolVersion`).toBe(revision);
      expect(result.capabilities, `${url}: capabilities`).toEqual({ tools: { listChanged: false } });
      expect(result.serverInfo?.name, `${url}: serverInfo carries a name`).toBeTruthy();
    }
  });

  it("§7 · `notifications/initialized` — the message every client sends next — is absorbed with a bodyless 202", async () => {
    const ns = await seedHandshakeNamespace();
    const response = await worker.fetch(
      new Request(`${ORIGIN}/${ns.owner.username}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${ns.tokens[TOKEN].token}` },
        // No `id`: that is what makes it a notification, and there is nothing to answer to.
        body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      }),
      env as unknown as Env,
    );
    expect(response.status, "a notification is absorbed, never answered").toBe(202);
    expect(await response.text(), "202 carries no body").toBe("");
  });
});

describe("the table's own invariants", () => {
  it("§9 rule 2 · every refusal row names an allow-twin present in this table", () => {
    for (const row of ORDER_ROWS) {
      const twin = ORDER_ROWS.find((candidate) => candidate.title === row.twin);
      // A deny-only oracle is satisfied by `throw` everywhere — this is the check that
      // makes each refusal carry the request that must still succeed.
      expect(twin, `no row titled "${row.twin}", named as the twin of "${row.title}"`).toBeDefined();
      expect(twin?.expect.code, `the twin of "${row.title}" is not an allow row`).toBeNull();
      if (row.expect.code === null) expect(row.twin).toBe(row.title);
    }
  });

  it("§9 rule 3 · every row names the stage that produced its answer — swapping two stages fails naming the row", () => {
    for (const row of ORDER_ROWS) {
      expect(
        STAGE_CODES[row.stage],
        `"${row.title}": stage "${row.stage}" cannot produce ${row.expect.code}`,
      ).toContain(row.expect.code);
      // The one stage that answers null two ways: on tools/list an empty pattern set is an
      // empty list, not a refusal — and `expect.list` is what tells the two apart.
      if (row.stage === "filter" && row.expect.code === null) {
        expect(row.expect.list, `"${row.title}": a filter stage succeeds only as an EMPTY list`).toBe(
          "empty",
        );
      }
      // Reaching a backend is what `dispatch` MEANS; no other stage may claim it.
      expect(row.effects.dispatched, `"${row.title}": only a dispatch row reaches a backend`).toBe(
        row.stage === "dispatch",
      );
    }
  });

  it("§7 · the three -32001 sources answer identically to one another; `data` is present only on -32003", async () => {
    // The one property of this table that no single row can hold: indistinguishability is
    // a SAMENESS claim, and equal codes are not enough — the whole error object must
    // match, message included. So this case drives its own requests rather than reading
    // answers another case happened to leave behind: `it.only` on one row, or a filtered
    // run, cannot turn the law into a failure that names the wrong problem.
    //
    // Every -32001 row, not only the three §7 names (ungranted, unknown prefix,
    // unsplittable name): the code has ONE spelling, so a fourth source that answered
    // differently would be the same leak. `data` rides -32003 and nothing else is
    // asserted per row, inside runOrderTable, where each row's own answer already is.
    const refusals = ORDER_ROWS.filter((row) => row.expect.code === -32001);
    expect(refusals.length, "the -32001 sources §7 pins as indistinguishable").toBeGreaterThan(2);
    const answers = new Map<string, string[]>();
    for (const row of refusals) {
      const error = JSON.stringify((await driveRow(row)).body.error);
      answers.set(error, [...(answers.get(error) ?? []), row.title]);
    }
    expect(
      answers.size,
      `every -32001 answers alike, or the differences map grant patterns: ${JSON.stringify([...answers])}`,
    ).toBe(1);
  });
});
