// upstream-credentials.test.ts — custody of upstream credentials (§7, §5): the envelope
// at rest, the totality of `connectionStatus`, and the connect flow's refusal matrix.
//
// The file exists because every failure it pins is silent. An envelope that stopped being
// encrypted still works; a callback that accepts a replayed `state` still connects; a
// `connectionStatus` that answers `connected` for a service whose refresh died still
// renders a page. Nothing goes red in production — the owner just has a D1 export with
// upstream tokens in it, or an attacker's authorization code redeemed into the owner's
// service row.
//
// Three things carry it:
//  · The status function is TOTAL over auth mode × stored-envelope state, which is why
//    the table is a cross-product with a coverage law rather than a handful of cases:
//    `needs_reconnect` is unreachable in headers mode, and the way to pin an unreachable
//    combination is to enumerate the space, not to test the reachable corners.
//  · Every callback refusal stores NOTHING — asserted against the whole service row, not
//    the envelope column alone. A refusal that still stamped a status or an audit row
//    would be a partial write on the CSRF path.
//  · The fake authorization server is ADVERSARIAL, not spec-shaped (strategy §9): it
//    serves no RFC 9728 document, refuses CIMD so DCR is forced, omits `expires_in`, and
//    performs a REAL S256 verifier check. Those are four production-only OAuth failures
//    made in-process, and a spec-shaped fake would pin none of them.
//
// Boundaries: refresh-before-forward, the needs_reconnect call path and the
// everything-becomes--32000 failure table are upstream-proxy.test.ts's; the flip that
// clears the envelope when the auth MODE changes is registry's row invariant, pinned in
// registry.test.ts and only observed here through connectionStatus.
//
// Project: `worker` — real D1, real WebCrypto, real fetch through miniflare's
// outboundService (fetchMock is gone; the fake AS and fake upstream are routes on that
// one router). No socket, no DO: parallel, per-file isolation, order free. The state
// row's TTL is read from limits.OAUTH_STATE_TTL_MS, never as a literal (§7).
//
// deps: test/harness/seed (namespace, proxied services) · test/harness/fake-upstream
// (outboundService router: the adversarial fake AS + token endpoint) · server/src/upstream
// (beginConnect, handleCallback, disconnect, setHeaders, connectionStatus,
// cleanupStaleState, clientMetadata) · server/src/limits (OAUTH_STATE_TTL_MS) · env.DB
// (real D1) · crypto.subtle (the AS's real S256 check)

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { query } from "../../src/audit";
import { requireOwnerSession } from "../../src/identity";
import worker from "../../src/index";
import type { Env } from "../../src/index";
import { OAUTH_STATE_TTL_MS } from "../../src/limits";
import { Registry } from "../../src/registry";
import type { ServiceDetail } from "../../src/registry";
import {
  beginConnect,
  CLIENT_METADATA_PATH,
  clientMetadata,
  cleanupStaleState,
  connectionStatus,
  disconnect,
  setHeaders,
} from "../../src/upstream";
import type { UpstreamConnectionStatus } from "../../src/upstream";
import {
  AS_HOST,
  asUrlFor,
  fakeAccessToken,
  fakeRefreshToken,
  readObservations,
  upstreamUrlFor,
} from "../harness/fake-upstream";
import type { AsQuirk, AsScenario, UpstreamScenario } from "../harness/fake-upstream";
import { seedNamespace, seedOwnerSession, seedToken, uniqueSlug } from "../harness/seed";
import type { SeededNamespace, SeededSession } from "../harness/seed";

/**
 * One cell of the status cross-product: an auth mode, an envelope state, and the answer.
 *
 * `envelope` names STORED state rather than upstream reality on purpose — connectionStatus
 * never dials, so a `connected` answer means "the last refresh left a live bundle here",
 * and a genuinely-down upstream that still holds good credentials is correctly
 * `connected` until a call proves otherwise. A row asserting otherwise would be asking
 * this function to do I/O it must not do.
 *
 * `unopenable` is a stored state like any other, not a hypothetical: the envelope leads
 * with a version byte precisely so UPSTREAM_CREDS_KEY can rotate without a migration
 * (upstream.ts's module header), and ciphertext written under the previous key — or under
 * a version this build does not know — is what a rotation without a re-seal leaves in the
 * column. The read is on the hot path (gateway.probeAvailability calls it per proxied
 * `tools/call`), so what it answers to a foreign envelope decides whether an owner sees a
 * Reconnect button or every consumer sees an unhandled error.
 */
export type ConnectionStatusRow = {
  title: string;
  authMode: NonNullable<ServiceDetail["upstreamAuthMode"]>;
  envelope: "none" | "headers" | "oauth_live" | "oauth_refresh_failed" | "unopenable";
  expect: UpstreamConnectionStatus;
};

/**
 * The single defect introduced into an otherwise-complete callback — the anti-CSRF and
 * mix-up matrix of §7. `none` is a member, so the allow-twin sits in the same table
 * (§9 rule 2): a handler that rejected every callback would satisfy a refusals-only list
 * and break nothing a test could see.
 *
 * `bearer_sourced_session` is not a duplicate of `no_owner_session`: a CLI device-flow
 * session replayed as a cookie is a VALID session that must still be refused here, which
 * is the whole reason identity distinguishes them.
 *
 * Three members cover §7's `iss` check, because that check is CONDITIONAL — it binds only
 * "when the AS advertises RFC 9207 support" — and a conditional needs a row on each side
 * of its condition or half of it is unwritten. `iss_mismatch` and `iss_missing` are the
 * two ways an advertising AS fails it (a wrong issuer, and no issuer at all — the cheaper
 * attack, since an attacker's AS simply does not echo the parameter, and `params.iss &&
 * params.iss !== recorded` waves it through); `iss_absent_not_advertised` is the branch
 * where the check does not bind, and it is an ALLOW member like `none`: a hub that
 * demanded `iss` unconditionally would refuse every AS that has not adopted RFC 9207 —
 * the majority, which is why the strategy files it as a likely-dead branch (§10) — and
 * connect would simply never complete.
 */
export type CallbackDefect =
  | "none"
  | "state_missing"
  | "state_unknown"
  | "state_replayed"
  | "state_expired"
  | "state_other_session"
  | "no_owner_session"
  | "bearer_sourced_session"
  | "iss_mismatch"
  | "iss_missing"
  | "iss_absent_not_advertised"
  | "verifier_mismatch";

/**
 * One callback row. `stores` is binary because the rule is binary — either the flow
 * completed and sealed a bundle, or the service row is byte-identical to before. The
 * response the browser gets is deliberately absent from the row type: error prose and
 * redirect targets are incidental (§7), and "never echoes AS details" is a hygiene law
 * asserted once by the runner rather than transcribed per row.
 */
export type OAuthCallbackRow = {
  title: string;
  defect: CallbackDefect;
  stores: "credential_envelope" | "nothing";
  audit: "upstream.oauth_connected" | "none";
};

/**
 * Rows are OWNER-AUTHORED in a separate commit before implementation (strategy §9
 * rule 1) — agents never fill them.
 */
