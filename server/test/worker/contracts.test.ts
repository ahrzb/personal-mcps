// contracts.test.ts — the L4 producer (strategy §4): the ONE writer of `contracts/*.json`.
//
// WHAT THIS SUITE PINS: that every wire shape the spec deliberately COPIES across a
// language boundary — whoami, the error vocabulary, the tunnel frames, close code →
// required client behavior, the bootstrap bodies, the admin op names and schemas, the two
// rows the diff planner reads, the MCP handshake every standards-compliant consumer opens
// with (§7's 2026-08-26 amendment), and the audit body stubs §15 defers to this directory
// — is one shape, not several that happen to agree today.
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
// AMENDED 2026-08-26 (§20.3): the tunnel-frames family's `roles` value gains the family
// dimension, so this file now pins the role declaration's TWO spellings — a bare pattern
// list beside a per-family object, in one declaration — where all four copies of that shape
// meet: the register frame both client libraries emit, the validation §6 judges it by, and
// §8's canonical READ, which is a separate decision from how storage normalizes it and is
// what `pmcp diff`'s stability rests on.
//
// PROJECT: `worker` — real D1, every sibling real, no sockets. Correct because eight of
// the nine families are HTTP or in-process emissions (a whoami response, a JSON-RPC error
// object, a handshake answer, an ops schema, a D1-backed row, a recorded audit body) and
// because per-file storage isolation lets this file seed whatever namespace each emission
// needs without coordinating with anyone. The ninth — the tunnel frames and close codes — is producible
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

import { env } from "cloudflare:test";
import { exports as workerExports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { adminBackend, ops } from "../../src/admin";
import type { AdminOp } from "../../src/admin";
import { query } from "../../src/audit";
import type { AuditRow, BodyStub } from "../../src/audit";
import { CAPABILITY_SHAPE } from "../../src/gateway";
import type { JsonRpcRequest, JsonRpcResponse, Tool } from "../../src/gateway";
import {
  AUDIT_BODY_CAP_BYTES,
  ROLE_NAME_MAX_LENGTH,
  ROLE_PATTERN_MAX_LENGTH,
  ROLE_PATTERNS_MAX,
} from "../../src/limits";
import { tokenPattern } from "../../src/principal";
import { PMCP_SLUG, Registry, ROLE_FAMILIES as SERVER_ROLE_FAMILIES } from "../../src/registry";
import type { Service } from "../../src/registry";
import { CODES } from "../../src/errors";
import {
  CLOSE_ARCHIVED,
  CLOSE_BEHAVIORS,
  CLOSE_POLICY,
  CLOSE_PROTOCOL,
  CLOSE_REPLACED,
  CLOSE_REVOKED,
  CLOSE_ROW_GONE,
  CLOSE_SCHEDULES,
  handleConnect,
  HUB_METHODS,
} from "../../src/tunnel";
import type { SeverCode } from "../../src/tunnel";
import { setHeaders } from "../../src/upstream";
import { upstreamUrlFor } from "../harness/fake-upstream";
import type { UpstreamScenario } from "../harness/fake-upstream";
import { seedNamespace, seedOwnerSession, uniqueSlug } from "../harness/seed";
import type { SeededNamespace } from "../harness/seed";
import { HUB_ERRORS } from "../../../cli/src/main";
import type { ApprovalRequiredData, WhoamiResponse } from "../../../cli/src/main";
// The command table is imported from its own module, not from main.ts: the mapping is
// data, and this suite has no reason to pull the CLI's node:fs config reading into workerd.
import { COMMANDS } from "../../../cli/src/commands";
import {
  parseDesired,
  planChanges,
  ROLE_FAMILIES as PLANNER_ROLE_FAMILIES,
  ROLE_NAME_MAX_LENGTH as PLANNER_ROLE_NAME_MAX_LENGTH,
  ROLE_PATTERN_MAX_LENGTH as PLANNER_ROLE_PATTERN_MAX_LENGTH,
  ROLE_PATTERNS_MAX as PLANNER_ROLE_PATTERNS_MAX,
} from "../../../cli/src/plan";
import type { CurrentService, PlanStep, RoleDeclaration } from "../../../cli/src/plan";
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
export const CONTRACT_FAMILIES: readonly ContractFamily[] = [
  // Nine families, TEN rows: the planner-rows family names two boundaries
  // the planner reads separately — `service_list` and `account_list` — and this row type
  // pins one file per row, which the "every fixture is claimed by exactly one row"
  // governance case depends on. Splitting them here rather than fusing the fixtures keeps
  // both properties true at once; contracts/README's table stays the count of FAMILIES.
  //
  // Strategy §4 and contracts/README.md both still say EIGHT: the ninth is the MCP
  // handshake family below, added when §7's 2026-08-26 amendment made `initialize` an
  // answer of ours rather than a -32601. Both documents owe it a line, and neither is
  // this file's to write (§9 rule 1 — the strategy and the fixture governance are the
  // owner's), so the disagreement is recorded here rather than silently reconciled.
  //
  // `consumers` is empty on four rows and that emptiness is the finding, not an omission:
  // whoami, the error vocabulary, the admin ops and the planner rows are produced and
  // type-pinned (see PinnedConsumerShapes) but no consumer suite opens the JSON yet.
  // `cli/test/` is where that gap closes; until it does, the honest place for it is here.

  {
    file: "contracts/whoami.json",
    spec: "§8",
    emission: "GET /api/whoami through exports.default.fetch, once under a device-flow session token, once under a live pmcp_sa_ key, and once under a pmcp_svc_ bearer for the 401 body and its WWW-Authenticate header",
    consumers: [],
    producer: "worker",
  },
  // §7's amended dispatch table: the handshake is the FIRST thing any standards-compliant
  // MCP client sends, and the answer it reads before deciding whether it can talk to this
  // hub at all — a copied shape with no shared declaration in exactly the sense the others
  // are, except that the consumer copies live in third-party clients rather than in this
  // repository. `consumers` is empty for that reason and not for the usual one.
  {
    file: "contracts/initialize.json",
    spec: "§7",
    emission: "the initialize result POST /<user>/mcp really answers a live pmcp_sa_ key — protocolVersion, capabilities, serverInfo — beside the request a compliant client opens with, whose protocolVersion is read off the hub's own server/discover rather than transcribed, and beside gateway's CAPABILITY_SHAPE: the per-family objects the SCOPED handshake derives its answer from, which is where a consumer meets resources and completions",
    consumers: [],
    producer: "worker",
  },
  {
    file: "contracts/errors.json",
    spec: "§7",
    emission: "the JSON-RPC error objects the /<user>/mcp pipeline really returns for each of the five codes — including a live -32003's data keys and the two byte-identical -32001 causes",
    consumers: [],
    producer: "worker",
  },
  // The two families that exist because tunnel.ts PUBLISHES its wire vocabulary rather than
  // hiding it (FINDINGS 2). Emitted from the exports here; locked to a live socket in
  // tunnel/protocol.test.ts. One definition, one emitter, one behavioral witness.
  {
    file: "contracts/tunnel-frames.json",
    spec: "§6/§7",
    emission: "the hub/register REQUEST shape the DO accepts — HUB_METHODS.register plus the params keys it reads (clientVersion, protocolVersion, roles, the last carrying §20.3's two spellings in one declaration: a bare pattern list beside a per-family object) and the wire revision it speaks, with no service or slug field ever — beside the ack and hub/replaced notification the DO emits, named by the same exported HUB_METHODS, plus the forwarded-call _meta key names (hub/principal, hub/roles, the mirrored clientCapabilities)",
    consumers: ["clients/js", "clients/py"],
    producer: "worker",
  },
  {
    file: "contracts/close-codes.json",
    spec: "§6",
    emission: "the exported close-code vocabulary — CLOSE_REPLACED, CLOSE_REVOKED, CLOSE_ARCHIVED, CLOSE_ROW_GONE, CLOSE_PROTOCOL — beside the 401 and 403 statuses captured from real handleConnect refusals (a dead credential, an archived service — both socket-free, which is why this project can produce them), each carrying its required client behavior and, where it reconnects, its schedule. The successful 101 is NOT an entry: §6's matrix gives it no meaning, it is not an ending, and the closed three-word behavior vocabulary has no member for \"proceed\"",
    consumers: ["clients/js", "clients/py"],
    producer: "worker",
  },
  {
    file: "contracts/bootstrap.json",
    spec: "§12",
    emission: "POST /internal/users request and response bodies for all four ops, plus the 404 the route returns while BOOTSTRAP_SECRET is unset and the 401 for a wrong secret",
    consumers: ["scripts"],
    producer: "worker",
  },
  {
    file: "contracts/admin-ops.json",
    spec: "§8",
    emission: "Object.keys(admin.ops) and each op's input schema as adminBackend renders it, plus token_issue's outputSchema with its writeOnly key field",
    consumers: [],
    producer: "worker",
  },
  {
    file: "contracts/service-list.json",
    spec: "§8/§9",
    emission: "a live service_list row for a tunneled service, a proxied service, and the builtin pmcp entry that has no D1 row behind it",
    consumers: [],
    producer: "worker",
  },
  {
    file: "contracts/account-list.json",
    spec: "§8/§9",
    emission: "a live account_list row with its grants inline — the other half of the planner's entire current-state read",
    consumers: [],
    producer: "worker",
  },
  // The one family whose consumer is inside this repository's own server (see the type's
  // doc): audit.ts writes the stub, the audit page, the JSONL export and hygiene.test.ts's
  // BodyColumnShape read it, and no declaration is shared between them.
  {
    file: "contracts/audit-body-stubs.json",
    spec: "§15",
    emission: "the audit.BodyStub values a real tools/call records — the blob stub standing in for an unstructured result block, and the oversize stub replacing a whole body against a shrunk AUDIT_BODY_CAP_BYTES",
    consumers: ["server"],
    producer: "worker",
  },
];

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
  it(`${family.spec} · ${family.file} deep-equals the emission it pins`, async () => {
    // FINDINGS 1, RESOLVED 2026-08-26: vitest's file snapshot is written by the Node host
    // over the pool's RPC, so `pnpm contracts:update` — a plain `vitest run --project
    // worker contracts -u` — is the whole write path, and it is this line. Verified against
    // @cloudflare/vitest-plugin 1.0.0 + vitest 4.1 before this file was implemented; the
    // Node-side fallback the finding named was not needed.
    await expect(fixtureText(await capture(family))).toMatchFileSnapshot(snapshotPath(family.file));
  }, CASE_BUDGET_MS);
}

/** What a case may take: every emission seeds a namespace through the real seams, and two
 *  of them drive a whole `tools/call`. Nothing here waits on a clock. */
const CASE_BUDGET_MS = 60_000;

/**
 * A fixture as it is written: pretty JSON with a trailing newline, so the file a human
 * reviews in the owner's fixture commit is diffable line by line rather than one long line.
 */
