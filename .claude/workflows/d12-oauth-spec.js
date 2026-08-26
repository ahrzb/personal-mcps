export const meta = {
  name: 'd12-oauth-spec',
  description: 'Research + spec amendments for D12 (inbound OAuth authorization server) and D13 (resources proxying) in one pass',
  whenToUse: 'After D11 gates. Produces both spec amendments and per-dispatch test lists; implementations are separate sequenced workflows (OAuth first) the orchestrator launches after reviewing the specs.',
  phases: [
    { title: 'Research', detail: 'better-auth provider surface + MCP client requirements + resources wire, in parallel', model: 'opus' },
    { title: 'Spec', detail: 'design-doc amendments + D12/D13 plan files + oracle-style test lists', model: 'opus' },
    { title: 'Verify', detail: 'adversarial spec review over both', model: 'opus' },
  ],
}

const DECISIONS = `
LOCKED OWNER DECISIONS (2026-08-26, not up for re-litigation):
1. An OAuth-connected client (e.g. claude.ai) gets SERVICE-ACCOUNT power, never owner power: the connection binds to a service account and is scoped by that account's role grants, exactly like a pmcp_sa_ key. §2's access model is untouched.
2. Consent is an explicit screen: after login the owner sees what the client requests, binds it (the lazy binding candidate: pick the service account on the consent page), and can revoke from the web UI. No silent auto-approve.
3. The auth/credential family (login, device approval, TOTP/passkey, sessions, passwords) is NEVER exposed on any MCP surface — the OAuth server must not widen it. Note D11 just landed a gate refusing Authorization-bearing requests to credential-family /api/auth paths; new OAuth endpoints must remain outside that family and reachable.
4. Implementation vehicle (orchestrator's call): better-auth's own OAuth-provider/MCP plugin if it fits the pinned version — hand-rolling an AS is the fallback, not the default.

LOCKED OWNER DECISIONS FOR D13 (MCP data model, 2026-08-26):
5. D13 reverses §18 decision 4: the hub proxies the MCP data model beyond tools — prompts, resources, resource templates, completions in scope; reverse-direction features (resources/subscribe, list_changed notifications to consumers, sampling, elicitation) are IN only if the research shows the consumer transport carries server→client traffic on the current architecture — otherwise recorded as deferred with the reason.
6. Access control is FINE-GRAINED and reuses the one existing pattern language (§18 d9, anchored regexes): roles gain pattern lists over resource URIs and prompt names, symmetric with tool-name patterns. This extends the hub/register roles wire shape and both client libraries' serve({roles}) API plus the YAML config — the spec must pin the new shapes and their backward compatibility (a bare pattern list keeps meaning tools).
7. Approvals remain a tools/call concern (reads of prompts/resources are audited, never approval-gated); §15 hygiene and redaction apply to resource/prompt contents the same way they apply to tool results.
`