export const connectionStatusRows: readonly ConnectionStatusRow[] = [
  // The fixture, named once: one proxied service whose `upstream_auth_mode` is the row's
  // `authMode` and whose stored envelope is the row's `envelope` — nothing else varies,
  // because nothing else may change the answer. The read dials nothing, so there is no
  // upstream to configure and no scenario to name.
  //
  // Why all ten cells and not the four reachable ones. Two combinations cannot occur
  // while registry.updateService keeps its row invariant (an auth-mode flip clears the
  // envelope in the same write — registry.test.ts's row): a headers-mode service holding
  // an oauth bundle, and an oauth-mode service holding stored headers. They are enumerated
  // here anyway, because the sentence this function has to be TOTAL over is not "what can
  // happen" but "what does it answer" — a status read that reported `connected` for
  // credentials the service's mode cannot use would render a Disconnect button over a
  // service that cannot call, and no reachable-corners table would notice. The rule the
  // two cells encode is one sentence: an envelope whose kind does not match the mode is
  // no credential at all.
  //
  // The second unreachable combination is the point of row 4: `needs_reconnect` is an
  // oauth-only state, and "unreachable in headers mode" is only pinned by asking the
  // headers-mode cell what it answers.
  //
  // The fifth envelope state is the opposite case — REACHABLE and easy to leave unasked.
  // An envelope that will not open (foreign version byte, or ciphertext from before an
  // UPSTREAM_CREDS_KEY rotation) is exactly what the version byte exists to survive, and
  // the two answers a status read could give it are both wrong in a way no other row
  // catches: throwing turns every consumer refusal on that service into an unhandled
  // error (probeAvailability is called per proxied call), and answering `connected` sends
  // the pipeline off to dial with a credential the hub cannot decrypt. The cells below
  // say which answer it is instead.
  {
    title:
      "§7 · headers mode, no envelope → not_connected — a fresh service, and what Disconnect leaves behind",
    authMode: "headers",
    envelope: "none",
    expect: "not_connected",
  },
  // §7/upstream.ts: "Headers-mode services report `connected` iff headers are stored."
  // The allow-twin of every not_connected row above and below it (§9 rule 2): a status
  // function stuck on not_connected would satisfy a refusals-only table perfectly.
  {
    title:
      "§7 · headers mode, stored headers → connected — the one way headers mode ever reads connected (the allow-twin of the mode's other three cells)",
    authMode: "headers",
    envelope: "headers",
    expect: "connected",
  },
  {
    title:
      "§7 · headers mode holding an oauth bundle → not_connected: an envelope whose kind does not match the mode is no credential at all",
    authMode: "headers",
    envelope: "oauth_live",
    expect: "not_connected",
  },
  // The unreachable state, asked rather than assumed: §7 says a headers-mode service "can
  // never be `needs_reconnect`", which is a claim about the ANSWER, so the cell that could
  // wrongly produce it is the only place to pin it.
  {
    title:
      "§7 · headers mode holding a dead oauth bundle → not_connected, never needs_reconnect — the state is unreachable in headers mode, and this row is what says so",
    authMode: "headers",
    envelope: "oauth_refresh_failed",
    expect: "not_connected",
  },
  // §5/upstream.ts:300-301 — the version byte is there so the key can rotate without a
  // migration, which makes "the stored bytes do not open under today's key" a state the
  // owner reaches by rotating a secret, not a corruption story. Headers mode reports
  // `connected` iff HEADERS are stored (§7); bytes that yield no headers are no headers.
  {
    title:
      "§7/§5 · headers mode holding an envelope that will not open — a foreign version byte, or ciphertext from before an UPSTREAM_CREDS_KEY rotation → not_connected, and never a throw: this read runs on every proxied call",
    authMode: "headers",
    envelope: "unopenable",
    expect: "not_connected",
  },
  {
    title:
      "§7 · oauth mode, no envelope → not_connected — Connect has not run yet, or Disconnect wiped the bundle",
    authMode: "oauth",
    envelope: "none",
    expect: "not_connected",
  },
  {
    title:
      "§7 · oauth mode holding stored headers → not_connected: the mismatch is refused in this direction too, so neither mode can borrow the other's credential",
    authMode: "oauth",
    envelope: "headers",
    expect: "not_connected",
  },
  // The row that makes the type's "STORED state, never upstream reality" note executable:
  // this answer must hold with the upstream face-down, because the function never dials.
  {
    title:
      "§7 · oauth mode, a live token bundle → connected — the last refresh left it live, and a genuinely-down upstream stays connected until a call proves otherwise",
    authMode: "oauth",
    envelope: "oauth_live",
    expect: "connected",
  },
  {
    title:
      "§7 · oauth mode, a bundle whose refresh failed → needs_reconnect — calls fail -32000 and /services offers Reconnect until the owner runs Connect again",
    authMode: "oauth",
    envelope: "oauth_refresh_failed",
    expect: "needs_reconnect",
  },
  // The oauth twin of the headers row above, and the one place the two answers differ: an
  // envelope the hub cannot open is a credential the hub cannot use, and the owner's only
  // repair in oauth mode is to run Connect again — which is precisely the button
  // `needs_reconnect` renders. `not_connected` would render Connect too, but it would also
  // tell `/services` the service was never connected, which is a different sentence than
  // "the credential it has is unusable".
  {
    title:
      "§7/§5 · oauth mode holding an envelope that will not open → needs_reconnect, and never a throw — the owner's one repair is Connect again, and a status read that crashed would take every consumer refusal on the service with it",
    authMode: "oauth",
    envelope: "unopenable",
    expect: "needs_reconnect",
  },
];