function fixtureText(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** A repo-relative fixture path as this file's snapshot path. */
function snapshotPath(file: string): string {
  return `../../../${file}`;
}

/**
 * The captured emission per family. One entry per row of CONTRACT_FAMILIES, keyed by the
 * row's own `file` so the table and this map cannot drift apart silently (the governance
 * case below checks both directions).
 */
const EMISSIONS: Record<string, () => Promise<unknown>> = {
  "contracts/whoami.json": whoamiEmission,
  "contracts/initialize.json": initializeEmission,
  "contracts/errors.json": errorsEmission,
  "contracts/tunnel-frames.json": tunnelFramesEmission,
  "contracts/close-codes.json": closeCodesEmission,
  "contracts/bootstrap.json": bootstrapEmission,
  "contracts/admin-ops.json": adminOpsEmission,
  "contracts/service-list.json": serviceListEmission,
  "contracts/account-list.json": accountListEmission,
  "contracts/audit-body-stubs.json": auditBodyStubsEmission,
};

/** One family's live emission, normalized. */
function capture(family: ContractFamily): Promise<unknown> {
  return emitted(family.file);
}

/**
 * The live emission for one family, captured at most once per run. Memoized because the
 * snapshot case and the property cases below ask the same question of the same surface, and
 * every emission seeds — and tears down — a whole namespace to answer it. The governance
 * case that hunts run-to-run variance deliberately does NOT come through here: a second,
 * independent capture is the only thing that can catch a value that moves.
 */
const CAPTURED = new Map<string, Promise<unknown>>();

function emitted(file: string): Promise<Record<string, unknown>> {
  const emission = EMISSIONS[file];
  if (emission === undefined) throw new Error(`no emission is wired for ${file}`);
  const existing = CAPTURED.get(file);
  if (existing !== undefined) return existing as Promise<Record<string, unknown>>;
  const fresh = emission();
  CAPTURED.set(file, fresh);
  return fresh as Promise<Record<string, unknown>>;
}

/**
 * The fixtures on disk, read as data. A glob rather than nine imports because the
 * governance case has to see EVERY file in the directory — including one no row claims,
 * which is the orphan it exists to catch. Eager, so a fixture read is a plain object.
 */
const FIXTURES = import.meta.glob("../../../contracts/*.json", { eager: true }) as Record<
  string,
  Record<string, unknown> & { default?: Record<string, unknown> }
>;

/**
 * Vite's build-time directory read, typed here rather than by pulling in `vite/client` —
 * the repo types every platform surface by hand (workers-env.d.ts says why), and this is
 * one method used in one file. The call must stay a literal `import.meta.glob(...)`: the
 * transform is syntactic, so a cast around it would leave a runtime property access.
 */
declare global {
  interface ImportMeta {
    glob(pattern: string, options?: { eager?: boolean }): Record<string, unknown>;
  }
}

/** One fixture's content, by the repo-relative path its CONTRACT_FAMILIES row names. */
function fixture(file: string): Record<string, unknown> {
  const module = FIXTURES[snapshotPath(file)];
  if (module === undefined) throw new Error(`${file} is missing — run \`pnpm contracts:update\``);
  return module.default ?? module;
}

/** The fixture files on disk, as repo-relative paths. */
function fixtureFiles(): string[] {
  return Object.keys(FIXTURES).map((path) => path.replace("../../../", ""));
}

/**
 * The stand-in a fixture carries where a value genuinely varies per run — a row id, a
 * generated password, a timestamp, a byte count (contracts/README.md's
 * nothing-that-varies-per-run rule). The KEY and the value's TYPE are pinned; the value
 * never is.
 */
const TYPE_TOKEN = { string: "<string>", number: "<number>" } as const;

/** Replaces one value with the token for its type. */
function typeToken(value: unknown): string {
  if (typeof value === "number") return TYPE_TOKEN.number;
  if (typeof value === "string") return TYPE_TOKEN.string;
  throw new Error(`no type token for ${typeof value}`);
}

/** A copy of `body` with each named key replaced by its type token — the one place a
 *  varying value is dropped, so every fixture drops them the same way. */
function pinTypes<T extends Record<string, unknown>>(body: T, keys: readonly string[]): T {
  const out = { ...body } as Record<string, unknown>;
  for (const key of keys) {
    if (key in out && out[key] !== null) out[key] = typeToken(out[key]);
  }
  return out as T;
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
  const pinned = new Set(exceptions);
  const missing = {
    [`${name}: on the left, mapping to nothing on the right`]: left
      .filter((entry) => !pinned.has(entry) && !right.includes(entry))
      .sort(),
    [`${name}: on the right, reachable from nothing on the left`]: right
      .filter((entry) => !pinned.has(entry) && !left.includes(entry))
      .sort(),
  };
  // BOTH directions in one assertion, so a failure names the whole disagreement rather
  // than whichever half the runner happened to check first.
  expect(missing).toEqual({
    [`${name}: on the left, mapping to nothing on the right`]: [],
    [`${name}: on the right, reachable from nothing on the left`]: [],
  });
}

// ── the emissions: one capture per family, each through the production surface ─────────

const ORIGIN = (env as unknown as { PUBLIC_ORIGIN: string }).PUBLIC_ORIGIN;

/**
 * The names every emission seeds under. FIXED rather than generated (seed.uniqueSlug) on
 * purpose: this project isolates storage per file and every capture tears its namespace
 * down, so a fixed name is free — and it is what lets `whoami.json` pin the `user:` /`sa:`
 * grammar as a literal instead of as a type token (contracts/README.md's rule is about
 * values that VARY, and these do not).
 */
const FIXTURE_USER = "contracts-user";
const FIXTURE_ACCOUNT = "contracts-agent";
const FIXTURE_TUNNEL = "contracts-tunnel";
const FIXTURE_PROXY = "contracts-proxy";
const FIXTURE_TOOL = "search";

/**
 * §20.3's role declaration, in the TWO spellings one `hub/register` may mix: a bare
 * pattern list — which means tools, forever, so every service in the field keeps
 * registering unchanged — and the per-family object. Spelled once here because three
 * surfaces read it: the tunnel-frames emission (the wire shape both client libraries copy
 * with no shared declaration), the acceptance case, and the canonical-read case. A second
 * spelling among them is exactly the drift this directory exists to catch.
 *
 * The multi-family role names all three families deliberately. §20.3 does not say whether
 * the canonical form fills an ABSENT family with `[]`, and a declaration that left one out
 * would make this file the place that guessed.
 */
const FIXTURE_TOOLS_ONLY_ROLE = "reader";
const FIXTURE_MULTI_FAMILY_ROLE = "curator";
const FIXTURE_ROLE_DECLARATION = {
  [FIXTURE_TOOLS_ONLY_ROLE]: [FIXTURE_TOOL],
  [FIXTURE_MULTI_FAMILY_ROLE]: {
    tools: ["publish"],
    prompts: ["digest_.*"],
    resources: ["news://feed/*"],
  },
};

/**
 * A role whose MEANING is tools-only but whose SPELLING is the per-family object — the
 * "whichever spelling registered it" half of §20.3's canonical read shape, and the only
 * way to tell a read that renders meaning from one that renders history.
 */
const SPELLED_TOOLS_ONLY_ROLE = "publisher";

/**
 * §20.2's owner-declared advertisement, spelled once for the three surfaces that read it:
 * the `service-list.json` proxy row, the read-back case, and the handshake case. It is
 * deliberately NOT the default — `tools` alone would make "the row carries what was stored"
 * indistinguishable from "the row invents the default", which is the whole subject of §8's
 * 2026-08-27 amendment — and it is deliberately not in declaration order either, so a reader
 * that sorted or a planner that compared as a list is visible.
 */
const FIXTURE_CAPABILITIES = ["resources", "tools"];

/** A second proxied service in the same namespace, created with no `capabilities` at all —
 *  the absent-is-absent half of the read-back case, beside its declared twin. */
const FIXTURE_UNDECLARED_PROXY = `${FIXTURE_PROXY}-undeclared`;

/**
 * §20.3's family vocabulary, read off the fixture's OWN multi-family role — which names all
 * three deliberately (see above). Derived rather than transcribed because a literal here
 * would be a third copy beside registry's `ROLE_FAMILIES` and the planner's, and a
 * validator that hand-copies the vocabulary it is validating checks only that this file
 * agrees with itself. The fixture is the one home; the case below locks both
 * implementations to it.
 */
const ROLE_FAMILIES = Object.keys(FIXTURE_ROLE_DECLARATION[FIXTURE_MULTI_FAMILY_ROLE]);

/** An obviously fake service credential — the wrong KIND for every consumer surface, which
 *  is the whole point of the whoami 401 row. */
const FAKE_SERVICE_TOKEN = "pmcp_svc_FAKE0000-not-a-consumer-credential";

/** Seeds a namespace, hands it to `body`, and tears it down — so the next capture may reuse
 *  the same fixed names, and the file's own governance sweep sees a clean database. */
async function inNamespace<T>(
  spec: Parameters<typeof seedNamespace>[1],
  body: (ns: SeededNamespace) => Promise<T>,
): Promise<T> {
  const ns = await seedNamespace(env.DB, { username: FIXTURE_USER, ...spec });
  try {
    return await body(ns);
  } finally {
    await ns.teardown();
  }
}

type Answer = { status: number; body: unknown };

/** One request through the running router — the same entry a consumer, the CLI and the
 *  bootstrap script all reach. */
async function fetched(path: string, init: RequestInit = {}): Promise<Answer> {
  const response = await workerExports.default.fetch(new Request(`${ORIGIN}${path}`, init));
  const text = await response.text();
  const json = response.headers.get("Content-Type")?.includes("application/json") === true;
  return { status: response.status, body: json ? (JSON.parse(text) as unknown) : text };
}

/** One JSON-RPC message to a consumer endpoint. */
function rpc(username: string, credential: string, slug: string | null, message: JsonRpcRequest) {
  const base = `/${username}/mcp`;
  return fetched(slug === null ? base : `${base}/${slug}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${credential}` },
    body: JSON.stringify(message),
  });
}

/** A `tools/call` as a consumer sends it. */
function callMessage(name: string, args: Record<string, unknown> = {}): JsonRpcRequest {
  return { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } };
}

/** The JSON-RPC error a message answered with — the object the error family pins. */
function errorOf(answer: Answer): { code: number; message: string; data?: unknown } {
  const error = (answer.body as JsonRpcResponse).error;
  if (error === undefined) throw new Error(`expected a refusal, got ${JSON.stringify(answer.body)}`);
  return error;
}

/**
 * §8's whoami, once per credential kind plus the refusal. The 401's `WWW-Authenticate` is
 * part of the shape: it is what tells a consumer to present a bearer at all.
 */
async function whoamiEmission(): Promise<unknown> {
  return inNamespace(
    { accounts: [{ slug: FIXTURE_ACCOUNT, tokens: [{ as: "key" }] }] },
    async (ns) => {
      const session = await seedOwnerSession(ns.owner);
      const whoami = (credential: string) =>
        fetched("/api/whoami", { headers: { Authorization: `Bearer ${credential}` } });
      const user = await whoami(session.token);
      const account = await whoami(ns.tokens.key.token);
      const refused = await workerExports.default.fetch(
        new Request(`${ORIGIN}/api/whoami`, {
          headers: { Authorization: `Bearer ${FAKE_SERVICE_TOKEN}` },
        }),
      );
      return {
        user: { status: user.status, body: user.body },
        service_account: { status: account.status, body: account.body },
        unauthorized: {
          status: refused.status,
          wwwAuthenticate: refused.headers.get("WWW-Authenticate"),
          body: await refused.text(),
        },
      };
    },
  );
}

/**
 * §7's handshake, amended 2026-08-26: the message every standards-compliant MCP client
 * opens with, and the answer it reads before it decides whether it can speak to this hub.
 *
 * Both halves are here for the same reason tunnel-frames.json carries the `hub/register`
 * REQUEST beside the ack — the hub does not produce the client's message, but the shape it
 * ACCEPTS is half the contract, and a fixture holding only the answer would let the request
 * side drift with nothing to notice. The request's `protocolVersion` is read off the hub's
 * own `server/discover` (wireRevision) rather than transcribed, so a revision bump reaches
 * this fixture through the hub; `capabilities: {}` is the legacy-lane declaration §7 names
 * ("a legacy-lane consumer that sent none gets `{}`") — an empty declaration is a
 * declaration; and `clientInfo` is pinned as two KEYS with string types, because every
 * client's own name and version differ and this directory pins nothing that varies.
 *
 * On the answering side only `serverInfo.version` is a type token: the hub's NAME is what a
 * consumer displays and does not move, while gateway's version string is a placeholder
 * waiting for a build stamp (its own `ponytail:` comment says so) — pinning that value
 * would make wiring one a contract break.
 */
async function initializeEmission(): Promise<unknown> {
  const revision = await wireRevision();
  const answered = await inNamespace(
    { accounts: [{ slug: FIXTURE_ACCOUNT, tokens: [{ as: "key" }] }] },
    async (ns) => {
      const answer = await rpc(
        ns.owner.username,
        ns.tokens.key.token,
        null,
        handshakeRequest(revision),
      );
      const body = answer.body as JsonRpcResponse;
      if (body.error !== undefined) {
        throw new Error(`the handshake was refused: ${JSON.stringify(body.error)}`);
      }
      return body.result as Record<string, unknown>;
    },
  );
  return {
    // No `id`: a correlation id is the client's own, and a fixture pins nothing per-run.
    request: {
      jsonrpc: "2.0",
      method: "initialize",
      params: {
        protocolVersion: revision,
        capabilities: {},
        clientInfo: pinTypes(FIXTURE_CLIENT_INFO, ["name", "version"]),
      },
    },
    result: {
      ...answered,
      serverInfo: pinTypes(answered.serverInfo as Record<string, unknown>, ["version"]),
    },
    // The SCOPED handshake's other half (§20.2), emitted from gateway's own constant the
    // way tunnel-frames is emitted from HUB_METHODS. `result.capabilities` above is the
    // AGGREGATED answer and carries two families; a scoped endpoint derives its object
    // from what the hub stores for that service, so a consumer meets `resources` (with a
    // `subscribe` key that appears nowhere else) and `completions` there. Both shapes are
    // one decision — CAPABILITY_SHAPE — and a directory that pinned only the first would
    // send an implementer to gateway.ts to learn the rest.
    scopedCapabilities: CAPABILITY_SHAPE,
  };
}

/** The handshake a compliant client opens with, at the revision the hub publishes. */
function handshakeRequest(revision: string): JsonRpcRequest {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: revision, capabilities: {}, clientInfo: FIXTURE_CLIENT_INFO },
  };
}

/** The identity a fixture client declares — obviously fake, and pinned in the fixture as a
 *  type rather than a value, because it is the CLIENT's and every client's differs. */
const FIXTURE_CLIENT_INFO = { name: "pmcp-contracts-client", version: "0.0.0-FAKE0000" };

/**
 * §7's five codes as the pipeline really emits them, each reduced to what is DURABLE: the
 * code and the key names of its `data` (null where there is no `data` member at all).
 * Messages are incidental (§7) and appear nowhere here.
 */
async function errorsEmission(): Promise<unknown> {
  return (await errorsWorld()).entries;
}

/**
 * Every refusal the error family pins, from ONE seeded namespace — the five codes reduced to
 * their durable half, plus the raw answers the cases below compare byte for byte (the two
 * -32001 causes, and the granted call that is their allow-twin). Memoized: the namespace
 * costs four services and a credentialled upstream, and every error case asks it the same
 * question.
 */
let errorsCapture: Promise<ErrorsWorld> | undefined;

type WireError = { code: number; message: string; data?: unknown };
type ErrorsWorld = {
  entries: Record<string, { code: number; dataKeys: string[] | null }>;
  raw: { ungranted: WireError; unknown: WireError; unavailable: WireError; allowed: unknown };
};

function errorsWorld(): Promise<ErrorsWorld> {
  return (errorsCapture ??= captureErrors());
}

async function captureErrors(): Promise<ErrorsWorld> {
  const gated = `${FIXTURE_PROXY}-gated`;
  return inNamespace(
    {
      services: [
        // Proxied and credentialled, so the approval gate is reachable without a socket.
        // Its declared roles cover exactly one tool, which is what makes an UNGRANTED tool
        // expressible on a service the caller can otherwise reach.
        {
          slug: gated,
          kind: "proxy",
          roles: { reader: [FIXTURE_TOOL] },
          upstreamUrl: upstreamUrlFor(healthyUpstream()),
          upstreamAuthMode: "headers",
        },
        // The same service in allow mode: the allow-twin every refusal here is measured
        // against, in the same namespace.
        {
          slug: FIXTURE_PROXY,
          kind: "proxy",
          roles: { reader: [FIXTURE_TOOL] },
          upstreamUrl: upstreamUrlFor(healthyUpstream({ structuredContent: { ok: true } })),
          upstreamAuthMode: "headers",
        },
        // Never connected, and archived: the -32000 and -32002 rows.
        { slug: FIXTURE_TUNNEL, kind: "tunnel" },
        { slug: `${FIXTURE_TUNNEL}-archived`, kind: "tunnel", archived: true },
      ],
      accounts: [
        {
          slug: FIXTURE_ACCOUNT,
          grants: {
            [gated]: [{ role: "reader", mode: "approval" }],
            [FIXTURE_PROXY]: [{ role: "reader", mode: "allow" }],
            [FIXTURE_TUNNEL]: [{ role: "all", mode: "allow" }],
            [`${FIXTURE_TUNNEL}-archived`]: [{ role: "all", mode: "allow" }],
          },
          tokens: [{ as: "key" }],
        },
      ],
    },
    async (ns) => {
      const registry = new Registry(env.DB);
      for (const slug of [gated, FIXTURE_PROXY]) {
        const proxied = await registry.getService(ns.owner.userId, slug);
        await setHeaders(proxied as Service, { Authorization: "Bearer FAKE0000-upstream" });
      }
      const as = (slug: string | null, message: JsonRpcRequest) =>
        rpc(ns.owner.username, ns.tokens.key.token, slug, message);

      const unavailable = errorOf(await as(FIXTURE_TUNNEL, callMessage(FIXTURE_TOOL)));
      const archived = errorOf(await as(`${FIXTURE_TUNNEL}-archived`, callMessage(FIXTURE_TOOL)));
      const approval = errorOf(await as(gated, callMessage(FIXTURE_TOOL)));
      // -32601 is sourced from a method §20.1 puts OUT OF SCOPE, not from one nobody had
      // implemented yet: `resources/list` used to answer this row and stopped the day §20.2
      // implemented it, which is how a fixture starts pinning a code no surface still emits.
      // `subscriptions/listen` is refused on both endpoint shapes by decision, so this row
      // keeps its meaning when the next family lands.
      const methodNotFound = errorOf(
        await as(FIXTURE_PROXY, { jsonrpc: "2.0", id: 1, method: "subscriptions/listen" }),
      );
      // The two -32001 causes, side by side: a tool the grant does not cover, and a name
      // that names no service at all on the aggregated shape.
      const ungranted = errorOf(await as(FIXTURE_PROXY, callMessage("a-tool-no-grant-covers")));
      const unknown = errorOf(await as(null, callMessage("nosuchservice_search")));
      const allowed = (await as(FIXTURE_PROXY, callMessage(FIXTURE_TOOL))).body;

      return {
        entries: {
          [String(unavailable.code)]: entry(unavailable),
          [String(ungranted.code)]: entry(ungranted),
          [String(archived.code)]: entry(archived),
          [String(approval.code)]: entry(approval),
          [String(methodNotFound.code)]: entry(methodNotFound),
        },
        raw: { ungranted, unknown, unavailable, allowed },
      };
    },
  );
}

