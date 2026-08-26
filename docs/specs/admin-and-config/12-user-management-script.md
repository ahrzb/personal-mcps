## 12. User management script

`scripts/users.ts` (run with `pnpm users …`), talking to `POST /internal/users` on the
Worker, guarded by a `BOOTSTRAP_SECRET` wrangler secret (constant-time compare). When
the secret is **unset, the route does not exist** (404 for everything) — so the owner
can keep it disabled between uses and re-enable with `wrangler secret put`. Every
invocation is logged. This secret is an all-namespaces master key (it can reset any
password): rotate it after each use, on any suspicion. `reset-password` deliberately
leaves TOTP/passkey enrollment intact, so a leaked secret alone doesn't defeat the
second factor. No email involved anywhere.

```
pnpm users create <username>     # generates a random password, prints it once
pnpm users list
pnpm users delete <username>
pnpm users reset-password <username>
```

The script itself reads only `PMCP_URL` and `BOOTSTRAP_SECRET` from the environment
(the master key never rides argv). Its `pnpm users` entry resolves a §10 profile
first — `--profile <name>` (consumed before the subcommand) or `PMCP_PROFILE`, then
the config file's default — filling those two variables from the profile's `url` and
`bootstrap_secret` wherever the environment hasn't already set them; an explicit
environment variable always wins *(amended 2026-08-26)*.

This seeds the first user and is the only user management surface for now. 2FA/passkey
enrollment happens through better-auth's endpoints after first login (minimal pages, §13).

