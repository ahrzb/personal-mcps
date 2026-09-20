/**
 * The three facts the SPA cannot read from an API and must not compute: the CSRF token
 * minted for this cookie session, the signed-in owner's username, and the hub's canonical
 * public origin. All three are the server's to state, so the Worker's shell document carries
 * them in a `<script type="application/json">` block — a JSON island rather than an
 * executable one, which is why the page needs no `script-src` relaxation in the existing CSP.
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
};

/**
 * The element the shell emits. Absent only if this module is loaded outside that document,
 * which is a wiring mistake rather than a state to render — so it throws rather than
 * defaulting to a token that would make every write 403 with no explanation.
 */
export function readBootstrap(): Bootstrap {
  const element = document.getElementById("pmcp-bootstrap");
  if (element === null) throw new Error("pmcp: the shell document carries no #pmcp-bootstrap block");
  const parsed: unknown = JSON.parse(element.textContent ?? "");
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("csrf" in parsed) ||
    !("username" in parsed) ||
    !("origin" in parsed) ||
    typeof parsed.csrf !== "string" ||
    typeof parsed.username !== "string" ||
    typeof parsed.origin !== "string"
  ) {
    throw new Error("pmcp: #pmcp-bootstrap is not {csrf, username, origin}");
  }
  return { csrf: parsed.csrf, username: parsed.username, origin: parsed.origin };
}