/** One error's durable half: the code, and the key names of its `data` (§7 — the presence
 *  of approvalUrl is durable, the prose is not). */
function entry(error: { code: number; data?: unknown }): { code: number; dataKeys: string[] | null } {
  const data = error.data;
  return {
    code: error.code,
    dataKeys:
      typeof data === "object" && data !== null ? Object.keys(data as object).sort() : null,
  };
}

/** A fake upstream that answers one tool and one result — the proxied service every
 *  socket-free family is built on. */
function healthyUpstream(result?: UpstreamScenario["result"]): UpstreamScenario {
  return {
    id: uniqueSlug("up"),
    mode: { kind: "ok" },
    tools: [{ name: FIXTURE_TOOL, inputSchema: { type: "object", properties: {} } }],
    ...(result === undefined ? {} : { result }),
  };
}

/**
 * §6's control frames, emitted from the exported vocabulary (FINDINGS 2) plus the wire
 * revision read off a real `server/discover` answer — so a revision bump reaches the
 * fixture through the hub rather than through a literal here.
 */
async function tunnelFramesEmission(): Promise<unknown> {
  const revision = await wireRevision();
  return {
    protocolVersion: revision,
    // The published control-frame vocabulary, whole: the client libraries' "is this a hub
    // frame" test is a set membership over exactly this.
    methods: { ...HUB_METHODS },
    register: {
      // The request the DO ACCEPTS. `roles` carries §20.3's two spellings in ONE
      // declaration — the family dimension is a shape both client libraries copy, so the
      // fixture has to SHOW it rather than merely leave room for it. (Before 2026-08-26
      // this was `{}`, on the reasoning that an empty declaration is a declaration (§6);
      // that stays true and is pinned where it is observable — both libraries send `{}`
      // through unchanged when the author declares none.) The client's own version string
      // varies, so its TYPE is pinned.
      request: {
        jsonrpc: "2.0",
        method: HUB_METHODS.register,
        params: {
          clientVersion: TYPE_TOKEN.string,
          protocolVersion: revision,
          roles: FIXTURE_ROLE_DECLARATION,
        },
      },
      // §6's sharpest privilege rule as data: identity comes exclusively from the token,
      // so these keys may never appear in the payload above.
      forbiddenParamsKeys: ["service", "slug"],
      // Correlation ids are the client's, so the two replies carry none. The rejection's
      // CODE comes from errors.ts's own name for it rather than a literal typed here, and
      // tunnel/protocol.test.ts case 8 asserts a really-refused declaration answers that
      // same code on a live socket — so the number has one home and one witness.
      ack: { jsonrpc: "2.0", result: { ok: true } },
      rejection: { jsonrpc: "2.0", error: { code: CODES.invalidParams } },
    },
    replaced: { jsonrpc: "2.0", method: HUB_METHODS.replaced },
    // The `_meta` names a forwarded call carries (§7). The hub's own two plus the mirrored
    // capabilities — no other `hub/*` name exists, which is the totality case below.
    forwardedCall: {
      metaKeys: [
        "hub/principal",
        "hub/roles",
        "io.modelcontextprotocol/clientCapabilities",
      ],
    },
  };
}

/** The one MCP revision this hub speaks, read off the hub's own `server/discover` answer
 *  rather than transcribed — the endpoint is answered by the gateway with no service
 *  resolved, so it needs no fixture of its own. */
async function wireRevision(): Promise<string> {
  return inNamespace({ accounts: [{ slug: FIXTURE_ACCOUNT, tokens: [{ as: "key" }] }] }, async (ns) => {
    const answer = await rpc(ns.owner.username, ns.tokens.key.token, null, {
      jsonrpc: "2.0",
      id: 1,
      method: "server/discover",
    });
    const result = (answer.body as JsonRpcResponse).result as { supportedVersions: string[] };
    return result.supportedVersions[0];
  });
}

/**
 * §6's close-code → required-client-behavior table, spread whole from tunnel.ts's exported
 * CLOSE_POLICY — the numbers AND the policy words come from the module that owns the
 * protocol, so a re-numbering and a policy change reach this fixture by the same route.
 * (Before FINDINGS 4 the words were typed here, in the file that also WRITES the fixture:
 * one decision with no home in src, no behavioral witness, and a producer grading its own
 * paper.) The two upgrade statuses come from REAL handleConnect refusals — a dead
 * credential and an archived service, both socket-free.
 */
async function closeCodesEmission(): Promise<unknown> {
  const { unauthorized, forbidden } = await upgradeRefusals();
  return {
    // The closed vocabularies, published beside the entries so a consumer can check its own
    // table against them without deriving a set from the rows.
    behaviors: [...CLOSE_BEHAVIORS],
    schedules: [...CLOSE_SCHEDULES],
    entries: {
      ...Object.fromEntries(
        Object.entries(CLOSE_POLICY).map(([code, policy]) => [
          `close:${code}`,
          { kind: "close", code: Number(code), ...policy },
        ]),
      ),
      // The upgrade half is this file's: §6 gives the two statuses their meaning at the
      // door, before any socket exists, so there is no close-code constant to hang them on.
      [`upgrade:${unauthorized}`]: {
        kind: "upgrade",
        code: unauthorized,
        behavior: "stop_fatal",
      },
      [`upgrade:${forbidden}`]: {
        kind: "upgrade",
        code: forbidden,
        behavior: "reconnect",
        schedule: "max_only",
      },
    },
  };
}

/** The two upgrade statuses, from real refusals: a revoked credential and an archived
 *  service. Neither reaches the DO, which is why this project can produce them. */
async function upgradeRefusals(): Promise<{ unauthorized: number; forbidden: number }> {
  return inNamespace(
    {
      services: [
        { slug: FIXTURE_TUNNEL, kind: "tunnel", tokens: [{ as: "dead", revoked: true }] },
        {
          slug: `${FIXTURE_TUNNEL}-archived`,
          kind: "tunnel",
          archived: true,
          tokens: [{ as: "archived" }],
        },
      ],
    },
    async (ns) => {
      const upgrade = async (token: string): Promise<number> => {
        const response = await handleConnect(
          new Request(`${ORIGIN}/connect`, {
            headers: { Upgrade: "websocket", Authorization: `Bearer ${token}` },
          }),
        );
        return response.status;
      };
      return {
        unauthorized: await upgrade(ns.tokens.dead.token),
        forbidden: await upgrade(ns.tokens.archived.token),
      };
    },
  );
}

/**
 * §12's four ops plus the two refusals, driven through the real route. The secret is set on
 * the ambient binding for the capture and put back afterwards — the same override
 * hygiene.test.ts uses for §15's knobs, and the only way to reach a route that does not
 * exist while its secret is unset.
 */
async function bootstrapEmission(): Promise<unknown> {
  const bindings = env as unknown as Record<string, string | undefined>;
  const previous = bindings.BOOTSTRAP_SECRET;
  const post = (secret: string | undefined, body: BootstrapRequest) =>
    fetched("/internal/users", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(secret === undefined ? {} : { Authorization: `Bearer ${secret}` }),
      },
      body: JSON.stringify(body),
    });

  // The route does not exist while the secret is unset — captured FIRST, because it is the
  // only state in which it can be.
  bindings.BOOTSTRAP_SECRET = undefined;
  const disabled = await post("anything", { op: "list" });

  bindings.BOOTSTRAP_SECRET = FIXTURE_BOOTSTRAP_SECRET;
  try {
    const wrongSecret = await post("FAKE0000-not-the-secret", { op: "list" });
    const listing: BootstrapRequest = { op: "list" };
    const created: BootstrapRequest = { op: "create", username: FIXTURE_USER };
    const reset: BootstrapRequest = { op: "reset-password", username: FIXTURE_USER };
    const removed: BootstrapRequest = { op: "delete", username: FIXTURE_USER };
    const list = await post(FIXTURE_BOOTSTRAP_SECRET, listing);
    const create = await post(FIXTURE_BOOTSTRAP_SECRET, created);
    const resetPassword = await post(FIXTURE_BOOTSTRAP_SECRET, reset);
    const remove = await post(FIXTURE_BOOTSTRAP_SECRET, removed);
    return {
      create: { request: created, response: pinTypes(body(create), ["password"]) },
      list: {
        request: listing,
        // A listing's CONTENTS are whatever the database holds; the shape is one string
        // per username, which is what the element token says.
        response: { ...body(list), usernames: [TYPE_TOKEN.string] },
      },
      "reset-password": {
        request: reset,
        response: pinTypes(body(resetPassword), ["password"]),
      },
      delete: { request: removed, response: body(remove) },
      disabled: { status: disabled.status },
      wrongSecret: { status: wrongSecret.status },
    };
  } finally {
    bindings.BOOTSTRAP_SECRET = previous;
  }
}

/** The bootstrap secret this capture sets — obviously fake, and unset again the moment the
 *  capture ends. */
const FIXTURE_BOOTSTRAP_SECRET = "FAKE0000-bootstrap-secret";

/** One bootstrap answer's body as the script parses it. */
function body(answer: Answer): Record<string, unknown> {
  return answer.body as Record<string, unknown>;
}

/**
 * §8's op names and their rendered schemas, straight off the backend that serves them — one
 * zod-equivalent declaration, one rendering, so the MCP tool and the web form cannot drift.
 */
async function adminOpsEmission(): Promise<unknown> {
  const tools = await servedOps();
  return {
    names: tools.map((tool) => tool.name).sort(),
    inputSchemas: Object.fromEntries(tools.map((tool) => [tool.name, tool.inputSchema])),
    outputSchemas: Object.fromEntries(
      tools
        .filter((tool) => tool.outputSchema !== undefined)
        .map((tool) => [tool.name, tool.outputSchema]),
    ),
  };
}

/** The builtin's tools, as adminBackend renders them. The `pmcp` Service value is virtual —
 *  no row exists for it (§8) — and only its ownerId is ever read. */
function servedOps(): Promise<Tool[]> {
  const virtual: Service = {
    id: PMCP_SLUG,
    ownerId: PMCP_SLUG,
    slug: PMCP_SLUG,
    kind: "tunnel",
    archived: false,
    logBodies: true,
  };
  return adminBackend.listTools(virtual, {
    principal: { kind: "user", userId: PMCP_SLUG, username: FIXTURE_USER },
    roles: ["all"],
  });
}

/** §8/§9's `service_list` rows — one per kind the planner can meet. */
async function serviceListEmission(): Promise<unknown> {
  return inNamespace(
    {
      services: [
        { slug: FIXTURE_TUNNEL, kind: "tunnel" },
        {
          slug: FIXTURE_PROXY,
          kind: "proxy",
          upstreamUrl: upstreamUrlFor(healthyUpstream()),
          // oauth mode, so the row carries the connection state the planner must never
          // plan against.
          upstreamAuthMode: "oauth",
        },
      ],
    },
    async (ns) => {
      // Declared rather than left default, because the row's SHAPE is what this family
      // pins: an undeclared service carries no `capabilities` key at all (§8's 2026-08-27
      // amendment, and the read-back case below), so a fixture built from one would pin the
      // proxied row as the shape that happens to omit the field.
      await ops.service_update.handler(ns.owner.userId, {
        slug: FIXTURE_PROXY,
        capabilities: FIXTURE_CAPABILITIES,
      });
      const listed = (await ops.service_list.handler(ns.owner.userId, {})) as {
        services: Record<string, unknown>[];
      };
      const row = (slug: string) => {
        const found = listed.services.find((service) => service.slug === slug);
        if (found === undefined) throw new Error(`service_list served no "${slug}"`);
        // createdAt and lastSeen are the row's own clock; `endpoint` is one deployment's
        // URL (here the fake upstream's, which encodes its scenario). None is a shape.
        return pinTypes(found, ["createdAt", "lastSeen", "endpoint"]);
      };
      return { tunnel: row(FIXTURE_TUNNEL), proxy: row(FIXTURE_PROXY), builtin: row(PMCP_SLUG) };
    },
  );
}

/** §8/§9's `account_list` row, grants inline — the planner's other whole read. */
async function accountListEmission(): Promise<unknown> {
  return inNamespace(
    {
      services: [{ slug: FIXTURE_TUNNEL, kind: "tunnel" }],
      accounts: [
        {
          slug: FIXTURE_ACCOUNT,
          grants: {
            [FIXTURE_TUNNEL]: [
              { role: "reader", mode: "allow" },
              { role: "writer", mode: "approval" },
            ],
          },
        },
      ],
    },
    async (ns) => {
      const listed = (await ops.account_list.handler(ns.owner.userId, {})) as {
        accounts: Record<string, unknown>[];
      };
      return { account: pinTypes(listed.accounts[0], ["createdAt"]) };
    },
  );
}

