// fresh-auth.test.ts — decision 39: credential management demands recent authentication at
// better-auth's own `/api/auth` mount, not only on the hub's routes.
//
// What this suite pins: a cookie session older than better-auth's `session.freshAge`, posting
// straight at the mount (no hub route, a same-origin `Origin`, no `Authorization`), is refused
// every change to the owner's password, second factor, passkeys or sessions — refused with
// better-auth's OWN `freshSessionMiddleware` answer, and refused BEFORE the endpoint runs, so
// the credential it aimed at still stands. Every refusal carries its twin: a session signed in
// moments ago, sending the same body, gets through.
//
// THE `GUARDED` TABLE IS THE LIST. Decision 39 names the categories and defers the endpoint
// list to this table: an endpoint in those four categories the table misses is a gap in the
// table, not an exemption. Rows whose guard is "better-auth" are the library's own fresh gate
// (passkey registration), kept here so the list is whole and a better-auth upgrade that
// dropped it reddens a row; rows whose guard is "mount" are identity.authRoutes'.
//
// The second describe pins the other half of the decision — what a day-old session must STILL
// reach at the same mount: sign-in, the second-factor challenge that completes a sign-in (the
// same two endpoints as the signed-in enrolment arm, told apart by what the request carries),
// sign-out, the device-flow legs, and the OAuth provider's authorize and consent.
//
// The third pins the one endpoint the mount refuses to everyone: `/update-user`. The username
// it could rewrite is the first segment of every MCP URL and the `user:<name>` principal in
// every audit row, and nothing in the hub calls it — so it answers as a disabled better-auth
// endpoint does, for every field and every caller.
//
// Project: `worker` — real D1, real better-auth, driven through `exports.default.fetch`. Every
// row seeds its own namespace, so no row's revocation or rotation reaches another's.
//
// deps: harness/seed (namespaces, real sign-ins) · harness/totp (the authenticator's side) ·
//   src/index (default.fetch, Env) · src/identity (AUTH_BASE_PATH) · applyD1Migrations (setup)

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { AUTH_BASE_PATH } from "../../src/identity";
import worker from "../../src/index";
import type { Env } from "../../src/index";
import { seedNamespace, seedOwnerSession, SEEDED_OWNER_PASSWORD, uniqueSlug } from "../harness/seed";
import type { SeededNamespace, SeededSession } from "../harness/seed";
import { totpCode } from "../harness/totp";

const ORIGIN = (env as unknown as Env).PUBLIC_ORIGIN;

/**
 * One guarded endpoint. `arrange` builds whatever the endpoint acts on inside a fresh world
 * and hands back the request body plus a READ of the state the endpoint would change — the
 * postcondition both halves of the row are measured by.
 */
type GuardedRow = {
  /** Path under the mount, as better-auth routes it. */
  endpoint: string;
  /** Decision 39's four categories — the column a reviewer checks the list's coverage by. */
  category: "password" | "second factor" | "passkey" | "session";
  /** Whose check refuses the stale session: better-auth's own middleware, or the mount's. */
  guard: "better-auth" | "mount";
  /**
   * What the fresh twin's answer shows. `changes`: 200 and the state moved. `answers`: 200
   * with nothing stored (a ceremony's first leg). `reaches-handler`: the endpoint's own
   * refusal, never the freshness one — for an arm this test cannot complete (WebAuthn
   * attestation, an OTP nothing can deliver), where passing the gate is the whole claim.
   */
  twin: "changes" | "answers" | "reaches-handler";
  /** What the stale refusal leaves standing, for the row's title. */
  stands: string;
  arrange(world: World): Promise<Arranged>;
};

/** What a row's `arrange` hands the runner: the request, and the state it must not move. */
type Arranged = {
  /** The JSON body to POST; `null` makes the request a GET. */
  body: Record<string, unknown> | null;
  /** A comparable read of the state the endpoint would change. */
  state(): Promise<unknown>;
};

/** One owner with two browser sessions on either side of better-auth's freshness line. */
type World = { ns: SeededNamespace; stale: SeededSession; fresh: SeededSession };

