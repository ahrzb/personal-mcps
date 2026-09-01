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
import type { JsonRpcResponse, Prompt, Resource, ResourceTemplate } from "../../src/gateway";
import { AGGREGATED_LIST_DEADLINE_MS, APPROVAL_WINDOW_MS } from "../../src/limits";
import { PMCP_SLUG, Registry } from "../../src/registry";
import type { GrantEntry, GrantMode, RoleDeclaration, Service } from "../../src/registry";
import type { Principal } from "../../src/identity";
import { status } from "../../src/tunnel";
import { setHeaders } from "../../src/upstream";
import type { UpstreamConnectionStatus } from "../../src/upstream";
import { readObservations, upstreamUrlFor } from "../harness/fake-upstream";
import type { UpstreamObservation, UpstreamScenario } from "../harness/fake-upstream";
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

/** One message's HTTP STATUS, for the answers the door writes rather than the pipeline —
 *  §7's one anonymous 404 is `text/plain`, so `rpc` above cannot read it. */
async function statusOf(url: string, token: string, message: Record<string, unknown>): Promise<number> {
  const response = await worker.fetch(
    new Request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(message),
    }),
    env as unknown as Env,
  );
  await response.body?.cancel().catch(() => undefined);
  return response.status;
}

/** What one `subscriptions/listen` answered (§21.1): either a HELD stream — read as its
 *  status, content type and minted session id, then CANCELLED, never awaited whole — or a
 *  JSON-RPC refusal, read as its code. `code` present ⇔ no stream was opened, which is what
 *  every §21 refusal row below asserts on. */
type StreamAnswer = {
  status: number;
  contentType: string | null;
  sessionId: string | null;
  code?: number;
};

async function listenAt(url: string, token: string): Promise<StreamAnswer> {
  const response = await worker.fetch(
    new Request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(message("subscriptions/listen")),
    }),
    env as unknown as Env,
  );
  const contentType = response.headers.get("Content-Type");
  const answer: StreamAnswer = {
    status: response.status,
    contentType,
    sessionId: response.headers.get("Mcp-Session-Id"),
  };
  // A held response never ends on its own: cancel the body rather than reading it, so the
  // invocation is free to end and no case waits out a keepalive it did not shrink.
  if (contentType?.includes("text/event-stream") === true) {
    await response.body?.cancel().catch(() => undefined);
    return answer;
  }
  const refusal = (await response.json().catch(() => ({}))) as JsonRpcResponse;
  return { ...answer, code: refusal.error?.code };
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

/**
 * A method the hub serves on neither shape — the -32601 rows' `other`. It was
 * `resources/list` until §20 made that a SERVED method on the scoped shape (and a -32601
 * on the aggregated one, which is its own row below): a constant that names a served
 * method would have made the scoped -32601 row assert the opposite of what it says.
 * `logging/*` is §20.1's own "Out" family — deprecated in 2026-07-28 itself — so it is
 * unserved for a reason the spec states rather than by happening not to be implemented.
 */