/**
 * §15's two typed size stubs, as a real `tools/call` records them: the `blob` an
 * unstructured block collapses into, and the `oversize` that replaces a whole over-cap
 * body. Driven against a SHRUNK cap rather than a megabyte fixture, and `bytes` is pinned
 * as a key with a number type — never as a value, which would change with the fixture.
 */
async function auditBodyStubsEmission(): Promise<unknown> {
  return inNamespace(
    {
      services: [
        {
          slug: FIXTURE_PROXY,
          kind: "proxy",
          logBodies: true,
          upstreamUrl: upstreamUrlFor(
            healthyUpstream({
              structuredContent: { ok: true },
              content: [{ type: "image", mimeType: STUB_MEDIA_TYPE, data: "FAKE0000-bytes" }],
            }),
          ),
          upstreamAuthMode: "headers",
        },
      ],
      accounts: [
        {
          slug: FIXTURE_ACCOUNT,
          grants: { [FIXTURE_PROXY]: [{ role: "all", mode: "allow" }] },
          tokens: [{ as: "key" }],
        },
      ],
    },
    async (ns) => {
      const proxied = await new Registry(env.DB).getService(ns.owner.userId, FIXTURE_PROXY);
      await setHeaders(proxied as Service, { Authorization: "Bearer FAKE0000-upstream" });
      const call = (args: Record<string, unknown>) =>
        rpc(ns.owner.username, ns.tokens.key.token, FIXTURE_PROXY, callMessage(FIXTURE_TOOL, args));

      await call({ q: "under the cap" });
      const blob = ((await lastRow(ns).then((row) => row.result)) as { content: BodyStub[] })
        .content[0];
      // The over-cap row runs against a shrunk cap, so "over-cap" needs no megabyte body and
      // survives a change to limits.AUDIT_BODY_CAP_BYTES.
      const oversize = await withCap(SHRUNK_CAP_BYTES, async () => {
        await call({ q: "x".repeat(SHRUNK_CAP_BYTES * 2) });
        return (await lastRow(ns)).args as unknown as BodyStub;
      });
      return {
        blob: pinTypes(blob as unknown as Record<string, unknown>, ["bytes"]),
        oversize: pinTypes(oversize as unknown as Record<string, unknown>, ["bytes"]),
      };
    },
  );
}

/** The media type the blob row's block declares — an image, because §15's own example is
 *  one ("the image generator returned a 4 MB png"). */
const STUB_MEDIA_TYPE = "image/png";

/** The cap the oversize row runs against: a FRACTION of the real one, so no byte literal
 *  exists here and the row moves with the constant. */
const SHRUNK_CAP_BYTES = AUDIT_BODY_CAP_BYTES / 16;

/** Runs `body` with §15's body cap overridden on the ambient binding — audit.ts resolves
 *  the knob at write time, and in this pool that env IS `cloudflare:test`'s. */
async function withCap<T>(capBytes: number, body: () => Promise<T>): Promise<T> {
  const bindings = env as unknown as Record<string, string | undefined>;
  const previous = bindings.AUDIT_BODY_CAP_BYTES;
  bindings.AUDIT_BODY_CAP_BYTES = String(capBytes);
  try {
    return await body();
  } finally {
    bindings.AUDIT_BODY_CAP_BYTES = previous;
  }
}

/** The newest `tools/call` row in a namespace, through the one read path §8 exposes. */
async function lastRow(ns: SeededNamespace): Promise<AuditRow> {
  const { rows } = await query(env.DB, ns.owner.userId, { event: "tools/call", limit: 1 });
  if (rows.length === 0) throw new Error("the call wrote no audit row");
  return rows[0];
}

// One registered case per family: the capture, deep-equalled against the checked-in
// fixture — and, under `pnpm contracts:update`, the one write path in the repository.
describe("§4 · the fixtures against the emissions they pin", () => {
  for (const family of CONTRACT_FAMILIES) runContractFamily(family);
});

describe("§4 · whoami — the CLI↔server contract", () => {
  it("§8 · whoami.json \"user\" row deep-equals GET /api/whoami under a device-flow session token", async () => {
    expect((await emitted(WHOAMI)).user).toEqual(fixture(WHOAMI).user);
  }, CASE_BUDGET_MS);

  it("§8 · whoami.json \"service_account\" row deep-equals GET /api/whoami under a live pmcp_sa_ key", async () => {
    expect((await emitted(WHOAMI)).service_account).toEqual(fixture(WHOAMI).service_account);
  }, CASE_BUDGET_MS);

  it("§8 · whoami.json \"unauthorized\" row deep-equals the 401 body and WWW-Authenticate header for a pmcp_svc_ bearer — refusal, twinned with the two rows above", async () => {
    const refused = (await emitted(WHOAMI)).unauthorized as Record<string, unknown>;
    expect(refused).toEqual(fixture(WHOAMI).unauthorized);
    // The header is part of the refusal's shape: it is what tells a consumer to present a
    // bearer at all, and the two rows above are what keep this from being the only outcome.
    expect(refused.status).toBe(401);
    expect(refused.wwwAuthenticate).toBe("Bearer");
  }, CASE_BUDGET_MS);

  it("§8 · cli WhoamiResponse's key set equals the fixture's, both directions — the copy is pinned on the consumer side too, not just the emitting side", () => {
    // The CLI's copy as a VALUE, so its key set is readable at runtime; the type annotation
    // is what makes a rename over there a compile error here.
    const copy: WhoamiResponse = { principal: "", namespace: "" };
    const served = (fixture(WHOAMI).user as { body: Record<string, unknown> }).body;
    assertTotalMapping("whoami keys", Object.keys(copy), Object.keys(served), []);
  });
});

const WHOAMI = "contracts/whoami.json";
const INITIALIZE = "contracts/initialize.json";
const ERRORS = "contracts/errors.json";
const TUNNEL_FRAMES = "contracts/tunnel-frames.json";
const CLOSE_CODES = "contracts/close-codes.json";
const BOOTSTRAP = "contracts/bootstrap.json";
const ADMIN_OPS = "contracts/admin-ops.json";
const SERVICE_LIST = "contracts/service-list.json";
const ACCOUNT_LIST = "contracts/account-list.json";
const AUDIT_STUBS = "contracts/audit-body-stubs.json";

describe("§4 · the MCP handshake — the shape every consumer meets first", () => {
  it("§7 · initialize.json's result carries the revision the hub PUBLISHES on server/discover — one revision, read off a second surface, so a bump can never reach the handshake without reaching the fixture", async () => {
    // File-vs-emission is the snapshot case's job. What this case adds is the cross-surface
    // agreement: §7 gives the hub one revision, and `server/discover` and the handshake are
    // two independent answers of it.
    const pinned = fixture(INITIALIZE).result as Record<string, unknown>;
    expect(pinned.protocolVersion).toBe(await wireRevision());
    // …and the request the client sends declares the same one, which is what makes the two
    // halves of this family one handshake rather than two shapes that share a file.
    const request = fixture(INITIALIZE).request as { params: Record<string, unknown> };
    expect(request.params.protocolVersion).toBe(pinned.protocolVersion);
  }, CASE_BUDGET_MS);

  it("§7 · initialize.json advertises the tools capability with listChanged FALSE — a stateless endpoint holds no session to notify, so a client that subscribed would wait forever; the same object server/discover publishes, never a second spelling of it", async () => {
    const pinned = fixture(INITIALIZE).result as { capabilities: Record<string, unknown> };
    // The TOOLS member, which is this case's own sentence. §20.2 put `prompts` beside it
    // (both `listChanged: false`, for the reason this title states); the whole capability
    // set, byte-for-byte, is the §20.2 row below — one owner per claim, so a family added
    // to the aggregated answer fails exactly one case and it is the one that says so.
    expect(pinned.capabilities.tools).toEqual({ listChanged: false });
    // The hub's two published answers agree, because one constant serves both (§7).
    const discovered = await inNamespace(
      { accounts: [{ slug: FIXTURE_ACCOUNT, tokens: [{ as: "key" }] }] },
      async (ns) => {
        const answer = await rpc(ns.owner.username, ns.tokens.key.token, null, {
          jsonrpc: "2.0",
          id: 1,
          method: "server/discover",
        });
        return ((answer.body as JsonRpcResponse).result as { capabilities: unknown }).capabilities;
      },
    );
    expect(pinned.capabilities).toEqual(discovered);
  }, CASE_BUDGET_MS);

  it("§7 · initialize.json pins serverInfo's two KEYS with the version left a type token, and carries no per-run value anywhere — the hub's name is what a consumer displays, a build stamp is not a wire contract", () => {
    const server = (fixture(INITIALIZE).result as { serverInfo: Record<string, unknown> })
      .serverInfo;
    expect(Object.keys(server).sort()).toEqual(["name", "version"]);
    expect(server.name).toBeTruthy();
    expect(server.version).toBe(TYPE_TOKEN.string);
    // The client's own identity is the same decision on the other side of the exchange.
    const declared = (fixture(INITIALIZE).request as { params: { clientInfo: Record<string, unknown> } })
      .params.clientInfo;
    expect(declared).toEqual({ name: TYPE_TOKEN.string, version: TYPE_TOKEN.string });
  });

  it("§7/§20.2 · contracts/initialize.json pins the aggregated answer byte-for-byte: tools and prompts, listChanged false, no resources and no completions", () => {
    const pinned = (fixture(INITIALIZE).result as { capabilities: Record<string, unknown> }).capabilities;
    // §20.2's aggregated constant, WHOLE: two families and no third, both unable to notify.
    // It stays a constant — and therefore stays a fixture — because an empty `prompts/list`
    // is a legal answer and composing a union across the namespace could only ever tell a
    // consumer to expect nothing (the intersection it sidesteps would let one tools-only
    // service suppress every other service's prompts).
    expect(pinned).toEqual({ tools: { listChanged: false }, prompts: { listChanged: false } });
    // `listChanged: false` on both is not decoration: server→consumer notifications are
    // deferred with `subscriptions/listen` (§20.1), and a declared listChanged would make a
    // Claude Code client open a listen stream, take -32601, and burn its reopen budget for
    // the rest of the day. Never declare a capability the transport cannot honor.
    for (const family of Object.values(pinned)) expect(family).toEqual({ listChanged: false });
    // The two families §18 decision 26 keeps OFF this endpoint shape: a URI cannot take a
    // `<slug>_` prefix and still be the URI the service knows, so `resources/*` and
    // `completion/complete` answer -32601 here — and a handshake must not promise what the
    // door refuses.
    for (const absent of ["resources", "completions"]) {
      expect(Object.keys(pinned), `the aggregated handshake promised ${absent}`).not.toContain(absent);
    }
  });
});

/**
 * §5 decision 20 / §7's client-metadata capture, driven the way the metadata actually
 * arrives — and in THIS file because the three columns are a copied shape with no shared
 * declaration in exactly the sense the fixtures pin: gateway.ts writes them off the wire,
 * audit.ts stores them, and the /audit page, the JSONL export and `audit_query.session`
 * read them back, with nothing but agreement holding the four together.
 *
 * The flow is the real one: the handshake declaring `clientInfo`, the
 * `notifications/initialized` behind it, then a `tools/call`. The identity rides that call's
 * `_meta` and not the handshake's params, because the wire is stateless (§7: `initialize`
 * is answered by the Worker and remembered by nothing, so there is no session for a
 * handshake to have populated) — a 2026-07-28 consumer therefore re-declares itself per
 * request under the reserved `io.modelcontextprotocol/clientInfo` key. §15 keeps
 * `tools/list` and the handshake out of audit entirely, so the `tools/call` row is where
 * "the persisted metadata" can be looked at at all.
 *
 * The two `_meta` key names are spelled here because gateway.ts keeps them module-private
 * (its SESSION_ID_META_KEYS allowlist is one line, deliberately). That makes these cases
 * the LOCK rather than a transcription: rename either key hub-side and this goes red,
 * which is the whole reason the spelling is driven through the wire instead of imported.
 */
describe("§4/§5 d20 · the identity a consumer declares reaches the ledger", () => {
  it("§7 · a real consumer flow — the handshake declaring clientInfo, then a tools/call carrying that identity in the stateless wire's `_meta` — lands name, version and session id on the tools/call audit row, and audit_query.session finds that row by it", async () => {
    const { identified, bySession } = await clientMetaWorld();
    expect(identified.client).toEqual({
      name: FIXTURE_CLIENT_INFO.name,
      version: FIXTURE_CLIENT_INFO.version,
      sessionId: FIXTURE_CLIENT_SESSION_ID,
    });
    // §5 decision 20's other half: the captured id is a FILTER, which is the only thing
    // besides display it may ever be used for.
    expect(bySession.map((row) => row.id)).toEqual([identified.id]);
  }, CASE_BUDGET_MS);

  it("§7 · the same call with no declared identity records no client fields at all — the columns are copied off the wire and never fabricated (the twin without which recording a constant would satisfy the row above)", async () => {
    const { anonymous } = await clientMetaWorld();
    // Absent, not empty-and-present: audit.toRow omits a member an event does not have, so
    // a reader never has to tell `null` from `undefined` for one absence.
    expect(anonymous.client).toBeUndefined();
    // …and it is the same call otherwise: a row was written, with the same tool and outcome.
    expect([anonymous.event, anonymous.tool]).toEqual(["tools/call", FIXTURE_TOOL]);
  }, CASE_BUDGET_MS);
});

/**
 * The client-metadata world: one namespace, one credentialled proxied upstream, two calls
 * behind one handshake — identified and anonymous. Memoized like every other capture here,
 * because both cases ask the same seeded question.
 */
let clientMetaCapture: Promise<ClientMetaWorld> | undefined;

type ClientMetaWorld = { identified: AuditRow; anonymous: AuditRow; bySession: AuditRow[] };

function clientMetaWorld(): Promise<ClientMetaWorld> {
  return (clientMetaCapture ??= captureClientMeta());
}