const GUARDED: GuardedRow[] = [
  {
    endpoint: "/change-password",
    category: "password",
    guard: "mount",
    twin: "changes",
    stands: "the old password still signs in",
    async arrange(world) {
      return {
        body: { currentPassword: SEEDED_OWNER_PASSWORD, newPassword: NEW_PASSWORD },
        state: () => signsIn(world.ns.owner.username, SEEDED_OWNER_PASSWORD),
      };
    },
  },
  {
    endpoint: "/two-factor/enable",
    category: "second factor",
    guard: "mount",
    twin: "changes",
    stands: "no TOTP secret is minted",
    async arrange(world) {
      return {
        body: { password: SEEDED_OWNER_PASSWORD },
        state: () => twoFactorOf(world.ns.owner.userId),
      };
    },
  },
  {
    // The SIGNED-IN arm: a full session verifying the enrolment's first code, which is what
    // flips the factor live. The sign-in arm of the same endpoint is the second describe's.
    endpoint: "/two-factor/verify-totp",
    category: "second factor",
    guard: "mount",
    twin: "changes",
    stands: "the pending enrolment stays unverified and the factor off",
    async arrange(world) {
      const enabled = await direct("/two-factor/enable", world.fresh.cookie, {
        password: SEEDED_OWNER_PASSWORD,
      });
      const { totpURI } = (await enabled.json()) as { totpURI: string };
      return {
        body: { code: await totpCode(secretOf(totpURI)) },
        state: async () => ({
          enabled: await twoFactorEnabledOf(world.ns.owner.userId),
          verified: (await twoFactorOf(world.ns.owner.userId))?.verified,
        }),
      };
    },
  },
  {
    endpoint: "/two-factor/disable",
    category: "second factor",
    guard: "mount",
    twin: "changes",
    stands: "the factor stays on",
    async arrange(world) {
      await enrollTotp(world.ns);
      return {
        body: { password: SEEDED_OWNER_PASSWORD },
        state: () => twoFactorEnabledOf(world.ns.owner.userId),
      };
    },
  },
  {
    endpoint: "/two-factor/generate-backup-codes",
    category: "second factor",
    guard: "mount",
    twin: "changes",
    stands: "the backup-code set is the one enrolment issued",
    async arrange(world) {
      await enrollTotp(world.ns);
      return {
        body: { password: SEEDED_OWNER_PASSWORD },
        state: async () => (await twoFactorOf(world.ns.owner.userId))?.backupCodes,
      };
    },
  },
  {
    // The signed-in arm again: a full session spending one of its own backup codes.
    endpoint: "/two-factor/verify-backup-code",
    category: "second factor",
    guard: "mount",
    twin: "changes",
    stands: "the code is not spent",
    async arrange(world) {
      const { backupCodes } = await enrollTotp(world.ns);
      return {
        body: { code: backupCodes[0] },
        state: async () => (await twoFactorOf(world.ns.owner.userId))?.backupCodes,
      };
    },
  },
  {
    // The signed-in arm enables the factor as verify-totp's does. identity configures no OTP
    // delivery, so no code exists for the twin to present: it shows the gate passed, no more.
    endpoint: "/two-factor/verify-otp",
    category: "second factor",
    guard: "mount",
    twin: "reaches-handler",
    stands: "the factor stays off",
    async arrange(world) {
      return {
        body: { code: "000000" },
        state: () => twoFactorEnabledOf(world.ns.owner.userId),
      };
    },
  },
  {
    endpoint: "/passkey/generate-register-options",
    category: "passkey",
    guard: "better-auth",
    twin: "answers",
    stands: "no passkey is added",
    async arrange(world) {
      return { body: null, state: () => passkeysOf(world.ns.owner.userId) };
    },
  },
  {
    // No test can perform WebAuthn, so the twin ends at the attestation check — past the gate.
    endpoint: "/passkey/verify-registration",
    category: "passkey",
    guard: "better-auth",
    twin: "reaches-handler",
    stands: "no passkey is added",
    async arrange(world) {
      return { body: { response: {} }, state: () => passkeysOf(world.ns.owner.userId) };
    },
  },
  {
    endpoint: "/passkey/delete-passkey",
    category: "passkey",
    guard: "mount",
    twin: "changes",
    stands: "the passkey stays registered",
    async arrange(world) {
      const id = await plantPasskey(world.ns.owner.userId, "laptop");
      return { body: { id }, state: () => passkeysOf(world.ns.owner.userId) };
    },
  },
  {
    endpoint: "/passkey/update-passkey",
    category: "passkey",
    guard: "mount",
    twin: "changes",
    stands: "the passkey keeps its name",
    async arrange(world) {
      const id = await plantPasskey(world.ns.owner.userId, "laptop");
      return { body: { id, name: "renamed" }, state: () => passkeysOf(world.ns.owner.userId) };
    },
  },
  {
    endpoint: "/revoke-session",
    category: "session",
    guard: "mount",
    twin: "changes",
    stands: "the named session still lives",
    async arrange(world) {
      const victim = await seedOwnerSession(world.ns.owner);
      return { body: { token: victim.token }, state: () => alive(victim.cookie) };
    },
  },
  {
    endpoint: "/revoke-sessions",
    category: "session",
    guard: "mount",
    twin: "changes",
    stands: "every other session still lives",
    async arrange(world) {
      const victim = await seedOwnerSession(world.ns.owner);
      return { body: {}, state: () => alive(victim.cookie) };
    },
  },
  {
    endpoint: "/revoke-other-sessions",
    category: "session",
    guard: "mount",
    twin: "changes",
    stands: "every other session still lives",
    async arrange(world) {
      const victim = await seedOwnerSession(world.ns.owner);
      return { body: {}, state: () => alive(victim.cookie) };
    },
  },
];

