// contracts.test.ts — the L4 producer (strategy §4): the ONE writer of `contracts/*.json`.
//
// WHAT THIS SUITE PINS: that every wire shape the spec deliberately COPIES across a
// language boundary — whoami, the error vocabulary, the tunnel frames, close code →
// required client behavior, the bootstrap bodies, the admin op names and schemas, the two
// rows the diff planner reads, and the audit body stubs §15 defers to this directory — is
// one shape, not several that happen to agree today.
// The mechanism is deliberately dumb: the server's REAL emission is captured and
// deep-equalled against a checked-in JSON fixture, and every consumer (cli, clients/js,
// clients/py, scripts) reads that same file read-only. Plain JSON is the point — neither
// side can import a type from it, so the copies stay copies while both answer to one
// oracle. Governance, the commit-separation rule, and what a fixture may contain live in
// `contracts/README.md`.
//
// It also carries parity directions C and D (§4): every planner-emitted step maps to an
// ops key with that op's required fields present, and every non-auth CLI subcommand maps
// to an ops key — total in both directions, so an op nobody can reach fails here too.
// Directions A and B live where their other halves live (admin-ops, web-pages).
//
// PROJECT: `worker` — real D1, every sibling real, no sockets. Correct because seven of
// the eight families are HTTP or in-process emissions (a whoami response, a JSON-RPC error
// object, an ops schema, a D1-backed row, a recorded audit body) and because per-file
// storage isolation lets this file seed whatever namespace each emission needs without
// coordinating with anyone. The eighth — the tunnel frames and close codes — is producible
// here too, without a socket, because tunnel.ts exports its wire vocabulary
// (CLOSE_REPLACED / CLOSE_ROW_GONE / CLOSE_PROTOCOL / HUB_METHODS beside the SeverCode
// pair): the fixture is emitted from the exports, and `tunnel/protocol.test.ts` locks the
// exports to what a live socket is observed to do. That is what keeps §4's single-writer
// claim literally true rather than approximately (see FINDINGS 2).
//
// HONESTY (strategy §9): this file WRITES nothing of its own. Fixture CONTENT is
// owner-authored and lands in its own commit before implementation; this suite only proves
// the server matches it, and regenerates on the owner's explicit `pnpm contracts:update`.
// Every refusal row below names its allow-twin in the same list.
//
// deps: harness/seed · harness/fake-upstream (the recorded body the stub family is captured from) · cloudflare:workers exports.default.fetch (whoami, bootstrap, the mcp endpoints) · admin.ops · admin.adminBackend · audit.BodyStub/query · limits.AUDIT_BODY_CAP_BYTES · tunnel.CLOSE_REVOKED/CLOSE_ARCHIVED/CLOSE_REPLACED/CLOSE_ROW_GONE/CLOSE_PROTOCOL/HUB_METHODS · cli plan.PlanStep · cli main command table · scripts/users wire types · contracts/*.json fixtures

import { describe, it } from "vitest";
import type { AdminOp } from "../../src/admin";
import type { BodyStub } from "../../src/audit";
import type { JsonRpcResponse } from "../../src/gateway";
import type { SeverCode } from "../../src/tunnel";
import type { ApprovalRequiredData, WhoamiResponse } from "../../../cli/src/main";
import type { PlanStep } from "../../../cli/src/plan";
import type { BootstrapRequest, BootstrapResponse } from "../../../scripts/users";

