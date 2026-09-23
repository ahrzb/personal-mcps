// `/settings` as pure rules (decision 38, family 2): the view rules the routes design (§2)
// moves to the client once the server answers one read — which dialog a `?confirm=` opens,
// which control a refused password change named, the rail's markers as list lengths, the
// Tokens filter, the Execution pane's sentence placement, the password-change success copy
// — over `web/src/features/settings/derive.ts` and `web/src/lib/notice.ts`, both reachable
// from plain Node for `audit-derive.test.ts`'s reason.
//
// The server half — the read's lists, every write's `next`, the recent-auth prefix — is
// pinned at `/api/hub/settings/*` by the worker suite; this file pins what the page does
// with what it is handed.

import { describe, expect, it } from "vitest";
import {
  confirmedLine,
  executionErrors,
  formatRelative,
  listedTokens,
  passwordErrorOf,
  passwordRefusal,
  railEntries,
  sessionLabel,
  settingsConfirm,
  settingsPaneOf,
  timeoutLabel,
  tokenKindOf,
} from "../../../web/src/features/settings/derive.ts";
import { noticeOf } from "../../../web/src/lib/notice.ts";
import { paths } from "../../../web/src/lib/paths.ts";
import type { SessionRow, SettingsRead, SettingsTokenRow } from "../../../web/src/lib/types.ts";

/** The instant the gallery renders at — the retired server states preview's own, kept so a state reads the same. */
const NOW = Date.parse("2026-08-24T14:47:00.000Z");

const session = (over: Partial<SessionRow>): SessionRow => ({
  id: "ses_1",
  client: "Chrome on Windows",
  source: "web",
  createdAt: "2026-08-24T14:43:00.000Z",
  lastActiveAt: "2026-08-24T14:47:00.000Z",
  current: false,
  ...over,
});

const token = (id: string, kind: SettingsTokenRow["kind"]): SettingsTokenRow => ({
  id,
  prefix: `pmcp_${kind}_${id}`,
  kind,
  boundTo: "claude",
  createdAt: NOW,
  expiresAt: null,
  lastUsedAt: null,
  expired: false,
});

const READ: SettingsRead = {
  twoFactor: { enabled: true },
  passkeys: [{ id: "pk_1", name: "Windows Hello", addedAt: "2026-03-12T09:14:00.000Z", lastUsedAt: null }],
  sessions: [
    session({ id: "ses_me", current: true }),
    session({ id: "ses_cli", client: "pmcp CLI", source: "cli" }),
  ],
  tokens: [token("a1", "agent"), token("a2", "agent"), token("p1", "app")],
  connections: [
    {
      id: "con_live",
      clientId: "client_live",
      clientName: null,
      agentSlug: "claude",
      createdAt: NOW,
      lastUsedAt: null,
      revokedAt: null,
      redirectOrigin: "https://claude.ai",
      selfRegistered: false,
    },
    {
      id: "con_gone",
      clientId: "client_gone",
      clientName: "Gone",
      agentSlug: "cron",
      createdAt: NOW,
      lastUsedAt: null,
      revokedAt: NOW,
      redirectOrigin: "https://gone.example",
      selfRegistered: true,
    },
  ],
  execution: { defaultTimeoutMs: 30_000, maxTimeoutMs: 1_500 },
  limits: { passwordMinLength: 12, minTimeoutMs: 1_000, maxTimeoutMs: 300_000 },
};

describe("which pane a URL names (the landing pane has no alias)", () => {
  it("/settings is Password, and /settings/password is no pane at all", () => {
    expect(settingsPaneOf(undefined)).toBe("password");
    expect(settingsPaneOf("password")).toBeNull();
    expect(settingsPaneOf("tokens")).toBe("tokens");
    expect(settingsPaneOf("wat")).toBeNull();
  });

  it("a pane's URL and its dialog's URL are the server's spellings", () => {
    expect(paths.settingsPane("password")).toBe("/settings");
    expect(paths.settingsPane("two-factor")).toBe("/settings/two-factor");
    expect(paths.settingsConfirm("sessions", "revoke-session", "ses_cli")).toBe(
      "/settings/sessions?confirm=revoke-session&id=ses_cli",
    );
    expect(paths.settingsConfirm("sessions", "revoke-other-sessions")).toBe(
      "/settings/sessions?confirm=revoke-other-sessions",
    );
  });
});