describe("§4 · decision 39 — credential management at better-auth's own mount demands a fresh session", () => {
  for (const row of GUARDED) {
    it(`§4 · ${row.category} · ${row.endpoint} (${row.guard}) · a day-old cookie straight at the mount is refused with better-auth's own SESSION_NOT_FRESH answer and ${row.stands} · a session signed in moments ago gets through with the same body (the twin)`, async () => {
      const world = await seedWorld();
      const arranged = await row.arrange(world);
      const before = await arranged.state();
      const reference = await betterAuthsOwnRefusal(world.stale.cookie);

      const refused = await direct(row.endpoint, world.stale.cookie, arranged.body);
      expect(refused.status).toBe(reference.status);
      expect(await refused.json()).toEqual(reference.body);
      expect(await arranged.state()).toEqual(before);

      const accepted = await direct(row.endpoint, world.fresh.cookie, arranged.body);
      const answer = (await accepted.clone().json().catch(() => null)) as { code?: string } | null;
      expect(answer?.code, "the fresh twin met the freshness refusal").not.toBe(NOT_FRESH);
      if (row.twin === "reaches-handler") return;
      expect(accepted.status, await accepted.text()).toBe(200);
      if (row.twin === "changes") expect(await arranged.state()).not.toEqual(before);
    });
  }

  it(`§4 · the mount's refusal IS better-auth's: a day-old cookie at /change-password is answered with the status, body and content type /list-sessions' own freshSessionMiddleware answers it with — one shape for every client`, async () => {
    const world = await seedWorld();
    const reference = await betterAuthsOwnRefusal(world.stale.cookie);
    expect(reference.status).toBe(403);
    expect((reference.body as { code?: string }).code).toBe(NOT_FRESH);

    const refused = await direct("/change-password", world.stale.cookie, {
      currentPassword: SEEDED_OWNER_PASSWORD,
      newPassword: NEW_PASSWORD,
    });
    expect(refused.status).toBe(reference.status);
    expect(refused.headers.get("Content-Type")).toBe(reference.contentType);
    expect(await refused.json()).toEqual(reference.body);
  });
});