/**
 * FINDINGS from writing this outline against the skeletons — each a question for the
 * owner, recorded rather than worked around.
 *
 * 1. WRITING the fixtures happens inside workerd, which has no filesystem. The planned
 *    mechanism is vitest's file-snapshot path (`toMatchFileSnapshot`), whose writes are
 *    performed by the Node host over the pool's RPC, making `pnpm contracts:update` a
 *    plain `vitest run --project worker contracts -u`. That must be VERIFIED against
 *    `@cloudflare/vitest-plugin@1.0.0` + vitest 4.1 before this file is implemented; if
 *    it does not hold, the fallback is a Node-side `scripts/contracts-update.ts` driving
 *    the same emissions through miniflare, and the sole-writer rule moves with it.
 *    Reading fixtures is unaffected — a plain `import … from "…json"` bundles.
 *
 * 2. RESOLVED 2026-08-25. Two families — close codes and tunnel frames — had no
 *    producible source in this project: `tunnel.ts` exported only CLOSE_REVOKED (4001)
 *    and CLOSE_ARCHIVED (4002), while 4000, 4003, 4004 and every `hub/*` method name were
 *    module-private and appeared only on a live socket. The alternative was producing
 *    those two families in `tunnel/protocol.test.ts`, which would have made §4's
 *    single-writer claim a two-writer claim the README had to state. The decision went
 *    the other way: tunnel.ts now exports CLOSE_REPLACED / CLOSE_ROW_GONE /
 *    CLOSE_PROTOCOL / HUB_METHODS as published cross-language vocabulary — not hidden
 *    mechanics — so both families are emitted HERE from the exports and the single-writer
 *    rule stands. What the export cannot prove on its own is that the socket agrees with
 *    it; `tunnel/protocol.test.ts` owns that lock (observed codes and method names equal
 *    the exports), and no other module imports them, so the vocabulary has exactly one
 *    definition, one emitter, and one behavioral witness.
 *
 * 3. `PlanStep.tool` is a bare `string`, so direction C's "maps to an ops key" is a
 *    runtime check with no compile-time half. Narrowing it to a union of ops keys would
 *    make half of direction C free — but it would also make plan.ts depend on the server,
 *    which §9 forbids for exactly the reason the fixture exists. Recorded as considered
 *    and rejected; the runtime check stands alone.
 */

/**
 * One fixture family — the row type the whole suite is driven by.
 *
 * `file` is the fixture this row owns (one row, one file, no sharing). `spec` is the
 * section printed in every generated test name, so a red row names the sentence to
 * re-read (§8). `emission` names the live thing captured and compared — not the assertion,
 * the SOURCE, because "the fixture disagrees with the server" is only actionable once you
 * know which server surface was asked. `consumers` lists the read-only readers, and a
 * family with none is a fixture nobody needs — the emptiness is itself a finding.
 * `producer` names the project that can capture the emission at all (see FINDINGS 2);
 * everything else consumes.
 *
 * `"server"` is a consumer like any other, and not a contradiction of "the copies stay
 * copies": the audit body stubs are written by audit.ts and read by everything that
 * renders a recorded body — the audit page, the JSONL export, hygiene.test.ts's own
 * BodyColumnShape — with no shared declaration between writer and readers. That is the
 * same no-shared-package situation as the cross-language families, one process in.
 */
export type ContractFamily = {
  file: string;
  spec: string;
  emission: string;
  consumers: readonly ("cli" | "clients/js" | "clients/py" | "scripts" | "server")[];
  /**
   * The project that captures the emission. One member, and that is the point (FINDINGS
   * 2): every family is producible in `worker`, so this suite is the single writer §4
   * claims it is. A second member here would be a strategy change, visible as one.
   */
  producer: "worker";
};

/**
 * The fixture families, as rows.
 *
 * OWNER-AUTHORED, in a separate commit before implementation (strategy §9 rule 1) —
 * agents never fill this, and never author the `contracts/*.json` content these rows
 * point at. Which shapes are contracts, and which surface is the authoritative emission
 * of each, is the spec decision this table encodes; an agent filling it would be choosing
 * the oracle it is later measured by.
 */
export const CONTRACT_FAMILIES: readonly ContractFamily[] = [];

/**
 * The runner: one family in, one comparison out. Captures `family.emission` from the
 * running worker, normalizes away the values a fixture may not contain (row ids,
 * timestamps, generated slugs — `contracts/README.md` pins the list), and deep-equals it
 * against `family.file`. In update mode it writes instead of comparing, which is the only
 * write path in the repository.
 *
 * Deliberately one function for all eight families: the alternative is eight bespoke
 * assertions that drift, and drift among the pinners is the exact disease the pins exist
 * to cure. A family whose emission cannot be captured through this seam is telling you
 * something about the module it came from (FINDINGS 2), not about this runner.
 */
export function runContractFamily(family: ContractFamily): void {
  // deps: seed.seedNamespace · exports.default.fetch · admin.ops · fixture import · vitest expect (file snapshot)
  throw new Error("unimplemented");
}

/**
 * The parity runner: two derived name sets in, one failure out — and the failure reports
 * BOTH directions at once. A one-directional check passes forever the day someone adds an
 * op no surface can reach, which is precisely the drift §8's parity invariant exists to
 * catch. `exceptions` carries §8's pinned unmapped names (the auth/credential family, the
 * OAuth consent redirect, the JSONL export) explicitly rather than as a skipped test, so
 * the exception list is itself reviewable and cannot quietly grow.
 */