const UNSERVED_METHOD = "logging/setLevel";

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

    // Two of the three ARE the same answer on both shapes; `capabilities` stopped being so
    // on 2026-08-26. §20.2 gives the aggregated shape one static two-family constant and
    // DERIVES the scoped one from what the hub stores for that service — and this
    // namespace's `news` is a tunnel that has never connected, so it declares `tools`
    // alone. The two answers are pinned here per shape rather than dropped, so this case
    // keeps stating the whole handshake; §20.2's own cases below own the reasoning.
    for (const [url, capabilities] of [
      [aggregated, AGGREGATED_CAPABILITIES],
      // §21.5 flipped the aggregated flags to TRUE and left the scoped derivation alone;
      // `news` has never connected, so it declares `tools` — with the listChanged a
      // tunneled service can now honor.
      [`${aggregated}/${NEWS}`, { tools: { listChanged: true } }],
    ] as const) {
      const answer = await rpc(url, token, { jsonrpc: "2.0", id: 1, method: "initialize", params: CLIENT_HANDSHAKE });
      expect(answer.error, `${url}: the handshake was refused`).toBeUndefined();
      const result = answer.result as {
        protocolVersion?: unknown;
        capabilities?: unknown;
        serverInfo?: { name?: unknown };
      };
      expect(result.protocolVersion, `${url}: protocolVersion`).toBe(revision);
      expect(result.capabilities, `${url}: capabilities`).toEqual(capabilities);
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

// ══ §20 — the MCP data model beyond tools ═════════════════════════════════════════════
//
// BESIDE the table rather than in it, for the reason the handshake cases above are: an
// OrderRow can observe four things — 200, error-vs-result, the `data` keys, the four
// effect deltas — and nearly every §20 sentence pins CONTENT no column can hold (a
// prompt's messages, a URI left unrewritten, a capabilities object, a `_meta` key that
// survived, a `ttlMs` that must not be there). The few that ARE pure order rows name
// their twin inside the same sentence, and a twin the table expresses as a SEPARATE row
// cannot be asserted from inside one case — which is what every "(the twin)" title here
// asks for.
//
// What these cases keep from the table is its discipline: one world per case, seeded
// through production seams alone, every refusal stated beside the allow-twin one column
// away, and every effect (an approval row that must not exist, an upstream arrival that
// must not happen) read as a DELTA around the case's own request.
//
// The backend under all of them is the PROXIED one. §20 is method-shaped, not
// backend-shaped — the same `route` table answers every family on both shapes — and the
// proxied fake is the only backend this project can drive live (the tunnel appears here
// only in its never-connected state, which is exactly what the -32000 row wants). The
// tunneled halves of §20 — the DO's three new catalog keys, the capability warm, the two
// new list_changed frames — are tunnel/**'s.

/**
 * The fake upstream's §20 seam, named HERE because the harness does not carry it yet:
 * `UpstreamScenario` gains one field per family, exactly as it already carries `tools`
 * and `result`. Spelled as an intersection so this file states the shape it needs and
 * the harness change lands as a deletion of these lines rather than a rewrite of every
 * fixture. Until it lands, every §20 case below fails on its assertions — which is the
 * intended shape of this stage's red.
 */
type ServingScenario = UpstreamScenario & {
  /** Served from `prompts/list` (§20.2). */
  prompts?: Prompt[];
  /** Answered to `prompts/get` — the family's analogue of `result`. */
  promptResult?: unknown;
  /** Served from `resources/list`. */
  resources?: Resource[];
  /** Served from `resources/templates/list`. */
  resourceTemplates?: ResourceTemplate[];
  /** Answered to `resources/read`. */
  readResult?: unknown;
  /** Answered to `completion/complete`. */
  completionResult?: unknown;
};

/** The second proxied service §20 needs: the aggregated rows need two prefixes to prove
 *  one, and "a read is routed by the addressed slug, never by the URI" needs two services
 *  serving one URI. No slug contains `_` (§7). */
const LINEAR = "linear";

/** The second account, for the row that compares one service against TWO callers'
 *  patterns — a claim no single-caller fixture can make. */
const OTHER_AGENT = "auditor";
const OTHER_TOKEN = "other-key";

/** The role that second account holds: resource patterns only, and template-shaped. */
const TEMPLATE_ROLE = "templar";

/** The prompt the granted pattern matches. Its own name carries a `_`, so every
 *  aggregated row also states §7's first-`_` split rather than merely assuming it. */
const PROMPT = "digest_daily";
/** …and the prompt on the same service that no granted pattern matches. */
const UNGRANTED_PROMPT = "payroll_export";
/** The prompt pattern the role declares — `*` is outside the tool-name charset, so this
 *  compiles rather than comparing literally (§20.3: prompts are matched by NAME). */
const PROMPT_PATTERN = "digest_.*";

/** The resource URI the granted pattern covers, and the one it does not. */
const URI = "news://feed/tech";
const UNGRANTED_URI = "vault://secrets/root";
/** The resource pattern the role declares (§20.3: `*` aliases `.*` in the resource
 *  grammar too, so this is what makes `news://feed/{id}` answerable). */
const RESOURCE_PATTERN = "news://feed/*";

/** Two templates `news://feed/*` covers and one it does not. §20.3: a template-shaped
 *  PATTERN compiles ({ and } are metacharacters) and still matches exactly its own
 *  template — which is only observable if a SECOND covered template exists to be dropped. */
const TEMPLATE = "news://feed/{id}";
const OTHER_TEMPLATE = "news://feed/latest";
const UNGRANTED_TEMPLATE = "vault://{id}";

/** The per-family declaration §20.3 introduces, and the one every §20 case grants out of.
 *  Tools ride along so the relayed-`resource_link` row has a grant to call with. */
const D13_ROLES: RoleDeclaration = {
  [ROLE]: {
    tools: [TOOL, `${TOOL}_pages`],
    prompts: [PROMPT_PATTERN],
    resources: [RESOURCE_PATTERN],
  },
};

/** §20.3's other spelling: a bare list is tools-only, so a caller holding it has ZERO
 *  prompt and ZERO resource grants — the state two rows below are entirely about. */
const TOOLS_ONLY_ROLES: RoleDeclaration = { [ROLE]: [TOOL, `${TOOL}_pages`] };

/** What a matched `prompts/get` answers. The message text is obviously fake because the
 *  redaction rows in hygiene.test.ts plant real-looking things in this same carrier. */
const PROMPT_RESULT = {
  description: "the daily digest",
  messages: [{ role: "user", content: { type: "text", text: "summarize FAKE0000-digest-body" } }],
  resultType: "complete",
};

/** What a matched `resources/read` answers. */
const READ_RESULT = {
  contents: [{ uri: URI, mimeType: "text/plain", text: "tech headlines" }],
  resultType: "complete",
};

/** What `completion/complete` answers — relayed verbatim for a ref the patterns match. */
const COMPLETION_RESULT = {
  completion: { values: ["tech", "world"], hasMore: false },
  resultType: "complete",
};

/** What every §20 fixture's upstream serves, in each family, unless the case says
 *  otherwise. Named once so a case's `serves` override reads as the one thing it bent. */
const D13_SERVES: Partial<ServingScenario> = {
  prompts: [
    { name: PROMPT, description: "the prompt the granted pattern matches" },
    { name: UNGRANTED_PROMPT, description: "the prompt no granted pattern matches" },
  ],
  promptResult: PROMPT_RESULT,
  resources: [
    { uri: URI, name: "tech feed" },
    // The resource §20.2's second matching rule exists for: its NAME is a string the
    // granted pattern matches, while its URI matches nothing the caller holds.
    { uri: UNGRANTED_URI, name: URI },
  ],
  resourceTemplates: [
    { uriTemplate: TEMPLATE, name: "one feed item" },
    { uriTemplate: OTHER_TEMPLATE, name: "the latest item" },
    { uriTemplate: UNGRANTED_TEMPLATE, name: "a vault entry" },
  ],
  readResult: READ_RESULT,
  completionResult: COMPLETION_RESULT,
};

/** The aggregated endpoint's ONE static answer (§20.2, flipped by §21.5): tools and
 *  prompts, both listChanged TRUE — the transport that honors it landed in the same deploy
 *  — and never resources, never completions. */
const AGGREGATED_CAPABILITIES = {
  tools: { listChanged: true },
  prompts: { listChanged: true },
};

/** The reserved `_meta` key §7 has the hub mirror onto every forwarded request — which
 *  §20.2 extends to every family. */
const CLIENT_CAPABILITIES = "io.modelcontextprotocol/clientCapabilities";

/** What one §20 case needs seeded over and above the shared defaults. Every field is an
 *  override of exactly one thing, so a case reads as "the world, except…". */
type D13Spec = {
  /** The proxied service's per-family declaration (default: D13_ROLES). */
  roles?: RoleDeclaration;
  /** The account's grant on it (default: the role, allow-mode). */
  grant?: GrantEntry[];
  archived?: boolean;
  /** §20.2's owner-declared `capabilities` config — absent means `tools` only. */
  capabilities?: string[];
  /** What the proxied upstream serves, or does. */
  serves?: Partial<ServingScenario>;
  /** A second proxied service: the aggregated prefix rows and the A-vs-B read row. */
  also?: { roles?: RoleDeclaration; grant?: GrantEntry[]; serves?: Partial<ServingScenario> };
  /**
   * Seed the never-connected tunnel too, granted the built-in `all`. `all` and not the
   * declared role, deliberately: a tunnel that has never registered declares NOTHING, so
   * any other grant resolves to the empty pattern set and the filter answers -32001 (§7
   * step 2) — which would make the -32000 row assert the wrong stage entirely.
   */
  withTunnel?: boolean;
  /** A second account and its grants — the two-callers rows. */
  second?: Record<string, GrantEntry[]>;
};

/** One §20 case's seeded world: what its assertions read, and nothing more. */
type D13World = {
  ns: SeededNamespace;
  /** The service account's `pmcp_sa_` key. */
  agent: string;
  /** The second account's key — throws when the case never asked for one. */
  otherAgent(): string;
  /** The aggregated URL, or one service's scoped URL. */
  url(slug?: string): string;
  /** What one upstream saw. The forwarded `_meta` lives here and nowhere else. */
  arrivals(slug?: string): Promise<UpstreamObservation[]>;
  /** The owner, signed in — the twin of every "the caller's grants" row. */
  ownerToken(): Promise<string>;
  /** How many approval rows this namespace holds (§18 decision 27: reads open none). */
  approvals(): Promise<number>;
};

/**
 * The §20 world, built per case through production seams alone: one proxied service on a
 * fake upstream serving every family, its credential written by `upstream.setHeaders`,
 * and — when the case asks — a second proxied service, a never-connected tunnel, and a
 * second account. Nothing is written as raw SQL, so a fixture can never reach a state the
 * hub itself cannot produce.
 */
async function seedD13(spec: D13Spec = {}): Promise<D13World> {
  const scenarios: Record<string, ServingScenario> = {
    [NOTION]: {
      id: uniqueSlug("up"),
      mode: { kind: "ok" },
      tools: UPSTREAM_TOOLS,
      ...D13_SERVES,
      ...spec.serves,
    },
  };
  if (spec.also !== undefined) {
    scenarios[LINEAR] = {
      id: uniqueSlug("up"),
      mode: { kind: "ok" },
      tools: UPSTREAM_TOOLS,
      ...D13_SERVES,
      ...spec.also.serves,
    };
  }

  const ns = await seedNamespace(env.DB, {
    services: [
      ...Object.entries(scenarios).map(([slug, scenario]) => ({
        slug,
        kind: "proxy" as const,
        upstreamUrl: upstreamUrlFor(scenario),
        upstreamAuthMode: "headers" as const,
        roles: (slug === NOTION ? spec.roles : spec.also?.roles) ?? D13_ROLES,
        logBodies: true,
        archived: slug === NOTION && spec.archived === true,
      })),
      ...(spec.withTunnel === true ? [{ slug: NEWS, kind: "tunnel" as const, logBodies: true }] : []),
    ],
    accounts: [
      {
        slug: AGENT,
        grants: {
          [NOTION]: spec.grant ?? [{ role: ROLE, mode: "allow" as const }],
          ...(spec.also === undefined
            ? {}
            : { [LINEAR]: spec.also.grant ?? [{ role: ROLE, mode: "allow" as const }] }),
          ...(spec.withTunnel === true ? { [NEWS]: [{ role: "all", mode: "allow" as const }] } : {}),
        },
        tokens: [{ as: TOKEN }],
      },
      ...(spec.second === undefined
        ? []
        : [{ slug: OTHER_AGENT, grants: spec.second, tokens: [{ as: OTHER_TOKEN }] }]),
    ],
  });

  const registry = new Registry(env.DB);
  for (const [slug, scenario] of Object.entries(scenarios)) {
    const service = await registry.getService(ns.owner.userId, slug);
    if (service === null) throw new Error(`seedD13: the proxied service "${slug}" vanished`);
    // The credential envelope, through the seam that owns the column — a proxied service
    // with none reads `not_connected` and is refused -32000 before any §20 rule is reached.
    await setHeaders(service, FAKE_UPSTREAM_HEADERS);
    if (spec.capabilities !== undefined && slug === NOTION) {
      // §20.2's owner-DECLARED set, written where an owner writes it. Not a cache, not a
      // probe of `scenario`: the declaration and what the upstream actually serves are
      // deliberately allowed to disagree, which is the whole of "a wrong declaration can
      // mislead feature detection but never widen access".
      await registry.updateService(service.id, { capabilities: spec.capabilities });
    }
  }

  return {
    ns,
    agent: ns.tokens[TOKEN].token,
    otherAgent() {
      const token = ns.tokens[OTHER_TOKEN];
      if (token === undefined) throw new Error("seedD13: this case seeded no second account");
      return token.token;
    },
    url: (slug?: string) =>
      `${ORIGIN}/${ns.owner.username}/mcp${slug === undefined ? "" : `/${slug}`}`,
    arrivals: (slug: string = NOTION) => readObservations(scenarios[slug].id),
    ownerToken: async () => (await seedOwnerSession(ns.owner)).token,
    approvals: async () =>
      (
        await db()
          .prepare(`SELECT COUNT(*) AS n FROM approval WHERE owner_id = ?`)
          .bind(ns.owner.userId)
          .first<{ n: number }>()
      )?.n ?? 0,
  };
}

// ── the messages, and the answers read back ───────────────────────────────────────────

/** One JSON-RPC request, spelled as the consumer spells it. */
function message(method: string, params: Record<string, unknown> = {}): Record<string, unknown> {
  return { jsonrpc: "2.0", id: 1, method, params };
}

/** The handshake, with the params a compliant client actually opens with. */
function initializeMessage(): Record<string, unknown> {
  return message("initialize", CLIENT_HANDSHAKE);
}

function getPrompt(name: string, params: Record<string, unknown> = {}): Record<string, unknown> {
  return message("prompts/get", { name, arguments: {}, ...params });
}

function readResource(uri: string): Record<string, unknown> {
  return message("resources/read", { uri });
}

/** A `completion/complete` whose `ref` names a PROMPT — matched by name (§20.2). */
function promptRef(name: string): Record<string, unknown> {
  return { ref: { type: "ref/prompt", name }, argument: { name: "topic", value: "te" } };
}

/** …and one whose `ref` names a resource TEMPLATE — matched by its template string. */
function resourceRef(uriTemplate: string): Record<string, unknown> {
  return { ref: { type: "ref/resource", uri: uriTemplate }, argument: { name: "id", value: "1" } };
}

/** The prompt names an answer served, sorted — a fan-out decides no order. */
function promptNames(answer: JsonRpcResponse): string[] {
  const prompts = (answer.result as { prompts?: { name: string }[] } | undefined)?.prompts ?? [];
  return prompts.map((prompt) => prompt.name).sort();
}

/** The resource URIs an answer served, sorted. */
function resourceUris(answer: JsonRpcResponse): string[] {
  const listed = (answer.result as { resources?: { uri: string }[] } | undefined)?.resources ?? [];
  return listed.map((resource) => resource.uri).sort();
}

/** The raw `uriTemplate` strings an answer served, sorted — the key §20.3 matches on. */
function templateStrings(answer: JsonRpcResponse): string[] {
  const listed =
    (answer.result as { resourceTemplates?: { uriTemplate: string }[] } | undefined)
      ?.resourceTemplates ?? [];
  return listed.map((template) => template.uriTemplate).sort();
}

/** The `capabilities` object of an `initialize` (or `server/discover`) answer. */
function capabilitiesOf(answer: JsonRpcResponse): Record<string, unknown> | undefined {
  return (answer.result as { capabilities?: Record<string, unknown> } | undefined)?.capabilities;
}

/** The slugs an aggregated answer reported unavailable, sorted. */
function unavailableIn(answer: JsonRpcResponse): string[] {
  const meta = (answer.result as { _meta?: Record<string, unknown> } | undefined)?._meta;
  const omitted = meta?.["pmcp/unavailable"];
  return Array.isArray(omitted) ? [...(omitted as string[])].sort() : [];
}

/** The arrivals of one JSON-RPC method, in arrival order. */
function matching(arrivals: UpstreamObservation[], method: string): UpstreamObservation[] {
  return arrivals.filter((arrival) => arrival.rpcMethod === method);
}

describe("§20.2 — prompts, on both endpoint shapes", () => {
  it("§20.2 · scoped prompts/list returns only the prompts the caller's grants match · the owner sees all (the twin)", async () => {
    const world = await seedD13();

    const scoped = await rpc(world.url(NOTION), world.agent, message("prompts/list"));
    expect(scoped.error, JSON.stringify(scoped.error)).toBeUndefined();
    expect(promptNames(scoped), "prompts are matched by NAME (§20.2)").toEqual([PROMPT]);

    // The twin: owners see everything in their namespace, in every family.
    const owner = await rpc(world.url(NOTION), await world.ownerToken(), message("prompts/list"));
    expect(promptNames(owner)).toEqual([PROMPT, UNGRANTED_PROMPT].sort());
  });

  it("§20.2 · aggregated prompts/list prefixes every name <slug>_<prompt>", async () => {
    const world = await seedD13({ also: {} });

    const aggregated = await rpc(world.url(), world.agent, message("prompts/list"));
    expect(aggregated.error, JSON.stringify(aggregated.error)).toBeUndefined();
    expect(promptNames(aggregated)).toEqual([`${LINEAR}_${PROMPT}`, `${NOTION}_${PROMPT}`].sort());
  });

  it("§20.2 · aggregated prompts/get splits at the first underscore and reaches the right service", async () => {
    // The two services answer DIFFERENTLY, which is what makes "the right service" a fact
    // rather than an inference: `notion_digest_daily` carries two underscores, so a
    // last-`_` split would address a service that does not exist and a greedy one would
    // address `linear` never at all.
    const elsewhere = { ...PROMPT_RESULT, description: "linear's own answer" };
    const world = await seedD13({ also: { serves: { promptResult: elsewhere } } });

    const answer = await rpc(world.url(), world.agent, getPrompt(`${NOTION}_${PROMPT}`));
    expect(answer.error, JSON.stringify(answer.error)).toBeUndefined();
    expect(answer.result, "the addressed service's own answer, relayed").toEqual(PROMPT_RESULT);
    expect(matching(await world.arrivals(NOTION), "prompts/get"), "reached notion").toHaveLength(1);
    expect(matching(await world.arrivals(LINEAR), "prompts/get"), "and nobody else").toHaveLength(0);
  });

  it("§20.2 · an aggregated prompt name whose prefix matches no visible service is -32001 — indistinguishable from not-permitted", async () => {
    const world = await seedD13();

    const ghost = await rpc(world.url(), world.agent, getPrompt(`ghost_${PROMPT}`));
    const ungranted = await rpc(world.url(), world.agent, getPrompt(`${NOTION}_${UNGRANTED_PROMPT}`));

    expect(ghost.error?.code).toBe(-32001);
    // Indistinguishable is a SAMENESS claim, so the whole error object is compared —
    // message included. A namespace's services are not enumerable through prompt names.
    expect(ghost.error, "a missing service must answer exactly like a missing grant").toEqual(
      ungranted.error,
    );
  });

  it("§20.2 · prompts/get for a prompt the caller's grants do not match is -32001 · a matched prompt returns messages (the twin)", async () => {
    const world = await seedD13();

    const refused = await rpc(world.url(NOTION), world.agent, getPrompt(UNGRANTED_PROMPT));
    expect(refused.error?.code).toBe(-32001);
    expect(matching(await world.arrivals(), "prompts/get"), "refused before the service").toHaveLength(0);

    // The twin, one prompt name away: the filter is a filter, not a wall.
    const allowed = await rpc(world.url(NOTION), world.agent, getPrompt(PROMPT));
    expect(allowed.error, JSON.stringify(allowed.error)).toBeUndefined();
    expect((allowed.result as { messages?: unknown }).messages).toEqual(PROMPT_RESULT.messages);
  });

  it("§20.2 · prompts/get on an archived service is -32002, after the filter check", async () => {
    const world = await seedD13({ archived: true });

    const granted = await rpc(world.url(NOTION), world.agent, getPrompt(PROMPT));
    expect(granted.error?.code, "archived, for a caller whose grants match").toBe(-32002);

    // "after the filter check" stated where it costs something: an ungranted caller must
    // not learn from a prompt name that the service is archived (§7 step 3's ordering,
    // reused unchanged — §20.2 grows no pipeline of its own).
    const ungranted = await rpc(world.url(NOTION), world.agent, getPrompt(UNGRANTED_PROMPT));
    expect(ungranted.error?.code, "filter first, always").toBe(-32001);
  });

  it("§20.2 · prompts/get on an offline tunneled service is -32000", async () => {
    const world = await seedD13({ withTunnel: true });

    const answer = await rpc(world.url(NEWS), world.agent, getPrompt(PROMPT));
    expect(answer.error?.code).toBe(-32000);
    expect(answer.error?.data, "-32000 carries no data, in any family").toBeUndefined();
  });

  it("§20.2 · prompts/get is never approval-gated — an approval-mode grant returns the prompt, not -32003", async () => {
    const world = await seedD13({ grant: [{ role: ROLE, mode: "approval" }] });
    const before = await world.approvals();

    const answer = await rpc(world.url(NOTION), world.agent, getPrompt(PROMPT));

    expect(answer.error, JSON.stringify(answer.error)).toBeUndefined();
    expect((answer.result as { messages?: unknown }).messages).toEqual(PROMPT_RESULT.messages);
    // The strong form (§18 decision 27): not merely "no -32003", but no owner asked at all.
    expect(await world.approvals(), "a read opens no pending row").toBe(before);
  });
});

describe("§20.2 — resources are scoped-only, and matched by URI", () => {
  it("§20.2 · aggregated resources/list is -32601 and the aggregated endpoint declares no resources capability", async () => {
    // The namespace's one service DECLARES resources, so the aggregated answer is a
    // constant rather than a union that happened to come out empty (§20.2).
    const world = await seedD13({ capabilities: ["tools", "prompts", "resources"] });

    const listed = await rpc(world.url(), world.agent, message("resources/list"));
    expect(listed.error?.code).toBe(-32601);

    const handshake = await rpc(world.url(), world.agent, initializeMessage());
    expect(capabilitiesOf(handshake)?.resources, "never declared on the aggregated shape")
      .toBeUndefined();
  });

  it("§20.2 · aggregated resources/read and completion/complete are -32601", async () => {
    const world = await seedD13();

    // §20.2 refuses the FAMILY on this shape — `resources/*` and `completion/complete` —
    // and `resources/templates/list` rides here because it is the member nothing else in
    // this file ever sends to the aggregated URL. A dispatch table that enumerated the
    // refusals method by method and forgot it would fan template listings across the
    // namespace: every service's raw `uriTemplate` strings, unprefixed and unroutable, on
    // the one shape §18 decision 26 keeps resources off entirely.
    for (const request of [
      readResource(URI),
      message("resources/templates/list"),
      message("completion/complete", promptRef(PROMPT)),
    ]) {
      const answer = await rpc(world.url(), world.agent, request);
      expect(answer.error?.code, String(request.method)).toBe(-32601);
    }
  });

  it("§20.2 · scoped resources/list returns unprefixed, unrewritten URIs", async () => {
    const world = await seedD13();

    const listed = await rpc(world.url(NOTION), world.agent, message("resources/list"));

    expect(listed.error, JSON.stringify(listed.error)).toBeUndefined();
    // One equality states both halves: a `notion_` prefix, or any rewrite at all, fails it.
    expect(resourceUris(listed)).toEqual([URI]);
  });

  it("§20.2 · scoped resources/read returns contents for a matched URI · an unmatched URI is -32001 (the twin)", async () => {
    const world = await seedD13();

    const matched = await rpc(world.url(NOTION), world.agent, readResource(URI));
    expect(matched.error, JSON.stringify(matched.error)).toBeUndefined();
    expect((matched.result as { contents?: unknown }).contents).toEqual(READ_RESULT.contents);

    const unmatched = await rpc(world.url(NOTION), world.agent, readResource(UNGRANTED_URI));
    expect(unmatched.error?.code).toBe(-32001);
  });

  it("§20.2 · resources are matched by uri, never by name — a resource whose NAME matches a granted pattern while its URI matches none is absent from resources/list and -32001 on read · the same resource under a granted URI pattern is listed and readable (the twin)", async () => {
    // The fixture's second resource carries `name: URI` — the exact string the granted
    // pattern matches — over a URI the pattern does not cover. Reusing the name-keyed
    // `filterList` here lists it and reads it; matching by `uri` does neither.
    const world = await seedD13();

    const listed = await rpc(world.url(NOTION), world.agent, message("resources/list"));
    expect(resourceUris(listed), "the name-matching resource is absent").toEqual([URI]);

    const byName = await rpc(world.url(NOTION), world.agent, readResource(UNGRANTED_URI));
    expect(byName.error?.code, "and unreadable").toBe(-32001);

    // The twin: the same caller, the same service, a resource whose URI the pattern covers.
    const byUri = await rpc(world.url(NOTION), world.agent, readResource(URI));
    expect(byUri.error, JSON.stringify(byUri.error)).toBeUndefined();
    expect((byUri.result as { contents?: unknown }).contents).toEqual(READ_RESULT.contents);
  });

  it("§20.2 · a URI served by both service A and service B is readable on A's scoped endpoint by a caller granted it on A · B's scoped endpoint refuses the same URI -32001 (the twin — a read is routed by the addressed slug, never by the URI)", async () => {
    // B declares a TOOLS-ONLY role (§20.3's bare list), so the identical URI it genuinely
    // serves is covered by no resource pattern of this caller's grants ON B. The URI is
    // the same bytes on both endpoints; only the URL differs.
    const world = await seedD13({ also: { roles: TOOLS_ONLY_ROLES } });

    const onA = await rpc(world.url(NOTION), world.agent, readResource(URI));
    expect(onA.error, JSON.stringify(onA.error)).toBeUndefined();
    expect((onA.result as { contents?: unknown }).contents).toEqual(READ_RESULT.contents);

    const onB = await rpc(world.url(LINEAR), world.agent, readResource(URI));
    expect(onB.error?.code, "judged against the grants held on B").toBe(-32001);
    expect(
      matching(await world.arrivals(LINEAR), "resources/read"),
      "and B is never dialed — the URI never selects the service",
    ).toHaveLength(0);
  });

  it("§20.2 · scoped resources/templates/list is filtered by the resource patterns of the caller's roles, matched against the raw uriTemplate string — \"news://feed/*\" keeps \"news://feed/{id}\", and a template-shaped pattern keeps exactly its own template", async () => {
    // Two callers, one service, two patterns — the only shape in which "matched against
    // the RAW uriTemplate" is falsifiable: the wildcard keeps both feed templates, and the
    // template-shaped pattern keeps one of them and drops the other. A hub that expanded
    // templates, or that matched a pattern against a template's expansion, cannot produce
    // both answers.
    const world = await seedD13({
      roles: {
        [ROLE]: { resources: [RESOURCE_PATTERN] },
        [TEMPLATE_ROLE]: { resources: [TEMPLATE] },
      },
      second: { [NOTION]: [{ role: TEMPLATE_ROLE, mode: "allow" }] },
    });

    const wildcard = await rpc(world.url(NOTION), world.agent, message("resources/templates/list"));
    expect(wildcard.error, JSON.stringify(wildcard.error)).toBeUndefined();
    expect(templateStrings(wildcard)).toEqual([OTHER_TEMPLATE, TEMPLATE].sort());

    const exact = await rpc(world.url(NOTION), world.otherAgent(), message("resources/templates/list"));
    expect(exact.error, JSON.stringify(exact.error)).toBeUndefined();
    expect(templateStrings(exact), "an unquantified brace sequence is a literal").toEqual([TEMPLATE]);
  });

  it("§20.2 · scoped completion/complete relays the service's suggestions verbatim for a ref the caller's patterns match · a ref naming an unmatched prompt or resource template is -32001 and never reaches the service (the twin)", async () => {
    const world = await seedD13();

    // BOTH `ref` kinds on the matched side, because §20.2 gives them two different
    // matching keys: a prompt by NAME against the prompt patterns, a resource template by
    // its raw TEMPLATE STRING against the resource patterns (`news://feed/*` covers
    // `news://feed/{id}`, §20.3). With only the prompt leg, a hub that implements
    // `ref/prompt` and falls through to -32001 on every `ref/resource` — or that matches a
    // resource ref against the prompt list, or against an expanded template — is green on
    // every completion case in this file while half the ref rule is dead.
    for (const ref of [promptRef(PROMPT), resourceRef(TEMPLATE)]) {
      const matched = await rpc(world.url(NOTION), world.agent, message("completion/complete", ref));
      expect(matched.error, JSON.stringify(ref)).toBeUndefined();
      expect((matched.result as { completion?: unknown }).completion, JSON.stringify(ref)).toEqual(
        COMPLETION_RESULT.completion,
      );
    }

    // The twin, on both `ref` kinds: a prompt no pattern matches, and a template no
    // pattern matches. Both refused, and — the half that makes the refusal worth having —
    // refused BEFORE anything reaches the service.
    const before = matching(await world.arrivals(), "completion/complete").length;
    for (const ref of [promptRef(UNGRANTED_PROMPT), resourceRef(UNGRANTED_TEMPLATE)]) {
      const refused = await rpc(world.url(NOTION), world.agent, message("completion/complete", ref));
      expect(refused.error?.code, JSON.stringify(ref)).toBe(-32001);
    }
    expect(matching(await world.arrivals(), "completion/complete"), "a refused ref is never relayed")
      .toHaveLength(before);
  });

  it("§20.2 · a caller with zero prompt and zero resource grants gets -32001 from completion/complete for every ref — the method cannot be used to enumerate past the role's patterns", async () => {
    // A tools-only role, which every service in the field holds today (§20.3): the caller
    // can call tools and must be able to complete NOTHING — not even the prompts and
    // templates this service genuinely serves.
    const world = await seedD13({ roles: TOOLS_ONLY_ROLES });

    for (const ref of [
      promptRef(PROMPT),
      promptRef(UNGRANTED_PROMPT),
      resourceRef(TEMPLATE),
      resourceRef(UNGRANTED_TEMPLATE),
    ]) {
      const refused = await rpc(world.url(NOTION), world.agent, message("completion/complete", ref));
      expect(refused.error?.code, JSON.stringify(ref)).toBe(-32001);
    }
    expect(matching(await world.arrivals(), "completion/complete"), "nothing reached the service")
      .toHaveLength(0);
  });

  it("§20.2 · a tool result carrying a resource_link is relayed byte-for-byte — no URI is rewritten anywhere", async () => {
    // §18 decision 26's residue, pinned: the aggregated endpoint prefixes NAMES, and a
    // `resource_link`'s URI is not a name. Asserted on both shapes because the aggregated
    // one is where a rewrite would be tempting and the scoped one is where it would be
    // pointless — the same bytes either way.
    const link = { type: "resource_link", uri: URI, name: "tech feed", mimeType: "text/plain" };
    const world = await seedD13({ serves: { result: { content: [link], resultType: "complete" } } });

    for (const [url, name] of [
      [world.url(NOTION), TOOL],
      [world.url(), `${NOTION}_${TOOL}`],
    ] as const) {
      const answer = await rpc(url, world.agent, message("tools/call", { name, arguments: ARGS }));
      expect(answer.error, `${url}: ${JSON.stringify(answer.error)}`).toBeUndefined();
      expect((answer.result as { content?: unknown }).content, url).toEqual([link]);
    }
  });
});

describe("§20.1/§20.2 — what each endpoint shape declares, and what it refuses", () => {
  it("§21.1 · subscriptions/listen leaves the -32601 leftover set — logging/setLevel still refuses -32601 on both shapes, the §7 amendment's remaining row (replaces :1993)", async () => {
    // §7's 2026-09-01 amendment served `subscriptions/listen` and the two per-URI methods,
    // and named what is LEFT: `logging/*` and every server-initiated request, both dead in
    // 2026-07-28 itself. The served method beside the refusal is what keeps this row from
    // passing on a hub that refuses everything — the leftover set shrank, it did not move.
    const world = await seedD13();

    for (const url of [world.url(), world.url(NOTION)]) {
      const answer = await rpc(url, world.agent, message(UNSERVED_METHOD));
      expect(answer.error?.code, url).toBe(-32601);

      const stream = await listenAt(url, world.agent);
      expect(stream.code, `${url}: listen is a served method now`).toBeUndefined();
      expect(stream.contentType, url).toContain("text/event-stream");
    }
  });

  it("§21.5 · the aggregated endpoint declares tools and prompts with listChanged TRUE — still one static answer whatever the namespace holds, still never resources or completions (replaces :2002)", async () => {
    // Two namespaces at the extremes of what a union would produce: one whose service
    // declares every family, one whose role grants tools alone. The answer is the same
    // object, which is what "static" means and what the fixture pins. §21.5 flipped the
    // FLAGS and nothing else about it: `resources` and `completions` are still not served on
    // this shape at all (§18 decision 26), so advertising either would promise a -32601.
    const rich = await seedD13({
      capabilities: ["tools", "prompts", "resources", "completions"],
      also: {},
    });
    expect(capabilitiesOf(await rpc(rich.url(), rich.agent, initializeMessage()))).toEqual(
      AGGREGATED_CAPABILITIES,
    );

    const bare = await seedD13({ roles: TOOLS_ONLY_ROLES });
    expect(capabilitiesOf(await rpc(bare.url(), bare.agent, initializeMessage()))).toEqual(
      AGGREGATED_CAPABILITIES,
    );
  });

  it("§21.5 · a proxied service keeps every push flag false whatever its owner-declared capabilities list says, and so does the pmcp builtin — kind, not stored set (replaces :2020)", async () => {
    // KIND is the axis §21.5 added, and these are the two kinds with no channel to ring
    // from: a proxied service has no DO (a Worker cannot hold an outbound stream past its
    // own invocation) and the builtin's tools never change. An implementation that asked
    // "is it proxied?" instead of naming three kinds gets the BUILTIN wrong, which is why
    // both halves are one row.
    //
    // It also carries :2020's other clause, which has nowhere else to live: the handshake
    // makes NO upstream call. The upstream HANGS — an `initialize` that asked it anything
    // would take a deadline to answer, or never answer at all, in the one method §7 pins as
    // stateless.
    const world = await seedD13({
      capabilities: ["tools", "prompts", "resources"],
      serves: { mode: { kind: "hang" } },
    });

    const startedAt = Date.now();
    const answer = await rpc(world.url(NOTION), world.agent, initializeMessage());
    const elapsed = Date.now() - startedAt;

    expect(capabilitiesOf(answer)).toEqual({
      tools: { listChanged: false },
      prompts: { listChanged: false },
      // Whole-object, and `subscribe` is ABSENT rather than present-and-false: §21.5 gives
      // that key to tunneled resources alone, so a client that read it here at all would be
      // reading a promise this kind of service can never keep.
      resources: { listChanged: false },
    });
    expect(await world.arrivals(), "the handshake dials nobody").toEqual([]);
    expect(elapsed, "…so a hung service cannot slow it").toBeLessThan(AGGREGATED_LIST_DEADLINE_MS);

    // The builtin, on the same axis — owner-only (§8), so the credential is a session's.
    const owner = await world.ownerToken();
    expect(capabilitiesOf(await rpc(world.url(PMCP_SLUG), owner, initializeMessage()))).toEqual({
      tools: { listChanged: false },
    });
  });

  it("§21.5 · a never-connected tunneled service declares exactly {tools: {listChanged: true}} on its scoped handshake, and an unresolvable slug answers the identical shape (replaces :2045; whole-object)", async () => {
    // Honest before the first registration (§21.5): the bell rings on the first write that
    // CHANGES a stored catalog, which the first non-empty registration is — and §21.3's
    // absent ≡ [] keeps an empty first warm silent. Whole-object, so a second family
    // appearing here fails instead of passing on a partial match.
    const world = await seedD13({ withTunnel: true });

    expect(capabilitiesOf(await rpc(world.url(NEWS), world.agent, initializeMessage()))).toEqual({
      tools: { listChanged: true },
    });

    // The unresolvable slug, answered as §7 answers it on this endpoint shape: the
    // anti-enumeration rule bites at the DOOR, before any handshake, so the caller never
    // reaches a capabilities object at all — byte-identical to the answer an ungranted
    // service gives, which is strictly stronger than the shape-identity §21.5 asks for. The
    // shape function's own identical answer for an unresolvable slug is pinned where it is
    // reachable: unit/capabilities.test.ts's never-connected row.
    expect(
      await statusOf(world.url(uniqueSlug("ghost")), world.agent, initializeMessage()),
    ).toBe(404);
  });

  it("§20.2 · a proxied service with no capabilities config declares tools only on its scoped endpoint · one whose config declares resources advertises it, listChanged and subscribe still forced false (the twin) — owner-declared configuration, never an upstream call", async () => {
    // The upstream serves every family in BOTH halves. What differs is the owner's
    // declaration, which is the point: absent means `tools` only, so every proxied service
    // in the field is unchanged by §20.
    const silent = await seedD13();
    expect(capabilitiesOf(await rpc(silent.url(NOTION), silent.agent, initializeMessage()))).toEqual({
      tools: { listChanged: false },
    });

    const declaring = await seedD13({ capabilities: ["tools", "resources"] });
    expect(
      capabilitiesOf(await rpc(declaring.url(NOTION), declaring.agent, initializeMessage())),
    ).toEqual({
      tools: { listChanged: false },
      // §21.5: `subscribe` is absent on a proxied service rather than present-and-false —
      // the key belongs to tunneled resources alone, and this kind advertises no push.
      resources: { listChanged: false },
    });
    expect(await declaring.arrivals(), "read per request from config, never dialed").toEqual([]);
  });

  it("§20.2 · server/discover's consumer-facing answer matches initialize's capabilities on both endpoint shapes — one source, two spellings", async () => {
    const world = await seedD13({ capabilities: ["tools", "prompts", "resources"] });

    for (const url of [world.url(), world.url(NOTION)]) {
      const discovered = await rpc(url, world.agent, message("server/discover"));
      const handshake = await rpc(url, world.agent, initializeMessage());
      // A divergence between the two is a bug, not a degree of freedom (§20.2).
      expect(capabilitiesOf(discovered), url).toEqual(capabilitiesOf(handshake));
    }
  });

  it("§20.2 · the pmcp builtin's scoped endpoint answers empty prompt and resource lists and declares neither capability", async () => {
    // `pmcp` is owner-only (§8), so the credential is a real signed-in session's.
    const world = await seedD13();
    const owner = await world.ownerToken();
    const url = world.url(PMCP_SLUG);

    const prompts = await rpc(url, owner, message("prompts/list"));
    const resources = await rpc(url, owner, message("resources/list"));

    // Empty ANSWERS, not refusals: the builtin serves both families and holds nothing in
    // either, which is a different thing from a method it does not implement.
    expect(prompts.error, JSON.stringify(prompts.error)).toBeUndefined();
    expect(promptNames(prompts)).toEqual([]);
    expect(resources.error, JSON.stringify(resources.error)).toBeUndefined();
    expect(resourceUris(resources)).toEqual([]);
    expect(capabilitiesOf(await rpc(url, owner, initializeMessage()))).toEqual({
      tools: { listChanged: false },
    });
  });
});

describe("§20.2/§20.4 — identity, MRTR, the fan-out and the two relay rules", () => {
  it("§20.2 · every forwarded prompts/get and resources/read carries hub/principal, hub/roles and the consumer's mirrored clientCapabilities", async () => {
    const world = await seedD13();
    const declared = { elicitation: {}, sampling: {} };
    const meta = { [CLIENT_CAPABILITIES]: declared };

    await rpc(world.url(NOTION), world.agent, getPrompt(PROMPT, { _meta: meta }));
    await rpc(world.url(NOTION), world.agent, message("resources/read", { uri: URI, _meta: meta }));

    const forwarded = (await world.arrivals()).filter(
      (arrival) => arrival.rpcMethod === "prompts/get" || arrival.rpcMethod === "resources/read",
    );
    expect(forwarded.map((arrival) => arrival.rpcMethod)).toEqual(["prompts/get", "resources/read"]);
    for (const arrival of forwarded) {
      expect(arrival.meta?.["hub/principal"], arrival.rpcMethod).toBe(`sa:${AGENT}`);
      expect(arrival.meta?.["hub/roles"], arrival.rpcMethod).toEqual([ROLE]);
      expect(arrival.meta?.[CLIENT_CAPABILITIES], arrival.rpcMethod).toEqual(declared);
    }
  });

  it("§20.2 · a consumer-supplied hub/* _meta key is stripped from a prompts/get before forwarding · progressToken survives (the twin)", async () => {
    const world = await seedD13();

    await rpc(
      world.url(NOTION),
      world.agent,
      getPrompt(PROMPT, {
        _meta: {
          "hub/principal": "user:FAKE0000-impostor",
          "hub/roles": ["all"],
          progressToken: "FAKE0000-progress",
        },
      }),
    );

    const [forwarded] = matching(await world.arrivals(), "prompts/get");
    expect(forwarded, "the call was forwarded at all").toBeDefined();
    // Overwrite, never merge: any `hub/*` a service sees was written by the hub.
    expect(forwarded.meta?.["hub/principal"]).toBe(`sa:${AGENT}`);
    expect(forwarded.meta?.["hub/roles"]).toEqual([ROLE]);
    // The twin: everything outside the reserved prefix passes untouched.
    expect(forwarded.meta?.progressToken).toBe("FAKE0000-progress");
  });

  it("§20.2 · an input_required result from prompts/get relays verbatim and the retry re-enters the pipeline as an ordinary request", async () => {
    const pending = {
      resultType: "input_required",
      requestState: "FAKE0000-opaque-request-state",
      inputRequests: [{ name: "topic", schema: { type: "string" } }],
    };
    const world = await seedD13({ serves: { promptResult: pending } });

    const first = await rpc(world.url(NOTION), world.agent, getPrompt(PROMPT));
    // Verbatim: `requestState` is opaque to the hub — never inspected, never rewritten.
    expect(first.result).toEqual(pending);

    const retry = await rpc(
      world.url(NOTION),
      world.agent,
      getPrompt(PROMPT, { inputResponses: { topic: "tech" }, requestState: pending.requestState }),
    );
    expect(retry.error, JSON.stringify(retry.error)).toBeUndefined();
    expect(matching(await world.arrivals(), "prompts/get"), "an ordinary request, forwarded again")
      .toHaveLength(2);
  });

  it("§20.2 · aggregated prompts/list survives one failing service and names it in _meta[\"pmcp/unavailable\"] · the scoped list against the same service fails -32000 (the twin)", async () => {
    const world = await seedD13({ also: { serves: { mode: { kind: "status", status: 503 } } } });

    const aggregated = await rpc(world.url(), world.agent, message("prompts/list"));
    expect(aggregated.error, "the aggregate itself always succeeds (§7, unchanged)").toBeUndefined();
    expect(promptNames(aggregated), "one service's failure costs the consumer only its own")
      .toEqual([`${NOTION}_${PROMPT}`]);
    expect(unavailableIn(aggregated)).toContain(LINEAR);

    // The twin: the scoped shape is where the aggregate's silent omission surfaces.
    const scoped = await rpc(world.url(LINEAR), world.agent, message("prompts/list"));
    expect(scoped.error?.code).toBe(-32000);
  });

  it("§20.4 · a service's cacheScope \"public\" on resources/read is downgraded to \"private\" before relay", async () => {
    // The one place verbatim relay is actually unsafe: the hub's authorization context is
    // per-token, so a `public` result from an authenticated endpoint could be shared
    // across access tokens.
    const world = await seedD13({
      serves: { readResult: { ...READ_RESULT, cacheScope: "public" } },
    });

    const answer = await rpc(world.url(NOTION), world.agent, readResource(URI));

    expect(answer.error, JSON.stringify(answer.error)).toBeUndefined();
    expect((answer.result as { cacheScope?: unknown }).cacheScope).toBe("private");
    expect((answer.result as { contents?: unknown }).contents, "and nothing else moved").toEqual(
      READ_RESULT.contents,
    );
  });

  it("§20.4 · a result carrying requestState is served with no ttlMs", async () => {
    const world = await seedD13({
      serves: {
        readResult: { resultType: "input_required", requestState: "FAKE0000-opaque-request-state" },
      },
    });

    const answer = await rpc(world.url(NOTION), world.agent, readResource(URI));
    expect(answer.error, JSON.stringify(answer.error)).toBeUndefined();
    expect((answer.result as Record<string, unknown>).requestState).toBe(
      "FAKE0000-opaque-request-state",
    );
    expect(
      "ttlMs" in (answer.result as object),
      "an exchange still in flight is not a cacheable answer (§20.5)",
    ).toBe(false);

    // Non-vacuous: the SAME world's listing does carry the hint, so "no ttlMs" is a
    // decision about this result rather than a hub that never mints one.
    const listed = await rpc(world.url(NOTION), world.agent, message("resources/list"));
    expect((listed.result as { ttlMs?: unknown }).ttlMs, "a listing is cacheable").toBeDefined();
  });
});

// ══ §21 — the stream's refusals, and the two per-URI methods ══════════════════════════
//
// BESIDE the table for §20's reason (an OrderRow observes four things, and "a held
// text/event-stream was opened" is none of them) plus one of its own: `resources/subscribe`
// exists on TUNNELED services alone (§21.4), and the table reaches a tunnel only in its
// never-connected state. Two rows here need one that is genuinely ONLINE, so this section
// holds a socket — dialled and closed inside the case, hand-rolled for the reason
// hygiene.test.ts's is: `harness/fake-service` is pinned to the `tunnel` project, and one
// case's socket must not import that project's assumptions.
//
// What these rows keep from the table is its discipline: one world per case, every refusal
// stated beside its allow-twin, and the ORDER observable — which is the whole reason
// §21.4's URI filter running before the archived check is a row at all.

/** The tunneled service every §21 case is about. Its own slug, so a case that also seeds a
 *  proxied `notion` reads unambiguously. */
const FEED = "feed";

/** A role the account is granted but the service never declared — the state §7 spells as
 *  "still a grant, empty pattern set", which is how a caller reaches the URI filter's
 *  refusal while the DOOR still admits it. */
const D14_ROLE = "watcher";

/** The URI a granted caller subscribes, and the one no pattern covers. */
const D14_URI = "news://feed/tech";

/** What the online service answers a forwarded `resources/subscribe` — relayed verbatim, so
 *  a distinguishable body is what makes "returns the service's result" assertable. */
const SUBSCRIBE_RESULT = { resultType: "complete" };

/** How one §21 world differs from the default — every field one override. */
type D14Spec = {
  /** The grant the account holds on the tunneled service; absent is the built-in wildcard,
   *  which spans every family (§20.3) and therefore passes every URI. */
  role?: string;
  archived?: boolean;
  /** Dial a real socket, so a forwarded subscribe can actually be answered. */
  online?: boolean;
  /** Add a PROXIED service with NO stored credential — `not_connected`, which §7 counts as
   *  known-unavailable and refuses -32000 before any dial. */
  unreachableProxy?: boolean;
};

type D14World = {
  ns: SeededNamespace;
  agent: string;
  url(slug?: string): string;
  ownerToken(): Promise<string>;
  close(): Promise<void>;
};

/**
 * One §21 world: a tunneled `feed`, an account holding one grant on it, and — when the case
 * asks — a proxied service the hub knows it cannot reach, an archive, or a live socket.
 * Seeded through production seams alone, like every other fixture in this file.
 */
async function seedD14(spec: D14Spec = {}): Promise<D14World> {
  const proxied: ServingScenario = {
    id: uniqueSlug("up"),
    mode: { kind: "ok" },
    tools: UPSTREAM_TOOLS,
    ...D13_SERVES,
  };
  const ns = await seedNamespace(env.DB, {
    services: [
      { slug: FEED, kind: "tunnel", logBodies: true, tokens: [{ as: "svc" }] },
      ...(spec.unreachableProxy === true
        ? [
            {
              slug: NOTION,
              kind: "proxy" as const,
              upstreamUrl: upstreamUrlFor(proxied),
              upstreamAuthMode: "headers" as const,
              roles: D13_ROLES,
              logBodies: true,
            },
          ]
        : []),
    ],
    accounts: [
      {
        slug: AGENT,
        grants: {
          [FEED]: [{ role: spec.role ?? "all", mode: "allow" }],
          // No `setHeaders` call anywhere below: that omission IS the not_connected state,
          // written the way an owner reaches it (a service configured and never connected).
          ...(spec.unreachableProxy === true ? { [NOTION]: [{ role: ROLE, mode: "allow" as const }] } : {}),
        },
        tokens: [{ as: TOKEN }],
      },
    ],
  });

  const close = spec.online === true ? await dialFeed(ns.tokens.svc.token) : async () => undefined;
  // Archived AFTER the socket, if a case ever wants both: archival is a stage, not a create
  // field, and it severs nothing here — admin's cascade owns that ordering (§6).
  if (spec.archived === true) await new Registry(env.DB).archiveService(ns.services[FEED].id);

  return {
    ns,
    agent: ns.tokens[TOKEN].token,
    url: (slug?: string) =>
      `${ORIGIN}/${ns.owner.username}/mcp${slug === undefined ? "" : `/${slug}`}`,
    ownerToken: async () => (await seedOwnerSession(ns.owner)).token,
    close,
  };
}

/**
 * One real service on the other end of §6's wire, answering `resources/subscribe` natively
 * (§21.4: "the author's SDK answers it natively, so neither client library changes"). It
 * answers the registration-time `server/discover` with -32601 — §20.5's compatibility
 * fallback, the leg every service already in the field takes — so this file states nothing
 * about that answer's shape, which is tunnel/**'s.
 */
async function dialFeed(token: string): Promise<() => Promise<void>> {
  const response = await worker.fetch(
    new Request(`${ORIGIN}/connect`, {
      headers: { Upgrade: "websocket", Authorization: `Bearer ${token}` },
    }),
    env as unknown as Env,
  );
  const socket = response.webSocket;
  if (response.status !== 101 || socket === null) {
    throw new Error(`/connect refused the upgrade: ${response.status}`);
  }
  socket.accept();
  socket.addEventListener("message", (event) => {
    const data = typeof event.data === "string" ? event.data : "";
    const frame = JSON.parse(data) as { id?: unknown; method?: unknown };
    // A warm whose answer arrives after the case closed this socket is a teardown race, not
    // a fixture failure: the send is guarded so it cannot surface as an uncaught exception.
    const answer = (body: Record<string, unknown>) => {
      try {
        socket.send(JSON.stringify({ jsonrpc: "2.0", id: frame.id, ...body }));
      } catch {
        // already closed
      }
    };
    if (frame.method === "server/discover") {
      answer({ error: { code: -32601, message: "method not found" } });
    } else if (frame.method === "tools/list") {
      answer({ result: { tools: [] } });
    } else if (frame.method === "prompts/list") {
      answer({ result: { prompts: [] } });
    } else if (frame.method === "resources/list") {
      answer({ result: { resources: [] } });
    } else if (frame.method === "resources/templates/list") {
      answer({ result: { resourceTemplates: [] } });
    } else if (frame.method === "resources/subscribe" || frame.method === "resources/unsubscribe") {
      answer({ result: SUBSCRIBE_RESULT });
    }
  });
  socket.send(
    JSON.stringify({
      jsonrpc: "2.0",
      id: "register",
      method: "hub/register",
      params: { clientVersion: "order-table/0", protocolVersion: "2026-07-28", roles: {} },
    }),
  );
  return async () => {
    try {
      socket.close(1000, "case teardown");
    } catch {
      // already gone
    }
  };
}

/** Registration is observable, never slept for: the pipeline serving the catalog IS
 *  registration having completed, and `status` reading online is what the availability
 *  check below consults. */
async function untilOnline(world: D14World): Promise<void> {
  for (let turn = 0; turn < 250; turn++) {
    if ((await status(world.ns.services[FEED].id)) === "online") return;
    await new Promise<void>((resolve) => {
      // REAL time: workerd is the runtime under test and vitest's fake timers do not reach
      // inside it. One millisecond per turn, and the loop exits on the condition itself.
      setTimeout(resolve, 1);
    });
  }
  throw new Error("the tunneled service never registered");
}


describe("§21.1 — what a listen request is refused for, and what it is not", () => {
  it("§21.1 · a GRANTED caller's scoped subscriptions/listen against an archived service is -32002 before the stream opens · the same caller's aggregated stream opens with the archived service simply not subscribed (the allow-twin)", async () => {
    const world = await seedD14({ archived: true });

    const scoped = await listenAt(world.url(FEED), world.agent);
    expect(scoped.code, "the refusal is a payload, and it comes before the first byte").toBe(-32002);
    expect(scoped.contentType).not.toContain("text/event-stream");
    expect(scoped.sessionId, "a refused open mints nothing").toBeNull();

    // The allow-twin: on the aggregated shape an archived service is not a refusal, it is
    // simply not in the subscribed set (§21.1) — and the stream is the same 200 either way.
    const aggregated = await listenAt(world.url(), world.agent);
    expect(aggregated.status).toBe(200);
    expect(aggregated.contentType).toContain("text/event-stream");
    expect(aggregated.code).toBeUndefined();
  });

  it("§21.1 · availability is never checked on listen — an offline tunneled service and a needs-reconnect proxied one, each -32000 to every call, both hand back a scoped stream", async () => {
    // FLAGGED, and stated rather than hidden: the proxied half rides `not_connected`, the
    // OTHER of §7's two known-unavailable proxied states, because this file's own seeder
    // hard-refuses needs_reconnect ("reaching it here would mean running a whole connect
    // flow, which is upstream-credentials.test.ts's subject and not this table's") and the
    // flip has exactly one production trigger — a rejected refresh. What the row needs of
    // the fixture is a service the hub KNOWS it cannot reach, which is what both states are;
    // needs_reconnect's own -32000 is pinned in upstream-proxy.test.ts.
    const world = await seedD14({ unreachableProxy: true });

    for (const slug of [FEED, NOTION]) {
      const call = await rpc(
        world.url(slug),
        world.agent,
        message("tools/call", { name: TOOL, arguments: ARGS }),
      );
      expect(call.error?.code, `${slug}: every CALL is refused`).toBe(-32000);

      // …and the stream is handed back anyway: a stream against a service that is down is
      // the point — the bell rings when it comes back changed (§21.1).
      const stream = await listenAt(world.url(slug), world.agent);
      expect(stream.code, `${slug}: availability was consulted`).toBeUndefined();
      expect(stream.status, slug).toBe(200);
      expect(stream.contentType, slug).toContain("text/event-stream");
    }
  });
});

describe("§21.4 — the two per-URI methods, in §7's order", () => {
  it("§7/§21.4 · resources/subscribe and resources/unsubscribe are -32601 on the aggregated endpoint · and -32601 scoped against a proxied service and the builtin — the capability is never advertised and there is nowhere to forward", async () => {
    const world = await seedD13();
    const owner = await world.ownerToken();

    for (const method of ["resources/subscribe", "resources/unsubscribe"]) {
      // Aggregated: a URI cannot take a `<slug>_` prefix and still be the URI the service
      // knows (§18 decision 26), so the shape refuses before any service is resolved.
      const aggregated = await rpc(world.url(), world.agent, message(method, { uri: URI }));
      expect(aggregated.error?.code, `${method}: aggregated`).toBe(-32601);

      // Scoped against a PROXIED service: no DO, no channel, nothing to forward to (§21.2),
      // and §21.5 never advertises the capability for it.
      const proxied = await rpc(world.url(NOTION), world.agent, message(method, { uri: URI }));
      expect(proxied.error?.code, `${method}: proxied`).toBe(-32601);

      // …and the builtin, whose tools never change — owner-only (§8), so a session's bearer.
      const builtin = await rpc(world.url(PMCP_SLUG), owner, message(method, { uri: URI }));
      expect(builtin.error?.code, `${method}: builtin`).toBe(-32601);
    }
  });

  it("§21.4 · an ungranted URI against an ARCHIVED service is -32001, never -32002 — the URI filter runs first, per the table's overlapping-condition doctrine", async () => {
    // A grant on a role the service never declared: §7 keeps it a GRANT (so the door admits
    // the caller — a 404 here would prove nothing about the order) whose pattern set is
    // EMPTY, so every URI is ungranted. The service is archived as well, which is the
    // overlapping condition: only the order decides which of the two codes comes back.
    const world = await seedD14({ role: D14_ROLE, archived: true });

    const refused = await rpc(
      world.url(FEED),
      world.agent,
      message("resources/subscribe", { uri: D14_URI }),
    );
    expect(refused.error?.code).toBe(-32001);
  });

  it("§21.4 · a granted URI against an archived AND known-offline service is -32002, never -32000 · the granted, online subscribe dispatches and returns the service's result (the allow-twin)", async () => {
    // Granted by the built-in wildcard, so the URI filter passes and the next two checks are
    // the only ones left. The service is archived AND has never held a socket: -32000 is the
    // answer an implementation that checked availability first would give.
    const archived = await seedD14({ archived: true });
    const refused = await rpc(
      archived.url(FEED),
      archived.agent,
      message("resources/subscribe", { uri: D14_URI }),
    );
    expect(refused.error?.code).toBe(-32002);

    // The allow-twin, on a service that is genuinely online: the frame reaches it and its
    // answer is relayed verbatim. No stream is open, so the DO stores nothing and forwards
    // anyway — a legal MCP request whose notifications are simply undeliverable (§21.4).
    const live = await seedD14({ online: true });
    try {
      await untilOnline(live);
      const dispatched = await rpc(
        live.url(FEED),
        live.agent,
        message("resources/subscribe", { uri: D14_URI }),
      );
      expect(dispatched.error, JSON.stringify(dispatched.error)).toBeUndefined();
      expect(dispatched.result).toEqual(SUBSCRIBE_RESULT);
    } finally {
      await live.close();
    }
  });
});