phase('Research')
const research = await parallel([
  () => agent(`Research task (read-only; you may read node_modules, and use WebSearch/WebFetch for current docs — no repo edits).

QUESTION: what does better-auth (pinned ^1.7.1 in this repo — check node_modules/better-auth's actual installed version and exports FIRST, docs second) offer for acting as an OAuth 2.1 authorization server for MCP clients?

Cover precisely, with evidence (file paths in node_modules, or doc URLs):
- The plugin name(s) and import paths: is it the 'mcp' plugin, 'oidcProvider', both? What does each mount under /api/auth, and does it serve /.well-known/oauth-authorization-server metadata (and where)?
- Dynamic client registration: supported? Endpoint? Anonymous or gated?
- PKCE enforcement, supported grant types, refresh tokens, token format (opaque vs JWT), and HOW A RESOURCE SERVER VALIDATES an access token server-side in the same worker (introspection function/API — the hub's gateway must map a presented token to a session/record cheaply on every MCP call).
- Storage: which tables/migrations the plugin needs (this repo hand-writes D1 migrations in server/migrations and pins them in migrations.test.ts SCHEMA_TABLES — list the exact new tables/columns the plugin expects; check how the repo generated better-auth tables before, e.g. existing migration files' comments).
- The consent flow: what the plugin gives (hooks/pages?) vs what the hub must render itself; where a custom consent page plugs in; how scopes are represented.
- Any known constraints on redirect URIs, trusted clients, or CORS that matter for claude.ai (redirect https://claude.ai/api/mcp/auth_callback) and Claude Code as clients.
- Cloudflare Workers compatibility notes for the plugin, if any.

This repo already wires better-auth in server/src/identity.ts (read its header and plugin list). Return findings as compact structured notes with an explicit UNKNOWNS list for anything you could not verify.`, {
    label: 'research:better-auth-provider', phase: 'Research', model: 'opus', schema: {
      type: 'object', additionalProperties: false,
      required: ['installed_version', 'plugin_surface', 'token_validation', 'storage', 'consent', 'client_constraints', 'unknowns'],
      properties: {
        installed_version: { type: 'string' },
        plugin_surface: { type: 'string' }, token_validation: { type: 'string' }, storage: { type: 'string' },
        consent: { type: 'string' }, client_constraints: { type: 'string' },
        unknowns: { type: 'array', items: { type: 'string' } },
      },
    },
  }),
  () => agent(`Research task (read-only; use WebSearch/WebFetch for current specs/docs — no repo edits).

QUESTION: what exactly must this MCP server implement for claude.ai custom connectors and Claude Code to connect via OAuth?

Cover precisely, citing the MCP authorization spec revision and Anthropic docs:
- The MCP authorization spec's requirements on the server: protected-resource metadata (RFC 9728) — where it must be served relative to the MCP endpoint (this hub serves MCP at https://<origin>/<user>/mcp, NOT at the origin root — spell out what resource-metadata URL a client will derive and what the 401 WWW-Authenticate challenge must carry), authorization-server metadata (RFC 8414), dynamic client registration (RFC 7591) — required or optional for claude.ai?, PKCE, resource indicators (RFC 8707) — does claude.ai send 'resource'?
- What claude.ai's custom-connector UI actually does today: the fields it accepts (URL, client id/secret?), the redirect URI it registers, whether it requires DCR or accepts pre-registered credentials, and its behavior when the server offers no OAuth (the flow the owner saw fail: /authorize 404 with client_id and redirect_uri=https://claude.ai/api/mcp/auth_callback).
- What Claude Code does for '--transport http' servers with OAuth (it currently connects here via a static Bearer header; does OAuth change anything for it?).
- Multi-tenant wrinkle: with per-user MCP paths (/ahrzb/mcp), can one origin-level authorization server serve all of them (resource parameter/audience), or does anything force per-path metadata?

Return compact structured notes with an explicit UNKNOWNS list.`, {
    label: 'research:mcp-client-reqs', phase: 'Research', model: 'opus', schema: {
      type: 'object', additionalProperties: false,
      required: ['server_requirements', 'claude_ai_behavior', 'claude_code_behavior', 'multitenant', 'unknowns'],
      properties: {
        server_requirements: { type: 'string' }, claude_ai_behavior: { type: 'string' },
        claude_code_behavior: { type: 'string' }, multitenant: { type: 'string' },
        unknowns: { type: 'array', items: { type: 'string' } },
      },
    },
  }),
  () => agent(`Research task (read-only; read this repo and node_modules, use WebSearch/WebFetch for the current MCP spec — no repo edits).

QUESTION: what would it take for this hub to proxy the MCP data model beyond tools — prompts, resources, resource templates, completions, and the reverse-direction features?

Ground yourself in the repo first: server/src/gateway.ts routes exactly initialize / tools/list / tools/call into its pipeline (read its module header and the method switch); server/src/tunnel.ts relays raw JSON-RPC frames both ways over the service tunnel; the consumer endpoint is POST /:user/mcp (read how responses are shaped — is there any SSE/streaming today?); spec §7 documents the door and §18 d4 records the tools-only decision.

Cover precisely, citing the MCP spec revision the repo pins (contracts/ names protocolVersion 2026-07-28) and the current published spec:
- The full method inventory per family: prompts/list, prompts/get; resources/list, resources/read, resources/templates/list, resources/subscribe + notifications/resources/updated + list_changed notifications; completion/complete; logging; sampling/createMessage; elicitation — for each: request/response or server-initiated, and which capability declarations gate it.
- Transport feasibility: on streamable HTTP, how do server->client messages (notifications, sampling requests) reach a consumer? What does the CURRENT consumer endpoint support (plain JSON responses vs SSE streams), and what would each reverse-direction feature demand of the hub's architecture (the DO already holds the service socket; the consumer side is request/response)?
- What claude.ai connectors and Claude Code actually consume today: prompts? resources? completions? (their observable behavior — which families are worth proxying for real value now).
- Aggregation questions the spec will have to answer: tools are aggregated across services at the bare /:user/mcp endpoint with name collision rules — what is the sane analog for prompts (names) and resources (URIs) across services, and what does the per-service endpoint shape look like instead?
- Caching/invalidations: how tools/list caching works in the DO today (catalog warm) and what listing caches the new families would need.

Return compact structured notes with an explicit UNKNOWNS list.`, {
    label: 'research:mcp-data-model', phase: 'Research', model: 'opus', schema: {
      type: 'object', additionalProperties: false,
      required: ['method_inventory', 'transport_feasibility', 'client_consumption', 'aggregation', 'caching', 'unknowns'],
      properties: {
        method_inventory: { type: 'string' }, transport_feasibility: { type: 'string' },
        client_consumption: { type: 'string' }, aggregation: { type: 'string' }, caching: { type: 'string' },
        unknowns: { type: 'array', items: { type: 'string' } },
      },
    },
  }),
])

