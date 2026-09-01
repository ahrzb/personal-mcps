# Specs

This directory holds the system's two spec documents — the **design spec** and the
**testing strategy** — split one file per section, grouped into component directories.
Section numbers are the stable citation form used across code, tests, and plans
("§7", "strategy §9"): the numbers did not change in the split, so every existing
reference still resolves — look the number up in the tables below.

## Design spec

Split from `docs/superpowers/specs/2026-08-24-personal-mcp-hub-design.md`.
Concatenating these files in § order reproduces that document exactly.

| § | Section | What it pins |
|---|---|---|
| — | [Front matter](overview/00-front-matter.md) | Document title, date, and draft status. |
| 1 | [Overview](overview/01-overview.md) | What the hub is: the two service kinds (tunneled bots that dial out, proxied remote endpoints the hub forwards to), the component table (server / clients / CLI / admin MCP / web pages), and the v1 non-goals. |
| 2 | [Concepts](overview/02-concepts.md) | The vocabulary everything else runs on: users as namespace owners and the reserved-username rule, services and their slugs, roles as anchored patterns plus the built-in `all`, service accounts, grants with `allow`/`approval` modes, and the three token kinds. Also the trust boundary — roles confine the account, not the service. |
| 3 | [Architecture](overview/03-architecture.md) | The request picture: the Worker as the single trust boundary, the `ServiceConnection` DO owning the hibernatable socket and the cached catalog, proxied upstreams dialed directly with no DO, and the rule that services always dial *in*. |
| 4 | [Tech stack](overview/04-tech-stack.md) | The pinned platform, verified against 2026-08 docs: Workers + Hono + D1 + SQLite DOs, MCP revision 2026-07-28 and the SDK gateway pattern, better-auth ≥ 1.7 and its exact plugin list, our own hashed token table (and why not `@better-auth/api-key`), session-scope guards, and how migrations are generated. |
| 5 | [Data model](data-model/05-data-model.md) | The D1 schema of record: `service`, `service_account`, `grant_`, `approval`, `token`, `audit`, `push_subscription`, `upstream_oauth_state` — column by column, with the constraints and the comments that carry the rules. Also what better-auth owns and what the DO keeps in its own SQLite. |
| 6 | [Reverse connection protocol](tunnel/06-reverse-connection-protocol.md) | The tunnel wire: the upgrade status matrix (401 fatal / 403 archived) and close codes, `hub/register` with role validation and role-drift auditing, `hub/replaced` and newest-wins, the 10 s registration deadline, ping-based liveness, the 30 s correlation timeout — plus the service lifecycle (provisioned → online/offline ↔ archived → deleted). |
| 7 | [Consumer-facing proxy](gateway/07-consumer-facing-proxy.md) | The door, and the longest section: aggregated vs scoped endpoints, authentication and the 401/404 anti-enumeration matrix, filter resolution and pattern semantics, the fixed check order (`-32001` → `-32002` → `-32003` → `-32000`), the approval flow with its CAS claim and MRTR handling, caller identity forwarding and `hub/*` strip-then-set, upstream OAuth for proxied services, and sensitive-field redaction. |
| 8 | [Admin MCP](admin-and-config/08-admin-mcp.md) | The built-in `pmcp` service: every admin tool and its shape, the uniform `pmcp`-slug rejection, the reserved-and-virtual slug, the parity invariant (anything the UI or CLI can do has a tool) with its pinned exceptions, and the `GET /api/whoami` contract the CLI depends on. |
| 9 | [YAML config, diff, apply](admin-and-config/09-yaml-config.md) | The declarative file: its exact shape for services, roles, redaction, and grants, and the desired-state semantics of `diff`/`apply` — deletes by absence, warn-vs-error per service kind, `pmcp` excluded, destructive flags. |
| 10 | [CLI](admin-and-config/10-cli.md) | The `pmcp` command surface (rewritten 2026-09-01: path-style refs for `describe`/`get`, `--json` everywhere, the frozen error-code contract, minimal interactivity), the rule that every non-auth/non-profile subcommand is sugar over the same MCP tools, and `~/.config/pmcp/config.toml` with named profiles and their selection precedence. |
| 11 | [Client libraries](admin-and-config/11-client-libraries.md) | What the Python and JS libraries own: dial, register, answer `server/discover`, bridge WS frames to the author's SDK, reconnect — plus the two in-handler affordances (caller identity, `Secret`/`sensitive()` marking). |
| 12 | [User management script](admin-and-config/12-user-management-script.md) | The bootstrap path: `scripts/users.ts` against `POST /internal/users`, guarded by a `BOOTSTRAP_SECRET` whose absence makes the route 404, and the profile/env resolution the script uses. |
| 13 | [Web surface](web-and-oauth/13-web-surface.md) | The server-rendered pages and what each is for (`/login`, `/device`, `/account`, `/audit`, `/approvals`, `/services`, the two `/oauth/*` pages), the PWA manifest + service worker, and approval Web Push. |
| 14 | [Alternatives considered](decisions/14-alternatives-considered.md) | The designs that were rejected and why — per-service tunnels, `McpAgent`, a full OAuth provider (later taken as §19), D1 for per-service state, upstream OAuth (later taken in §7). |
| 15 | [Error handling and operational behavior](ops/15-error-handling.md) | The operational contract: the 30 s request budget, at-most-once calls across deploys, unavailability and revocation behavior, the WAF rate-limiting rule, log hygiene, what the audit trail records and what it never does, audit bodies with their stubs and cap, and retention. |
| 16 | [Testing](ops/16-testing.md) | The test obligations the design itself pins — the core tunnel integration test, the pattern-matching regressions, the approval-flow cases, upstream and inbound OAuth, the router walk, and the per-family §20 cases. |
| 17 | [Repo layout](overview/17-repo-layout.md) | The monorepo tree: what lives in `server/`, `cli/`, `clients/`, `examples/`, `scripts/`. |
| 18 | [Decisions made by default](decisions/18-decision-log.md) | The numbered decision log (1–28), each with its rationale and, where it changed, the revision that superseded it — the place a reader checks before re-litigating a choice. |
| 19 | [Inbound OAuth](web-and-oauth/19-inbound-oauth.md) | The hub as an authorization server: the vehicle and its verify side, the discovery documents and routes, the pinned provider options, the `oauth_binding` table, the consent screen, the token end to end (including the byte-level JWT predicate and the terminal, fail-closed door leg), the interaction with the `/api/auth` allowlist, the failure matrix, and what is explicitly out of scope. |
| 20 | [The MCP data model beyond tools](gateway/20-mcp-data-model-beyond-tools.md) | Prompts, resources, resource templates and completions through the same pipeline: what is in and what is deferred with its reason, per-family routing and capability advertisement, roles over three keyspaces, per-family audit and URI hygiene, caching, and the CLI/library surfaces. |
| 21 | [Push: the listen stream](gateway/21-push.md) | Server→consumer notifications un-deferred (decision 28): the Worker-held `text/event-stream`, subscriber sockets into service DOs, doorbell-not-data, `resources/subscribe`/`updated`, capability flags flipping in lockstep with the transport, and the recorded ceilings. |