describe("?confirm= (model.ts's settingsConfirm: a dialog rides its owning pane and names a real row)", () => {
  it("opens on its owning pane, carrying what the copy names", () => {
    expect(settingsConfirm({ confirm: "remove-passkey", id: "pk_1" }, "passkeys", READ)).toEqual({
      kind: "remove-passkey",
      id: "pk_1",
      name: "Windows Hello",
    });
    expect(settingsConfirm({ confirm: "revoke-session", id: "ses_cli" }, "sessions", READ)).toEqual({
      kind: "revoke-session",
      id: "ses_cli",
      label: "pmcp CLI · device flow",
    });
    expect(settingsConfirm({ confirm: "revoke-connection", id: "con_live" }, "clients", READ)).toEqual({
      kind: "revoke-connection",
      id: "con_live",
      client: "client_live",
    });
    expect(settingsConfirm({ confirm: "disable-two-factor" }, "two-factor", READ)).toEqual({ kind: "disable-two-factor" });
  });

  it("the same query on another pane opens nothing", () => {
    expect(settingsConfirm({ confirm: "disable-two-factor" }, "sessions", READ)).toBeNull();
    expect(settingsConfirm({ confirm: "remove-passkey", id: "pk_1" }, "password", READ)).toBeNull();
  });

  it("a row that is not there — a guessed id, the current session, a revoked binding — is no dialog", () => {
    expect(settingsConfirm({ confirm: "remove-passkey", id: "pk_guess" }, "passkeys", READ)).toBeNull();
    expect(settingsConfirm({ confirm: "revoke-session", id: "ses_me" }, "sessions", READ)).toBeNull();
    expect(settingsConfirm({ confirm: "revoke-connection", id: "con_gone" }, "clients", READ)).toBeNull();
    expect(settingsConfirm({ confirm: "toString" }, "sessions", READ)).toBeNull();
  });
});

describe("the Password pane's refusals and its success copy", () => {
  it("the field a refused change names is read on the Password pane only, and only beside a failure", () => {
    const refused = new URLSearchParams({ failed: "change_password", reason: "Invalid password", field: "currentPassword" });
    expect(passwordErrorOf(refused, "password")).toBe("currentPassword");
    expect(passwordErrorOf(refused, "sessions")).toBeNull();
    expect(passwordErrorOf(new URLSearchParams({ field: "newPassword" }), "password")).toBeNull();
    expect(passwordErrorOf(new URLSearchParams({ failed: "change_password", field: "password" }), "password")).toBeNull();
    expect(passwordErrorOf(null, "password")).toBeNull();
  });

  it("the length hint is the server's one minimum", () => {
    expect(passwordRefusal(12).newPassword).toBe("At least 12 characters.");
    expect(passwordRefusal(16).newPassword).toBe("At least 16 characters.");
  });

  it("a refusal keeps better-auth's words in a titled danger notice; none reads the fallback", () => {
    expect(noticeOf(new URLSearchParams({ failed: "change_password", reason: "Invalid password" }))).toEqual({
      tone: "danger",
      title: "Change password failed",
      message: "Invalid password",
    });
    expect(noticeOf(new URLSearchParams({ failed: "change_password", field: "confirmPassword" }))?.message).toBe(
      "The change was refused.",
    );
  });

  it("success says what changed, what it cost in sessions only when asked, and what it did not touch", () => {
    expect(noticeOf(new URLSearchParams({ done: "change_password" }))).toEqual({
      tone: "success",
      title: "Password updated.",
      message: "App and agent tokens keep working: they do not derive from the password.",
    });
    expect(noticeOf(new URLSearchParams({ done: "change_password", signedOut: "2" }))?.message).toBe(
      "2 other session(s) were signed out — this one stays. App and agent tokens keep working: they do not derive from the password.",
    );
  });

  it("'Confirmed your identity' counts whole minutes since the current session began", () => {
    expect(confirmedLine("2026-08-24T14:43:00.000Z", NOW)).toBe("Confirmed your identity 4 minutes ago.");
    expect(confirmedLine("2026-08-24T14:46:00.000Z", NOW)).toBe("Confirmed your identity 1 minute ago.");
  });
});