describe("§4 · decision 39 — what a day-old session still reaches at the same mount", () => {
  it(`§4 · sign-in is never refused for age: a password sign-in carrying a day-old cookie mints a new session`, async () => {
    const world = await seedWorld();
    const answered = await call(
      post("/sign-in/username", world.stale.cookie, {
        username: world.ns.owner.username,
        password: SEEDED_OWNER_PASSWORD,
      }),
    );
    expect(answered.status, await answered.clone().text()).toBe(200);
    expect(((await answered.json()) as { token?: string }).token).toEqual(expect.any(String));
  });

  it(`§4 · /two-factor/verify-totp decides its arm by what the request carries: the sign-in challenge completes although the browser signed in over a day-old cookie · the same challenge sent with that day-old session attached is the signed-in arm, and refused`, async () => {
    await challengeRow(async (enrolled) => totpCode(enrolled.secret), "/two-factor/verify-totp");
  });

  it(`§4 · /two-factor/verify-backup-code decides its arm the same way: the sign-in challenge completes with a backup code · the same challenge with the day-old session attached is refused and spends nothing`, async () => {
    await challengeRow(async (enrolled) => enrolled.backupCodes[0], "/two-factor/verify-backup-code");
  });

  it(`§4 · sign-out is never refused: a day-old session posting /sign-out ends`, async () => {
    const world = await seedWorld();
    const answered = await direct("/sign-out", world.stale.cookie, {});
    expect(answered.status, await answered.clone().text()).toBe(200);
    expect(await alive(world.stale.cookie)).toBe(false);
  });

  it(`§4/§13 · the device-flow legs are untouched: a day-old session claims and approves a user code, and the CLI redeems its token`, async () => {
    const world = await seedWorld();
    const codes = (await (
      await call(
        new Request(`${ORIGIN}${AUTH_BASE_PATH}/device/code`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ client_id: DEVICE_CLIENT_ID }),
        }),
      )
    ).json()) as { device_code: string; user_code: string };

    const claimed = await direct(`/device?user_code=${codes.user_code}`, world.stale.cookie, null);
    expect(claimed.status, await claimed.clone().text()).toBe(200);
    const approved = await direct("/device/approve", world.stale.cookie, { userCode: codes.user_code });
    expect(approved.status, await approved.clone().text()).toBe(200);

    const redeemed = await call(
      new Request(`${ORIGIN}${AUTH_BASE_PATH}/device/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: codes.device_code,
          client_id: DEVICE_CLIENT_ID,
        }),
      }),
    );
    expect(((await redeemed.json()) as { access_token?: string }).access_token).toEqual(expect.any(String));
  });

  it(`§19.5 · the OAuth provider's legs are untouched: a day-old session is sent on to consent by /oauth2/authorize, not to /login, and its consent is accepted with a code`, async () => {
    const world = await seedWorld();
    const registered = (await (
      await call(
        new Request(`${ORIGIN}${AUTH_BASE_PATH}/oauth2/register`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            client_name: "Fresh-auth Connector",
            redirect_uris: [REDIRECT_URI],
            token_endpoint_auth_method: "none",
            grant_types: ["authorization_code", "refresh_token"],
            response_types: ["code"],
          }),
        }),
      )
    ).json()) as { client_id: string };

    const query = new URLSearchParams({
      client_id: registered.client_id,
      redirect_uri: REDIRECT_URI,
      response_type: "code",
      scope: "mcp",
      code_challenge: CODE_CHALLENGE,
      code_challenge_method: "S256",
    });
    const authorized = await call(
      new Request(`${ORIGIN}${AUTH_BASE_PATH}/oauth2/authorize?${query}`, {
        headers: { Cookie: world.stale.cookie },
      }),
    );
    expect(authorized.status).toBe(302);
    const consentPage = new URL(authorized.headers.get("Location") ?? "", ORIGIN);
    expect(consentPage.pathname).toBe("/oauth/consent");

    const consented = await direct("/oauth2/consent", world.stale.cookie, {
      accept: true,
      oauth_query: consentPage.search.slice(1),
    });
    expect(consented.status, await consented.clone().text()).toBe(200);
    expect(((await consented.json()) as { url?: string }).url ?? "").toContain("code=");
  });
});

