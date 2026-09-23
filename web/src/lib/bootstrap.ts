/**
 * The four facts the SPA cannot read from an API and must not compute: the CSRF token
 * minted for this cookie session, the signed-in owner's username, the hub's canonical
 * public origin, and the Web Push public key. All four are the server's to state, so the
 * Worker's shell document carries them in a `<script type="application/json">` block — a
 * JSON island rather than an executable one, which is why the page needs no `script-src`
 * relaxation in the existing CSP.
 *
 * Read ONCE at module load rather than per use: the document never changes under a running
 * client, and a second read would suggest it might.
 */
export type Bootstrap = {
  /** The token every non-GET carries as `X-Pmcp-Csrf`. Stable for the life of the cookie
   *  session and meaningless outside it. */
  csrf: string;
  /** The namespace owner, shown in the header beside Sign out and embedded in every scoped
   *  endpoint URL the surfaces hand over. */
  username: string;
  /**
   * `env.PUBLIC_ORIGIN` — scheme + host, no trailing slash.
   *
   * NOT `location.origin`, and the difference is not cosmetic: a scoped endpoint URL is a
   * value the owner COPIES into a bot's configuration, and the canonical origin is the one
   * the hub puts on the wire everywhere else (§7's approvalUrl, the CIMD document, the
   * `wss://` the clients derive). A browser reaching the dashboard on some other host would
   * otherwise be handed an endpoint naming that host.
   */
  origin: string;
  /**
   * `env.VAPID_PUBLIC_KEY`, base64url — what `/approvals`' notifications control hands to
   * `PushManager.subscribe` (§13). Configuration like `origin`, and reported by no API.
   * `""` where the deployment has no key configured: the control still renders, and a
   * subscribe against it fails and says so.
   */
  vapidPublicKey: string;
};

/**
 * The element the shell emits on every session-gated page. Absent anywhere but `/login`, it
 * means this module was loaded outside that document — a wiring mistake rather than a state
 * to render — so it throws rather than defaulting to a token that would make every write 403
 * with no explanation. `/login` alone has no session and therefore no bootstrap.
 */
export function readBootstrap(): Bootstrap {
  const element = document.getElementById("pmcp-bootstrap");
  if (element === null) {
    // /login is the one document with no session, so the Worker writes no bootstrap there
    // (routes design §5). An inert one stands in for it: every field empty, so a write made
    // with it would carry no token and be refused — and /login makes none.
    if (location.pathname === "/login") return { csrf: "", username: "", origin: "", vapidPublicKey: "" };
    throw new Error("pmcp: the shell document carries no #pmcp-bootstrap block");
  }
  const parsed: unknown = JSON.parse(element.textContent ?? "");
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("csrf" in parsed) ||
    !("username" in parsed) ||
    !("origin" in parsed) ||
    !("vapidPublicKey" in parsed) ||
    typeof parsed.csrf !== "string" ||
    typeof parsed.username !== "string" ||
    typeof parsed.origin !== "string" ||
    typeof parsed.vapidPublicKey !== "string"
  ) {
    throw new Error("pmcp: #pmcp-bootstrap is not {csrf, username, origin, vapidPublicKey}");
  }
  return {
    csrf: parsed.csrf,
    username: parsed.username,
    origin: parsed.origin,
    vapidPublicKey: parsed.vapidPublicKey,
  };
}

/**
 * `/login`'s island (`#pmcp-login`, routes design §5) — `pages/model.ts`'s `loginIsland`.
 * Computed on the SERVER for every request, because both of its judgements are the
 * server's to make: which card the query asks for, and where a sign-in may land (the
 * relative-only rule on `?next=`, and §19.5's constant authorize landing for a signed OAuth
 * request). Every string in it is untrusted — any link can set `?error=`, `?username=` and
 * `?next=` — so the page draws each as a text node or an attribute value, never markup.
 */
export type LoginIsland = {
  step:
    | { kind: "credentials"; username: string; error: string | null }
    | { kind: "totp"; error: string | null }
    | { kind: "backup-code"; error: string | null };
  /** Where a sign-in lands — the hidden `callbackURL` and the passkey's landing alike — or
   *  null, which means `/apps`. */
  redirectTo: string | null;
};

/**
 * The island, validated. Absent only when a page other than `/login` asks, which is a wiring
 * mistake — so it throws, as `readBootstrap` does. Read by the page on mount rather than here
 * at module load, which is what lets the preview gallery write one per state.
 */
export function readLoginIsland(): LoginIsland {
  const element = document.getElementById("pmcp-login");
  if (element === null) throw new Error("pmcp: /login's document carries no #pmcp-login block");
  const parsed: unknown = JSON.parse(element.textContent ?? "");
  if (typeof parsed !== "object" || parsed === null) throw new Error("pmcp: #pmcp-login is not {step, redirectTo}");
  const island = parsed as { step?: { kind?: unknown; username?: unknown; error?: unknown }; redirectTo?: unknown };
  const step = island.step;
  const nullableText = (value: unknown): value is string | null => value === null || typeof value === "string";
  const ok =
    typeof step === "object" &&
    step !== null &&
    nullableText(step.error) &&
    nullableText(island.redirectTo) &&
    (step.kind === "totp" ||
      step.kind === "backup-code" ||
      (step.kind === "credentials" && typeof step.username === "string"));
  if (!ok) throw new Error("pmcp: #pmcp-login is not {step, redirectTo}");
  return parsed as LoginIsland;
}