export function assertTotalMapping(
  name: string,
  left: readonly string[],
  right: readonly string[],
  exceptions: readonly string[],
): void {
  // deps: none
  throw new Error("unimplemented");
}

describe("§4 · whoami — the CLI↔server contract", () => {
  it.todo("§8 · whoami.json \"user\" row deep-equals GET /api/whoami under a device-flow session token");
  it.todo("§8 · whoami.json \"service_account\" row deep-equals GET /api/whoami under a live pmcp_sa_ key");
  it.todo("§8 · whoami.json \"unauthorized\" row deep-equals the 401 body and WWW-Authenticate header for a pmcp_svc_ bearer — refusal, twinned with the two rows above");
  it.todo("§8 · cli WhoamiResponse's key set equals the fixture's, both directions — the copy is pinned on the consumer side too, not just the emitting side");
});

describe("§4 · error vocabulary", () => {
  it.todo("§7 · errors.json code set equals the five codes the pipeline emits (-32000/-32001/-32002/-32003/-32601) and admits no sixth");
  it.todo("§7 · errors.json -32003 entry's data keys deep-equal a real approval-required error's data — approvalId, approvalUrl, expiresAt, nothing else");
  it.todo("§7 · errors.json -32001 entry is ONE shape for both causes: an ungranted tool and an unknown tool are byte-identical — refusal");
  it.todo("§7 · a granted call in the same seeded namespace returns a result and no error member — the allow-twin of the -32001 and -32000 rows");
  it.todo("§7 · errors.json -32000 entry carries no data key, and no upstream status, header, or body fragment appears anywhere in it — refusal, twinned with the row above");
  it.todo("§10 · cli HUB_ERRORS names map onto errors.json codes, total in both directions");
});

describe("§4 · tunnel frames and close codes", () => {
  it.todo("§6 · close-codes.json's 4001 and 4002 entries equal the exported CLOSE_REVOKED and CLOSE_ARCHIVED, and the SeverCode union admits exactly those two");
  it.todo("§6 · close-codes.json's other three entries equal the exported CLOSE_REPLACED, CLOSE_ROW_GONE and CLOSE_PROTOCOL — the fixture is emitted from the vocabulary, so a renumbering cannot reach the wire without reaching the fixture");
  it.todo("§6 · close-codes.json covers every code in the 4000–4004 vocabulary and the upgrade statuses, each with exactly one required client behavior");
  it.todo("§6 · the fixture's behavior vocabulary is exactly three words — stop_fatal, stop_quiet, reconnect — and admits no fourth: the ONE spelling both client reconnect tables transcribe");
  it.todo("§6 · every entry carries a `schedule` attribute — exponential or max_only — and only where it means something: a reconnect entry names its schedule, a stopping entry names none, so \"retry at max backoff\" is a schedule of reconnect and never a behavior of its own");
  it.todo("§6 · every stop_fatal entry (close 4001, upgrade 401) sits beside a keep-connecting twin (close 4002 reconnect at max_only, upgrade 403 the same, close 4000 stop_quiet) — no deny-only close-code table");
  it.todo("§6 · tunnel-frames.json hub/register ack and hub/replaced notification deep-equal the frames the DO emits, and their method names are the values of the exported HUB_METHODS — the frames' agreement with a live socket is tunnel/protocol.test.ts's lock, not this file's");
  it.todo("§7 · tunnel-frames.json's forwarded-call _meta names are exactly hub/principal, hub/roles, and the mirrored clientCapabilities key — no other hub/* name exists");
});

describe("§4 · bootstrap", () => {
  it.todo("§12 · bootstrap.json request rows deep-equal scripts' BootstrapRequest for all four ops");
  it.todo("§12 · bootstrap.json response rows deep-equal the live route's bodies, with `password` present on create and reset-password and absent from list and delete — allow");
  it.todo("§12 · bootstrap.json's disabled row pins the 404 the route returns while BOOTSTRAP_SECRET is unset, beside its wrong-secret 401 twin — refusal, twinned with the row above");
});

describe("§4 · admin op names and schemas", () => {
  it.todo("§8 · admin-ops.json op-name set equals Object.keys(ops), total in both directions — a new op that forgets its fixture fails here");
  it.todo("§8 · admin-ops.json input schemas deep-equal what adminBackend renders per op — one zod schema, one rendering, so the tool and the web form cannot drift");
  it.todo("§15 · admin-ops.json records token_issue's outputSchema with its key field writeOnly, and no other op declares one — the uniform-body rule's whole footprint");
});