describe("the rail and the Tokens filter (a marker is the length of the list its pane draws)", () => {
  it("each marker is its pane's list length; Password has none; Two-factor is a status in words", () => {
    const entries = railEntries(READ, "sessions", null);
    expect(entries.map((entry) => [entry.pane, entry.marker, entry.current])).toEqual([
      ["password", null, false],
      ["two-factor", { text: "enabled", dot: "on" }, false],
      ["passkeys", { text: "1" }, false],
      ["sessions", { text: "2" }, true],
      ["tokens", { text: "3" }, false],
      ["clients", { text: "2" }, false],
      ["execution", { text: "30s / 1500ms" }, false],
    ]);
    expect(railEntries({ ...READ, twoFactor: { enabled: false } }, "password", null)[1]?.marker).toEqual({
      text: "not enabled",
      dot: "off",
    });
  });

  it("?kind= narrows the table and the Tokens marker together; anything else is All", () => {
    expect(tokenKindOf({ kind: "agent" })).toBe("agent");
    expect(tokenKindOf({ kind: "robot" })).toBeNull();
    expect(tokenKindOf({})).toBeNull();
    expect(listedTokens(READ.tokens, "app").map((row) => row.id)).toEqual(["p1"]);
    expect(railEntries(READ, "tokens", "agent")[4]?.marker).toEqual({ text: "2" });
  });

  it("a timeout reads in seconds where it divides, in milliseconds where it does not", () => {
    expect(timeoutLabel(30_000)).toBe("30s");
    expect(timeoutLabel(1_500)).toBe("1500ms");
  });
});

describe("the Execution pane's refusal (web.ts's executionErrors)", () => {
  it("each sentence under the control its field names, quote prefix dropped, one period", () => {
    expect(
      executionErrors([
        { field: "default_timeout_ms", reason: `"default_timeout_ms" must not exceed "max_timeout_ms"` },
        { field: "max_timeout_ms", reason: "must be an integer." },
      ]),
    ).toEqual({ defaults: `Must not exceed "max_timeout_ms".`, maximum: "Must be an integer." });
  });

  it("a refusal naming neither control is the whole-form message; two on one control join", () => {
    expect(executionErrors([{ field: "", reason: "nope" }])).toEqual({ form: "Nope." });
    expect(
      executionErrors([
        { field: "max_timeout_ms", reason: "too big" },
        { field: "max_timeout_ms", reason: "too odd" },
      ]),
    ).toEqual({ maximum: "Too big. Too odd." });
  });
});

describe("the stamps", () => {
  it("relative time: now, minutes, hours, yesterday, days, then a date", () => {
    expect(formatRelative("2026-08-24T14:46:30.000Z", NOW)).toBe("Now");
    expect(formatRelative("2026-08-24T14:30:00.000Z", NOW)).toBe("17 minutes ago");
    expect(formatRelative("2026-08-24T12:47:00.000Z", NOW)).toBe("2 hours ago");
    expect(formatRelative("2026-08-23T21:02:00.000Z", NOW)).toBe("yesterday");
    expect(formatRelative("2026-08-21T10:05:00.000Z", NOW)).toBe("3 days ago");
    expect(formatRelative("2026-08-02T08:25:00.000Z", NOW)).toBe("Aug 2, 2026");
  });

  it("a CLI session is labelled as the device flow that minted it", () => {
    expect(sessionLabel(session({ client: "pmcp CLI", source: "cli" }))).toBe("pmcp CLI · device flow");
    expect(sessionLabel(session({}))).toBe("Chrome on Windows");
  });
});