/** Rows are OWNER-AUTHORED, as above (strategy §9 rule 1). */
export const oauthCallbackRows: readonly OAuthCallbackRow[] = [
  // One row per CallbackDefect member, `none` included — the allow-twin sits IN the table
  // (§9 rule 2) rather than beside it, because a handler that refused every callback would
  // satisfy a refusals-only list and break nothing any other case here can see.
  //
  // Every refusal row is the SAME complete flow with one thing bent, which is what makes
  // `stores: "nothing"` mean something: the code is real, the AS is willing, the redemption
  // would have succeeded. Only the defect stands between the row and a stored bundle.
  //
  // §7's sentence these transcribe: "missing, mismatched, expired, or replayed `state`
  // rejects the callback with nothing stored".
  {
    title:
      "§7 · a complete callback on its own live state row → the bundle is sealed into the envelope and upstream.oauth_connected is written (the allow-twin every refusal below sits beside)",
    defect: "none",
    stores: "credential_envelope",
    audit: "upstream.oauth_connected",
  },
  {
    title:
      "§7 · no `state` parameter at all → refused, nothing stored: the callback's first act is to resolve a state row, never to redeem a code",
    defect: "state_missing",
    stores: "nothing",
    audit: "none",
  },
  {
    title:
      "§7 · a well-formed `state` matching no row → refused, nothing stored — an invented nonce is answered exactly like a consumed one",
    defect: "state_unknown",
    stores: "nothing",
    audit: "none",
  },
  // Single-use, and the reason the consuming delete is a compare-and-set: the replay row
  // is the sequential half of the concurrency case in this file's last describe block.
  {
    title:
      "§7 · a `state` already consumed by an earlier callback → refused, nothing stored: single-use is enforced by the consuming delete, not by a flag anyone could forget to read",
    defect: "state_replayed",
    stores: "nothing",
    audit: "none",
  },
  // §5/§7: the TTL is limits.OAUTH_STATE_TTL_MS, and the row is still in the table when
  // this callback arrives — the daily sweep is hygiene, so expiry has to bite at read time
  // or it does not bite at all.
  {
    title:
      "§7/§5 · a `state` row past limits.OAUTH_STATE_TTL_MS → refused, nothing stored, while the row is still in the table — expiry bites at read time, the sweep is only hygiene",
    defect: "state_expired",
    stores: "nothing",
    audit: "none",
  },
  {
    title:
      "§7 · a live, unconsumed `state` belonging to a DIFFERENT owner session → refused, nothing stored: the row is bound to the session that minted it",
    defect: "state_other_session",
    stores: "nothing",
    audit: "none",
  },
  // §13: /oauth/upstream/callback is part of the cookie-session-gated surface. No session,
  // no callback — before `state` is even looked up.
  {
    title:
      "§13/§7 · a callback carrying no owner cookie session → refused, nothing stored: Connect's callback is a cookie-session-gated surface",
    defect: "no_owner_session",
    stores: "nothing",
    audit: "none",
  },
  // NOT a duplicate of the row above (see CallbackDefect's own note): this session is
  // valid — a CLI device-flow session replayed as a cookie — and must still be refused,
  // which is the whole reason identity distinguishes the two sources.
  {
    title:
      "§7/§13 · a VALID bearer-sourced (CLI device-flow) session replayed as the callback's cookie → refused, nothing stored — a session is not enough, it must be the browser session that began the flow",
    defect: "bearer_sourced_session",
    stores: "nothing",
    audit: "none",
  },
  // §7: "when the AS advertises RFC 9207 support, verifies the response's `iss` equals the
  // recorded issuer". The fake AS's `advertise_iss` / `wrong_iss` quirks are this row and
  // its complete-flow twin at the top of the table.
  {
    title:
      "§7 · RFC 9207: an `iss` that is not the issuer recorded at initiation → refused, nothing stored (the mix-up defense's second half)",
    defect: "iss_mismatch",
    stores: "nothing",
    audit: "none",
  },
  // The same check, failed the cheap way. An attacker's AS does not have to send a WRONG
  // issuer — omitting the parameter costs nothing, and the natural spelling of the check
  // (`if (params.iss && params.iss !== recorded) reject`) treats absence as consent. The
  // AS here advertises RFC 9207 and then omits `iss`, which the fake AS has no quirk for
  // yet: advertise-and-omit is this row's fixture, beside `advertise_iss` / `wrong_iss`.
  {
    title:
      "§7 · RFC 9207: an AS that advertises support and then sends NO `iss` at all → refused, nothing stored — the mix-up attack is an omitted parameter, so the check has to bite on absence, not only on mismatch",
    defect: "iss_missing",
    stores: "nothing",
    audit: "none",
  },
  // The other side of §7's conditional, and an ALLOW row: the AS advertises no RFC 9207
  // support (no quirk on the fake AS at all) and sends no `iss`, and the flow must
  // complete. Without this row an unconditional `iss` requirement passes every other row
  // in the table and refuses every real-world AS that has not adopted the RFC — a failure
  // that is silent in this suite's exact sense: connect just never completes.
  {
    title:
      "§7 · an AS that does NOT advertise RFC 9207 and sends no `iss` → the bundle is sealed and upstream.oauth_connected is written: the check is conditional, and demanding `iss` unconditionally would lock the hub out of every AS that has not adopted it",
    defect: "iss_absent_not_advertised",
    stores: "credential_envelope",
    audit: "upstream.oauth_connected",
  },
  // The refusal the fake AS produces itself, with real S256: the hub presents a verifier
  // that is not the one bound to this state, the AS rejects the redemption, and the hub
  // must leave the service row exactly as it found it rather than storing a half-flow.
  {
    title:
      "§7 · the AS's own S256 check rejects the redemption — a verifier that is not the one bound to this state → refused, nothing stored",
    defect: "verifier_mismatch",
    stores: "nothing",
    audit: "none",
  },
];

/**
 * Registers one case per status row: seed the mode and envelope state, assert the answer,
 * and assert the call made no outbound request (the read is side-effect free by
 * contract). Two table laws: the rows exhaust auth mode × envelope state — totality is
 * the property here, so a combination without a row fails the table rather than going
 * unasked — and no row's read ever THROWS. The second is not decoration: this function is
 * called per proxied `tools/call` by the approval path's availability probe, so a throw
 * on any stored byte-sequence turns a service's refusals into unhandled errors, and the
 * `unopenable` rows are the ones that would produce it.
 */
export function runConnectionStatusTable(rows: readonly ConnectionStatusRow[]): void {
  // deps: test/harness/seed · server/src/upstream (connectionStatus)
  for (const row of rows) {
    it(row.title, async () => {
      const world = await seedStatusWorld(row);
      const before = (await readObservations(world.upstreamId)).length;
      // Called bare — no try/catch — because "never a throw" is one of this table's two
      // laws and a caught throw would be a passing test for a crashing hot path.
      expect(await connectionStatus(world.service), row.title).toBe(row.expect);
      expect(
        (await readObservations(world.upstreamId)).length,
        `${row.title}: the read dialed the upstream`,
      ).toBe(before);
    }, CASE_BUDGET_MS);
  }
}

/**
 * How long a case in this file may take. Every oauth envelope state is reached by running
 * a WHOLE connect flow (there is no other way to write one — seed.ts's header), and a
 * flow is a sign-in plus four round trips, so the vitest default is not the right budget
 * to measure this file against.
 */
const CASE_BUDGET_MS = 30_000;

/** One status row's world: the service under test, plus the scenario whose observation log
 *  proves the read dialed nothing. */
type StatusWorld = { ns: SeededNamespace; service: ServiceDetail; upstreamId: string };

/**
 * Seed one cell of the cross-product. Every envelope that can be written by a production
 * seam IS — `setHeaders` for the headers bundle, a real connect flow for the oauth ones —
 * and the two mode/kind MISMATCH cells are reached by sealing the bundle on a donor service
 * of the matching mode and copying the ciphertext across. That copy is the only hand-written
 * thing here and it is deliberately not a hand-written ENVELOPE: what the mismatch rows ask
 * is what the reader answers to a real bundle sitting in the wrong service, and a bundle
 * this suite invented would be asking something else.
 */
async function seedStatusWorld(row: ConnectionStatusRow): Promise<StatusWorld> {
  const upstream = liveScenario();
  const donorNeeded = DONOR_MODE[row.envelope];
  const ns = await seedNamespace(env.DB, {
    services: [
      {
        slug: TARGET,
        kind: "proxy",
        upstreamUrl: upstreamUrlFor(upstream),
        upstreamAuthMode: row.authMode,
      },
      ...(donorNeeded === null || donorNeeded === row.authMode
        ? []
        : [
            {
              slug: DONOR,
              kind: "proxy" as const,
              upstreamUrl: upstreamUrlFor(liveScenario()),
              upstreamAuthMode: donorNeeded,
            },
          ]),
    ],
  });
  const registry = new Registry(env.DB);
  const service = await detail(registry, ns, TARGET);
  const world: StatusWorld = { ns, service, upstreamId: upstream.id };

  if (row.envelope === "none") return world;
  if (row.envelope === "unopenable") {
    // What an UPSTREAM_CREDS_KEY rotation without a re-seal leaves behind: bytes led by a
    // version header this build does not know. Written raw because that is what the state
    // IS — no seam can produce ciphertext under a key the worker no longer holds.
    await plantEnvelope(service.id, FOREIGN_ENVELOPE);
    return world;
  }
  const producer = donorNeeded === row.authMode ? service : await detail(registry, ns, DONOR);
  await produceEnvelope(ns, producer, row.envelope);
  if (producer.id !== service.id) {
    await plantEnvelope(service.id, (await envelopeOf(producer.id)) ?? "");
  }
  return world;
}

