# Specs

This directory holds the system's two spec documents — the **design spec** and the
**testing strategy** — split one file per section, grouped into component directories.
Section numbers are the stable citation form used across code, tests, and plans
("§7", "strategy §9"): the numbers did not change in the split, so every existing
reference still resolves — look the number up in the tables below.

## Design spec

Split 2026-08-26 from a single-file spec (its last text is in git at `3003a1f^`, under
`docs/superpowers/specs/`); the monolith is gone and these files are the only current
text — §21, decisions 29–30 and the 2026-09-02 web-surface rewrite exist nowhere else.

| § | Section | What it pins |
|---|---|---|
| — | [Front matter](overview/00-front-matter.md) | Document title, date, and draft status. |
| 1 | [Overview](overview/01-overview.md) | What the hub is: the two app kinds (tunneled bots that dial out, proxied remote endpoints the hub forwards to), the component table (server / clients / CLI / admin MCP / web pages), and the v1 non-goals. |
| 2 | [Concepts](overview/02-concepts.md) | The vocabulary everything else runs on: users as namespace owners and the reserved-username rule, apps and their slugs, roles as anchored patterns plus the built-in `all`, agents, grants with `allow`/`approval` modes, and the three token kinds. Also the trust boundary — roles confine the agent, not the app. |
| 3 | [Architecture](overview/03-architecture.md) | The Worker trust boundary, shared scoped dispatch, `AppConnection`, and in-process QuickJS execution path. |
| 4 | [Tech stack](overview/04-tech-stack.md) | Workers/Hono/D1/DOs, MCP/better-auth, dependency policy, and the pinned QuickJS/Wasm execution boundary. |
| 5 | [Data model](data-model/05-data-model.md) | Better Auth tables, app/agent/grant/approval/token/audit/push/OAuth rows, owner execution settings, durable TypeScript reservations, and app DO state. |
| 6 | [Reverse connection protocol](tunnel/06-reverse-connection-protocol.md) | Tunnel upgrade/framing, registration roles and optional alias hints, role drift, non-disconnecting alias collisions, cache warm, liveness, replacement, and lifecycle. |
| 7 | [Consumer-facing proxy](gateway/07-consumer-facing-proxy.md) | Aggregate hub, scoped hub/app mounts, authentication, filters/check order, shared dispatch, approval, caller metadata, upstream OAuth, and redaction. |
| 8 | [Admin MCP](admin-and-config/08-admin-mcp.md) | Built-in `pmcp` operations, reserved virtual slugs, settings/alias configuration, parity, credential policy, and `GET /api/whoami`. |
| 10 | [CLI](admin-and-config/10-cli.md) | The `pmcp` command surface (rewritten 2026-09-01: path-style refs for `describe`/`get`, `--json` everywhere, the frozen error-code contract, minimal interactivity), the rule that every non-auth/non-profile subcommand is sugar over the same MCP tools, and `~/.config/pmcp/config.toml` with named profiles and their selection precedence. |
| 11 | [Client libraries](admin-and-config/11-client-libraries.md) | What the Python, JS, and Go libraries own: dial, register, answer `server/discover`, bridge WS frames to the author's SDK, reconnect — plus the two in-handler affordances (caller identity and secret-schema marking). |
| 12 | [User management script](admin-and-config/12-user-management-script.md) | The bootstrap path: `scripts/users.ts` against `POST /internal/users`, guarded by a `BOOTSTRAP_SECRET` whose absence makes the route 404, and the profile/env resolution the script uses. |
| 13 | [Web surface](web-and-oauth/13-web-surface.md) | ~~Server-rendered~~ Login/device, seven-pane Settings including Execution, approvals and OAuth consent — the SPA since decision 38 (2026-09-23), with the JSON routes that replaced their handlers; the SPA's app/agent catalog and alias views plus the `/audit` explorer (decision 36) — PWA and Web Push. |
| 14 | [Alternatives considered](decisions/14-alternatives-considered.md) | Rejected designs and their reasons. |
| 15 | [Error handling and operational behavior](ops/15-error-handling.md) | Direct and program deadlines, at-most-once behavior, revocation, failure classification, hygiene, audit bodies, what `detail` may hold, and retention with its read-side ceilings. |
| 16 | [Testing](ops/16-testing.md) | Unit/workerd/tunnel/client obligations plus the deployed QuickJS proof boundary. |
| 17 | [Repo layout](overview/17-repo-layout.md) | Monorepo and sibling-provider ownership. |
| 18 | [Decisions made by default](decisions/18-decision-log.md) | Numbered decisions 1–40 and their supersession history. |
| 19 | [Inbound OAuth](web-and-oauth/19-inbound-oauth.md) | The hub as an authorization server: the vehicle and its verify side, the discovery documents and routes, the pinned provider options, the `oauth_binding` table, the consent screen, the token end to end (including the byte-level JWT predicate and the terminal, fail-closed door leg), the interaction with the `/api/auth` allowlist, the failure matrix, and what is explicitly out of scope. |
| 20 | [The MCP data model beyond tools](gateway/20-mcp-data-model-beyond-tools.md) | Prompts, resources, resource templates and completions through the same pipeline: what is in and what is deferred with its reason, per-family routing and capability advertisement, roles over three keyspaces, per-family audit and URI hygiene, caching, and the CLI/library surfaces. |
| 21 | [Push: the listen stream](gateway/21-push.md) | Server→consumer notifications un-deferred (decision 28): the Worker-held `text/event-stream`, subscriber sockets into app DOs, doorbell-not-data, `resources/subscribe`/`updated`, capability flags flipping in lockstep with the transport, and the recorded ceilings. |
| 22 | [The OpenTofu provider](provider/22-opentofu-provider.md) | `terraform-provider-pmcp`, living in its own repo and managing hub contents while Wrangler owns the Worker: the `pmcp_adm_` admin credential, write-only upstream headers, resources and data sources, the behavioural parity oracle, flakes, terranix module, and acceptance rig. |
| 23 | [Hub JavaScript execution](gateway/23-hub-execution.md) | The aggregate cutover to hub-owned `execute`/`search_types`, declaration resources, isolated QuickJS/Wasm execution, credential reauthorization, stable hub-local TypeScript aliases, configurable synchronous deadlines, limits, audit, and deployed proof boundary. |


## Testing strategy

Split 2026-08-26 from a single-file strategy (last text at `3003a1f^`, same directory).
Cited as "strategy §N"; amended since (decision 29's rename), so these files are the only
current text.

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
