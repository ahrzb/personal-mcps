# D11 — Remediation of the D10 seam-sweep findings

> Source: the D10 final-sweep workflow (four Opus seam lenses + coverage
> critic, every finding adversarially verified). Run `wf_ca1a902c-297`;
> full JSON archived at the sweep run's transcript dir. 10 confirmed
> findings (1 blocker fixed in D10), 12 coverage gaps. The blocker
> (public sign-up) was fixed and deployed during D10 (`dc835e60`,
> postmortem `2026-08-26-public-signup-open.md`). Everything below is the
> remainder, deferred here by the user's call on 2026-08-26.

**Grain:** one remediation workflow (fixes are disjoint by module) + a
test-authoring pass for the coverage gaps. Standard gate per the orchestration
plan. Every fix is written red-first and driven by its **real actor** (the
through-line of the postmortem track): an anonymous/stale/bearer client for the
auth findings, a real dropped socket for the tunnel findings.

## Security findings (enforce existing spec — no spec decision needed)

- [ ] **Recent-auth not enforced on the credential POSTs.** §4 requires a
  recently-authenticated cookie for TOTP/passkey/session-revoke changes;
  `web.ts` applies `requireOwnerSession(req, { recent: true })` only on
  `GET /account`. The five mutating routes go through `credential()` →
  `mutation()` → `requireOwnerSession(c.req.raw)` with no `recent`, so a
  day-old owner cookie (better-auth default freshAge = 1 day) + password (no
  second factor) can perform them; the CSRF token is readable off /services.
  Fix: thread `{ recent: true }` through `credential()`/`mutation()` for the
  credential routes. Evidence: [web.ts:467](../../../server/src/web.ts:467),
  web.ts:556, §4 spec ~line 147. Test: stale-cookie POST → refused.
- [ ] **CLI device-flow bearer token reaches the credential family.** The
  `bearer()` plugin rewrites any `Authorization` header into a session cookie
  for better-auth's own middleware, and the credential endpoints are also
  mounted raw at `/api/auth`. So a stolen CLI token (`access_token` is a raw
  better-auth session token) can `POST /api/auth/revoke-sessions` /
  `/two-factor/disable` etc., skipping the hub's cookie-only + recent + CSRF
  guards — the "structural" cookie-only guard (`requireOwnerSession` reads only
  Cookie) never runs because these requests never route through the hub's
  /account wrappers. §4 says bearer/device sessions must not reach the
  credential family. Fix: gate the credential sub-paths of the `/api/auth`
  mount against bearer-derived sessions (or scope the CLI device token so it
  cannot authorize credential-family endpoints). Evidence:
  [identity.ts:95](../../../server/src/identity.ts:95), identity.ts:440-445,
  device-authorization routes. Test: bearer POST to a credential endpoint →
  refused.

## Correctness / hygiene findings

- [ ] **Redaction pattern typo fails open (hygiene-security).** A `redact:` /
  `redact_results:` key that fails to compile is stored with a shape check
  only and then silently matches no tool — so the argument/result it was meant
  to mask is persisted in full into the approval `args_json` and audit body
  columns. The sibling *role* pattern fails loudly (`assertRoles` →
  RegistryRefusal). Fix: validate redact keys as patterns at write time, the
  way roles are (add the compile check in `createService`/`updateService` and
  in `cli/src/plan.ts`). Evidence:
  [registry.ts:1046](../../../server/src/registry.ts:1046),
  registry.ts:714-715/778-779 vs registry.ts:695. Test: a non-compiling
  redact key is refused at write.
- [ ] **Tunnel `drain()` reports "offline" for frames already on the wire.**
  The at-most-once guarantee the module names is violated under a connection
  drop — a frame that may have executed is reported as certainly-did-not.
  Evidence: [tunnel.ts:722](../../../server/src/tunnel.ts:722).
- [ ] **A failed catalog warm wedges a service "online" refusing every call.**
  `tools/call` returns -32001 silently, no retry, no operator signal on either
  side. Evidence: [tunnel.ts:575](../../../server/src/tunnel.ts:575).
- [ ] **DO RPC failures escape the HubError contract.** Consumer gets -32603
  instead of the pinned -32000, and the audit row loses the failure class.
  Evidence: [tunnel.ts:245](../../../server/src/tunnel.ts:245).
- [ ] **(nit) The service's `error` member is cast unvalidated in the DO and
  relayed verbatim to the MCP caller**, breaking the gateway's error-shape
  invariant. Evidence: [tunnel.ts:886](../../../server/src/tunnel.ts:886).
- [ ] **(known ceiling) /account "Enable two-factor" and "Regenerate backup
  codes" render no password control** but `web.ts`'s `credential()` reads one,
  so both refuse on every click. Needs a spec decision: add a password field
  to `account.tsx` or `twoFactor({ allowPasswordless: true })`. Already
  recorded as a login-fix ceiling. Evidence: account.tsx:183.

## Coverage gaps (test-authoring pass; write each as its real actor)

- [ ] **serious** §13 / strategy §9 rule 4(b) — no case submits `/device`'s
  approve/deny form (`paths.deviceDecide = "/device/decide"`). The same
  unwalked-form class as the 415.
- [ ] **serious** §15 — no case mentions `auth.login` or
  `auth.device_approved`; the audit rows those events write are unproven.
- [ ] **serious** §6 — the DO-side cache-invalidation on
  `notifications/tools/list_changed` is untested.
- [ ] **serious** §5 — migration 0004's `upstream_oauth_state` table is unpinned
  by `migrations.test.ts` `SCHEMA_TABLES`.
- [ ] **serious** §10 — `pmcp audit --since 7d` and `pmcp token issue
  --expires 90d` forward their strings verbatim into integer-only op fields;
  neither spelling is walked.
- [ ] **serious** §7 step 1 (initialize, amended 2026-08-26) — the auth-matrix
  refusal matrix is method-monomorphic; nothing proves the `initialize`
  handshake is subject to the door.
- [ ] **serious** §7 / §5 decision 20 — the client-metadata capture path
  (`client_name`/`client_version`/`client_session_id`) from the wire is proven
  by nothing.
- [ ] **serious** §8 — `audit_query`'s `principal`, `since`, `until` filters are
  never passed a value by any case.
- [ ] **serious** strategy §4 — there is no `initialize` contract family;
  `contracts/` holds eight files, none the handshake. (Ties to the §7 gap.)
- [ ] **nit** §16 — clients/py's 42 cases are outside `test-inventory.json`
  entirely (the inventory covers only vitest).
- [ ] **nit** strategy §10 — aggregated tool names are never validated against
  the consumer charset `^[a-zA-Z0-9_-]{1,128}$`.
- [ ] **nit** §7 — the tuple form of `items` in the writeOnly redaction walk is
  an unexercised branch (registry.ts:388-390).