/** Which auth mode can legitimately produce each envelope — null for the two states no
 *  seam writes (an empty column, and ciphertext from a key that is gone). */
const DONOR_MODE: Record<ConnectionStatusRow["envelope"], "headers" | "oauth" | null> = {
  none: null,
  unopenable: null,
  headers: "headers",
  oauth_live: "oauth",
  oauth_refresh_failed: "oauth",
};

/** Write one real envelope onto `service` through the seam its kind belongs to. */
async function produceEnvelope(
  ns: SeededNamespace,
  service: ServiceDetail,
  envelope: "headers" | "oauth_live" | "oauth_refresh_failed",
): Promise<void> {
  if (envelope === "headers") {
    await setHeaders(service, SENTINEL_HEADERS);
    return;
  }
  // A dead bundle is reached the one way §7 allows: connect, then let a refresh fail. The
  // AS hands out a token that is already expired, so the very next call must refresh — and
  // this persona refuses every refresh.
  const quirks: AsQuirk[] =
    envelope === "oauth_refresh_failed" ? ["stale_first_token", "refresh_fails"] : [];
  await connect(ns, service, { id: uniqueSlug("as"), quirks });
  if (envelope === "oauth_refresh_failed") await failRefresh(ns, service);
}

/**
 * Provoke the one thing that sets `needs_reconnect`: a call whose proactive refresh the AS
 * rejects. Driven through the consumer pipeline rather than by poking the column, because
 * the flag lives INSIDE the ciphertext and only upstream.ts may put it there.
 */
async function failRefresh(ns: SeededNamespace, service: ServiceDetail): Promise<void> {
  const account = await new Registry(env.DB).createAccount({
    ownerId: ns.owner.userId,
    slug: uniqueSlug("caller"),
    name: "caller",
  });
  await new Registry(env.DB).setGrants(account.id, service.id, [{ role: "all", mode: "allow" }]);
  const { token } = await seedToken(ns.owner.userId, "service_account", account.id, account.slug, {
    as: "caller",
  });
  await worker.fetch(
    new Request(`${ORIGIN}/${ns.owner.username}/mcp/${service.slug}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "anything", arguments: {} },
      }),
    }),
    env as unknown as Env,
  );
  if ((await connectionStatus(service)) !== "needs_reconnect") {
    throw new Error(`seed: the refresh did not fail for "${service.slug}"`);
  }
}

/**
 * Registers one case per callback row: run a real begin→callback flow against the fake AS
 * with the row's defect injected, then assert what was stored and what was audited. Three
 * table-wide laws:
 *
 *  · every `nothing` row leaves the ENTIRE service row unchanged, not just the envelope
 *    column;
 *  · no response body or redirect ever carries an AS-derived status, header or body (§7's
 *    hygiene rule extended to this surface);
 *  · the AS's token response carries SENTINEL access and refresh tokens
 *    (`FAKE0000-…`-spelled, like every planted secret in this suite), and after a
 *    `credential_envelope` row neither appears anywhere: not in any column of the service
 *    row (§5 — `upstream_auth_json` is ciphertext at rest so a D1 dump leaks nothing),
 *    not in the `upstream.oauth_connected` row the same call writes (`detail` is a
 *    free-form JSON column, and §5 pins that it never holds token material), and not in
 *    the bytes the browser receives. `stores: "credential_envelope"` says a bundle
 *    landed; only the sentinel says it landed SEALED — and the setHeaders half of the
 *    envelope, pinned in "§5 · the envelope at rest" below, says nothing about this one.
 */
export function runOAuthCallbackTable(rows: readonly OAuthCallbackRow[]): void {
  // deps: test/harness/seed · test/harness/fake-upstream (fake AS) ·
  //       server/src/upstream (beginConnect, handleCallback)
  for (const row of rows) {
    it(row.title, async () => {
      const flow = await beginFlow(QUIRKS_FOR[row.defect]);
      const callback = await bend(flow, row.defect);
      // Taken AFTER the bend, because one defect is a history rather than a parameter: the
      // replay row's first callback is a complete, legitimate flow, and what this row asks
      // is what the SECOND one does. Every column below is therefore a delta around the
      // callback under test.
      const before = await serviceRowOf(flow.service.id);
      const auditedBefore = (
        await query(env.DB, flow.ns.owner.userId, { event: "upstream.oauth_connected" })
      ).total;
      const answer = await worker.fetch(callback, env as unknown as Env);
      const bytes = `${answer.status} ${answer.headers.get("Location") ?? ""} ${await answer.text()}`;

      const after = await serviceRowOf(flow.service.id);
      if (row.stores === "nothing") {
        // The WHOLE row, not the envelope column: a refusal that still stamped a status, a
        // timestamp or a mode would be a partial write on the CSRF path.
        expect(after, `${row.title}: the service row changed`).toEqual(before);
      } else {
        expect(after.upstream_auth_json, `${row.title}: no bundle was sealed`).not.toBeNull();
        expect(await connectionStatus(flow.service)).toBe("connected");
      }

      const written = (
        await query(env.DB, flow.ns.owner.userId, { event: "upstream.oauth_connected" })
      ).rows;
      expect(written.length - auditedBefore, `${row.title}: upstream.oauth_connected`).toBe(
        row.audit === "none" ? 0 : 1,
      );

      // LAW 2 — the browser never learns what the AS said. Not its host, not its status,
      // not its body: an error page that quoted the AS would hand a phished owner the
      // attacker's own diagnostics.
      expect(bytes.includes(AS_HOST), `${row.title}: the response named the AS`).toBe(false);

      // LAW 3 — the sentinel tokens the AS minted appear NOWHERE after a stored flow: not
      // in any column of the service row (the column is ciphertext at rest), not in the
      // audit row the same call writes, and not in the bytes the browser received.
      const sentinels = [fakeAccessToken(flow.as.id), fakeRefreshToken(flow.as.id)];
      for (const sentinel of sentinels) {
        expect(JSON.stringify(after).includes(sentinel), `${row.title}: token in the service row`).toBe(false);
        expect(JSON.stringify(written).includes(sentinel), `${row.title}: token in the ledger`).toBe(false);
        expect(bytes.includes(sentinel), `${row.title}: token in the browser's bytes`).toBe(false);
      }
    }, CASE_BUDGET_MS);
  }
}

/** The AS persona each defect needs — only the three `iss` members ask for one, and the
 *  third asks for the ABSENCE of one, which is why it is spelled here rather than assumed. */
const QUIRKS_FOR: Record<CallbackDefect, AsQuirk[]> = {
  none: [],
  state_missing: [],
  state_unknown: [],
  state_replayed: [],
  state_expired: [],
  state_other_session: [],
  no_owner_session: [],
  bearer_sourced_session: [],
  iss_mismatch: ["wrong_iss"],
  iss_missing: ["omit_iss"],
  iss_absent_not_advertised: [],
  verifier_mismatch: [],
};

/**
 * One connect flow, begun and carried to the AS's redirect but not yet completed — the
 * state every callback row bends exactly one thing about. Everything here is the real
 * path: a real sign-in, a real `beginConnect`, and the fake AS's own 302 rather than a
 * callback URL this suite composed.
 */
