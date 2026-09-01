## 11. Decisions and findings from authoring this strategy

Resolved:
- **Catalog-miss refusal → `-32001`** (decided 2026-08-25): an unknown tool inside
  an approval-mode pattern must be indistinguishable from an ungranted one; spec
  §7 and both skeleton comments updated.
- The router-walk test §2 mandates is now a named suite (`routes.test.ts`).

Resolved 2026-08-25 — **availability-first**: the approval gate consults known
availability before touching any approval row — an app the hub already knows
cannot execute (tunnel offline; proxied `not_connected`/`needs_reconnect`) fails
`-32000` with no pending row, no push, and no pass consumed. Spec §7 + gateway/
approvals skeleton comments updated; the order-table and approval-e2e rows encode
(no pass × known-offline) → `-32000`.

Resolved 2026-08-25 — **N1 applied**: registry exports the pure pair
`writeOnlyPaths(schema)` / `applyRedaction(args, paths)`; tunnel, approvals, and
the gateway's audit-body path (the principal consumer since the body decision)
consume them, so the path grammar has one definition and `unit/redact.test.ts`
is unconditional. **N2 applied**: `backoffDelay(attempt, rng)` (JS) and
`backoff_delay(attempt, rng)` (Python) exported pure, first delay jittered from
zero (the deploy-storm mitigation, now table-testable).

Resolved 2026-08-25 — **constants module applied**: `server/src/limits.ts` owns
the six timing constants; the fan-out deadline and the call budget are TWO knobs
(a slow upstream may take 30 s when called directly but must not hold the
aggregated listing hostage past 10 s). `ApprovalsConfig.now()` re-added with it.
**Attachment versioning applied**: `ConnectionAttachment {v: 1, …}` in tunnel.ts;
a wake reading an unknown or absent version closes 4004 → routine reconnect.

Resolved 2026-08-25 — **`UPSTREAM_CREDS_KEY`** wins the secret-name drift
(`index.ts` updated). **Cron legs under `allSettled`** as a stubbable named
list, per-leg outcome folded into the `cron.swept` row (skeleton updated).
**Fixture governance**: regenerating `contracts/*.json` is owner-run and always
its own commit; CI rejects commits touching `contracts/**` together with
implementation files (§9 rule 1). **`pageRoutes`-as-data**: considered and
rejected — exporting routes solely for a test violates the suite's own
no-test-only-exports rule; Direction B plus review is the guard. **E1
acknowledged**: the constant-time BOOTSTRAP_SECRET compare stays
reviewed-not-tested (timing is not behaviorally observable in-process).

Resolved 2026-08-25 — **audit bodies, uniform rule** (spec §5/§7/§15, decision
22): the pmcp-body special case is GONE — `token_issue`'s key is a
`writeOnly`-marked output field masked like any other secret. Sensitivity is
declared in both directions: the client libraries' `Secret` field type /
`secret()` wrapper emits `writeOnly` in input and output schemas (the hub strips
it from served outputSchemas — internal marker only), and config gains
`redact_results` beside `redact`. Audit `tools/call` rows carry bodies per the
per-app `log_bodies` flag (tunneled default on, proxied default off — no
trustworthy proxied schema, so the owner opts in with config paths): args and
result structuredContent post-redaction; unstructured blocks and over-cap bodies
become typed size stubs (`AUDIT_BODY_CAP_BYTES`, default 16 KiB). Retention
drops to **7 days** default; both knobs are env vars parsed once at the
composition root (`AUDIT_RETENTION_DAYS`, `AUDIT_BODY_CAP_BYTES`), with
limits.ts holding the defaults. `hygiene.test.ts` owns the body table;
`unit/redact.test.ts` walks both directions. (Also fixed while pinning: §5's
`app` table had never materialized the config `redact` column — it now has
`redact_json`, `redact_results_json`, and `log_bodies`.)

Resolved 2026-08-25 — **the skeleton-authoring escalations**, decided as a batch:
- **Injected clock in identity** (`resolvePrincipal` / `resolveAppToken` /
  `issueToken` take optional `now()`): the expired-token refusal is seeded by
  issuing at a fake t0 and resolving past expiry — no sleeping, no test-only
  mint-dead-token affordance; same rationale as `ApprovalsConfig.now()`.
- **Tunnel wire vocabulary exported** (`CLOSE_REPLACED`/`CLOSE_ROW_GONE`/
  `CLOSE_PROTOCOL`/`HUB_METHODS` beside the existing SeverCode pair): the
  published cross-language contract, not hidden mechanics — the contracts
  producer emits fixtures from it, and `tunnel/protocol.test.ts` asserts observed
  wire values equal the exports, locking behavior to the table. No sibling
  imports them.
- **The writeOnly walk resolves local refs** (spec §7): same-document `#/…` JSON
  Pointer resolution, mark union across `allOf`/`anyOf`/`oneOf`, secret-free
  cycles cut. The refuse-line — external refs, `$id`/`$anchor`/`$dynamicRef`,
  recursive-secret cycles — is enforced by the new pure
  `registry.validateSchemaIndirection` at catalog warm: loud per-tool violations,
  registration still succeeds, the tool is cached schema-unsound → `sensitivePaths`
  null → `-32001` on gated calls and no recorded bodies. Forced client-side
  inlining was considered and rejected (plain-SDK bots emit `$defs` by default;
  refusing them breaks the just-connect promise). `unit/redact.test.ts`'s open
  `$ref` ambiguity is thereby closed.
- **Named constants** for the role caps (`ROLE_PATTERN_MAX_LENGTH` /
  `ROLE_PATTERNS_MAX` / `ROLE_NAME_MAX_LENGTH` in limits.ts) and the mask
  sentinel (`registry.REDACTED`) — the table runners lose their caps/sentinel
  parameters and reference the names.
- **Close-code behavior vocabulary**: three behaviors (`stop_fatal` /
  `stop_quiet` / `reconnect`) plus a `schedule` attribute (`exponential` /
  `max_only`) — matching the row shape both client suites already carry; the
  contracts README and both client docstrings align to this one vocabulary.

Open: none.

First tasks at implementation, no decision needed: verify better-auth 1.7 on D1
inside workerd before `auth-matrix.test.ts` is written (Kysely D1 dialect —
sources conflict), and run `tunnel/smoke.test.ts` before anything else in
`server/test/tunnel/`.
