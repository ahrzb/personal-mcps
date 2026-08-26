// oauth-provider.test.ts — §19.3's two provider-config properties, the ones the door's whole
// authority model rests on. Neither is a hub behavior we wrote; both are @better-auth/oauth-
// provider's, configured by identity.ts's oauthProvider() options and PINNED here because
// §19.3 makes them blocking: without them, open dynamic registration is open impersonation.
//
//   1. The authorization server ASSIGNS client_id. A registration body naming its own is
//      ignored and a fresh id minted — so a client can never name an already-consented id
//      and step into its oauth_binding (§19.4's UNIQUE(owner_id, client_id) resolves
//      authority from (owner, client_id) alone).
//   2. redirect_uri is matched as an EXACT string. The hub performs the final browser
//      redirect (§19.5 step 4), so a loose match is an open redirector carrying an
//      authorization code — the classic way an AS gives its codes away.
//
// These ride the provider's own endpoints under the EXISTING /api/auth mount (§19.2, no
// route work), reached through the composition root's `worker.fetch` exactly as routes.test.ts
// drives it. No session is ever established: registration is anonymous DCR, and the authorize
// cases assert the redirect-URI verdict, which the provider reaches BEFORE any login or
// consent screen. Nothing here reads a token — the door (auth-matrix.test.ts) owns that.
//
// Project: `worker` — the provider only exists inside a running worker with a real D1 (its
// oauthClient rows), and better-auth signs with its default dev secret under test.
//
// deps: src/index (worker.fetch) · src/identity (auth() plugin list) · applyD1Migrations

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../../src/index";
import type { Env } from "../../src/index";

const ORIGIN = (env as unknown as { PUBLIC_ORIGIN: string }).PUBLIC_ORIGIN;
const AUTH = `${ORIGIN}/api/auth/oauth2`;

/** A registered redirect URI shaped like claude.ai's real one (§19.6): https, non-loopback,
 *  so the provider's "web" application-type policy accepts it and exact matching is the only
 *  thing that decides an authorize request's redirect verdict. */
const REDIRECT_URI = "https://claude.ai/api/mcp/auth_callback";

/** RFC 7636 Appendix B's example S256 challenge — a real base64url challenge value, not a
 *  secret. Present only so the authorize flow's PKCE gate (public clients require it) passes
 *  and the request reaches the redirect-URI verdict rather than erroring on a missing one. */
const CODE_CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

function call(request: Request): Promise<Response> {
  return worker.fetch(request, env as unknown as Env);
}

/**
 * Registers a public client via anonymous DCR (§19.3) and returns the server-assigned
 * client_id. `extraBody` lets a case smuggle its own `client_id` into the request to prove
 * it is ignored.
 */
async function registerClient(
  redirectUris: string[] = [REDIRECT_URI],
  extraBody: Record<string, unknown> = {},
): Promise<Response> {
  return call(
    new Request(`${AUTH}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "Test Connector",
        redirect_uris: redirectUris,
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        ...extraBody,
      }),
    }),
  );
}

/** GETs the authorize endpoint for a client, with a valid PKCE challenge and no session, so
 *  the response's whole content is the provider's redirect-URI verdict. */
async function authorize(clientId: string, redirectUri: string): Promise<Response> {
  const q = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "mcp",
    code_challenge: CODE_CHALLENGE,
    code_challenge_method: "S256",
  });
  // No `redirect: "manual"` needed — worker.fetch returns the 302 itself; a plain GET with no
  // Sec-Fetch/Accept:json headers takes the provider's `throw ctx.redirect(...)` branch.
  return call(new Request(`${AUTH}/authorize?${q}`, { method: "GET" }));
}

describe("§19.3 · the authorization server assigns client identity", () => {
  it(
    "§19.3 · a registration body carrying its own client_id gets a different, server-assigned one back — a client can never name an existing id and inherit its binding",
    async () => {
      const chosen = "attacker-chosen-client-id";
      const response = await registerClient([REDIRECT_URI], { client_id: chosen });
      expect(response.ok).toBe(true);
      const body = (await response.json()) as { client_id?: string };
      expect(typeof body.client_id).toBe("string");
      expect(body.client_id).not.toBe(chosen);
    },
  );
});

describe("§19.3 · redirect_uri is matched as an exact string", () => {
  it(
    "§19.3 · an authorize request whose redirect_uri is not an exactly-registered string is refused before the consent screen renders and issues no code · the registered string byte-for-byte is accepted (the twin)",
    async () => {
      const registered = (await (await registerClient()).json()) as { client_id: string };

      // Refusal: a redirect_uri that was never registered. The provider redirects to its own
      // /error page (invalid_redirect), never to the client and never to /login — and no code.
      const refused = await authorize(registered.client_id, "https://evil.example/callback");
      expect(refused.status).toBe(302);
      const refusedLocation = refused.headers.get("location") ?? "";
      expect(refusedLocation).toMatch(/invalid_redirect|\/error/);
      expect(refusedLocation).not.toContain("code=");
      expect(refusedLocation).not.toContain("/login");

      // Twin: the registered string byte-for-byte. With no session the provider proceeds to
      // the login page carrying the signed query — the redirect_uri was accepted.
      const accepted = await authorize(registered.client_id, REDIRECT_URI);
      expect(accepted.status).toBe(302);
      const acceptedLocation = accepted.headers.get("location") ?? "";
      expect(acceptedLocation).toContain("/login");
      expect(acceptedLocation).not.toMatch(/error=invalid_redirect/);
      expect(acceptedLocation).not.toContain("code=");
    },
  );

  it(
    "§19.3 · a redirect_uri differing only by a trailing slash, an added port, or an extra path segment is refused — matching is exact, with no prefix, wildcard, or port-agnostic form for https",
    async () => {
      const registered = (await (await registerClient()).json()) as { client_id: string };

      // Each near-miss of the registered https URI. None is loopback, so the provider's RFC
      // 8252 port-variance carve-out does not apply and every one must miss.
      const nearMisses = [
        `${REDIRECT_URI}/`, // trailing slash
        "https://claude.ai:443/api/mcp/auth_callback", // added (default) port
        `${REDIRECT_URI}/extra`, // extra path segment
      ];
      for (const redirectUri of nearMisses) {
        const response = await authorize(registered.client_id, redirectUri);
        expect(response.status).toBe(302);
        const location = response.headers.get("location") ?? "";
        expect(location, `redirect_uri ${redirectUri} must be refused`).toMatch(
          /invalid_redirect|\/error/,
        );
        expect(location).not.toContain("code=");
        expect(location).not.toContain("/login");
      }

      // The exact string still matches, so the near-miss refusals are about exactness, not a
      // broken client.
      const exact = await authorize(registered.client_id, REDIRECT_URI);
      expect(exact.headers.get("location") ?? "").toContain("/login");
    },
  );
});