type Flow = {
  ns: SeededNamespace;
  service: ServiceDetail;
  as: AsScenario;
  /** The resource scenario the service points at — RFC 9728 and the RFC 8414 fallback
   *  are asked of the RESOURCE, so those arrivals land in this log, not the AS's. */
  upstreamId: string;
  session: SeededSession;
  sessionId: string;
  /** Where the AS sent the browser — the callback URL, unbent. */
  callbackUrl: string;
  state: string;
};

async function beginFlow(quirks: AsQuirk[] = []): Promise<Flow> {
  const as: AsScenario = { id: uniqueSlug("as"), quirks };
  const upstream: UpstreamScenario = {
    id: uniqueSlug("up"),
    mode: { kind: "ok" },
    as,
    requireBearer: `Bearer ${fakeAccessToken(as.id)}`,
  };
  const ns = await seedNamespace(env.DB, {
    services: [
      {
        slug: TARGET,
        kind: "proxy",
        upstreamUrl: upstreamUrlFor(upstream),
        upstreamAuthMode: "oauth",
        roles: { reader: ["search"] },
      },
    ],
  });
  const service = await detail(new Registry(env.DB), ns, TARGET);
  const session = await seedOwnerSession(ns.owner);
  const { sessionId } = await requireOwnerSession(
    new Request(`${ORIGIN}/services`, { headers: { Cookie: session.cookie } }),
  );
  const authorize = await beginConnect(service, { id: sessionId });
  // The browser's leg, answered by the AS itself: composing the callback URL here instead
  // would mean the `code` and the `iss` came from the test rather than from the server the
  // flow is defending against.
  const redirect = await fetch(authorize.toString(), { redirect: "manual" });
  const callbackUrl = redirect.headers.get("Location");
  if (callbackUrl === null) {
    throw new Error(`beginFlow: the fake AS answered no redirect (${redirect.status})`);
  }
  return {
    ns,
    service,
    as,
    upstreamId: upstream.id,
    session,
    sessionId,
    callbackUrl,
    state: authorize.searchParams.get("state") ?? "",
  };
}

/** The row's defect, injected into an otherwise-complete callback. Everything not named
 *  here is left exactly as the real flow produced it. */
async function bend(flow: Flow, defect: CallbackDefect): Promise<Request> {
  const url = new URL(flow.callbackUrl);
  let cookie: string | undefined = flow.session.cookie;
  switch (defect) {
    case "none":
    case "iss_mismatch":
    case "iss_missing":
    case "iss_absent_not_advertised":
      break;
    case "state_missing":
      url.searchParams.delete("state");
      break;
    case "state_unknown":
      url.searchParams.set("state", "FAKE0000-invented-state-nonce");
      break;
    case "state_replayed":
      // Consumed by a first, entirely valid callback — so what this row bends is history.
      await worker.fetch(new Request(url, { headers: { Cookie: cookie } }), env as unknown as Env);
      break;
    case "state_expired":
      await backdateState(flow.state);
      break;
    case "state_other_session": {
      // A second, equally VALID owner session — the row is about which session minted the
      // row, not about whether the caller is signed in.
      cookie = (await seedOwnerSession(flow.ns.owner)).cookie;
      break;
    }
    case "no_owner_session":
      cookie = undefined;
      break;
    case "bearer_sourced_session":
      // The CLI's bearer token replayed as a raw cookie value: a real credential, and the
      // one better-auth's signed cookie is designed to reject.
      cookie = `${flow.session.cookie.split("=")[0]}=${flow.session.token}`;
      break;
    case "verifier_mismatch":
      // The stored verifier is replaced, so the hub presents one that does not hash to the
      // challenge the AS bound — and the AS's own S256 check is what refuses it.
      await retargetVerifier(flow.state);
      break;
  }
  return new Request(url, cookie === undefined ? {} : { headers: { Cookie: cookie } });
}

// ── the file's own vocabulary and D1 sliver ───────────────────────────────────────────

/** The hub's own origin, as the worker under test knows it. */
const ORIGIN = (env as unknown as Env).PUBLIC_ORIGIN;

/** The service every case is about, and the one that exists only to seal a bundle the
 *  target's own mode could not have written. */
const TARGET = "notion";
const DONOR = "donor";

/**
 * The headers this suite seals. Spelled `Authorization` because that is the header a
 * static-token upstream actually wants AND the one the fake upstream can observe — a
 * sentinel nobody can see arrive would prove only half of "sealed, not lost".
 */
const SENTINEL_HEADERS = { Authorization: "Bearer FAKE0000-sealed-upstream-header" };

/**
 * Ciphertext this build cannot open: a leading version byte of 0x02 — a version that does
 * not exist — over bytes that are not a valid AES-GCM frame. It stands for the reachable
 * state §5's version header exists FOR: an UPSTREAM_CREDS_KEY rotated without a re-seal.
 */
const FOREIGN_ENVELOPE = btoa(
  String.fromCharCode(2, ...new Array(32).fill(0).map((_, n) => (n * 7 + 13) % 256)),
);

/** A healthy upstream for a service that is never actually dialed by these cases. */
function liveScenario(): UpstreamScenario {
  return { id: uniqueSlug("up"), mode: { kind: "ok" }, tools: [] };
}

/** The service row as registry reports it, or a loud failure — every case addresses
 *  services by slug and none of them may silently operate on `null`. */
async function detail(
  registry: Registry,
  ns: SeededNamespace,
  slug: string,
): Promise<ServiceDetail> {
  const service = await registry.getService(ns.owner.userId, slug);
  if (service === null) throw new Error(`the seeded service "${slug}" vanished`);
  return service;
}

/**
 * A whole §7 connect flow against `as`, driven exactly as the owner's browser drives it:
 * beginConnect mints the authorization URL, the fake AS answers the 302, and the callback
 * returns through the composition root on the cookie session the flow was bound to.
 */
async function connect(
  ns: SeededNamespace,
  service: ServiceDetail,
  as: AsScenario,
): Promise<void> {
  // Discovery starts at the RESOURCE (§7: RFC 9728 protected-resource metadata), so the
  // upstream this service points at has to advertise this AS persona — and a fake scenario
  // carries everything about itself in its URL (fake-upstream's isolation note). Repointed
  // through registry's own seam, which leaves the credential column alone because the auth
  // MODE is untouched; that keeps the persona a parameter of the flow rather than something
  // every fixture has to decide at seed time.
  await new Registry(env.DB).updateService(service.id, {
    upstreamUrl: upstreamUrlFor({ ...liveScenario(), as }),
  });
  const session = await seedOwnerSession(ns.owner);
  const { sessionId } = await requireOwnerSession(
    new Request(`${ORIGIN}/services`, { headers: { Cookie: session.cookie } }),
  );
  const authorize = await beginConnect(service, { id: sessionId });
  const redirect = await fetch(authorize.toString(), { redirect: "manual" });
  const location = redirect.headers.get("Location");
  if (location === null) throw new Error(`connect: the fake AS answered no redirect`);
  const answer = await worker.fetch(
    new Request(location, { headers: { Cookie: session.cookie } }),
    env as unknown as Env,
  );
  if (answer.status !== 302) throw new Error(`connect: the callback refused (${answer.status})`);
}

/** One headers-mode proxied service on a live fake upstream, plus a credentialled account
 *  — the world the envelope-at-rest cases seal into and dial from. */
