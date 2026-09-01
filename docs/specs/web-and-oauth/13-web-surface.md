## 13. Web surface

Deliberately tiny — server-rendered pages (Hono JSX) only where a browser is required:

- `/login` — username + password, TOTP challenge, passkey button.
- `/device` — device-approval page (user enters the code the CLI printed). Since we
  hand-build it anyway: it shows the requesting IP and user-agent and states plainly
  that approval grants **full admin CLI control of the namespace** (RFC 8628 §5.4 /
  cross-device-flow BCP: the user-code channel is unauthenticated, so the page is the
  phishing defense); the approval POST carries a CSRF token; device-code lifetime is
  set to ~10 minutes (down from better-auth's 30-minute default).
- `/settings` — enroll/remove TOTP and passkeys, active sessions. Requires a
  cookie-authenticated session with recent authentication — bearer-sourced sessions are
  rejected on these routes (§4).
- `/audit` — read-only, cookie-session-gated view over the audit table (§5): a plain
  server-rendered table, newest first, with the same filters as `audit_query`
  (agent, app, event, tool, time range) and offset/limit paging backed by
  `audit_query`'s `total` (desktop shows numbered pages, mobile a "Load more" that
  accumulates offsets — one contract, two presentations). An **Export JSONL** action
  streams every row matching the current filters, one JSON object per line: the
  handler re-runs the same query in `limit`-sized chunks and writes each chunk to a
  streaming response as it is fetched, never holding the full result set in memory —
  a serialization of `audit_query`, not a new capability. The expanded row detail
  shows the caller's client metadata when present (client name/version and session id,
  §5/§7) and the recorded call bodies when present (§15) — post-redaction args and
  result structuredContent, with stubs rendered as typed size placeholders (e.g.
  `‹blob image/png · 4.2 MB›`, never the bytes); the session id renders as a link to this same audit view filtered to that
  session (`?session=…`, backed by `audit_query`'s `session` filter). No mutations, so
  no CSRF surface.
- `/approvals` — cookie-session-gated: pending requests up top (agent, app, tool,
  redacted arguments, requested time, approve/reject buttons — CSRF token on the POST),
  decision history below. `/approvals/<id>` is the detail page the `-32003` error links
  to; only the namespace owner can open it.
- `/apps` — cookie-session-gated app management: active apps (kind, status —
  online/offline for tunneled, connection state for OAuth-proxied — roles, last seen)
  with archive/delete actions; an archived section with unarchive/delete; an add-app
  flow (pick tunneled or proxied — the two kinds, §2; for proxied, after the endpoint
  the form asks for the authentication type, `headers` or `oauth` (§7); tunneled
  creation shows the app token once; choosing `oauth` continues into the provider's
  consent screen, §7); and
  Connect/Reconnect/Disconnect for `auth: oauth` apps. CSRF tokens on every
  mutation. Future work for the add-app form: probe the entered URL (the §7
  RFC 9728 discovery) to suggest the auth type and surface provider-specific options,
  and accept manually pre-registered client credentials for OAuth providers without
  dynamic client registration. `/oauth/upstream/callback` belongs to this cookie-session-gated surface:
  it requires the owner's session and a live single-use `state` bound to it, per §7 —
  the callback is a mutation (it writes `upstream_auth_json`) and is guarded like one.
- `/oauth/consent` and `/oauth/connections` *(added 2026-08-26, §19 — the inbound
  direction, under the same already-reserved `oauth` segment)*: the consent screen an
  external MCP client's authorization request lands on (what the client is, what it
  asks for, which namespace, and the **agent picker** that decides how much
  power it gets), and the list of connections it produces, with Revoke. Both are
  cookie-session-gated owner pages with a CSRF token on every POST, exactly like
  `/apps` — the consent POST is a mutation (it writes the binding **and** authorizes
  a client) and is gated like the strictest one. §19 pins the flow.

**PWA**: the web surface ships a web-app manifest and a minimal service worker, so
the dashboard installs to phone and desktop home screens. Pages stay server-rendered —
the service worker exists for installability and push, not offline rendering (the
no-SPA pin holds, §1). **Approval push**: `/approvals` offers a per-browser "Enable
notifications" control; subscriptions land in `push_subscription` (§5), and every new
approval request sends a Web Push (VAPID keys in Worker secrets, ES256 via WebCrypto,
RFC 8291 payload encryption) naming the app and tool — never arguments — which
opens `/approvals/<id>` on tap. A `404`/`410` from the push service prunes the
subscription. Best-effort delivery; the dashboard is the source of truth (§7).

The dashboard pages `/apps`, `/approvals`, and `/audit` and the CLI are both
fronts over the same server-side handlers as the `pmcp` tools — one implementation,
three surfaces. `/settings` is the deliberate exception: credential management (TOTP,
passkeys, active sessions) rides better-auth's endpoints and is intentionally
web-only — §4's session-scope guards reject bearer-sourced sessions there precisely so
no CLI token or `pmcp` tool can ever reach it.