async function captureClientMeta(): Promise<ClientMetaWorld> {
  // Read before the namespace is seeded: wireRevision seeds one of its own under the same
  // fixed username, and the two may not overlap.
  const revision = await wireRevision();
  return inNamespace(
    {
      services: [
        {
          slug: FIXTURE_PROXY,
          kind: "proxy",
          roles: { reader: [FIXTURE_TOOL] },
          upstreamUrl: upstreamUrlFor(healthyUpstream({ structuredContent: { ok: true } })),
          upstreamAuthMode: "headers",
        },
      ],
      accounts: [
        {
          slug: FIXTURE_ACCOUNT,
          grants: { [FIXTURE_PROXY]: [{ role: "reader", mode: "allow" }] },
          tokens: [{ as: "key" }],
        },
      ],
    },
    async (ns) => {
      const proxied = await new Registry(env.DB).getService(ns.owner.userId, FIXTURE_PROXY);
      await setHeaders(proxied as Service, { Authorization: "Bearer FAKE0000-upstream" });
      const as = (message: JsonRpcRequest) =>
        rpc(ns.owner.username, ns.tokens.key.token, FIXTURE_PROXY, message);

      // What a client does before its first call, in order.
      await as(handshakeRequest(revision));
      await as({ jsonrpc: "2.0", method: "notifications/initialized" });

      const call = (meta?: Record<string, unknown>) =>
        as({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: FIXTURE_TOOL,
            arguments: { q: "hello" },
            ...(meta === undefined ? {} : { _meta: meta }),
          },
        });

      await call({
        // The reserved wire key for a consumer's self-declaration, and §7's one-entry
        // vendor session-id allowlist. Both spelled here because gateway keeps them
        // private; see this describe's header.
        "io.modelcontextprotocol/clientInfo": FIXTURE_CLIENT_INFO,
        "claudecode/sessionId": FIXTURE_CLIENT_SESSION_ID,
      });
      const identified = await lastRow(ns);
      const bySession = (
        await query(env.DB, ns.owner.userId, {
          event: "tools/call",
          session: FIXTURE_CLIENT_SESSION_ID,
        })
      ).rows;

      await call();
      return { identified, anonymous: await lastRow(ns), bySession };
    },
  );
}

/** The vendor session id a fixture client declares — obviously fake, never a real one. */
const FIXTURE_CLIENT_SESSION_ID = "FAKE0000-client-session";

/**
 * Strategy §10's aggregated tool-name code contract, at the seam that serves the names.
 *
 * §7 composes an aggregated name as `<slug>_<tool>`: the slug half is ours and pinned to
 * `[a-z0-9-]`, and the tool half is whatever an upstream or a registered service calls
 * itself. Real consumers refuse names outside `^[a-zA-Z0-9_-]{1,128}$`, so the composition
 * is where an otherwise-healthy service becomes a tool list a client rejects — §10 records
 * exactly that as a code contract, and notes that the spec's own `get.news` example
 * violates the charset.
 *
 * The fixture is that example: an upstream serving one in-charset tool and one dotted one.
 */
describe("§4/§10 · aggregated tool names against the consumer charset", () => {
  it("§10 · every name an aggregated tools/list serves matches ^[a-zA-Z0-9_-]{1,128}$ — the charset real consumers accept — while the in-charset tool beside it is still served, so \"serve nothing\" cannot satisfy this", async () => {
    const served = await aggregatedNames();
    // The allow half first: a hub that dropped the whole listing would otherwise pass.
    expect(served).toContain(`${FIXTURE_PROXY}_${FIXTURE_TOOL}`);
    const refusedByConsumers = served.filter((name) => !CONSUMER_TOOL_NAME.test(name));
    expect(
      refusedByConsumers,
      "these names reach a consumer that will refuse them (strategy §10's code contract)",
    ).toEqual([]);
  }, CASE_BUDGET_MS);
});

/**
 * The charset a consumer accepts, from strategy §10 — spelled here rather than referenced
 * from limits.ts because no production constant exists: nothing validates these names
 * today, which is what the case above is measuring.
 */
const CONSUMER_TOOL_NAME = /^[a-zA-Z0-9_-]{1,128}$/;

/** §10's own example of a name that violates the consumer charset. */
const OUT_OF_CHARSET_TOOL = "get.news";

/** The names one aggregated tools/list really serves, over an upstream that offers both an
 *  in-charset tool and §10's dotted example. */
async function aggregatedNames(): Promise<string[]> {
  return inNamespace(
    {
      services: [
        {
          slug: FIXTURE_PROXY,
          kind: "proxy",
          // `.*` rather than the two names, so the declaration is not what decides the
          // outcome: everything the upstream offers reaches the composition.
          roles: { reader: [".*"] },
          upstreamUrl: upstreamUrlFor({
            ...healthyUpstream(),
            tools: [
              { name: FIXTURE_TOOL, inputSchema: { type: "object", properties: {} } },
              { name: OUT_OF_CHARSET_TOOL, inputSchema: { type: "object", properties: {} } },
            ],
          }),
          upstreamAuthMode: "headers",
        },
      ],
      accounts: [
        {
          slug: FIXTURE_ACCOUNT,
          grants: { [FIXTURE_PROXY]: [{ role: "reader", mode: "allow" }] },
          tokens: [{ as: "key" }],
        },
      ],
    },
    async (ns) => {
      const proxied = await new Registry(env.DB).getService(ns.owner.userId, FIXTURE_PROXY);
      await setHeaders(proxied as Service, { Authorization: "Bearer FAKE0000-upstream" });
      const answer = await rpc(ns.owner.username, ns.tokens.key.token, null, {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
      });
      const result = (answer.body as JsonRpcResponse).result as { tools?: { name: string }[] };
      return (result.tools ?? []).map((tool) => tool.name);
    },
  );
}

describe("§4 · error vocabulary", () => {
  it("§7 · errors.json code set equals the five codes the pipeline emits (-32000/-32001/-32002/-32003/-32601) and admits no sixth", async () => {
    const emitted = Object.keys((await errorsWorld()).entries).sort();
    expect(Object.keys(fixture(ERRORS)).sort()).toEqual(emitted);
    expect(emitted).toEqual(["-32000", "-32001", "-32002", "-32003", "-32601"].sort());
  }, CASE_BUDGET_MS);

  it("§7 · errors.json -32003 entry's data keys deep-equal a real approval-required error's data — approvalId, approvalUrl, expiresAt, nothing else", async () => {
    const live = (await errorsWorld()).entries["-32003"];
    expect(fixture(ERRORS)["-32003"]).toEqual(live);
    expect(live.dataKeys).toEqual(["approvalId", "approvalUrl", "expiresAt"]);
    // The CLI's copy of that payload, pinned as a type: a rename over there is a compile
    // error here rather than a runtime surprise months later.
    const copy: ApprovalRequiredData = { approvalId: "", approvalUrl: "", expiresAt: "" };
    expect(Object.keys(copy).sort()).toEqual(live.dataKeys);
  }, CASE_BUDGET_MS);

  it("§7 · errors.json -32001 entry is ONE shape for both causes: an ungranted tool and an unknown tool are byte-identical — refusal", async () => {
    const { ungranted, unknown } = (await errorsWorld()).raw;
    // Byte-identical, message included: an agent that can tell the two apart can map the
    // grant patterns it was not given (§7).
    expect(JSON.stringify(unknown)).toBe(JSON.stringify(ungranted));
    expect(fixture(ERRORS)["-32001"]).toEqual(entry(ungranted));
  }, CASE_BUDGET_MS);

  it("§7 · a granted call in the same seeded namespace returns a result and no error member — the allow-twin of the -32001 and -32000 rows", async () => {
    const answer = (await errorsWorld()).raw.allowed as JsonRpcResponse;
    expect(answer.error, "the refusal rows would be satisfied by refusing everything").toBeUndefined();
    expect(answer.result).toBeDefined();
  }, CASE_BUDGET_MS);

  it("§7 · errors.json -32000 entry carries no data key, and no upstream status, header, or body fragment appears anywhere in it — refusal, twinned with the row above", async () => {
    const pinned = fixture(ERRORS)["-32000"] as { code: number; dataKeys: null };
    expect(pinned).toEqual({ code: -32000, dataKeys: null });
    // Whole-entry, not key-by-key: a status line, a WWW-Authenticate, or a body fragment
    // would have to appear somewhere in these bytes to reach a consumer.
    const bytes = JSON.stringify(pinned);
    for (const leak of ["401", "WWW-Authenticate", "upstream", "message"]) {
      expect(bytes.includes(leak), `"${leak}" reached the consumer's error`).toBe(false);
    }
  }, CASE_BUDGET_MS);

  it("§10 · cli HUB_ERRORS names map onto errors.json codes, total in both directions", () => {
    assertTotalMapping(
      "HUB_ERRORS ↔ errors.json",
      Object.values(HUB_ERRORS).map(String),
      Object.keys(fixture(ERRORS)),
      [],
    );
  });
});

describe("§4 · tunnel frames and close codes", () => {
  it("§6 · close-codes.json's 4001 and 4002 entries equal the exported CLOSE_REVOKED and CLOSE_ARCHIVED, and the SeverCode union admits exactly those two", () => {
    expect(closeEntry(`close:${CLOSE_REVOKED}`).code).toBe(CLOSE_REVOKED);
    expect(closeEntry(`close:${CLOSE_ARCHIVED}`).code).toBe(CLOSE_ARCHIVED);
    // Exhaustive by the type system: a third SeverCode fails to compile here, and a
    // fourth key in this object fails the `satisfies` check.
    expect(Object.keys(SEVER_CODES).map(Number).sort()).toEqual(
      [CLOSE_REVOKED, CLOSE_ARCHIVED].sort(),
    );
  });

  it("§6 · close-codes.json's other three entries equal the exported CLOSE_REPLACED, CLOSE_ROW_GONE and CLOSE_PROTOCOL — the fixture is emitted from the vocabulary, so a renumbering cannot reach the wire without reaching the fixture", () => {
    expect(closeEntry(`close:${CLOSE_REPLACED}`).code).toBe(CLOSE_REPLACED);
    expect(closeEntry(`close:${CLOSE_ROW_GONE}`).code).toBe(CLOSE_ROW_GONE);
    expect(closeEntry(`close:${CLOSE_PROTOCOL}`).code).toBe(CLOSE_PROTOCOL);
  });

  it("§6 · close-codes.json covers every code in the 4000–4004 vocabulary and the upgrade statuses, each with exactly one required client behavior", () => {
    // File-vs-emission is the snapshot case's job, for this family and the other eight —
    // re-comparing a subtree of the same two values here could not fail while that case
    // passes. What this case adds is COVERAGE: the key set, and one behavior per entry.
    const entries = closeEntries();
    expect(Object.keys(entries).sort()).toEqual(
      [
        `close:${CLOSE_REPLACED}`,
        `close:${CLOSE_REVOKED}`,
        `close:${CLOSE_ARCHIVED}`,
        `close:${CLOSE_ROW_GONE}`,
        `close:${CLOSE_PROTOCOL}`,
        `upgrade:401`,
        `upgrade:403`,
      ].sort(),
    );
    for (const [key, value] of Object.entries(entries)) {
      expect(typeof value.behavior, `${key} names no behavior`).toBe("string");
      expect(BEHAVIORS, `${key} names a behavior outside the vocabulary`).toContain(value.behavior);
    }
    // The 101 is not an entry: §6's matrix gives it no meaning, and the closed vocabulary
    // has no word for "proceed".
    expect(Object.keys(entries)).not.toContain("upgrade:101");
  });

  it("§6 · the fixture's behavior vocabulary is exactly three words — stop_fatal, stop_quiet, reconnect — and admits no fourth: the ONE spelling both client reconnect tables transcribe", () => {
    expect(fixture(CLOSE_CODES).behaviors).toEqual(["stop_fatal", "stop_quiet", "reconnect"]);
    const used = new Set(Object.values(closeEntries()).map((value) => value.behavior));
    assertTotalMapping("behaviors", [...used], [...BEHAVIORS], []);
  });

  it("§6 · every entry carries a `schedule` attribute — exponential or max_only — and only where it means something: a reconnect entry names its schedule, a stopping entry names none, so \"retry at max backoff\" is a schedule of reconnect and never a behavior of its own", () => {
    const schedules = fixture(CLOSE_CODES).schedules as string[];
    expect(schedules).toEqual(["exponential", "max_only"]);
    for (const [key, value] of Object.entries(closeEntries())) {
      if (value.behavior === "reconnect") {
        expect(schedules, `${key} reconnects on no schedule`).toContain(value.schedule);
      } else {
        expect(value.schedule, `${key} stops, and named a schedule anyway`).toBeUndefined();
      }
      // The two axes stay apart: a behavior is never a schedule word.
      expect(schedules).not.toContain(value.behavior);
    }
  });

  it("§6 · every stop_fatal entry (close 4001, upgrade 401) sits beside a keep-connecting twin (close 4002 reconnect at max_only, upgrade 403 the same, close 4000 stop_quiet) — no deny-only close-code table", () => {
    const entries = closeEntries();
    const fatal = Object.entries(entries)
      .filter(([, value]) => value.behavior === "stop_fatal")
      .map(([key]) => key)
      .sort();
    expect(fatal).toEqual([`close:${CLOSE_REVOKED}`, "upgrade:401"].sort());
    expect(entries[`close:${CLOSE_ARCHIVED}`]).toMatchObject({
      behavior: "reconnect",
      schedule: "max_only",
    });
    expect(entries["upgrade:403"]).toMatchObject({ behavior: "reconnect", schedule: "max_only" });
    expect(entries[`close:${CLOSE_REPLACED}`].behavior).toBe("stop_quiet");
  });

  it("§6 · tunnel-frames.json hub/register ack and hub/replaced notification deep-equal the frames the DO emits, and their method names are the values of the exported HUB_METHODS — the frames' agreement with a live socket is tunnel/protocol.test.ts's lock, not this file's", async () => {
    const live = (await emitted(TUNNEL_FRAMES)) as Record<string, Record<string, unknown>>;
    const pinned = fixture(TUNNEL_FRAMES) as Record<string, Record<string, unknown>>;
    expect(pinned.register).toEqual(live.register);
    expect(pinned.replaced).toEqual(live.replaced);
    expect(pinned.methods).toEqual({ ...HUB_METHODS });
    const published: string[] = Object.values(HUB_METHODS);
    expect(published).toContain((pinned.replaced as { method: string }).method);
    expect(published).toContain(
      ((pinned.register as { request: { method: string } }).request as { method: string }).method,
    );
    // §6's identity rule, as data: the register payload may never carry a service or slug.
    const params = (pinned.register as { request: { params: Record<string, unknown> } }).request
      .params;
    for (const forbidden of (pinned.register as { forbiddenParamsKeys: string[] })
      .forbiddenParamsKeys) {
      expect(Object.keys(params)).not.toContain(forbidden);
    }
  }, CASE_BUDGET_MS);

  it("§7 · tunnel-frames.json's forwarded-call _meta names are exactly hub/principal, hub/roles, and the mirrored clientCapabilities key — no other hub/* name exists", () => {
    const meta = (fixture(TUNNEL_FRAMES).forwardedCall as { metaKeys: string[] }).metaKeys;
    expect(meta).toEqual([
      "hub/principal",
      "hub/roles",
      "io.modelcontextprotocol/clientCapabilities",
    ]);
    expect(meta.filter((key) => key.startsWith("hub/"))).toHaveLength(2);
  });
});

