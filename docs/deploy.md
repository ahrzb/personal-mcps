# Deploy your own hub

This is the path from a fresh clone to a working hub on **your** Cloudflare account:
one Worker, one D1 database, one Durable Object namespace, seven secrets, one user.
Follow it top to bottom in one sitting — every step is verifiable before the next.

The repo is checked in configured for its author's deployment. Four values are the
author's and are yours to change; they are called out where you meet them, and
collected in [§9](#9-what-was-the-authors) at the end.

## 0. Prerequisites

- A Cloudflare account (the free plan covers everything here: Workers, D1, Durable
  Objects on the SQLite backend).
- Node ≥ 22.18 / 23.6 — the CLI and the repo's scripts are TypeScript run through
  Node's native type stripping, and `cli/package.json` sets `engines.node >= 20`
  for the published CLI alone.
- `pnpm` (the repo is a pnpm workspace).

```bash
pnpm install
```

```bash
npx wrangler login
```

Everything below uses `npx wrangler`, so no global install is needed. Confirm you
landed on the right account before creating anything:

```bash
npx wrangler whoami
```

## 1. Name the Worker

`wrangler.jsonc` (repo root — not `server/`) opens with:

```jsonc
"name": "personal-mcps",
```

The name is the workers.dev hostname, so keeping it means deploying to
`https://personal-mcps.<your-subdomain>.workers.dev`. That is already distinct from
the author's, so renaming is optional — but pick the name now, because the origin
you derive from it is baked into `PUBLIC_ORIGIN` two steps down.

There is no `routes` or custom-domain block in the config: a plain `wrangler deploy`
publishes to workers.dev. Attaching a custom domain later is fine, and means coming
back to `PUBLIC_ORIGIN` (see [§10](#10-optional-extras)).

## 2. Create the D1 database

The config binds one database, `DB`, and points migrations at `server/migrations`:

```jsonc
"d1_databases": [
  {
    "binding": "DB",
    "database_name": "personal-mcps",
    "database_id": "…",
    "migrations_dir": "server/migrations"
  }
]
```

Create it under whatever name you keep in `database_name` (the two must agree — the
migration commands below address the database by name):

```bash
npx wrangler d1 create personal-mcps
```

The command prints a `database_id`. **Paste it over the checked-in one** in
`wrangler.jsonc` — the committed id belongs to the author's account and your deploy
cannot reach it.

Leave the Durable Object block alone:

```jsonc
"durable_objects": {
  "bindings": [{ "name": "SERVICE_CONNECTION", "class_name": "ServiceConnection" }]
},
"migrations": [{ "tag": "v1", "new_sqlite_classes": ["ServiceConnection"] }]
```

`new_sqlite_classes` (not `new_classes`) is load-bearing: the storage backend is
fixed when the class is first created and cannot be changed afterwards.

## 3. Set PUBLIC_ORIGIN

```jsonc
"vars": {
  "PUBLIC_ORIGIN": "https://personal-mcps.ahrzb.workers.dev"
}
```

**This one is the author's and must be yours.** It is the single source for every
absolute URL the hub emits — better-auth's `baseURL` and cookie domain, approval
URLs in `-32003` errors, the OAuth discovery documents, the upstream callback
redirect URI, and the origin clients derive `wss://<origin>/connect` from. Scheme and
host only: no trailing slash, no path.

```jsonc
"PUBLIC_ORIGIN": "https://personal-mcps.<your-subdomain>.workers.dev"
```

Two optional vars sit commented out beside it — `AUDIT_RETENTION_DAYS` (default 7)
and `AUDIT_BODY_CAP_BYTES` (default 16 KiB). Leave them unset to take the defaults
from `server/src/limits.ts`.

## 4. Set the secrets

Seven, and the Worker's `Env` type in `server/src/index.ts` is the authority on all
of them. The four required ones have no default and no fallback; the three optional
ones each degrade cleanly to "that feature is off".

| Secret | Required? | What it is | Generate with |
|---|---|---|---|
| `BETTER_AUTH_SECRET` | **yes** | better-auth's signing/session secret (§4) | `openssl rand -base64 32` |
| `UPSTREAM_CREDS_KEY` | **yes** | AES-GCM key enveloping `upstream_auth_json` at rest (§5) | `openssl rand -base64 32` |
| `VAPID_PUBLIC_KEY` | **yes** | Web Push ES256 public key (§13) | the snippet below |
| `VAPID_PRIVATE_KEY` | **yes** | Web Push ES256 private key (§13) | the snippet below |
| `BOOTSTRAP_SECRET` | for [§7](#7-create-the-first-user) | gates `POST /internal/users`; **while unset the route does not exist** — 404 for everything | `openssl rand -base64 32` |
| `BETTER_AUTH_API_KEY` | no | better-auth Dash (the hosted ops dashboard). Unset means the plugin is never constructed, so nothing phones home | from the Dash console |
| `SENTRY_DSN` | no | Sentry DSN. Unset means Sentry is fully disabled — no transport, no events; the Worker behaves as if the integration were absent | from your Sentry project |

`UPSTREAM_CREDS_KEY` is SHA-256'd into the AES key, so any high-entropy string works
— length and encoding are yours to pick. The envelope carries a one-byte version
header specifically so this key can be rotated later without a migration (ciphertext
written under the old key then reads as `needs_reconnect`, and the owner reconnects).

### The VAPID pair

The pair has a specific shape: the public half is base64url over the **raw 65-byte
P-256 point** (the same bytes a browser subscribes with as `applicationServerKey`),
and the private half is base64url over the **raw 32-byte scalar**. `server/src/push.ts`
also accepts a PKCS#8 private half, but the raw scalar is the form to generate — it
is what the repo's own pair uses and what every VAPID generator prints.

```bash
node -e 'const b=x=>Buffer.from(x).toString("base64url");(async()=>{const p=await crypto.subtle.generateKey({name:"ECDSA",namedCurve:"P-256"},true,["sign","verify"]);const j=await crypto.subtle.exportKey("jwk",p.privateKey);console.log("VAPID_PUBLIC_KEY ",b(await crypto.subtle.exportKey("raw",p.publicKey)));console.log("VAPID_PRIVATE_KEY",j.d)})()'
```

That prints an 87-character public key and a 43-character private key — for example
`BJ81ZfPO…VLl1M` and `jLldFOXd…WO44o`. Keep them together; the public half is served
to browsers by the approvals page, and a mismatched pair fails only at push time.

### Putting them in

`wrangler secret put` reads the value from stdin (or prompts) — never from argv, so
nothing lands in shell history:

```bash
for name in BETTER_AUTH_SECRET UPSTREAM_CREDS_KEY VAPID_PUBLIC_KEY VAPID_PRIVATE_KEY BOOTSTRAP_SECRET; do
  npx wrangler secret put "$name"
done
```

Add `BETTER_AUTH_API_KEY` and `SENTRY_DSN` to that list only if you want them.
Confirm what landed:

```bash
npx wrangler secret list
```

Local development is separate: `pnpm dev` reads `.dev.vars`, which is gitignored and
holds its own throwaway values. Nothing you set here affects it.

## 5. Apply the migrations

The SQL files in `server/migrations` — better-auth's tables plus the hub's. Remote
first-run:

```bash
npx wrangler d1 migrations apply personal-mcps --remote
```

(`--local` is the dev-database equivalent, and the vitest suite applies them itself.)

One thing to know rather than to fix: `0005_oauth.sql` contains a back-fill with the
author's origin as a SQL literal, because a `.sql` migration cannot read
`PUBLIC_ORIGIN`. It inserts an `oauthResource` row per **pre-existing** user — and on
a fresh database there are none, so on your deploy it matches zero rows and does
nothing. Every user you create afterwards gets its resource identifier from
`env.PUBLIC_ORIGIN` via `admin.provisionUser`, which is why this is safe to leave
alone.

## 6. Deploy

```bash
npx wrangler deploy
```

`--dry-run` is worth knowing about: it is what actually validates
`compatibility_flags` (the vitest Workers pool tolerates their absence, a real deploy
does not), which is why the repo runs it in CI.

The daily cron (`0 4 * * *`) registers on deploy and sweeps expired approvals, aged
audit rows, and stale OAuth `state` rows.

## 7. Create the first user

There is no public sign-up — better-auth's `/sign-up/email` is explicitly disabled,
so `POST /internal/users` behind `BOOTSTRAP_SECRET` is the only way a user comes into
existence (§12). The script reads its two inputs from the environment only, never
from argv, so the master key stays out of shell history and process listings:

```bash
PMCP_URL=https://personal-mcps.<your-subdomain>.workers.dev BOOTSTRAP_SECRET=<your-bootstrap-secret> pnpm users create <username>
```

It prints the username and a generated password on stdout — **once**. There is no
self-serve password change anywhere in the system, so store it now. Second factors
(TOTP, passkey) are enrolled through the account page after first login.

If it answers `the bootstrap route does not exist`, the Worker has no
`BOOTSTRAP_SECRET` — that 404 is the route being switched off, not a missing path.

`pnpm users list`, `delete`, and `reset-password <username>` round out the surface.
When you are done, rotate: `BOOTSTRAP_SECRET` is an all-namespaces master key that
can reset any password, and the script reminds you on every use.

## 8. Verify

Give the CLI a profile. `~/.config/pmcp/config.toml` holds named hub identities —
`url` and `token` are written by `pmcp login`, while `bootstrap_secret` is
hand-written and survives login/logout:

```toml
profile = "mine"

[profiles.mine]
url = "https://personal-mcps.<your-subdomain>.workers.dev"
bootstrap_secret = "<your-bootstrap-secret>"
```

Selection order is `--profile <name>` > `PMCP_PROFILE` > the file's top-level
`profile` > the name `default`; the flat `PMCP_URL` / `PMCP_TOKEN` env vars override
whatever the profile resolved. Inside the clone, `pnpm pmcp` is the CLI:

```bash
pnpm pmcp login
```

That is the RFC 8628 device flow — it prints a `<origin>/device` URL to approve in a
browser signed in as the user you just created. Then:

```bash
pnpm pmcp whoami
```

A `user:<username>` principal and your namespace means the auth stack, D1, and
`PUBLIC_ORIGIN` all agree.

For the full end-to-end walk — bootstrap, sign-in, device flow, admin MCP, a real
tunnel from your machine through Cloudflare's edge, an approval, the audit ledger,
then teardown:

```bash
pnpm smoke
```

It resolves `url` + `bootstrap_secret` from the same profile (`--profile <name>`
works, and `HUB_ORIGIN` / `PMCP_URL` / `BOOTSTRAP_SECRET` override it), runs under a
throwaway `smoke-<epoch>` namespace, and cleans up whatever a previous run left
behind. A failing suite is a bug in the hub; a failing smoke is a bug in the
*deployment* — a missing secret, an unmigrated database, a binding that did not ship.
That is the whole reason it exists.

## 9. What was the author's

Every place the repo names a deployment that is not yours:

| Where | What | Action |
|---|---|---|
| `wrangler.jsonc` → `vars.PUBLIC_ORIGIN` | `https://personal-mcps.ahrzb.workers.dev` | **Must change** — every absolute URL derives from it |
| `wrangler.jsonc` → `d1_databases[0].database_id` | the author's D1 id | **Must change** — replace with your `d1 create` output |
| `wrangler.jsonc` → `name` | `personal-mcps` | Optional — it is your workers.dev hostname |
| `server/migrations/0005_oauth.sql` | the origin as a SQL literal, twice | No action on a fresh deploy — the back-fill matches zero rows ([§5](#5-apply-the-migrations)) |
| `docs/quickstart-clients.md` | the origin in example commands | Docs only — substitute yours as you read |

There is no account id anywhere in the repo: `wrangler login` decides the account,
which is why [§0](#0-prerequisites) ends with `wrangler whoami`.

## 10. Optional extras

- **Sentry** — set `SENTRY_DSN` and redeploy. The Worker wraps its handler only when
  a DSN exists; request bodies are never captured and `beforeSend` strips
  `Authorization`.
- **better-auth Dash** — set `BETTER_AUTH_API_KEY` and redeploy. The plugin phones
  home by design, so it is constructed only where the key is deployed.
- **Custom domain** — attach it in the Cloudflare dashboard or via a `routes` entry,
  then set `PUBLIC_ORIGIN` to the new origin and redeploy. Sessions issued under the
  old origin will not carry over, and any already-provisioned `oauthResource`
  identifiers still name the old one.
- **Retention** — uncomment `AUDIT_RETENTION_DAYS` / `AUDIT_BODY_CAP_BYTES` in
  `vars` to override the defaults in `server/src/limits.ts`.

## 11. Connect clients

Your hub serves two MCP endpoint shapes, both streamable HTTP, both taking a
`pmcp_sa_…` service-account key as a bearer token:

```
https://<origin>/<user>/mcp            # aggregated — every service the account can reach
https://<origin>/<user>/mcp/<service>  # scoped to one service
```

Issue a key with `pnpm pmcp token issue --account <slug>`. To write a bot, put it
behind the tunnel, and point Claude Code at it, read the
[client quickstart](quickstart-clients.md) — substituting your origin for the one in
its examples.
