// policy-rows.ts — §6's reconnect policy as data: the row type, and the two tables of
// endings the client library must have an answer for. transport.test.ts runs them;
// contracts-consumer.test.ts checks the fixture-keyed table against
// contracts/close-codes.json in both directions.
//
// WHY THIS IS NOT A `.test.ts` FILE (finding, resolved 2026-08-26). `vitest.config.mts`'s
// `clients` project collects `clients/js/test/**/*.test.ts`, so transport.test.ts is a
// test file in its own right. contracts-consumer.test.ts needs the rows as VALUES, and
// importing them from transport.test.ts would execute that module's body a second time
// during contracts-consumer's collection: every describe/it in transport.test.ts would
// register twice, and once implemented each duplicate would stand up its own fake hub on
// its own ephemeral port and drive its own reconnect loop. The rows therefore live in a
// plain module beside fake-hub.ts, imported by both suites. The Python mirror keeps
// RECONNECT_ROWS inside tests/test_transport.py because pytest collects by path and
// `from tests.test_transport import RECONNECT_ROWS` re-collects nothing — the divergence
// is deliberate, and stated here so it is not read as drift.
//
// deps: clients/js/src/index.ts (CredentialsError, RegistrationError — named as classes so
//   a rename breaks this table) — no fixture, no harness, no runner

import { CredentialsError, RegistrationError } from "../src/index";

/**
 * How a connection ended — the row's input, driven by the fake hub. Four
 * shapes, because §6 gives the policy four kinds of input and the client must
 * not conflate them: a refused upgrade (an HTTP status, before any frame), a
 * close code (after establishment), a rejected registration (a JSON-RPC error
 * reply to hub/register), and an ordinary transport failure (drop, hub deploy).
 */
export type PolicyTrigger =
  | { kind: "upgrade"; status: number }
  | { kind: "close"; code: number }
  | { kind: "register-rejected" }
  | { kind: "network-drop" };

/**
 * What `HubTransport.closed` must do at that ending. `pending` is the load-
 * bearing case — an ending that reconnects must leave the promise unsettled
 * forever, which is what makes "reconnect" observably different from "stop". The
 * fatal cases name the constructor rather than a string, so renaming an error
 * class breaks this table instead of silently matching nothing.
 *
 * The fixture's three behavior words land here one-to-one: `stop_quiet` →
 * `resolve`, `stop_fatal` → `reject`, `reconnect` → `pending`. The mapping is
 * total in both directions, which is what lets contracts-consumer.test.ts check
 * a row against a fixture entry without either side owning a fourth word.
 */
export type PolicySettlement =
  | { kind: "pending" }
  | { kind: "resolve" }
  | { kind: "reject"; error: typeof CredentialsError | typeof RegistrationError };

/**
 * One row of §6's reconnect policy — the deliberate cross-language duplication: the
 * Python table in clients/py/tests/test_transport.py carries the same rows, and
 * contracts-consumer.test.ts pins that {@link reconnectPolicyRows} transcribes
 * contracts/close-codes.json totally in both directions.
 *
 * The columns are the observable consequences, chosen so no two behaviors share
 * a signature: does the fake hub see another dial (`redials`), on which schedule
 * (`schedule` — named, never a millisecond literal: §7 puts timing numbers in
 * api.test.ts's schedule table and nowhere else), and what does `closed` do
 * (`settlement`). `stop_quiet` and `stop_fatal` differ in `settlement`; the two
 * `reconnect` entries differ only in `schedule`, which is precisely why the
 * fixture's vocabulary keeps the two axes apart.
 */