/**
 * §20.3's role declaration where every copy of it meets: the `hub/register` frame both
 * client libraries emit, the validation §6 judges it by, and §8's canonical READ — the
 * shape `pmcp diff` plans against, which storage being normalized does not by itself
 * decide.
 */
describe("§4 · the roles wire — one language, three keyspaces", () => {
  it("§6/§20.3 · tunnel-frames' register frame accepts a bare pattern list and a per-family object in the same declaration", async () => {
    const declared = registerRoles(fixture(TUNNEL_FRAMES));
    // Both spellings ride ONE declaration (§20.3's own example): mixing them across roles
    // is legal, which is what makes "every service in the field keeps registering
    // unchanged" and "a role may span three keyspaces" the same sentence rather than two
    // wire revisions.
    expect(declared[FIXTURE_TOOLS_ONLY_ROLE]).toEqual(FIXTURE_ROLE_DECLARATION[FIXTURE_TOOLS_ONLY_ROLE]);
    expect(declared[FIXTURE_MULTI_FAMILY_ROLE]).toEqual(FIXTURE_ROLE_DECLARATION[FIXTURE_MULTI_FAMILY_ROLE]);
    // "Accepts" is the HUB's answer and not this file's: §8 gives a proxied service's role
    // definitions exactly the `hub/register` validation §6 pins, so the declaration a
    // socket would be judged by is judged here, without one. A violation throws.
    const stored = await roundTripRoles(declared);
    // The VALUE, not the key set. A hub that took the declaration and then dropped the
    // family dimension — flattening `curator` to its tools, or discarding the `prompts` and
    // `resources` keys it had never heard of — leaves exactly the same role NAMES behind and
    // would satisfy a key comparison while accepting nothing this row is about. §20.3 makes
    // the two spellings ONE declaration after normalization, so the prompt and resource
    // patterns have to survive storage to have been accepted at all. The fixture's
    // declaration is already canonical (the tools-only role spelled bare, the multi-family
    // one spelled as the object), so §8's read owes it back unchanged.
    expect(stored).toEqual(declared);
  }, CASE_BUDGET_MS);

  it("§6/§20.3 · the contract fixture pins both role spellings — a shape change in either library fails here first", async () => {
    const declared = registerRoles(fixture(TUNNEL_FRAMES));
    const values = Object.values(declared);
    // A bare list, still a list — the spelling every deployed service registers with, and
    // the one an older CLI typed `Record<string, string[]>` stays correct for.
    expect(values.filter((value) => Array.isArray(value))).not.toEqual([]);
    // …beside a per-family object keyed only by §20.3's families, each holding a pattern
    // list. Pinned by its KEYS rather than by either library's type, because the copies
    // stay copies (§4) — there is no shared declaration to rename.
    const objects = values.filter(
      (value) => !Array.isArray(value) && typeof value === "object" && value !== null,
    ) as Record<string, unknown>[];
    expect(objects).not.toEqual([]);
    for (const object of objects) {
      expect(Object.keys(object)).not.toEqual([]);
      for (const [family, patterns] of Object.entries(object)) {
        expect(ROLE_FAMILIES, `"${family}" is not one of §20.3's families`).toContain(family);
        expect(Array.isArray(patterns), `"${family}" holds no pattern list`).toBe(true);
      }
    }
    // …and the fixture is the EMISSION's, never a hand-edit: what a library copies and
    // what the hub accepts are one value, which is the whole mechanism (§4).
    expect(declared).toEqual(registerRoles((await emitted(TUNNEL_FRAMES)) as Record<string, unknown>));
    // WHERE THE LIBRARY HALF LIVES (recorded 2026-08-26, reconciliation): "a shape change in
    // either library fails here" cannot be asserted from workerd — both libraries are Node
    // packages (`ws`, `websockets`) and neither is importable in this project. So the half
    // that judges a library lives where the copies do: the fixture's own
    // `register.request.params.roles` is handed to HubTransport and deep-equalled against the
    // frame the fake hub observes, in clients/js/test/contracts-consumer.test.ts and
    // clients/py/tests/test_contracts.py. A library that flattened the per-family object to
    // its tools, or lifted the bare list into one, fails there against THIS value. What this
    // case owns is the value itself: the fixture really carries both spellings, keyed only by
    // §20.3's families, so there is one declaration for those two rows to be measured by.
  }, CASE_BUDGET_MS);

  it("§8/§20.3 · service_get renders a tools-only role as a bare list and a multi-family role as the per-family object — the canonical read shape, whichever spelling registered it", async () => {
    const rendered = await roundTripRoles({
      // Registered as a bare list…
      [FIXTURE_TOOLS_ONLY_ROLE]: [FIXTURE_TOOL],
      // …and the same MEANING registered as an object. Both render the bare list, which is
      // what makes the read a function of meaning rather than of history: always rendering
      // the object would diff every YAML file written before §20.3 landed, and rendering
      // whichever spelling registered would make `pmcp diff` stable or noisy by accident.
      [SPELLED_TOOLS_ONLY_ROLE]: { tools: ["publish"] },
      [FIXTURE_MULTI_FAMILY_ROLE]: FIXTURE_ROLE_DECLARATION[FIXTURE_MULTI_FAMILY_ROLE],
    });
    expect(rendered).toEqual({
      [FIXTURE_TOOLS_ONLY_ROLE]: [FIXTURE_TOOL],
      [SPELLED_TOOLS_ONLY_ROLE]: ["publish"],
      // Not tools-only, so the object survives — the other direction of the same rule,
      // without which "render the bare list" would be satisfied by flattening everything.
      [FIXTURE_MULTI_FAMILY_ROLE]: FIXTURE_ROLE_DECLARATION[FIXTURE_MULTI_FAMILY_ROLE],
    });
  }, CASE_BUDGET_MS);
});

/** The `roles` value a register frame carries — read the same way out of the fixture and
 *  out of a live capture, so the two cases above cannot compare different subtrees. */
function registerRoles(frames: Record<string, unknown>): Record<string, unknown> {
  return (frames.register as { request: { params: { roles: Record<string, unknown> } } }).request.params
    .roles;
}

/**
 * One proxied service created with `declaration` and read straight back — the roles wire's
 * two halves in one call, both through production seams.
 *
 * Acceptance is `service_create`'s: §8 gives a proxied service's role definitions "the same
 * validation as `hub/register`" (§6), so the declaration a socket would be judged by is
 * judged here without one — and a violating declaration throws rather than returning, which
 * is what lets the acceptance case assert acceptance by simply reading the row back. The
 * read is `service_get`'s, which §8 pins as the canonical form §20.3 defines.
 *
 * `declaration` is `unknown` on purpose: the per-family spelling is the thing under test,
 * and typing this parameter against the server's own RoleDeclaration would make the case
 * unwritable until that type widens — a compile error where the oracle wants a behavioral
 * one.
 */
async function roundTripRoles(declaration: unknown): Promise<Record<string, unknown>> {
  return inNamespace({}, async (ns) => {
    await ops.service_create.handler(ns.owner.userId, {
      slug: FIXTURE_PROXY,
      kind: "proxy",
      endpoint: upstreamUrlFor(healthyUpstream()),
      roles: declaration,
    });
    const read = (await ops.service_get.handler(ns.owner.userId, { slug: FIXTURE_PROXY })) as {
      service: { roles: Record<string, unknown> };
    };
    return read.service.roles;
  });
}

/**
 * §20.2's proxied `capabilities`, where its two readers meet. Until §8's 2026-08-27
 * amendment the key was create-only: registry stored it, the scoped handshake read it, and
 * no read tool reported it — so `pmcp diff` had nothing to compare a file against and the
 * planner excluded the field by construction. These two cases are that gap closed, from
 * both ends: the row carries the STORED value (absent when nothing was ever configured, so
 * the planner can tell "undeclared" from "declared as the default"), and one `service_update`
 * moves both readers at once.
 */
describe("§4 · the capabilities wire — one stored declaration, two readers", () => {
  it('§8/§20.2 · service_get returns a proxied service\'s stored capabilities list, and omits the field when none was ever configured — absent is absent, never ["tools"]', async () => {
    await inNamespace({}, async (ns) => {
      const create = (slug: string, capabilities?: string[]) =>
        ops.service_create.handler(ns.owner.userId, {
          slug,
          kind: "proxy",
          endpoint: upstreamUrlFor(healthyUpstream()),
          ...(capabilities === undefined ? {} : { capabilities }),
        });
      await create(FIXTURE_PROXY, FIXTURE_CAPABILITIES);
      await create(FIXTURE_UNDECLARED_PROXY);
      // Verbatim, in the owner's own order: the row is the stored declaration, not a
      // rendering of it, so a read that sorted or de-duplicated would be reporting its own
      // opinion of the config back to the owner who wrote it.
      expect((await serviceGetRow(ns, FIXTURE_PROXY)).capabilities).toEqual(FIXTURE_CAPABILITIES);
      // The twin, and the half that is easy to get wrong: §20.2's default is what the
      // HANDSHAKE answers for an undeclared service, never what the row claims was
      // configured. A row that helpfully filled in `["tools"]` would make the planner plan a
      // `service_update` against every file that omits the key — forever.
      const undeclared = await serviceGetRow(ns, FIXTURE_UNDECLARED_PROXY);
      expect(undeclared.capabilities).toBeUndefined();
      expect(Object.keys(undeclared)).not.toContain("capabilities");
    });
  }, CASE_BUDGET_MS);

  it("§8/§20.2 · service_update with capabilities changes what service_get returns and what the scoped handshake advertises — one stored value, two readers", async () => {
    // Read before the namespace is seeded: wireRevision seeds one of its own under the same
    // fixed username, and the two may not overlap.
    const revision = await wireRevision();
    await inNamespace(
      {
        services: [
          {
            slug: FIXTURE_PROXY,
            kind: "proxy",
            upstreamUrl: upstreamUrlFor(healthyUpstream()),
            upstreamAuthMode: "headers",
          },
        ],
      },
      async (ns) => {
        // The owner's own session: §7's scoped visibility gives an owner every service in
        // the namespace, so the handshake under test is not also a grant test.
        const session = await seedOwnerSession(ns.owner);
        const advertised = async (): Promise<string[]> => {
          const answer = await rpc(
            ns.owner.username,
            session.token,
            FIXTURE_PROXY,
            handshakeRequest(revision),
          );
          const body = answer.body as JsonRpcResponse;
          if (body.error !== undefined) {
            throw new Error(`the scoped handshake was refused: ${JSON.stringify(body.error)}`);
          }
          return Object.keys((body.result as { capabilities: Record<string, unknown> }).capabilities).sort();
        };
        // Undeclared: the row says nothing and the handshake says tools — the two answers
        // §20.2 gives for "the hub was never told", captured before the change so the change
        // is what the assertions below observe.
        expect((await serviceGetRow(ns, FIXTURE_PROXY)).capabilities).toBeUndefined();
        expect(await advertised()).toEqual(["tools"]);
        await ops.service_update.handler(ns.owner.userId, {
          slug: FIXTURE_PROXY,
          capabilities: FIXTURE_CAPABILITIES,
        });
        // ONE write, both readers. A hub that stored the update but kept answering the
        // handshake from a second copy — or a row that reported an update the handshake had
        // never seen — passes neither half, which is what makes this one case rather than two.
        expect((await serviceGetRow(ns, FIXTURE_PROXY)).capabilities).toEqual(FIXTURE_CAPABILITIES);
        expect(await advertised()).toEqual([...FIXTURE_CAPABILITIES].sort());
      },
    );
  }, CASE_BUDGET_MS);
});

/** One service as §8's read op reports it — the row both capabilities cases assert on, so
 *  neither reaches past `service_get` for a value the amendment is about. */
async function serviceGetRow(
  ns: SeededNamespace,
  slug: string,
): Promise<Record<string, unknown>> {
  const read = (await ops.service_get.handler(ns.owner.userId, { slug })) as {
    service: Record<string, unknown>;
  };
  return read.service;
}

/** One close-code entry as the fixture carries it. */
type CloseEntry = { kind: string; code: number; behavior: string; schedule?: string };

function closeEntries(): Record<string, CloseEntry> {
  return fixture(CLOSE_CODES).entries as Record<string, CloseEntry>;
}

function closeEntry(key: string): CloseEntry {
  const found = closeEntries()[key];
  if (found === undefined) throw new Error(`close-codes.json defines no "${key}"`);
  return found;
}

/** §6's three behavior words, spelled once for the cases that check the vocabulary is
 *  closed. */
const BEHAVIORS = ["stop_fatal", "stop_quiet", "reconnect"] as const;

/**
 * The SeverCode union as a runtime value — exhaustive by construction: `satisfies` refuses
 * a missing member, and the excess-property check refuses a fourth. A third code entering
 * the union is therefore a compile error here rather than a fixture that quietly lags.
 */
const SEVER_CODES = {
  [CLOSE_REVOKED]: true,
  [CLOSE_ARCHIVED]: true,
} as const satisfies Record<SeverCode, true>;

describe("§4 · bootstrap", () => {
  it("§12 · bootstrap.json request rows deep-equal scripts' BootstrapRequest for all four ops", () => {
    // The script's copy, as VALUES: the annotation is the compile-time half of the pin and
    // the deep-equal below is the runtime half.
    const copies: BootstrapRequest[] = [
      { op: "create", username: FIXTURE_USER },
      { op: "list" },
      { op: "delete", username: FIXTURE_USER },
      { op: "reset-password", username: FIXTURE_USER },
    ];
    const pinned = fixture(BOOTSTRAP) as Record<string, { request?: unknown }>;
    assertTotalMapping(
      "bootstrap ops",
      copies.map((copy) => copy.op),
      Object.keys(pinned).filter((key) => pinned[key].request !== undefined),
      [],
    );
    for (const copy of copies) expect(pinned[copy.op].request).toEqual(copy);
  });

  it("§12 · bootstrap.json response rows deep-equal the live route's bodies, with `password` present on create and reset-password and absent from list and delete — allow", async () => {
    const live = (await emitted(BOOTSTRAP)) as Record<string, { response?: unknown }>;
    const pinned = fixture(BOOTSTRAP) as Record<string, { response?: BootstrapResponse }>;
    for (const op of ["create", "list", "delete", "reset-password"]) {
      expect(pinned[op].response, `the ${op} response drifted`).toEqual(live[op].response);
    }
    const carries = (op: string) => Object.keys(pinned[op].response as object).includes("password");
    expect([carries("create"), carries("reset-password")]).toEqual([true, true]);
    expect([carries("list"), carries("delete")]).toEqual([false, false]);
  }, CASE_BUDGET_MS);

  it("§12 · bootstrap.json's disabled row pins the 404 the route returns while BOOTSTRAP_SECRET is unset, beside its wrong-secret 401 twin — refusal, twinned with the row above", () => {
    const pinned = fixture(BOOTSTRAP) as Record<string, { status?: number }>;
    // 404 says "the route does not exist"; 401 says "the secret is wrong". The split is
    // the whole signal scripts/users.ts reads (§12), so it is two rows, never one.
    expect(pinned.disabled).toEqual({ status: 404 });
    expect(pinned.wrongSecret).toEqual({ status: 401 });
  });
});

