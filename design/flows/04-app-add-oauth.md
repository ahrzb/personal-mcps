# Add a proxied app & upstream OAuth

A proxied upstream, authenticated by static headers or by a Connect flow the
owner walks in their browser. Rules: §7 (Upstream OAuth), §13 (`/apps`,
`/oauth/upstream/callback`).

## Wireframe map

| Journey moment | Artboard |
|---|---|
| Add form, kind/auth pickers | `AppNew` / `MobileAppNew` |
| Row with connection state, Reconnect / Disconnect | `Apps` |

The provider's consent screen is theirs, not ours. **Gap**: `AppNewStates`
renders only the tunneled branch — the proxied states (endpoint/auth-type
errors, the needs-reconnect row emphasized, mid-connect) are unrendered; see
README.

## The journey

1. In the add-app form, pick **proxied**, enter the endpoint, then choose
   the auth type: `headers` (default) or `oauth` (§13).
2. `headers`: the form takes static headers (`app_set_upstream_auth`
   underneath) and the app is usable immediately.
3. `oauth`: the flow continues into **Connect** — also reachable later from the
   app's row (§7):
   - The hub discovers the upstream's authorization server (RFC 9728), obtains
     a client identity (CIMD, falling back to DCR), and runs
     authorization-code + PKCE in the owner's browser.
   - Connect initiation mints a single-use `state` bound to the initiating
     cookie session (and to issuer/token-endpoint/verifier), expiring in ~10
     minutes (§7 — it, not PKCE, is the CSRF and mix-up defense).
   - `/oauth/upstream/callback` requires the owner's session and that live,
     unconsumed `state`; anything missing, mismatched, expired, or replayed
     rejects with nothing stored (§7, §13).
4. On success the token bundle lands encrypted server-side; the row shows the
   **connection state** (§13's status column for OAuth-proxied apps) and
   the app proxies with `Authorization: Bearer` attached upstream.

## States & edges

- A failed refresh flips the app to **needs reconnect**: calls fail
  `-32000` and the row grows a **Reconnect** button (same Connect flow) (§7).
- **Disconnect** wipes the token bundle; connect/disconnect/refresh-failure all
  write `upstream.oauth_*` audit rows (§7).
- The YAML config declares only `auth: oauth` — tokens never appear in it, so
  `diff`/`apply` never touch the bundle (§7, §9).
- Future form work pinned in §13: probe the endpoint to suggest the auth type;
  accept pre-registered client credentials for providers without DCR.