export type ReconnectPolicyRow = {
  /** spec reference printed in the case title, e.g. "§6 · close 4002 · archived reconnects on the max_only schedule" */
  spec: string;
  trigger: PolicyTrigger;
  /** whether the fake hub observes a further dial after this ending — `redials: true` IS the fixture's `reconnect` */
  redials: boolean;
  /**
   * The fixture's `schedule` attribute for this entry; null when the behavior does not
   * reconnect.
   *
   * OBSERVED AT A FIXED DRAW, resolved 2026-08-26. The schedule is full jitter from zero —
   * `max_only` draws over [0, 60 s] and `exponential` over [0, 1 s]·2ⁿ — so the two windows
   * OVERLAP at every attempt and no delay observed under a live `Math.random` distinguishes
   * them: a client that ran BOTH archived endings as ordinary exponential backoff (hammering
   * an archived app every ~1 s instead of ~30 s) would pass a table that only looked at
   * delays. The runner therefore fixes the jitter draw — the same seeded stub api.test.ts's
   * schedule table uses — and reads the resulting CEILING: at a draw just under 1, attempt 0
   * answers ~59.94 s on `max_only` and ~0.999 s on `exponential`.
   *
   * That also settles which reading of §6 the two tables encode: `max_only` means the
   * ceiling stops doubling and stays at the cap. "Keep retrying at max backoff" is a
   * statement about the WINDOW, never a floor under the wait — which is api.test.ts's
   * attempt-40-draw-0 row read from the other side, so the two tables now say one thing.
   *
   * DESIGN CHECK (strategy §6), the same shape as the sleep seam transport.test.ts's header
   * records: the draw must be injectable to be fixed. RESOLVED — `backoffDelay` takes an
   * `rng` argument, and the loop reads it from the module-level `seams` object a suite
   * replaces (the Python twin's `pmcp_client._rng`, monkeypatched). `HubTransport`'s
   * constructor still takes only `{url, token, roles}`, which is what §11 promises; the
   * observation seam did not have to become part of the interface to exist.
   */
  schedule: "exponential" | "max_only" | null;
  settlement: PolicySettlement;
};

/**
 * Rows are OWNER-AUTHORED in a separate commit before implementation (strategy
 * §9 rule 1) — agents never fill them. The oracle is §6's upgrade matrix and
 * close-code list plus the contracts fixture derived from them; rows are written
 * from the spec, never from the library.
 *
 * This table is exactly the fixture's vocabulary: every row names an entry
 * contracts/close-codes.json defines, and every entry has a row here — the two
 * totality cases in contracts-consumer.test.ts. Endings the fixture deliberately does
 * not key live in {@link unlistedEndingRows} below.
 */
export const reconnectPolicyRows: readonly ReconnectPolicyRow[] = [
  {
    spec: "§6 · upgrade 401 · a missing, invalid, expired, revoked or wrong-kind token — or one whose app row is gone or proxied — is fatal before a single frame exists: CredentialsError, and the hub never sees a second dial",
    trigger: { kind: "upgrade", status: 401 },
    redials: false,
    schedule: null,
    settlement: { kind: "reject", error: CredentialsError },
  },
  {
    spec: "§6 · upgrade 403 · archived means exactly one thing, so the client keeps dialing on the max_only schedule and unarchiving heals within a minute without touching the bot — the allow-twin of the 401 above",
    trigger: { kind: "upgrade", status: 403 },
    redials: true,
    schedule: "max_only",
    settlement: { kind: "pending" },
  },
  {
    spec: "§6 · close 4000 · hub/replaced gave the slot to a newer connection for the same app: this copy stops QUIETLY — `closed` resolves, and it must never dial back and fight for the slot",
    trigger: { kind: "close", code: 4000 },
    redials: false,
    schedule: null,
    settlement: { kind: "resolve" },
  },
  {
    spec: "§6 · close 4001 · a token revoked or an app deleted AFTER establishment is the same fatal ending as 401 — surface a credentials error, never retry a dead credential",
    trigger: { kind: "close", code: 4001 },
    redials: false,
    schedule: null,
    settlement: { kind: "reject", error: CredentialsError },
  },
  {
    spec: "§6 · close 4002 · an app archived mid-life is severed and reconnects on the max_only schedule — the same archived policy as the 403 refusal, reached from the other side of the handshake",
    trigger: { kind: "close", code: 4002 },
    redials: true,
    schedule: "max_only",
    settlement: { kind: "pending" },
  },
  {
    spec: "§6 · close 4003 · the row-gone-between-upgrade-and-register race reconnects on the exponential schedule; if the app really is gone the next upgrade answers 401 and THAT is the fatal ending, so the race never needs its own",
    trigger: { kind: "close", code: 4003 },
    redials: true,
    schedule: "exponential",
    settlement: { kind: "pending" },
  },
  {
    spec: "§6 · close 4004 · a protocol error or a missed 10 s registration deadline is treated like any other disconnect — reconnect on the exponential schedule",
    trigger: { kind: "close", code: 4004 },
    redials: true,
    schedule: "exponential",
    settlement: { kind: "pending" },
  },
];