describe("§4 · admin op names and schemas", () => {
  it("§8 · admin-ops.json op-name set equals Object.keys(ops), total in both directions — a new op that forgets its fixture fails here", () => {
    assertTotalMapping("ops ↔ admin-ops.json", Object.keys(ops), fixture(ADMIN_OPS).names as string[], []);
  });

  it("§8 · admin-ops.json input schemas deep-equal what adminBackend renders per op — one zod schema, one rendering, so the tool and the web form cannot drift", async () => {
    const served = await servedOps();
    const pinned = fixture(ADMIN_OPS).inputSchemas as Record<string, unknown>;
    for (const tool of served) {
      expect(pinned[tool.name], `${tool.name}'s rendered inputSchema drifted`).toEqual(
        tool.inputSchema,
      );
    }
    expect(Object.keys(pinned).sort()).toEqual(served.map((tool) => tool.name).sort());
  }, CASE_BUDGET_MS);

  it("§15 · admin-ops.json records token_issue's outputSchema with its key field writeOnly, and no other op declares one — the uniform-body rule's whole footprint", () => {
    const outputs = fixture(ADMIN_OPS).outputSchemas as Record<string, Record<string, unknown>>;
    expect(Object.keys(outputs)).toEqual(["token_issue"]);
    const properties = outputs.token_issue.properties as Record<string, Record<string, unknown>>;
    expect(properties.token.writeOnly).toBe(true);
    // The mark is on the key alone: the row id and the display prefix are recorded verbatim
    // (§5), which is what makes the uniform rule need no pmcp special case.
    expect(properties.id.writeOnly).toBeUndefined();
    expect(properties.prefix.writeOnly).toBeUndefined();
  });
});

describe("§4 · planner-facing rows", () => {
  it("§8 · service-list.json row keys equal a live service_list row's, for tunnel, proxy, and the builtin pmcp entry (builtin: true, no D1 row behind it)", async () => {
    const live = (await emitted(SERVICE_LIST)) as Record<string, Record<string, unknown>>;
    const pinned = fixture(SERVICE_LIST) as Record<string, Record<string, unknown>>;
    for (const kind of ["tunnel", "proxy", "builtin"]) {
      expect(Object.keys(pinned[kind]).sort(), `the ${kind} row's keys drifted`).toEqual(
        Object.keys(live[kind]).sort(),
      );
    }
    // The builtin is the one row with no D1 row behind it, and it says so.
    expect(pinned.builtin.builtin).toBe(true);
    expect(pinned.builtin.slug).toBe(PMCP_SLUG);
    expect(pinned.tunnel.builtin).toBeUndefined();
  }, CASE_BUDGET_MS);

  it("§8 · account-list.json rows carry grants inline, so the planner's entire current-state read is these two families and nothing else", () => {
    // File-vs-emission belongs to the snapshot case; what this one adds is the SHAPE of
    // the grants cell — §9's own grant syntax, so what account_list reads back is what
    // grant_set takes.
    const pinned = (fixture(ACCOUNT_LIST) as { account: Record<string, unknown> }).account;
    expect(pinned.grants).toEqual({ [FIXTURE_TUNNEL]: ["reader", "writer:approval"] });
  });

  it("§9 · plan.CurrentService's keys equal service-list.json's minus exactly the runtime facts (status, oauth connection state, last seen) — a plan can never turn on status, and the two rows sit side by side so the omission is visible", () => {
    const pinned = fixture(SERVICE_LIST) as Record<string, Record<string, unknown>>;
    const served = new Set(
      ["tunnel", "proxy", "builtin"].flatMap((kind) => Object.keys(pinned[kind])),
    );
    const planned = Object.keys(CURRENT_SERVICE_KEYS);
    assertTotalMapping("CurrentService ↔ service_list", planned, [...served], RUNTIME_FACTS);
    // …and the omissions are those facts and nothing else: each is present on the served
    // side and absent from the planner's.
    for (const fact of RUNTIME_FACTS) {
      expect(served.has(fact), `service_list serves no "${fact}"`).toBe(true);
      expect(planned, `a plan can turn on "${fact}"`).not.toContain(fact);
    }
  });
});

/**
 * The runtime facts a plan may never carry. Three are the ones §9 names — a tunnel's
 * `status`, an oauth service's `connection`, and `lastSeen`. `createdAt` is the fourth and
 * belongs with them for the same reason: it is a fact about the row's LIFE, produced by the
 * server, and a plan that could set it would be planning history.
 */
const RUNTIME_FACTS = ["status", "connection", "lastSeen", "createdAt"];

/**
 * plan.CurrentService's keys as a runtime value. Exhaustive by the type system — a field
 * added to the planner's projection without a key here is a compile error — which is what
 * makes the comparison above a real total mapping rather than a transcription.
 */
const CURRENT_SERVICE_KEYS = {
  slug: true,
  kind: true,
  name: true,
  description: true,
  archived: true,
  builtin: true,
  roles: true,
  redact: true,
  redactResults: true,
  logBodies: true,
  endpoint: true,
  auth: true,
  forwardIdentity: true,
  capabilities: true,
} as const satisfies Record<keyof Required<CurrentService>, true>;

describe("§4 · audit body stubs — the spelling §15 defers to this directory", () => {
  it("§15 · audit-body-stubs.json's `blob` row deep-equals the stub a real tools/call records for an unstructured result block: the discriminator, the content type, and `bytes` present as a number — §15 names the stub but not its keys, so this row IS the naming", async () => {
    const pinned = stubRow("blob");
    expect((await emitted(AUDIT_STUBS)).blob).toEqual(pinned);
    expect(pinned.stub).toBe("blob");
    expect(pinned.contentType).toBe(STUB_MEDIA_TYPE);
    expect(pinned.bytes).toBe(TYPE_TOKEN.number);
  }, CASE_BUDGET_MS);

  it("§15 · audit-body-stubs.json's `oversize` row deep-equals the stub that replaces a whole over-cap body, driven against a shrunk AUDIT_BODY_CAP_BYTES rather than a megabyte fixture, and carrying no fragment of the body it replaced — refusal, twinned with the row below", async () => {
    const pinned = stubRow("oversize");
    expect((await emitted(AUDIT_STUBS)).oversize).toEqual(pinned);
    // The whole body is REPLACED, never truncated: the stub carries a discriminator and a
    // size, and no key that could hold a fragment of what it stood in for.
    expect(Object.keys(pinned).sort()).toEqual(["bytes", "stub"]);
    expect(pinned.stub).toBe("oversize");
  }, CASE_BUDGET_MS);

  it("§15 · an under-cap structured body records intact, so the two stub rows are pinned beside the shape that must NOT be stubbed — the allow-twin without which \"stub everything\" satisfies this family", async () => {
    const recorded = await underCapRecording();
    expect(recorded.args, "an under-cap body was stubbed").toEqual({ q: "under the cap" });
    expect((recorded.result as { structuredContent: unknown }).structuredContent).toEqual({
      ok: true,
    });
  }, CASE_BUDGET_MS);

  it("§15 · the fixture's stub kinds are exactly the two the spec allows, total in both directions against audit.ts's BodyStub union — a third stub cannot enter the recorder without entering the fixture", () => {
    assertTotalMapping(
      "BodyStub kinds ↔ audit-body-stubs.json",
      Object.keys(STUB_KINDS),
      Object.keys(fixture(AUDIT_STUBS)),
      [],
    );
  });

  it("§15 · `bytes` is pinned as a KEY with a number type and never as a value, per this directory's nothing-that-varies-per-run rule — the fixture stays stable while the cap and the fixture bodies move", () => {
    for (const kind of Object.keys(STUB_KINDS)) {
      const row = stubRow(kind);
      expect(Object.keys(row), `${kind} pins no bytes key`).toContain("bytes");
      expect(row.bytes, `${kind} pinned a byte COUNT`).toBe(TYPE_TOKEN.number);
    }
  });

  it("§15 · CONSUMER NOTE — hygiene.test.ts transcribes this fixture into BodyColumnShape's `stubbed` and `oversize` members (its rows spell stubs as `Omit<BodyStub, \"bytes\">`), and it is the family's only reader today. A disagreement between that type and this fixture is the drift this row exists to catch; hygiene.test.ts asserts BEHAVIOR against the shape, this file asserts the shape itself, and neither may respell the other's half.", () => {
    // The consumer's spelling as a VALUE: `Omit<BodyStub, "bytes">` is exactly a stub row
    // with its varying count removed, so a rename in either half breaks compilation here.
    const transcribed: Omit<BodyStub, "bytes"> = { stub: "blob", contentType: STUB_MEDIA_TYPE };
    const { bytes, ...shape } = stubRow("blob");
    expect(shape).toEqual(transcribed);
    expect(bytes).toBe(TYPE_TOKEN.number);
  });
});

/** One stub row of the fixture. */
function stubRow(kind: string): Record<string, unknown> & { bytes?: unknown } {
  const row = (fixture(AUDIT_STUBS) as Record<string, Record<string, unknown>>)[kind];
  if (row === undefined) throw new Error(`audit-body-stubs.json defines no "${kind}" row`);
  return row;
}

/**
 * audit.ts's stub vocabulary as a runtime value — exhaustive by the type system, so a third
 * member of the union cannot enter the recorder without entering this object and, through
 * the totality case above, the fixture.
 */
const STUB_KINDS = { blob: true, oversize: true } as const satisfies Record<BodyStub["stub"], true>;

/** The under-cap recording the stub rows are pinned beside — captured once, like the
 *  emissions, because it seeds the same credentialled upstream they do. */
let underCap: Promise<AuditRow> | undefined;

function underCapRecording(): Promise<AuditRow> {
  return (underCap ??= captureUnderCap());
}

async function captureUnderCap(): Promise<AuditRow> {
  return inNamespace(
    {
      services: [
        {
          slug: FIXTURE_PROXY,
          kind: "proxy",
          logBodies: true,
          upstreamUrl: upstreamUrlFor(healthyUpstream({ structuredContent: { ok: true } })),
          upstreamAuthMode: "headers",
        },
      ],
      accounts: [
        {
          slug: FIXTURE_ACCOUNT,
          grants: { [FIXTURE_PROXY]: [{ role: "all", mode: "allow" }] },
          tokens: [{ as: "key" }],
        },
      ],
    },
    async (ns) => {
      const proxied = await new Registry(env.DB).getService(ns.owner.userId, FIXTURE_PROXY);
      await setHeaders(proxied as Service, { Authorization: "Bearer FAKE0000-upstream" });
      await rpc(
        ns.owner.username,
        ns.tokens.key.token,
        FIXTURE_PROXY,
        callMessage(FIXTURE_TOOL, { q: "under the cap" }),
      );
      return lastRow(ns);
    },
  );
}

/**
 * UNBLOCKED 2026-08-26 — the note this replaces recorded both directions as waiting on a
 * skeleton, and the refusals it recorded still hold: nothing below transcribes a mapping
 * into this file. Direction C runs the REAL planner over one file-and-server pair chosen
 * to exercise its whole vocabulary, and reads the steps it actually emitted; direction D
 * reads `cli/src/commands.ts`'s table, which is the value main.ts dispatches through.
 *
 * That table lives beside main.ts rather than in it so this suite reads DATA and not the
 * CLI: main.ts reads `~/.config/pmcp/config.json` through node:fs, which inside workerd is
 * a compatibility shim nothing here should depend on. `plan.ts` is pure and imports cleanly.
 *
 * The asymmetry that leaves — direction C runs the real planner while direction D reads a
 * table nothing ties to the dispatcher — is closed in the `cli` project, not here:
 * `cli/test/commands.test.ts` drives `main(argv)` per row against a recording `fetch` and
 * asserts the ops actually reached for equal the row's. Both halves are needed; this one
 * says the row names ops the hub serves, that one says the row is true of the CLI.
 */

/**
 * One file-and-server pair that provokes every step kind the planner has: a server-only
 * service and account (deletes), a file-only pair (creates), a changed field (update), and
 * both archive transitions — plus a grant. Written as the YAML shape rather than as
 * PlanStep literals on purpose: a literal here would be this file transcribing the
 * planner's output, which is exactly the drift direction C exists to catch.
 *
 * Both KINDS are here, and that is load-bearing rather than thorough: `endpoint`, `auth`,
 * `forward_identity` and `roles` are emitted only for a proxied service, so a tunnel-only
 * fixture would leave half of service_create's and service_update's argument surface
 * unmeasured against the real op schema — and `grant_set`'s `:approval` re-joining likewise
 * needs one grant that carries the suffix.
 */
function plannerSteps(): PlanStep[] {
  const desired = parseDesired({
    services: {
      fresh: {},
      keep: { name: "Renamed" },
      parked: { archived: true },
      revived: {},
      // Created: the proxy half of service_create's arguments.
      notion: {
        kind: "proxy",
        endpoint: "https://mcp.notion.com/mcp",
        auth: "oauth",
        forward_identity: true,
        roles: { writer: ["create_.*"] },
      },
      // Updated: the same fields on the other op, reached by moving the endpoint.
      linear: { kind: "proxy", endpoint: "https://mcp.linear.app/mcp", roles: { writer: ["create_.*"] } },
    },
    service_accounts: { agent: { grants: { keep: ["reader"], notion: ["writer:approval"] } } },
  });
  const server = (slug: string, over: Partial<CurrentService> = {}): CurrentService => ({
    slug,
    kind: "tunnel",
    name: slug,
    description: "",
    archived: false,
    builtin: false,
    roles: { reader: [".*"] },
    redact: {},
    redactResults: {},
    logBodies: true,
    ...over,
  });
  return planChanges(desired, {
    services: [
      server("gone"),
      server("keep"),
      server("parked"),
      server("revived", { archived: true }),
      server("linear", {
        kind: "proxy",
        endpoint: "https://old.linear.app/mcp",
        auth: "headers",
        forwardIdentity: false,
        logBodies: false,
        roles: { writer: ["create_.*"] },
      }),
    ],
    accounts: [{ slug: "stale", name: "stale", description: "", grants: {} }],
  }).steps;
}