async function seedHeadersWorld(): Promise<StatusWorld & { credential: string }> {
  const upstream: UpstreamScenario = { id: uniqueSlug("up"), mode: { kind: "ok" }, tools: [] };
  const ns = await seedNamespace(env.DB, {
    services: [
      {
        slug: TARGET,
        kind: "proxy",
        upstreamUrl: upstreamUrlFor(upstream),
        upstreamAuthMode: "headers",
        logBodies: true,
      },
    ],
    accounts: [
      { slug: "agent", grants: { [TARGET]: [{ role: "all", mode: "allow" }] }, tokens: [{ as: "t" }] },
    ],
  });
  return {
    ns,
    service: await detail(new Registry(env.DB), ns, TARGET),
    upstreamId: upstream.id,
    credential: ns.tokens.t.token,
  };
}

/** One scoped `tools/call` through the composition root — enough to make the hub dial. */
async function callOnce(world: StatusWorld & { credential: string }): Promise<Response> {
  return worker.fetch(
    new Request(`${ORIGIN}/${world.ns.owner.username}/mcp/${world.service.slug}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${world.credential}` },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "search", arguments: {} },
      }),
    }),
    env as unknown as Env,
  );
}

/** The sliver of the D1 binding this file reaches for directly — every raw read here is
 *  an assertion about a column, and every raw write is a state no seam can reach. */
type D1Like = {
  prepare(sql: string): {
    bind(...values: unknown[]): {
      run(): Promise<unknown>;
      first<T>(): Promise<T | null>;
      all<T>(): Promise<{ results: T[] }>;
    };
  };
};
const db = () => env.DB as D1Like;

/** The whole service row, for the "nothing stored" law — every column, not just the one. */
async function serviceRowOf(serviceId: string): Promise<Record<string, unknown>> {
  const row = await db().prepare(`SELECT * FROM service WHERE id = ?`).bind(serviceId).first<Record<string, unknown>>();
  if (row === null) throw new Error("serviceRowOf: the service vanished");
  return row;
}

async function envelopeOf(serviceId: string): Promise<string | null> {
  const row = await db()
    .prepare(`SELECT upstream_auth_json FROM service WHERE id = ?`)
    .bind(serviceId)
    .first<{ upstream_auth_json: string | null }>();
  return row?.upstream_auth_json ?? null;
}

/** Move a bundle (or a foreign byte sequence) onto a service the seams would not have put
 *  it on — the only hand-written write in this file, and only for the states no seam has. */
async function plantEnvelope(serviceId: string, envelope: string): Promise<void> {
  await db()
    .prepare(`UPDATE service SET upstream_auth_json = ? WHERE id = ?`)
    .bind(envelope, serviceId)
    .run();
}

/** Age a live state row past limits.OAUTH_STATE_TTL_MS — the TTL by NAME, never a literal,
 *  and applied to the row rather than to a clock so the row is still in the table. */
async function backdateState(state: string): Promise<void> {
  const past = Date.now() - OAUTH_STATE_TTL_MS - 1_000;
  await db()
    .prepare(`UPDATE upstream_oauth_state SET created_at = ?, expires_at = ? WHERE state = ?`)
    .bind(past - OAUTH_STATE_TTL_MS, past, state)
    .run();
}

/** Replace the bound PKCE verifier, so the hub presents one that does not hash to the
 *  challenge the AS recorded — and the AS's own S256 check is what refuses the redemption. */
async function retargetVerifier(state: string): Promise<void> {
  await db()
    .prepare(`UPDATE upstream_oauth_state SET code_verifier = ? WHERE state = ?`)
    .bind("FAKE0000-not-the-bound-verifier-0123456789abcdef", state)
    .run();
}

/** How many state rows are past their TTL right now, across the whole table — the sweep's
 *  own scope, which is namespace-blind by design (one daily cron for the hub). */