describe("§4 · planner-facing rows", () => {
  it.todo("§8 · service-list.json row keys equal a live service_list row's, for tunnel, proxy, and the builtin pmcp entry (builtin: true, no D1 row behind it)");
  it.todo("§8 · account-list.json rows carry grants inline, so the planner's entire current-state read is these two families and nothing else");
  it.todo("§9 · plan.CurrentService's keys equal service-list.json's minus exactly the runtime facts (status, oauth connection state, last seen) — a plan can never turn on status, and the two rows sit side by side so the omission is visible");
});

describe("§4 · audit body stubs — the spelling §15 defers to this directory", () => {
  it.todo("§15 · audit-body-stubs.json's `blob` row deep-equals the stub a real tools/call records for an unstructured result block: the discriminator, the content type, and `bytes` present as a number — §15 names the stub but not its keys, so this row IS the naming");
  it.todo("§15 · audit-body-stubs.json's `oversize` row deep-equals the stub that replaces a whole over-cap body, driven against a shrunk AUDIT_BODY_CAP_BYTES rather than a megabyte fixture, and carrying no fragment of the body it replaced — refusal, twinned with the row below");
  it.todo("§15 · an under-cap structured body records intact, so the two stub rows are pinned beside the shape that must NOT be stubbed — the allow-twin without which \"stub everything\" satisfies this family");
  it.todo("§15 · the fixture's stub kinds are exactly the two the spec allows, total in both directions against audit.ts's BodyStub union — a third stub cannot enter the recorder without entering the fixture");
  it.todo("§15 · `bytes` is pinned as a KEY with a number type and never as a value, per this directory's nothing-that-varies-per-run rule — the fixture stays stable while the cap and the fixture bodies move");
  it.todo("§15 · CONSUMER NOTE — hygiene.test.ts transcribes this fixture into BodyColumnShape's `stubbed` and `oversize` members (its rows spell stubs as `Omit<BodyStub, \"bytes\">`), and it is the family's only reader today. A disagreement between that type and this fixture is the drift this row exists to catch; hygiene.test.ts asserts BEHAVIOR against the shape, this file asserts the shape itself, and neither may respell the other's half.");
});

describe("§4 direction C · planner steps → ops", () => {
  it.todo("§4 · every PlanStep.tool the planner can emit is a key of ops");
  it.todo("§4 · every emitted step's args cover its op schema's required fields");
});

describe("§4 direction D · CLI subcommands → ops", () => {
  it.todo("§4 · every non-auth CLI subcommand maps to an ops key");
  it.todo("§4 · every ops key is reachable from some CLI subcommand — the reverse direction, so an op nobody can run fails here");
  it.todo("§8 · the pinned parity exceptions (auth/credential family, the OAuth consent redirect, the JSONL export) are the ONLY unmapped names, listed explicitly rather than skipped");
});

describe("§9 · fixture governance", () => {
  it.todo("§9 · every contracts/*.json on disk is claimed by exactly one CONTRACT_FAMILIES row — an orphan fixture nobody produces fails here");
  it.todo("§9 · no fixture contains a sentinel secret, a pmcp_ token prefix, or a value that varies between two runs of this suite");
});

/**
 * The types this suite pins on the consumer side, referenced so a rename in a copied shape
 * breaks compilation here rather than surfacing months later as a runtime mismatch. They
 * are never imported at runtime — the copies stay copies (§4); this is the compile-time
 * half of the same pin, and the fixtures are the runtime half.
 */
export type PinnedConsumerShapes = {
  whoami: WhoamiResponse;
  approvalRequired: ApprovalRequiredData;
  bootstrapRequest: BootstrapRequest;
  bootstrapResponse: BootstrapResponse;
  plannerStep: PlanStep;
  severCode: SeverCode;
  adminOp: AdminOp;
  wireResponse: JsonRpcResponse;
  /**
   * The audit body-stub family's consumer-side declaration. It is the one entry whose
   * consumer lives in this repository's own server code rather than across a language
   * boundary — which changes nothing about why it is here: audit.ts writes the stub,
   * hygiene.test.ts's BodyColumnShape and every renderer read it, and no declaration is
   * shared between them. A rename in `stub`, `contentType`, or `bytes` breaks compilation
   * here rather than surfacing as an audit page rendering a blank placeholder.
   */
  auditBodyStub: BodyStub;
};