describe("§4 direction C · planner steps → ops", () => {
  it("§4 · every PlanStep.tool the planner can emit is a key of ops", () => {
    const emitted = [...new Set(plannerSteps().map((step) => step.tool))].sort();
    // The fixture provokes all eight, so this is a real cover and not a vacuous subset
    // check — and every one of them must be a tool the hub actually serves.
    expect(emitted).toEqual([
      "account_create",
      "account_delete",
      "grant_set",
      "service_archive",
      "service_create",
      "service_delete",
      "service_unarchive",
      "service_update",
    ]);
    for (const tool of emitted) expect(Object.keys(ops), `${tool} is not an op`).toContain(tool);
  });

  it("§4 · every emitted step's args cover its op schema's required fields", async () => {
    const schemas = Object.fromEntries((await servedOps()).map((tool) => [tool.name, tool.inputSchema]));
    for (const step of plannerSteps()) {
      const schema = schemas[step.tool] as { required?: string[]; properties?: Record<string, unknown> };
      for (const field of schema.required ?? []) {
        expect(Object.keys(step.args), `${step.tool} omits the required ${field}`).toContain(field);
      }
      // The other half of "ready to forward verbatim": these schemas reject
      // additionalProperties, so an argument the op does not declare is a refused call.
      for (const key of Object.keys(step.args)) {
        expect(Object.keys(schema.properties ?? {}), `${step.tool} sends an undeclared ${key}`).toContain(key);
      }
    }
  }, CASE_BUDGET_MS);
});

describe("§9 · the planner's copy of the role-declaration rules", () => {
  it("§6/§9 · the caps cli/src/plan.ts validates a proxy `roles:` block against are limits.ts's, by name — the planner's early refusal exists so `pmcp apply` never dies mid-plan, and a copy that drifted low would call a file valid that the hub then rejects AFTER the destructive delete phase has run", async () => {
    // plan.ts deliberately re-implements registry.validateRoles rather than importing it
    // (§9: the planner never depends on the server, which is why the fixtures exist at
    // all). A second implementation is only safe with a lock, and this case is it — the
    // same by-name reading server/test/unit/pattern.test.ts does on the server's side.
    expect(PLANNER_ROLE_NAME_MAX_LENGTH).toBe(ROLE_NAME_MAX_LENGTH);
    expect(PLANNER_ROLE_PATTERN_MAX_LENGTH).toBe(ROLE_PATTERN_MAX_LENGTH);
    expect(PLANNER_ROLE_PATTERNS_MAX).toBe(ROLE_PATTERNS_MAX);
    // The family VOCABULARY is a rule of exactly the same kind and needs the same lock:
    // add a family to registry.ROLE_FAMILIES without this line and the whole suite stays
    // green while `pmcp diff` hard-errors on a legal file with `"x" is not a role family`.
    // Both copies answer to the fixture's own declaration, never to each other.
    expect([...SERVER_ROLE_FAMILIES]).toEqual(ROLE_FAMILIES);
    expect([...PLANNER_ROLE_FAMILIES]).toEqual(ROLE_FAMILIES);
    // …and the copy still refuses what the server would: a declaration one pattern over
    // the shared cap is a hard error in the plan, not a call the hub gets to reject.
    const overCap = planChanges(
      parseDesired({
        services: {
          notion: {
            kind: "proxy",
            endpoint: "https://mcp.notion.com/mcp",
            roles: { writer: Array.from({ length: ROLE_PATTERNS_MAX + 1 }, (_, index) => `t_${index}`) },
          },
        },
      }),
      { services: [], accounts: [] },
    );
    expect(overCap.errors.length).toBeGreaterThan(0);

    // §20.3's canonical READ beside the planner's canonical COMPARE — the second copied
    // rule in this pair, and the one whose drift is silent rather than loud: a planner that
    // canonicalizes differently from the hub's read plans `service_update` on every run, so
    // `pmcp diff` never comes back clean and `pmcp apply` never converges. The table is the
    // declarations whose spelling and canonical form differ, empty families included —
    // `docs: {tools: [publish], prompts: []}` and the bare `docs: {}` placeholder are files
    // an owner plausibly writes, and neither is covered by the two spellings alone.
    const declared: RoleDeclaration = {
      bare: ["publish"],
      spelled: { tools: ["publish"] },
      trailing: { tools: ["publish"], prompts: [] },
      placeholder: {},
      hollow: { tools: [], prompts: [] },
      spanning: { tools: ["publish"], prompts: ["digest_.*"], resources: [] },
    };
    // The hub's half of the table: what §8's read renders each declaration back as. An
    // empty family is a family not declared, in every row — which is why the first five
    // collapse and only the genuinely multi-family one keeps the object.
    const rendered = (await roundTripRoles(declared)) as RoleDeclaration;
    expect(rendered).toEqual({
      bare: ["publish"],
      spelled: ["publish"],
      trailing: ["publish"],
      placeholder: [],
      hollow: [],
      spanning: { tools: ["publish"], prompts: ["digest_.*"], resources: [] },
    });
    // …and the planner's half: the file that WROTE those declarations, diffed against the
    // hub's rendering of them, plans nothing at all.
    const endpoint = "https://mcp.notion.com/mcp";
    const current: CurrentService = {
      slug: FIXTURE_PROXY,
      kind: "proxy",
      name: FIXTURE_PROXY,
      description: "",
      archived: false,
      builtin: false,
      roles: rendered,
      redact: {},
      redactResults: {},
      logBodies: false,
      endpoint,
      auth: "headers",
      forwardIdentity: false,
    };
    const settled = planChanges(
      parseDesired({ services: { [FIXTURE_PROXY]: { kind: "proxy", endpoint, roles: declared } } }),
      { services: [current], accounts: [] },
    );
    expect(settled.errors).toEqual([]);
    expect(settled.steps).toEqual([]);
  }, CASE_BUDGET_MS);
});

/**
 * The MCP methods a CLI command may front INSTEAD of an admin op — §7's tool surface plus
 * §20.6's four data-model commands. Gateway sugar, not a capability of its own: any agent
 * holding the same token calls these directly, which is why §8's parity list is untouched
 * by them and why they are not exceptions to it.
 *
 * Spelled here because gateway.ts's dispatch table is a `switch` and not a value — and that
 * is a GAP, not a lock (finding, recorded 2026-08-26 rather than worked around). A literal
 * in this file cannot fail when the hub stops routing one of these names, so a CLI row
 * fronting a method §20.1 puts out of scope (`logging/setLevel`) ships green on one added
 * line here. What the two cases below really assert is the CLASSIFICATION — an op, a
 * gateway method, or a pinned exception — and the routing half is witnessed one file over,
 * by order.table.test.ts's per-method rows. Closing the gap is FINDINGS 2's own precedent
 * applied once more: gateway.ts publishing its consumer-facing method vocabulary as a value,
 * this list becoming an assertTotalMapping against it with `completion/complete` — §20.6's
 * one deliberately unfronted method — as the named exception. That export is
 * `server/src/gateway.ts`'s to make, not this file's.
 */
const GATEWAY_METHODS = [
  "tools/list",
  "tools/call",
  "prompts/list",
  "prompts/get",
  "resources/list",
  "resources/templates/list",
  "resources/read",
];

describe("§4 direction D · CLI subcommands → ops", () => {
  it("§4 · every non-auth CLI subcommand maps to an ops key", () => {
    for (const command of COMMANDS) {
      if (command.exception === "auth") continue;
      // Either it fronts admin ops, or it fronts a gateway method that IS the consumer
      // surface (`pmcp tools` / `pmcp call`, and §20.6's four) — nothing else is a legal row.
      if (command.ops.length === 0) {
        expect(command.method, `${command.name} fronts neither an op nor an MCP method`).toBeDefined();
        expect(GATEWAY_METHODS, command.name).toContain(command.method);
        continue;
      }
      for (const op of command.ops) expect(Object.keys(ops), `${command.name} → ${op}`).toContain(op);
    }
  });

  it("§4 · every ops key is reachable from some CLI subcommand — the reverse direction, so an op nobody can run fails here", () => {
    const reachable = [...new Set(COMMANDS.flatMap((command) => command.ops))];
    assertTotalMapping("CLI subcommands ↔ ops", reachable, Object.keys(ops), []);
  });

  it("§8 · the pinned parity exceptions (auth/credential family, the OAuth consent redirect, the JSONL export) are the ONLY unmapped names, listed explicitly rather than skipped", () => {
    // "Unmapped" means fronting no op AND no gateway method — a name with nothing behind
    // it on the hub. §8 pins three exceptions and the auth family is the only one of them
    // that is a CLI command in its own right; the other two ride commands that DO front an
    // op (`connect` → service_get, `audit --export jsonl` → audit_query) and are flagged
    // there, so the exception is visible without the name going missing from the mapping.
    const unmapped = COMMANDS.filter((command) => command.ops.length === 0 && command.method === undefined);
    expect(unmapped.map((command) => command.name).sort()).toEqual(["login", "logout", "whoami"]);
    expect(new Set(unmapped.map((command) => command.exception))).toEqual(new Set(["auth"]));
    // All three pinned exceptions are named in the table, so none can be silently dropped.
    expect(new Set(COMMANDS.flatMap((command) => (command.exception === undefined ? [] : [command.exception])))).toEqual(
      new Set(["auth", "oauth-consent", "jsonl-export"]),
    );
  });

  it('§8 parity D · every CLI command fronts an admin op or a pinned exception — "connections" and "connection revoke" front connection_list/connection_revoke', () => {
    // §19/§8: the OAuth connections page has a CLI front too — unlike the consent SCREEN it
    // manages (the next case), these two rows are grants-shaped and front a real op each,
    // no exception needed.
    const connections = COMMANDS.find((command) => command.name === "connections");
    const revoke = COMMANDS.find((command) => command.name === "connection revoke");
    expect(connections?.ops).toEqual(["connection_list"]);
    expect(revoke?.ops).toEqual(["connection_revoke"]);
    expect(Object.keys(ops)).toEqual(expect.arrayContaining(["connection_list", "connection_revoke"]));
  });

  it("§8 parity D · pmcp prompts/prompt/resources/read front MCP methods, not admin ops — the parity table classifies them like tools/call", () => {
    // §20.6: all four are gateway sugar of the kind `tools`/`call` already are. That
    // classification is the whole claim — an admin op for them would put a second,
    // hub-side front on a method the caller's own token already reaches, and an EXCEPTION
    // for them would say the CLI can do something no agent can, which is the sentence §8's
    // parity invariant exists to keep false.
    const fronted = {
      prompts: "prompts/list",
      prompt: "prompts/get",
      resources: "resources/list",
      read: "resources/read",
    };
    for (const [name, method] of Object.entries(fronted)) {
      const command = COMMANDS.find((entry) => entry.name === name);
      expect(command, `the CLI table has no "${name}" row`).toBeDefined();
      expect(command?.ops, `"${name}" fronts an admin op`).toEqual([]);
      expect(command?.method, `"${name}" fronts the wrong method`).toBe(method);
      expect(command?.exception, `"${name}" was made a parity exception`).toBeUndefined();
      expect(GATEWAY_METHODS, method).toContain(method);
    }
    // …and no op appeared to front them: the four are reachable through the gateway alone.
    for (const method of Object.values(fronted)) {
      expect(Object.keys(ops), `${method} grew an admin op`).not.toContain(method.replace("/", "_"));
    }
  });

  it("§8 parity · /oauth/consent is a pinned parity exception and has no admin op", () => {
    // §19.5/§8 (amended 2026-08-26): the inbound consent screen mints authority through a
    // browser-only interaction and is folded into §8's exception list for the same reason
    // as the pre-existing upstream-OAuth consent redirect — no admin op fronts it, named or
    // otherwise, and no CLI command names it either. connection_list/connection_revoke (the
    // case above) cover everything the /oauth/connections page around it can do; the consent
    // screen itself is the part with no tool.
    expect(Object.keys(ops)).not.toContain("oauth_consent");
    expect(COMMANDS.some((command) => command.name.includes("consent"))).toBe(false);
  });
});

describe("§9 · fixture governance", () => {
  it("§9 · every contracts/*.json on disk is claimed by exactly one CONTRACT_FAMILIES row — an orphan fixture nobody produces fails here", () => {
    const claimed = CONTRACT_FAMILIES.map((family) => family.file);
    assertTotalMapping("contracts/*.json ↔ CONTRACT_FAMILIES", fixtureFiles(), claimed, []);
    // Exactly one: two rows claiming one file would pass the mapping above and leave the
    // second row's emission unwritten.
    expect(new Set(claimed).size).toBe(claimed.length);
    // …and every claimed file has an emission wired, so no row is a name with nothing
    // behind it.
    assertTotalMapping("CONTRACT_FAMILIES ↔ emissions", claimed, Object.keys(EMISSIONS), []);
  });

  it("§9 · no fixture contains a sentinel secret, a pmcp_ token prefix, or a value that varies between two runs of this suite", async () => {
    const credential = tokenPattern(1, "g");
    for (const file of fixtureFiles()) {
      const bytes = JSON.stringify(fixture(file));
      expect(bytes.match(credential), `${file} carries credential material`).toBeNull();
      for (const secret of ["password", "FAKE0000"]) {
        // The KEY `password` is a shape and may appear; a VALUE beside it may not.
        expect(bytes.includes(`"${secret}"`) && !bytes.includes(`"${secret}":`)).toBe(false);
      }
    }
    // "Varies between two runs" is only answerable by running it twice: every family is
    // captured a SECOND time, independently of the memoized capture the cases above share,
    // and the two must be identical.
    for (const family of CONTRACT_FAMILIES) {
      const second = await EMISSIONS[family.file]();
      expect(second, `${family.file} is not stable across two captures`).toEqual(
        await emitted(family.file),
      );
    }
  }, CASE_BUDGET_MS);
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