const [provider, clientReqs, dataModel] = research
if (!provider || !clientReqs || !dataModel) throw new Error('a research agent died; resume the run')
log('Research done; drafting the spec amendment')

phase('Spec')
const spec = await agent(`You are amending the design spec of personal-mcps with TWO features: D12, the inbound OAuth authorization server, and D13, proxying the MCP data model beyond tools. You EDIT exactly three files: docs/superpowers/specs/2026-08-24-personal-mcp-hub-design.md (one new numbered section per feature at the end, plus minimal cross-reference amendments inside existing sections where a feature genuinely changes them — §2 reserved routes, §4 identity, §6 tunnel/registration wire, §7 proxy door, §11 client libraries, §13 web surface, §18 decisions — d4 and d9 are explicitly revised by D13) and TWO new plan files: docs/superpowers/plans/2026-08-26-d12-oauth.md and docs/superpowers/plans/2026-08-26-d13-data-model.md. Read the spec's existing sections first and match its voice: precise, decision-recording, § cross-references. D12 and D13 are implemented as SEPARATE sequenced workflows (OAuth first) — each plan file must stand alone.
${DECISIONS}
RESEARCH INPUT (verified by three research agents; treat UNKNOWNS as open questions to record, not to silently resolve):
--- better-auth provider surface ---
${JSON.stringify(provider, null, 1)}
--- MCP client requirements ---
${JSON.stringify(clientReqs, null, 1)}
--- MCP data model beyond tools ---
${JSON.stringify(dataModel, null, 1)}
--- end research ---

The D13 amendment must pin, at minimum:
- Which families are IN (prompts, resources, resource templates, completions) with their full method routing at the door — per-service endpoint and the aggregated bare endpoint (name/URI collision rules per family, following how tools aggregate today) — and which reverse-direction features are IN or DEFERRED strictly per the transport research, each with its recorded reason.
- The extended roles wire shape (decision 6): the hub/register declaration, its backward compatibility (a bare pattern list still means tools), the YAML config shape, validation caps (mirror the existing per-role caps in limits.ts), and the serve({roles}) API in both client libraries.
- Audit/hygiene per family (decision 7): what rows reads leave, how redaction applies to resource/prompt content, §15 constraints.
- DO catalog/caching per family, and the CLI surface (pmcp resources / prompts / read — name the commands and their op families).

The D12 amendment must pin, at minimum:
- The endpoints and metadata documents the hub serves, with exact paths, and every new top-level route segment added to the ROUTES table (§2/§16: segments reserve usernames; the router-walk test must stay total).
- The data model: new tables/columns (hand-written D1 migration, pinned in SCHEMA_TABLES), including the client↔service-account binding created at consent.
- The token story end to end: what claude.ai receives, how /:user/mcp validates it at the door (same seam as pmcp_sa_ keys — name the gateway function), what principal/audit identity a call carries ("sa:<slug>" like any service-account call, per decision 1), expiry/refresh/revocation (web UI revoke per decision 2).
- The consent page: route, what it shows, the service-account picker (or the researched alternative if the plugin dictates otherwise — record the choice as a decision), CSRF/cookie posture consistent with §13, and its exclusion from MCP surfaces (decision 3).
- Interaction with D11's bearer→credential-family gate: state why OAuth endpoints are outside the family and how the gate's list stays correct. NOTE: D11's remediation workflow is landing concurrently in server/src — when referencing its changes, state the invariant and cite docs/superpowers/plans/2026-08-26-d11-remediation.md rather than pinning line numbers in identity.ts/tunnel.ts/web.ts, which are mid-edit.
- Failure modes: 401 challenge with resource metadata, unknown client, revoked binding mid-session.
- Explicitly out of scope for D12 (record it): anything the research flagged UNKNOWN that does not block the claude.ai + Claude Code flows.

Each plan file gets: dispatch shape for its implementation workflow (disjoint ownership groups; D13's must note it runs AFTER D12 and touches gateway.ts/tunnel.ts/registry.ts/both client libs/cli), and an oracle-style test list — exact it()-title candidates per suite (D12: auth-matrix door cases, routes walk, migrations pin, consent page cases, smoke.ts live OAuth round-trip if feasible without a real claude.ai; D13: per-family door cases, roles-wire compatibility cases in the contracts family + both client-library suites, redaction-on-content cases, CLI command cases). Tests are the precise spec — titles must be assertable.

House rules: never touch any other file; no code; commit nothing. Return the section numbers you added, all file paths, the new route segments, the new tables, and the open questions you recorded.`, {
  label: 'spec:d12-d13', phase: 'Spec', model: 'opus', schema: {
    type: 'object', additionalProperties: false,
    required: ['sections_added', 'files', 'new_route_segments', 'new_tables', 'open_questions', 'summary'],
    properties: {
      sections_added: { type: 'array', items: { type: 'string' } }, files: { type: 'array', items: { type: 'string' } },
      new_route_segments: { type: 'array', items: { type: 'string' } },
      new_tables: { type: 'array', items: { type: 'string' } },
      open_questions: { type: 'array', items: { type: 'string' } },
      summary: { type: 'string' },
    },
  },
})

