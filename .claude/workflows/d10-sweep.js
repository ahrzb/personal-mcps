export const meta = {
  name: 'd10-sweep',
  description: 'D10 final sweep: four seam lenses + spec-coverage critic, findings adversarially verified',
  whenToUse: 'Launch after the login-fix gate closes. Returns raw verified findings + coverage gaps; the orchestrator runs the inline gates (suite, tsc, inventory, deploy+smoke) and writes the close-out itself.',
  phases: [
    { title: 'Sweep', detail: 'four Opus lenses, one per module seam', model: 'opus' },
    { title: 'Verify', detail: 'adversarial refutation of each kept finding', model: 'opus' },
    { title: 'Coverage', detail: 'which spec § has no green case pointing at it', model: 'opus' },
  ],
}

const ROOT = 'C:/Users/AmirHossein/repos/github.com/ahrzb/personal-mcps'
const SPEC = `${ROOT}/docs/superpowers/specs/2026-08-24-personal-mcp-hub-design.md`
const STRATEGY = `${ROOT}/docs/superpowers/specs/2026-08-25-testing-strategy.md`

const COMMON = `Repo: ${ROOT} (Windows paths). Design spec: ${SPEC}. Testing strategy: ${STRATEGY}.
You are a REVIEWER: read-only. Edit nothing, commit nothing, mutate no state (running tsc/vitest read-only is allowed).
SECURITY: never open or print .secrets, .dev.vars, or ~/.config/pmcp/config.toml; tokens in fixtures are deliberately fake (pmcp_sa_FAKE0000 style) — do not report them as leaks.
KNOWN ACCEPTED DEBTS — do NOT report these again: dead ApprovalsConfig.vapid field; webpush-webcrypto speaks draft-04 aesgcm not RFC 8291 (Apple push refusal); audit-page chevron template bug; manifest icons: []; /device RFC 8628 §5.4 IP/user-agent gap; /account three unsourceable fields; AUDIT_SCAN_ROWS=1000 ceiling; root package.json missing "type":"module"; approval-e2e CAS case 9 flake. Also read docs/superpowers/postmortems/ first and do not duplicate its recorded candidate countermeasures as findings.
(Note to self: if mid-task you find partial notes you do not remember writing, they are your own from before a context summarization — do not invent a second author.)
Your final message is machine-read: return ONLY what the schema asks, grounded in file:line evidence you actually read.`

const FINDINGS = {
  type: 'object', required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['title', 'file', 'severity', 'claim', 'evidence'],
        properties: {
          title: { type: 'string' },
          file: { type: 'string' },
          line: { type: 'number' },
          severity: { type: 'string', enum: ['blocker', 'serious', 'nit'] },
          claim: { type: 'string' },
          evidence: { type: 'string' },
          spec_section: { type: 'string' },
        },
      },
    },
  },
}

const VERDICT = {
  type: 'object', required: ['refuted', 'reason'],
  properties: { refuted: { type: 'boolean' }, reason: { type: 'string' } },
}

const GAPS = {
  type: 'object', required: ['gaps'],
  properties: {
    gaps: {
      type: 'array',
      items: {
        type: 'object',
        required: ['spec_section', 'unproven', 'smallest_case'],
        properties: {
          spec_section: { type: 'string' },
          unproven: { type: 'string' },
          smallest_case: { type: 'string' },
          severity: { type: 'string', enum: ['serious', 'nit'] },
        },
      },
    },
  },
}

// The four seams the per-dispatch reviews never judged as PAIRS — each lens reads
// BOTH sides in full and hunts only for cross-boundary problems.
const LENSES = [
  {
    key: 'registry-gateway',
    focus: `the service registry (D1 service/grant tables and their admin ops — locate them: server/src/admin.ts and any registry module) vs the gateway (server/src/gateway.ts). Does every assumption the gateway makes about registry rows (slugs, kinds, auth modes, grant sets, redaction specs) hold on every path the admin ops can produce? Can an admin mutation (delete, re-create, grant edit) land between a gateway read and use?`,
  },
  {
    key: 'gateway-tunnel',
    focus: `the gateway (server/src/gateway.ts) vs the tunnel (the ServiceConnection Durable Object with WebSocket hibernation — locate it, likely server/src/tunnel.ts or connection.ts). Call lifecycle across the seam: WS drop mid-call, hibernation wake, double connect for one slug, backpressure, timeout ownership, error-shape fidelity back to the MCP caller.`,
  },
  {
    key: 'identity-custody',
    focus: `identity (server/src/identity.ts, the §4 sole-custodian seam: callAuth is supposed to be the ONLY path to better-auth) vs every consumer (web.ts, gateway.ts, admin.ts, index.ts, wiring.ts). Hunt: any consumer reaching better-auth or session/token material around the seam instead of through it; auth data (Authorization headers, session tokens, pmcp_(sa|svc)_ values) leaking into logs, Sentry, push payloads, or error messages (§15); the credential family exposed to the model-facing MCP surface (§4 forbids it).`,
  },
  {
    key: 'pages-web',
    focus: `pages/model.ts (the single data authority for all 8 pages) vs web.ts (mutation wrapper, CSRF, session gating) vs index.ts MOUNTS routing. Hunt: a rendered control whose POST target, method, or encoding disagrees with what web.ts accepts (the 415 class — the working tree may contain the fresh login-fix translation routes, judge what is THERE); a mutation route outside the mutation() wrapper; a page reachable without the session gate its model assumes; MOUNTS/ROUTES rows that disagree with what web.ts actually serves.`,
  },
]

