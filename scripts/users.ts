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
 * A refused invocation, classified rather than described — the operator's next action
 * differs per class and the message wording is incidental (§7's durable/incidental rule).
 * `route-disabled` is the 404 that means BOOTSTRAP_SECRET is unset on the Worker (never a
 * plain not-found), `wrong-secret` is the 401, and `http` is every other non-2xx, whose
 * `status` survives into the failure so a 500 is distinguishable from a 502.
 */
export class BootstrapError extends Error {
  readonly kind: "route-disabled" | "wrong-secret" | "http";
  readonly status: number;
  constructor(kind: "route-disabled" | "wrong-secret" | "http", status: number, message: string) {
    super(message);
    this.kind = kind;
    this.status = status;
  }
}

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
  const response = await fetch(`${target.origin.replace(/\/+$/, "")}/internal/users`, {
    method: "POST",
    // The secret rides the header and nowhere else: never the body, never the URL.
    headers: { Authorization: `Bearer ${target.secret}`, "Content-Type": "application/json" },
    body: JSON.stringify(req),
    // This is the one request in the system carrying an all-namespaces master key, and
    // fetch follows redirects transparently by default while undici strips `authorization`
    // on CROSS-origin redirects only — so a same-origin 302 to any other route would walk
    // off with the key. A 3xx reaches the mapping below as an ordinary failure instead.
    redirect: "manual",
  });
  if (response.status === 404) {
    throw new BootstrapError("route-disabled", 404, "the bootstrap route does not exist: BOOTSTRAP_SECRET is unset on the Worker (`wrangler secret put BOOTSTRAP_SECRET`)");
  }
  if (response.status === 401) throw new BootstrapError("wrong-secret", 401, "the bootstrap secret was rejected");
  if (!response.ok) throw new BootstrapError("http", response.status, `POST /internal/users → ${response.status}`);
  return (await response.json()) as BootstrapResponse;
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
  const [op, username] = argv;
  const usage = "usage: pnpm users <create|list|delete|reset-password> [username]";
  if (op !== "create" && op !== "list" && op !== "delete" && op !== "reset-password") {
    return fail(usage);
  }
  if (op !== "list" && (username === undefined || username === "")) return fail(`${op} needs a username — ${usage}`);
  // Read from the environment, never from a flag: the master key stays out of shell
  // history and process listings — and a missing one fails before any request is made.
  const origin = process.env.PMCP_URL;
  const secret = process.env.BOOTSTRAP_SECRET;
  if (origin === undefined || origin === "") return fail("PMCP_URL is not set");
  if (secret === undefined || secret === "") return fail("BOOTSTRAP_SECRET is not set");

  try {
    const request = (op === "list" ? { op } : { op, username: username as string }) as BootstrapRequest;
    const result = await bootstrap({ origin, secret }, request);
    if (result.op === "list") {
      process.stdout.write(`${result.usernames.length === 0 ? "(no users)" : result.usernames.join("\n")}\n`);
      return 0;
    }
    if (result.op === "delete") {
      process.stdout.write(`deleted ${result.username}\n`);
      return 0;
    }
    // The one plaintext appearance this credential will ever have (§12) — stdout, once.
    process.stdout.write(`${result.username}\n${result.password}\n`);
    process.stderr.write(
      "BOOTSTRAP_SECRET is an all-namespaces master key (it can reset any password): rotate it now.\n",
    );
    return 0;
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

/** One operator-facing failure line on stderr, and the exit code that goes with it. */
function fail(message: string): number {
  process.stderr.write(`${message}\n`);
  return 1;
}
