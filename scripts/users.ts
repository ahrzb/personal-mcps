/**
 * scripts/users.ts — the bootstrap client (§12): `pnpm users
 * create|list|delete|reset-password`, talking to POST /internal/users guarded
 * by BOOTSTRAP_SECRET.
 *
 * This module OWNS the operator side of the bootstrap contract: the argv
 * grammar of the four subcommands, the request/response wire shapes below
 * (copied, not shared — tests pin both sides), and the once-only printing of
 * generated passwords. Together with the server route it is the ONLY password
 * path in the system — there is deliberately no self-serve password change
 * anywhere (§4, §12), so a compromised session can never rotate a password to
 * lock the owner out. Everything clever is HIDDEN server-side by design:
 * password generation, the constant-time secret compare, the
 * route-does-not-exist-while-unset behavior, audit rows (principal
 * `bootstrap`), namespace teardown on delete, and reset-password leaving
 * TOTP/passkey enrollment intact. This script is a thin, honest messenger.
 */

/**
 * COPIED wire shape — the POST /internal/users request body, one op per
 * request (the server route is identity.bootstrapRoute; tests pin both
 * sides). The secret rides `Authorization: Bearer`, never the body or URL.
 * Passwords never appear here: the server generates them (§12).
 */
export type BootstrapRequest =
  | { op: "create"; username: string }
  | { op: "list" }
  | { op: "delete"; username: string }
  | { op: "reset-password"; username: string };

/**
 * COPIED wire shape — the success body, echoing `op` so the shape is
 * self-describing. `password` is the only plaintext appearance that
 * credential will ever have: shown once by this script, stored and logged
 * nowhere (§12). `delete` succeeds even for an absent username — the
 * postcondition is absence.
 */
export type BootstrapResponse =
  | { op: "create" | "reset-password"; username: string; password: string }
  | { op: "list"; usernames: string[] }
  | { op: "delete"; username: string };

/** Where and how to reach the route: the hub's https origin and the secret. */
export type BootstrapTarget = { origin: string; secret: string };

/**
 * One bootstrap invocation: POSTs `req` to `<origin>/internal/users` with the
 * secret as the bearer. Failure mapping is part of the contract: 404 means
 * the route is disabled — BOOTSTRAP_SECRET unset on the Worker (§12) — and is
 * reported as exactly that, not "not found"; 401 is a wrong secret; any other
 * non-2xx throws with the status. Never retries on its own — every accepted
 * invocation is audited server-side and `create` is not idempotent.
 */
export async function bootstrap(
  target: BootstrapTarget,
  req: BootstrapRequest,
): Promise<BootstrapResponse> {
  // deps: fetch
  throw new Error("unimplemented");
}

/**
 * `pnpm users <create|list|delete|reset-password> [username]` — parses argv,
 * reads the hub origin from PMCP_URL and the secret from the BOOTSTRAP_SECRET
 * environment variable (an env var, never a flag, so the master key stays out
 * of shell history and process listings), runs the op, prints the result.
 * `create` / `reset-password` write the password to stdout exactly once; a
 * reminder that the secret is an all-namespaces master key to rotate after
 * use (§12) goes to stderr. Exit 0 on success, 1 otherwise.
 */
export async function main(argv: string[]): Promise<number> {
  // deps: bootstrap · node:process
  throw new Error("unimplemented");
}