## Testing strategy

Split from `docs/superpowers/specs/2026-08-25-testing-strategy.md`. Cited as
"strategy §N". Concatenating these files in § order reproduces that document exactly.

| § | Section | What it pins |
|---|---|---|
| — | [Front matter](testing/00-front-matter.md) | Document title and its one-sentence framing. |
| 1 | [The frame](testing/01-the-frame.md) | Why the suite looks the way it does: tests are the spec stated precisely, a one-line spec change must not ripple through forty tests, and the risk profile (ordering, refusal, state, concurrency) that puts the center of gravity in-process inside workerd. Includes the size budget. |
| 2 | [Projects and verified tooling facts](testing/02-projects-and-tooling.md) | The verified Workers-test facts the layout depends on — the plugin version, `exports.default.fetch`, per-file storage isolation, D1 migration application, `outboundService`, `evictDurableObject` and testable hibernation, injected time — and the four-project table. |
| 3 | [The suites](testing/03-the-suites.md) | File-by-file: what each `unit`, `worker`, and `tunnel` test file pins, plus the client and script suites. The closest thing to an index of the whole test tree. |
| 4 | [Cross-language contracts](testing/04-cross-language-contracts.md) | `contracts/*.json` as the one oracle for shapes deliberately copied across languages, with a single writer and read-only consumers, and the parity directions that live there. |
| 5 | [What was considered and rejected](testing/05-considered-and-rejected.md) | Regression-only floors, characterization-after, per-function unit TDD everywhere, and full ceremony (deployed e2e, Playwright, mutation tooling, coverage targets) — each with the reason it loses. |
| 6 | [Authored when, by whom](testing/06-authored-when-by-whom.md) | The authorship table (which artifact is written before implementation, and by owner or agent), the vertical slices that keep the outer loop from staying red, and where fail-first actually pays. |
| 7 | [Durable contract vs incidental detail](testing/07-durable-vs-incidental.md) | The rule for what to assert hard and what to put behind a constant, with the explicit durable and incidental lists. |
| 8 | [When a test fails](testing/08-when-a-test-fails.md) | The three commit types (`fix:` / `spec:` / `test:`) and why data-shaped oracles make code-wrong vs spec-changed nearly automatic to tell apart. |
| 9 | [Keeping agent-written tests honest](testing/09-agent-written-tests.md) | The four rules: owner-authored commit-separated oracle, every refusal row beside its allow-twin, spot mutation over coverage, and no rendered control unwalked with exclusions that intersect to zero. Plus what is never faked, and the adversarial fake AS. |
| 10 | [What in-process testing cannot catch](testing/10-what-in-process-cannot-catch.md) | The structural gap and how it is covered out-of-process: the automated deploy gate and smoke, the on-demand e2e, the manual one-time observations written back into the spec, the `cron.swept` heartbeat, per-commit CI, and the accepted risks with their revisit triggers. |
| 11 | [Decisions and findings](testing/11-decisions-and-findings.md) | Everything authoring the strategy resolved — catalog-miss `-32001`, availability-first, the pure redaction and backoff pairs, the constants module and attachment versioning, audit bodies under the uniform rule, and the skeleton-authoring escalations decided as a batch. |