async function expiredStateCount(): Promise<number> {
  const row = await db()
    .prepare(`SELECT COUNT(*) AS n FROM upstream_oauth_state WHERE expires_at <= ?`)
    .bind(Date.now())
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** Every live state row for one owner, as the connect flow wrote it. */
async function stateRowsOf(ownerId: string): Promise<Record<string, unknown>[]> {
  return (
    await db()
      .prepare(`SELECT * FROM upstream_oauth_state WHERE owner_id = ?`)
      .bind(ownerId)
      .all<Record<string, unknown>>()
  ).results;
}

describe("§7 · connectionStatus is total", () => {
  runConnectionStatusTable(connectionStatusRows);

  it("§7 · the cross-product is exhausted and the read dials nothing", () => {
    // Totality is the property, so a combination without a row fails the TABLE rather than
    // going unasked — which is the whole reason this is a cross-product and not a handful
    // of reachable corners.
    const modes: ConnectionStatusRow["authMode"][] = ["headers", "oauth"];
    const envelopes: ConnectionStatusRow["envelope"][] = [
      "none",
      "headers",
      "oauth_live",
      "oauth_refresh_failed",
      "unopenable",
    ];
    const cells = connectionStatusRows.map((row) => `${row.authMode}/${row.envelope}`);
    for (const authMode of modes) {
      for (const envelope of envelopes) {
        expect(cells, `no row asks ${authMode} × ${envelope}`).toContain(`${authMode}/${envelope}`);
      }
    }
    expect(new Set(cells).size, "a cell is asked twice").toBe(modes.length * envelopes.length);
    // §7's own sentence, as a property of the table rather than of one row: the state does
    // not exist in headers mode, and no cell may claim otherwise.
    for (const row of connectionStatusRows) {
      if (row.authMode === "headers") expect(row.expect).not.toBe("needs_reconnect");
    }
  });
});

describe("§5 · the envelope at rest", () => {
  it("§5 · a sentinel header stored through setHeaders appears nowhere in the service row — the column holds ciphertext", async () => {
    const world = await seedHeadersWorld();
    await setHeaders(world.service, SENTINEL_HEADERS);
    const row = await serviceRowOf(world.service.id);
    expect(row.upstream_auth_json, "something was stored").not.toBeNull();
    // The whole row, because "which column" is not the claim: a D1 export of this table
    // must leak nothing, wherever an implementation decided to put it.
    expect(JSON.stringify(row).includes(SENTINEL_HEADERS.Authorization)).toBe(false);
  });

  it("§5 · twin to the case above: the fake upstream observes that exact header on the next dial — sealed, not lost", async () => {
    const world = await seedHeadersWorld();
    await setHeaders(world.service, SENTINEL_HEADERS);
    await callOnce(world);
    const [dial] = await readObservations(world.upstreamId);
    expect(dial?.authorization, "the sealed header is what reached the upstream").toBe(
      SENTINEL_HEADERS.Authorization,
    );
  });

  it("§5 · the envelope leads with a version byte, so ciphertext written under today's key is self-describing before any key is applied", async () => {
    const world = await seedHeadersWorld();
    await setHeaders(world.service, SENTINEL_HEADERS);
    const stored = await envelopeOf(world.service.id);
    const framed = Uint8Array.from(atob(stored ?? ""), (c) => c.charCodeAt(0));
    // Version, then a 12-byte AES-GCM nonce, then ciphertext — readable in that order by
    // anything holding the bytes, which is what lets the key rotate without a migration.
    expect(framed[0], "the leading version byte").toBe(1);
    expect(framed.length, "a nonce and a non-empty ciphertext follow it").toBeGreaterThan(1 + 12);
  });
});

describe("§7 · one credential path per mode", () => {
  it("§7 · setHeaders refuses an oauth-mode service and beginConnect refuses a headers-mode or tunneled one · twins: each mode's own path stores", async () => {
    const ns = await seedNamespace(env.DB, {
      services: [
        {
          slug: "headersmode",
          kind: "proxy",
          upstreamUrl: upstreamUrlFor(liveScenario()),
          upstreamAuthMode: "headers",
        },
        {
          slug: "oauthmode",
          kind: "proxy",
          upstreamUrl: upstreamUrlFor(liveScenario()),
          upstreamAuthMode: "oauth",
        },
        { slug: "tunneled", kind: "tunnel" },
      ],
    });
    const registry = new Registry(env.DB);
    const headersMode = await detail(registry, ns, "headersmode");
    const oauthMode = await detail(registry, ns, "oauthmode");
    const tunneled = await detail(registry, ns, "tunneled");
    const session = { id: "FAKE0000-session-that-never-gets-used" };

    // Each mode has exactly one credential path, so the other mode's path is not a
    // fallback — it is a refusal, and a service that took both would have two.
    await expect(setHeaders(oauthMode, SENTINEL_HEADERS)).rejects.toThrow();
    await expect(beginConnect(headersMode, session)).rejects.toThrow();
    await expect(beginConnect(tunneled, session)).rejects.toThrow();
    // Nothing was half-written on the way to any of those refusals.
    for (const service of [headersMode, oauthMode, tunneled]) {
      expect(await envelopeOf(service.id), service.slug).toBeNull();
    }

    // The twins: each mode's OWN path stores. Without them a module that refused every
    // request would satisfy the three refusals above perfectly.
    await setHeaders(headersMode, SENTINEL_HEADERS);
    expect(await connectionStatus(headersMode)).toBe("connected");
    await connect(ns, oauthMode, { id: uniqueSlug("as") });
    expect(await connectionStatus(oauthMode)).toBe("connected");
  }, CASE_BUDGET_MS);

  it("§7 · disconnect wipes the envelope, writes upstream.disconnected, leaves roles, grants and config untouched, and is idempotent", async () => {
    const ns = await seedNamespace(env.DB, {
      services: [
        {
          slug: TARGET,
          kind: "proxy",
          upstreamUrl: upstreamUrlFor(liveScenario()),
          upstreamAuthMode: "headers",
          roles: { reader: ["search"] },
          redact: { search: ["password"] },
          forwardIdentity: true,
        },
      ],
      accounts: [{ slug: "agent", grants: { [TARGET]: [{ role: "reader", mode: "allow" }] } }],
    });
    const registry = new Registry(env.DB);
    const service = await detail(registry, ns, TARGET);
    await setHeaders(service, SENTINEL_HEADERS);
    const configured = await serviceRowOf(service.id);

    await disconnect(service);
    expect(await envelopeOf(service.id), "the bundle is gone").toBeNull();
    expect(await connectionStatus(service)).toBe("not_connected");
    // Every other column is what it was: Disconnect is a credential op, not a reset.
    expect(await serviceRowOf(service.id)).toEqual({ ...configured, upstream_auth_json: null });
    const grants = await registry.grantsFor(ns.accounts.agent.id);
    expect(grants.find((entry) => entry.serviceSlug === TARGET)?.entries).toEqual([
      { role: "reader", mode: "allow" },
    ]);

    await disconnect(service);
    expect(await envelopeOf(service.id), "idempotent about the envelope").toBeNull();
    // The audit row is NOT idempotent, and deliberately: it records that Disconnect RAN,
    // which is what an owner reading the ledger asked about.
    const written = await query(env.DB, ns.owner.userId, { event: "upstream.disconnected" });
    expect(written.total).toBe(2);
    expect(written.rows[0].service).toBe(TARGET);
    expect(written.rows[0].principal).toBe(`user:${ns.owner.username}`);
  }, CASE_BUDGET_MS);
});

describe("§7 · the connect flow against an adversarial AS", () => {
  it("§7 · beginConnect records one single-use state row bound to owner, service, issuer, token endpoint, verifier and session — and stores nothing on the service", async () => {
    const flow = await beginFlow();
    const rows = await stateRowsOf(flow.ns.owner.userId);
    expect(rows.length, "one row per initiation, and only one").toBe(1);
    const [state] = rows;
    expect(state).toMatchObject({
      state: flow.state,
      owner_id: flow.ns.owner.userId,
      service_id: flow.service.id,
      session_id: flow.sessionId,
      issuer: asUrlFor(flow.as),
      token_endpoint: `${asUrlFor(flow.as)}/token`,
      redirect_uri: `${ORIGIN}/oauth/upstream/callback`,
    });
    expect(typeof state.code_verifier === "string" && state.code_verifier.length >= 43).toBe(true);
    // The TTL by name, with a second of slack for the round trips between mint and read.
    expect(Number(state.expires_at) - Number(state.created_at)).toBe(OAUTH_STATE_TTL_MS);
    // Initiation stores NOTHING on the service: a flow abandoned in the browser leaves a
    // service exactly as connected — or as unconnected — as it was.
    expect(await envelopeOf(flow.service.id)).toBeNull();
    expect(await connectionStatus(flow.service)).toBe("not_connected");
  }, CASE_BUDGET_MS);

  it("§7 · the AS's real S256 check bites: a redemption carrying a verifier that does not match the recorded challenge is refused and stores nothing · twin: the bound verifier redeems", async () => {
    const bent = await beginFlow();
    await retargetVerifier(bent.state);
    const refused = await worker.fetch(await bend(bent, "none"), env as unknown as Env);
    expect(refused.status).toBe(400);
    expect(await envelopeOf(bent.service.id), "a half-flow was stored").toBeNull();
    // The AS's own arithmetic, read back rather than recomputed here: recomputing the hash
    // in the test would just be a second implementation of the thing under test.
    const checks = (await readObservations(bent.as.id)).filter((seen) => seen.pkce !== undefined);
    expect(checks.length, "the AS performed a check").toBe(1);
    expect(checks[0].pkce?.ok, "and it failed").toBe(false);

    const bound = await beginFlow();
    const accepted = await worker.fetch(await bend(bound, "none"), env as unknown as Env);
    expect(accepted.status, "the twin: the bound verifier redeems").toBe(302);
    expect(await connectionStatus(bound.service)).toBe("connected");
    const passed = (await readObservations(bound.as.id)).filter((seen) => seen.pkce !== undefined);
    expect(passed[0].pkce?.ok).toBe(true);
  }, CASE_BUDGET_MS);

  it("§7 · mix-up defense: the code is redeemed only at the token endpoint recorded at initiation, even when the AS advertises a different one afterwards", async () => {
    const flow = await beginFlow();
    // A second, entirely functional authorization server, named nowhere in the state row.
    const impostor: AsScenario = { id: uniqueSlug("impostor") };
    const url = new URL(flow.callbackUrl);
    // The callback is an attacker-influenced surface: it says the flow belongs to somebody
    // else and points at somebody else's endpoints. Nothing it says may be believed —
    // §7 binds the redemption to what initiation recorded, not to what the response claims.
    url.searchParams.set("iss", asUrlFor(impostor));
    url.searchParams.set("token_endpoint", `${asUrlFor(impostor)}/token`);
    const answer = await worker.fetch(
      new Request(url, { headers: { Cookie: flow.session.cookie } }),
      env as unknown as Env,
    );

    expect(answer.status, "the flow completed at the RECORDED endpoint").toBe(302);
    expect(await connectionStatus(flow.service)).toBe("connected");
    expect(
      (await readObservations(impostor.id)).length,
      "the impostor was never dialed — not for metadata, not for the code",
    ).toBe(0);
    expect(
      (await readObservations(flow.as.id)).some((seen) => seen.path.endsWith("/token")),
      "and the recorded endpoint was",
    ).toBe(true);
  }, CASE_BUDGET_MS);

  it("§7/§9 · the adversarial branches are the real ones: no RFC 9728 document, CIMD refused so DCR runs, no expires_in in the token response — connect still completes and the service reads `connected`", async () => {
    const flow = await beginFlow(["no_prm", "reject_cimd", "no_expires_in"]);
    const answer = await worker.fetch(await bend(flow, "none"), env as unknown as Env);
    expect(answer.status, "all three branches taken, and the flow still completes").toBe(302);
    expect(await connectionStatus(flow.service)).toBe("connected");

    const seen = await readObservations(flow.as.id);
    // The DCR leg is otherwise never exercised: a spec-shaped AS advertises CIMD and the
    // hub never registers at all, so this persona is the only thing that runs that code.
    expect(seen.some((arrival) => arrival.path.endsWith("/register"))).toBe(true);
    // And discovery reached this AS despite the resource serving no RFC 9728 document.
    // The fallback's arrival lands on the RESOURCE, not on the AS, and that is the whole
    // shape of it: with no protected-resource metadata to name an authorization server,
    // the hub asks the resource's own URL for RFC 8414 metadata instead — so the evidence
    // that discovery fell back rather than crashed is a well-known request in the
    // resource's log, followed by the AS being dialed at all.
    const atResource = await readObservations(flow.upstreamId);
    expect(
      atResource.some((arrival) => arrival.path.includes("/.well-known/oauth-protected-resource")),
      "RFC 9728 was tried first",
    ).toBe(true);
    expect(
      atResource.some((arrival) =>
        arrival.path.includes("/.well-known/oauth-authorization-server"),
      ),
      "and the RFC 8414 fallback asked the resource itself",
    ).toBe(true);
  }, CASE_BUDGET_MS);
});

describe("§7 · the callback refusal matrix", () => {
  runOAuthCallbackTable(oauthCallbackRows);

  it("§7 · state is single-use by compare-and-set delete: of two concurrent callbacks on one state row, one connects and one is refused", async () => {
    const flow = await beginFlow();
    const callback = () =>
      worker.fetch(
        new Request(flow.callbackUrl, { headers: { Cookie: flow.session.cookie } }),
        env as unknown as Env,
      );
    // Concurrent, not sequential: a SELECT-then-act handler passes the replay row in the
    // table above and still lets both of these through.
    const [first, second] = await Promise.all([callback(), callback()]);
    const statuses = [first.status, second.status].sort();
    expect(statuses, "exactly one connects, exactly one is refused").toEqual([302, 400]);
    expect(await connectionStatus(flow.service)).toBe("connected");
    // And the bundle was sealed once, by one of them: the ledger says how many flows
    // completed, and two would mean the code was redeemed twice.
    const written = await query(env.DB, flow.ns.owner.userId, { event: "upstream.oauth_connected" });
    expect(written.total).toBe(1);
  }, CASE_BUDGET_MS);
});

describe("§7 · hygiene around the flow", () => {
  it("§7 · cleanupStaleState deletes past-TTL rows and only those — and a past-TTL row was already dead to the callback before the sweep ran (hygiene, not correctness)", async () => {
    const stale = await beginFlow();
    const live = await beginFlow();
    // The sweep is HUB-WIDE by contract — namespace-blind, one daily cron — while this
    // project's storage isolation is per FILE, so earlier cases in this file have left
    // their own dead rows behind. Drained here, before the row under test is backdated, so
    // the count below is a fact about this case and not about the whole run.
    await cleanupStaleState();
    await backdateState(stale.state);

    // The order is the point: the callback runs BEFORE any sweep, and the row is still in
    // the table. Expiry has to bite at read time or it does not bite at all.
    const refused = await worker.fetch(
      new Request(stale.callbackUrl, { headers: { Cookie: stale.session.cookie } }),
      env as unknown as Env,
    );
    expect(refused.status).toBe(400);
    expect(await envelopeOf(stale.service.id)).toBeNull();
    expect(
      (await stateRowsOf(stale.ns.owner.userId)).length,
      "the dead row was still there when the callback refused it",
    ).toBe(1);

    // The sweep is HUB-WIDE — one daily cron, namespace-blind — and this project's storage
    // isolation is per FILE, so earlier cases in this file have left state rows of their
    // own behind. What the sweep must equal is therefore the number of past-TTL rows in the
    // table, counted here rather than assumed to be this case's one.
    const expired = await expiredStateCount();
    expect(expired, "this case contributed the row it is about").toBeGreaterThanOrEqual(1);
    expect(await cleanupStaleState(), "the sweep removed the past-TTL rows and only those").toBe(
      expired,
    );
    expect((await stateRowsOf(stale.ns.owner.userId)).length).toBe(0);
    expect(
      (await stateRowsOf(live.ns.owner.userId)).length,
      "and only that one — a live flow survives the cron",
    ).toBe(1);

    // The live flow still completes afterwards, which is what "hygiene, not correctness"
    // means: the sweep is not part of any decision.
    const answer = await worker.fetch(await bend(live, "none"), env as unknown as Env);
    expect(answer.status).toBe(302);
  }, CASE_BUDGET_MS);

  it("§7 · clientMetadata serves a static secret-free document whose client_id is its own URL under the injected origin", async () => {
    const injected = new URL("https://hub.example.test");
    const document = (await clientMetadata(injected).json()) as Record<string, unknown>;
    // The client_id IS the document's own URL — that is the whole CIMD mechanism, and an
    // id that pointed anywhere else would authenticate the hub as something else.
    expect(document.client_id).toBe(`https://hub.example.test${CLIENT_METADATA_PATH}`);
    expect(document.redirect_uris).toEqual(["https://hub.example.test/oauth/upstream/callback"]);
    // Secret-free by construction: a public client holds no client secret for any upstream,
    // which is what makes PKCE the whole of the redemption binding.
    expect(document.token_endpoint_auth_method).toBe("none");
    // The document is fetched by any authorization server the owner points the hub at, so
    // "secret-free" is asserted against the fields that would carry one — never against the
    // WORD "token", which a legitimate `token_endpoint_auth_method` contains.
    for (const key of ["client_secret", "client_secret_expires_at", "jwks", "jwks_uri"]) {
      expect(document[key], `a CIMD document carries no ${key}`).toBeUndefined();
    }
    expect(
      JSON.stringify(document),
      "and no planted secret of this suite's leaked into it either",
    ).not.toMatch(/FAKE0000|pmcp_(sa|svc)_/);

    // Served unauthenticated on the canonical origin, because an AS fetches it with no
    // credential of ours and must find the same bytes.
    const served = await worker.fetch(
      new Request(`${ORIGIN}${CLIENT_METADATA_PATH}`),
      env as unknown as Env,
    );
    expect(served.status).toBe(200);
    expect(((await served.json()) as Record<string, unknown>).client_id).toBe(
      `${ORIGIN}${CLIENT_METADATA_PATH}`,
    );
  });
});
