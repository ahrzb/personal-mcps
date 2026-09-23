// `/login`'s card-switch links (decision 38, family 5) — the one piece of /login the CLIENT
// builds. Everything else on the page is the server's island; these links are the client's,
// and they must carry the landing so the next card posts the same `callbackURL` the one it
// left was posting (routes design §5, rows 2147 / 2178). Over `web/src/lib/paths.ts`'s
// `loginUrl`, a verbatim copy of `pages/model.ts`'s, reachable from plain Node.

import { describe, expect, it } from "vitest";
import { loginUrl, paths } from "../../../web/src/lib/paths.ts";

describe("a card switch is /login plus the method and the landing", () => {
  it("carries the landing as next=, and a missing one is no key at all", () => {
    expect(loginUrl({ method: "backup-code", next: "/approvals/apr_8f2k" })).toBe(
      "/login?method=backup-code&next=%2Fapprovals%2Fapr_8f2k",
    );
    expect(loginUrl({ method: "totp", next: null })).toBe("/login?method=totp");
    expect(loginUrl({})).toBe(paths.login);
  });

  it("§19.5's signed authorize landing survives the round trip byte for byte", () => {
    const landing =
      "/api/auth/oauth2/authorize?client_id=cli_FAKE&redirect_uri=https%3A%2F%2Fclaude.ai%2Fcb&state=s+t&sig=AbC_-9";
    const href = loginUrl({ method: "backup-code", next: landing });
    // What the server reads back out of the switch link's query is the landing it sent.
    expect(new URL(href, "https://hub.example").searchParams.get("next")).toBe(landing);
  });

  it("the three kept form targets are the Worker's own translating routes", () => {
    expect([paths.signIn, paths.totpVerify, paths.backupCodeVerify, paths.signOut]).toEqual([
      "/login/sign-in/username",
      "/login/two-factor/verify-totp",
      "/login/two-factor/verify-backup-code",
      "/login/sign-out",
    ]);
  });
});