phase('Verify')
const review = await agent(`Adversarially review the just-written D12 (OAuth server) and D13 (MCP data model) spec amendments (git diff docs/ shows them; read the full amended sections and both new plan files under docs/superpowers/plans/). You are trying to REFUTE their readiness. Judge:
(a) SECURITY: does any path let an OAuth token reach owner power or the credential family (violating the locked decisions)? Is consent bypassable? Is the client↔service-account binding forgeable or confusable (client impersonation via DCR)? Redirect-URI validation pinned? For D13: can a resource/prompt read leak content past a role's URI/name patterns, past redaction, or into audit rows §15 forbids?
(b) CONSISTENCY: do they contradict the existing spec (§2 route reservations, §4, §6 registration wire, §7 door order, §11 client APIs, §13, §15 hygiene, §16 test totality)? Are new ROUTES segments complete? Is the roles-wire extension genuinely backward compatible (a bare pattern list still means tools) across hub, contracts fixtures, and BOTH client libraries?
(c) IMPLEMENTABILITY: is anything asserted that the research marked UNKNOWN? Any TBD/vague requirement an implementation agent could interpret two ways? Is every D13 reverse-direction feature explicitly IN with a transport story or DEFERRED with a reason?
(d) TEST LISTS: do the oracle titles cover the failure modes (D12: 401 challenge, revoked binding, unknown client, wrong-audience token, consent CSRF; D13: pattern-denied read, cross-service URI collision, redacted content, stale catalog)?
Report findings with file/section anchors; blockers are things that must change before implementation. Do not edit anything.`, {
  label: 'spec-review', phase: 'Verify', model: 'opus', schema: {
    type: 'object', additionalProperties: false,
    required: ['blockers', 'serious', 'nits', 'verdict'],
    properties: {
      blockers: { type: 'array', items: { type: 'string' } },
      serious: { type: 'array', items: { type: 'string' } },
      nits: { type: 'array', items: { type: 'string' } },
      verdict: { type: 'string' },
    },
  },
})

return { provider, clientReqs, spec, review }