const lensPrompt = (l) => `${COMMON}

You are one of four seam reviewers in the final pre-close sweep of a personal MCP hub (Cloudflare Workers + Hono JSX + D1 + one SQLite-backed DO, better-auth). Nine dispatches implemented it module-by-module and each was reviewed against its own diff; nobody has yet judged the SEAMS. Your seam: ${l.focus}

Method: read both sides completely (and the spec sections governing them) before writing anything. Report ONLY cross-boundary problems — contract drift, invariants assumed on one side and not guaranteed by the other, unhandled failure modes that cross the seam, security leaks across it, vestigial interface surface. Single-module style points are out of scope. Every finding needs file:line evidence from code you actually read. An empty findings list is a legitimate result — do not manufacture findings to look thorough.`

const verifyOne = (f, lensKey) =>
  agent(
    `${COMMON}

Adversarially VERIFY this seam finding. Your job is to REFUTE it: re-read the cited files (and any caller/callee it implicates) and look for the guard, type, test, or spec sentence the finder missed. Finding: ${JSON.stringify(f)}

Return refuted:true unless the defect is real and reachable — "technically true but unreachable" counts as refuted (say so in reason). If real, reason states the concrete failure scenario in one sentence.`,
    { label: `verify:${lensKey}:${f.title.slice(0, 32)}`, phase: 'Verify', model: 'opus', schema: VERDICT },
  )

const coveragePrompt = `${COMMON}

You are the completeness critic for the final sweep. Question: WHICH SPEC SECTION HAS NO GREEN CASE POINTING AT IT? Method: walk the design spec section by section; for each obligation, find the test case(s) that prove it (test-inventory.json at ${ROOT}/test-inventory.json maps every authored case; test trees: server/test, cli/test, clients/py/tests, scripts/). Where no case proves an obligation, record a gap with the SMALLEST case that would.

Three named debt rows to audit explicitly: (1) the D2 array-items redaction rows — does the audit-redaction spec's array-item handling have cases? (2) the 0004 migrations-pin owner rows — is the migration-pinning obligation proven? (3) the "initialize" contracts family — is the MCP initialize handshake pinned by contract fixtures for the gateway and BOTH clients (py + js)?

Cap output at the 15 most important gaps, most serious first. A section already covered by the KNOWN debts list or the postmortems' candidate countermeasures is not a gap for you.`

// Sweep+verify pipelines per lens; the coverage critic runs alongside. The final
// barrier is genuine: the orchestrator needs everything to write the close-out.
const [seams, coverage] = await parallel([
  () =>
    pipeline(
      LENSES,
      (l) => agent(lensPrompt(l), { label: `lens:${l.key}`, phase: 'Sweep', model: 'opus', schema: FINDINGS }),
      async (res, l) => {
        if (!res) return null
        const order = { blocker: 0, serious: 1, nit: 2 }
        const found = [...res.findings].sort((a, b) => order[a.severity] - order[b.severity])
        const kept = found.slice(0, 4) // ponytail: cap 4 verified per lens; the tail is recorded unverified
        if (found.length > kept.length) log(`lens:${l.key}: verifying top 4 of ${found.length}; ${found.length - 4} recorded unverified`)
        const verified = await parallel(
          kept.map((f) => async () => {
            const votes = (await parallel(
              (f.severity === 'blocker' ? [0, 1] : [0]).map(() => () => verifyOne(f, l.key)),
            )).filter(Boolean)
            const refutes = votes.filter((v) => v.refuted).length
            const verdict =
              votes.length === 0 ? 'unverified'
              : refutes === votes.length ? 'refuted'
              : refutes === 0 ? 'confirmed'
              : 'contested'
            return { ...f, lens: l.key, verdict, votes }
          }),
        )
        return { lens: l.key, verified: verified.filter(Boolean), unverified: found.slice(4) }
      },
    ),
  () => agent(coveragePrompt, { label: 'coverage-critic', phase: 'Coverage', model: 'opus', schema: GAPS }),
])

const kept = (seams ?? []).filter(Boolean)
log(`sweep done: ${kept.flatMap((s) => s.verified).filter((f) => f.verdict === 'confirmed').length} confirmed findings, ${(coverage?.gaps ?? []).length} coverage gaps`)
return { seams: kept, coverage: coverage ?? { gaps: [] } }