describe("§2 · /update-user is not available at the mount — the username is the namespace", () => {
  it(`§2 · a session signed in moments ago posting {"username"} to /api/auth/update-user gets the answer a disabled better-auth endpoint gives (/delete-user's) · the username is unchanged, the old one still signs in, and the namespace's MCP URL still resolves`, async () => {
    const ns = await seedNamespace(env.DB, { agents: [{ slug: "agent", tokens: [{ as: "live" }] }] });
    const fresh = await seedOwnerSession(ns.owner);
    const reference = await disabledEndpointAnswer(fresh.cookie);

    const refused = await direct("/update-user", fresh.cookie, { username: "x-renamed" });
    expect(await answerOf(refused)).toEqual(reference);
    expect((await userRowOf(ns.owner.userId))?.username).toBe(ns.owner.username);
    expect(await signsIn(ns.owner.username, SEEDED_OWNER_PASSWORD)).toBe(true);
    const mcp = await call(
      new Request(`${ORIGIN}/${ns.owner.username}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${ns.tokens.live.token}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
    );
    expect(mcp.status, await mcp.text()).toBe(200);
  });

  it(`§2 · every field is refused alike — {"name"} and {"image"} from a fresh session get the same disabled-endpoint answer and the user row is untouched`, async () => {
    const world = await seedWorld();
    const reference = await disabledEndpointAnswer(world.fresh.cookie);
    const before = await userRowOf(world.ns.owner.userId);
    for (const body of [{ name: "FAKE0000 renamed" }, { image: "https://example.invalid/face.png" }]) {
      const refused = await direct("/update-user", world.fresh.cookie, body);
      expect(await answerOf(refused), JSON.stringify(body)).toEqual(reference);
    }
    expect(await userRowOf(world.ns.owner.userId)).toEqual(before);
  });

  it(`§2 · whoever asks gets that one answer — a day-old session, and a request with no session at all, are answered as not available rather than as unfresh or unauthorized`, async () => {
    const world = await seedWorld();
    const reference = await disabledEndpointAnswer(world.fresh.cookie);
    expect(await answerOf(await direct("/update-user", world.stale.cookie, { username: "x-renamed" }))).toEqual(reference);
    const anonymous = await call(
      new Request(`${ORIGIN}${AUTH_BASE_PATH}/update-user`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: ORIGIN },
        body: JSON.stringify({ username: "x-renamed" }),
      }),
    );
    expect(await answerOf(anonymous)).toEqual(reference);
    expect((await userRowOf(world.ns.owner.userId))?.username).toBe(world.ns.owner.username);
  });
});

/* ------------------------------------------------------------------ *
 * The runner's pieces
 * ------------------------------------------------------------------ */

/** better-auth's error code for a session outside `freshAge` — what no twin may meet. */
const NOT_FRESH = "SESSION_NOT_FRESH";

/** Obviously fake, and past §4's floor, so a twin's refusal is never about length. */
const NEW_PASSWORD = "FAKE0000-the-new-owner-password";

/** The RFC 8628 client id the CLI presents — a fixture name, nothing is registered. */
const DEVICE_CLIENT_ID = "pmcp-cli";

/** claude.ai's real callback shape (§19.6), as oauth-provider.test.ts registers it. */
const REDIRECT_URI = "https://claude.ai/api/mcp/auth_callback";

/** RFC 7636 Appendix B's example S256 challenge — PKCE's gate, not a secret. */
const CODE_CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

/** Comfortably past better-auth's one-day `freshAge`, and nowhere near session expiry. */
const AGED_SESSION_MS = 3 * 24 * 60 * 60 * 1000;

/** Every request goes through the composition root, exactly as a browser's or a script's. */
function call(request: Request): Promise<Response> {
  return worker.fetch(request, env as unknown as Env);
}

/** A same-origin JSON POST at the mount under one cookie — the direct call decision 39 closes. */
function post(endpoint: string, cookie: string, body: Record<string, unknown>): Request {
  return new Request(`${ORIGIN}${AUTH_BASE_PATH}${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: cookie },
    body: JSON.stringify(body),
  });
}

/** `post`, or a GET carrying the same cookie and Origin when there is no body. */
function direct(endpoint: string, cookie: string, body: Record<string, unknown> | null): Promise<Response> {
  if (body !== null) return call(post(endpoint, cookie, body));
  return call(new Request(`${ORIGIN}${AUTH_BASE_PATH}${endpoint}`, { headers: { Origin: ORIGIN, Cookie: cookie } }));
}

/** A fresh namespace whose owner holds one day-old session and one signed in just now. */
async function seedWorld(): Promise<World> {
  const ns = await seedNamespace(env.DB, {});
  const stale = await seedOwnerSession(ns.owner);
  const fresh = await seedOwnerSession(ns.owner);
  await ageSession(stale.token);
  return { ns, stale, fresh };
}

/**
 * The refusal better-auth's own `freshSessionMiddleware` gives this cookie, at `/list-sessions`
 * — the reference every mount refusal is compared against, so no row spells the library's words.
 */
async function betterAuthsOwnRefusal(
  cookie: string,
): Promise<{ status: number; contentType: string | null; body: unknown }> {
  const answered = await direct("/list-sessions", cookie, null);
  return {
    status: answered.status,
    contentType: answered.headers.get("Content-Type"),
    body: await answered.json(),
  };
}

/** What a client can see of one answer — status, Content-Type and body text — as one value. */
type Answer = { status: number; contentType: string | null; body: string };

async function answerOf(response: Response): Promise<Answer> {
  return {
    status: response.status,
    contentType: response.headers.get("Content-Type"),
    body: await response.text(),
  };
}

/**
 * How better-auth answers an endpoint its config has switched off, read live: `/delete-user`
 * with `user.deleteUser` unset. The reference the mount's refusal of `/update-user` must be
 * indistinguishable from — if deleteUser is ever enabled this reference moves, and the rows
 * using it must pick another disabled endpoint rather than pass by accident.
 */
async function disabledEndpointAnswer(cookie: string): Promise<Answer> {
  const answered = await direct("/delete-user", cookie, {});
  expect(answered.status, "the reference endpoint is no longer disabled").toBe(404);
  return answerOf(answered);
}

/** The owner's user row as better-auth stores it — the fields /update-user could write. */
async function userRowOf(
  userId: string,
): Promise<{ username: string | null; name: string | null; image: string | null } | null> {
  return (env.DB as D1Like)
    .prepare(`SELECT "username", "name", "image" FROM "user" WHERE "id" = ?`)
    .bind(userId)
    .first();
}

/**
 * Both arms of one dual second-factor endpoint, in one owner's life: 2FA enrolled, a day-old
 * session in the browser, a password sign-in over it (which answers the challenge and expires
 * that cookie, as better-auth's sign-in hook does), then the challenge sent twice — first with
 * the day-old session re-attached, which makes it the signed-in arm and is refused with nothing
 * spent, then as the browser holds it, which completes the sign-in.
 */
async function challengeRow(
  codeFor: (enrolled: Enrolled) => Promise<string>,
  endpoint: string,
): Promise<void> {
  const world = await seedWorld();
  const enrolled = await enrollTotp(world.ns);
  const signIn = await call(
    post("/sign-in/username", world.stale.cookie, {
      username: world.ns.owner.username,
      password: SEEDED_OWNER_PASSWORD,
    }),
  );
  expect(((await signIn.json()) as { twoFactorRedirect?: boolean }).twoFactorRedirect).toBe(true);
  const jar = carried([world.stale.cookie], signIn);
  expect(jar, "the sign-in left the day-old session cookie in place").not.toContain(world.stale.cookie);
  const code = await codeFor(enrolled);
  const factor = await twoFactorOf(world.ns.owner.userId);

  const signedInArm = await call(post(endpoint, [...jar, world.stale.cookie].join("; "), { code }));
  expect(signedInArm.status).toBe(403);
  expect(((await signedInArm.json()) as { code?: string }).code).toBe(NOT_FRESH);
  expect(await twoFactorOf(world.ns.owner.userId)).toEqual(factor);

  const challenge = await call(post(endpoint, jar.join("; "), { code }));
  expect(challenge.status, await challenge.clone().text()).toBe(200);
  const { token } = (await challenge.json()) as { token?: string };
  expect(token).toEqual(expect.any(String));
  expect(carried(jar, challenge).some((pair) => pair.includes(`=${token}.`))).toBe(true);
}

/** What enrolment hands the authenticator: the TOTP secret, and the one-time backup codes. */
type Enrolled = { secret: string; backupCodes: string[] };

/**
 * Turn the owner's TOTP factor on the way the Two-factor pane does — enable, then verify the
 * first code — under a session of its own, so the world's fresh and stale sessions keep their
 * ages. The verify replaces that enrolling session; no other session is touched.
 */
async function enrollTotp(ns: SeededNamespace): Promise<Enrolled> {
  const enroller = await seedOwnerSession(ns.owner);
  const enabled = await direct("/two-factor/enable", enroller.cookie, { password: SEEDED_OWNER_PASSWORD });
  const { totpURI, backupCodes } = (await enabled.json()) as { totpURI: string; backupCodes: string[] };
  const secret = secretOf(totpURI);
  const verified = await direct("/two-factor/verify-totp", enroller.cookie, { code: await totpCode(secret) });
  if (verified.status !== 200) throw new Error(`enrolment failed: ${verified.status} ${await verified.text()}`);
  return { secret, backupCodes };
}

/** The base32 secret an `otpauth://` URI carries — what an authenticator app reads off it. */
function secretOf(totpURI: string): string {
  const secret = new URL(totpURI).searchParams.get("secret");
  if (secret === null) throw new Error("the enrolment answered no secret");
  return secret;
}

/**
 * A browser's cookie jar after one response: `name=value` pairs, with every Set-Cookie applied —
 * an empty value or `Max-Age=0` removes the cookie, as better-auth's `expireCookie` spells it.
 */
function carried(cookies: string[], response: Response): string[] {
  const jar = new Map(cookies.map((pair) => [pair.slice(0, pair.indexOf("=")), pair]));
  for (const header of response.headers.getSetCookie()) {
    const pair = header.split(";")[0];
    const name = pair.slice(0, pair.indexOf("="));
    if (pair.slice(name.length + 1) === "" || /max-age=0\b/i.test(header)) jar.delete(name);
    else jar.set(name, pair);
  }
  return [...jar.values()];
}

/** Whether a password still opens the door — a JSON sign-in at the mount answering 200. */
async function signsIn(username: string, password: string): Promise<boolean> {
  const answered = await call(
    new Request(`${ORIGIN}${AUTH_BASE_PATH}/sign-in/username`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: ORIGIN },
      body: JSON.stringify({ username, password }),
    }),
  );
  return answered.status === 200;
}

/** Whether a session cookie still resolves to a session — better-auth's own read of it. */
async function alive(cookie: string): Promise<boolean> {
  const answered = await direct("/get-session", cookie, null);
  return (await answered.json()) !== null;
}

/**
 * Age one session past better-auth's freshness window — the passage of time, the one state no
 * seam can express (a production affordance for "make this session old" is what must not
 * exist). better-auth's SQLite adapter stores dates as ISO-8601 text, so the write speaks that.
 */
async function ageSession(token: string): Promise<void> {
  await (env.DB as D1Like)
    .prepare(`UPDATE "session" SET "createdAt" = ? WHERE "token" = ?`)
    .bind(new Date(Date.now() - AGED_SESSION_MS).toISOString(), token)
    .run();
}

/** The owner's two-factor row as better-auth stores it, or null when none was ever minted. */
async function twoFactorOf(
  userId: string,
): Promise<{ secret: string; backupCodes: string; verified: number | null } | null> {
  return (env.DB as D1Like)
    .prepare(`SELECT "secret", "backupCodes", "verified" FROM "twoFactor" WHERE "userId" = ?`)
    .bind(userId)
    .first();
}

/** better-auth's own flag for "the second factor is live" on the user row. */
async function twoFactorEnabledOf(userId: string): Promise<number> {
  const row = await (env.DB as D1Like)
    .prepare(`SELECT "twoFactorEnabled" AS enabled FROM "user" WHERE "id" = ?`)
    .bind(userId)
    .first<{ enabled: number | null }>();
  return row?.enabled ?? 0;
}

/** The owner's passkeys, id and name — the state every passkey row is measured by. */
async function passkeysOf(userId: string): Promise<{ id: string; name: string | null }[]> {
  const { results } = await (env.DB as D1Like)
    .prepare(`SELECT "id", "name" FROM "passkey" WHERE "userId" = ? ORDER BY "id"`)
    .bind(userId)
    .all<{ id: string; name: string | null }>();
  return results;
}

/**
 * A registered passkey's row, minus the ceremony no test can perform: written the way the
 * plugin writes it (its columns, ISO dates), and everything afterwards goes through the mount.
 */
async function plantPasskey(userId: string, name: string): Promise<string> {
  const id = uniqueSlug("pk");
  await (env.DB as D1Like)
    .prepare(
      `INSERT INTO "passkey" ("id", "name", "publicKey", "userId", "credentialID", "counter", "deviceType", "backedUp", "createdAt")
       VALUES (?, ?, 'pk', ?, ?, 0, 'singleDevice', 0, ?)`,
    )
    .bind(id, name, userId, uniqueSlug("cred"), new Date().toISOString())
    .run();
  return id;
}