/**
 * The endings the fixture does NOT key, and why they need their own table (finding,
 * resolved 2026-08-26).
 *
 * contracts/close-codes.json keys seven entries, all `close:NNNN` or `upgrade:NNN`. Three
 * endings §6 nonetheless gives the client have no key there, so a row for one of them in
 * {@link reconnectPolicyRows} would fail contracts-consumer.test.ts's "every row names an
 * entry the fixture defines" — which is why the register-rejected row was missing from
 * both languages even though {@link PolicyTrigger} declares it, the block header promises
 * it, and {@link PolicySettlement}'s RegistrationError arm exists for nothing else.
 *
 * They are pinned here instead, run by the same runner. What each one costs if unpinned:
 * a bot that retried a REJECTED DECLARATION would hammer the hub's registration path
 * forever with a valid app token; a transport that treated a bare TCP DROP or a close
 * code outside 4000–4004 as fatal would go dark on every hub deploy. The safe default —
 * anything unlabelled reconnects — is D7's verified slice's rule (`CLOSE_POLICY[code] ??
 * "reconnect"`, scripts/thin-serve.ts — deleted at D8, the table now lives in
 * clients/js/src/index.ts) and nothing asserted it.
 *
 * The refusal here carries its alive twin in the same table (strategy §9 rule 2): the
 * rejected registration stops, the drop beside it keeps going.
 */
export const unlistedEndingRows: readonly ReconnectPolicyRow[] = [
  {
    spec: "§6 · a rejected hub/register — bad role name, non-compiling pattern, over caps — is a JSON-RPC ERROR REPLY, not a close code, and it is terminal: RegistrationError, and the hub records no further dial. Identical input cannot start succeeding, so retrying a refused declaration is an infinite loop against the hub holding a perfectly valid token",
    trigger: { kind: "register-rejected" },
    redials: false,
    schedule: null,
    settlement: { kind: "reject", error: RegistrationError },
  },
  {
    spec: "§6 · a bare TCP sever with no close frame at all — what a hub deploy and a network failure actually look like — reconnects on the exponential schedule and never settles `closed`: the alive twin of the rejected declaration above, and the ending most likely to be mishandled",
    trigger: { kind: "network-drop" },
    redials: true,
    schedule: "exponential",
    settlement: { kind: "pending" },
  },
  {
    spec: "§6 · a close code the vocabulary does not name (1001, a hub going away) reconnects on the exponential schedule — unknown means reconnect, so adding a code to the protocol can never silently strand a fleet of bots",
    trigger: { kind: "close", code: 1001 },
    redials: true,
    schedule: "exponential",
    settlement: { kind: "pending" },
  },
  {
    spec: "§6 · an upgrade status §6 never mentions (500 from an edge failure) reconnects on the exponential schedule — only 401 is fatal, so a client that lumped the refusals together and gave up here would stay down through a transient outage",
    trigger: { kind: "upgrade", status: 500 },
    redials: true,
    schedule: "exponential",
    settlement: { kind: "pending" },
  },
];
