# Sign-in & device approval

How a browser session comes to exist, and the page that approves a device.
Rules: §13 (`/login`, `/device`), §19.5 (the signed-query variant); the CLI
side of the device flow is §10's, not this folder's.

## Wireframe map

| Journey moment | Artboard |
|---|---|
| `/login`, idle | `Login` / `MobileLogin` |
| Bad credentials | `AuthStates · LOGIN — ERROR` |
| TOTP challenge | `TwoFactor` / `MobileTwoFactor` |
| Wrong TOTP code | `AuthStates · TWO-FACTOR — ERROR` |
| Backup code instead | `AuthStates · BACKUP CODE` |
| `/device`, code entry | `Device` / `MobileDevice`, `AuthStates · DEVICE — ENTER CODE` |
| Expired or wrong code | `AuthStates · DEVICE — EXPIRED CODE` |
| Approved | `AuthStates · DEVICE — APPROVED` |

## Web sign-in

1. `/login` renders username + password and a passkey button (§13). Field and
   credential errors re-render inline — see `AuthStates`.
2. If the account has TOTP, success continues to the two-factor challenge
   (`TwoFactor`); a backup code is accepted in place of a TOTP code
   (`AuthStates`).
3. Success sets the session cookie and lands on the dashboard. Pages that manage
   credentials (`/settings`) additionally require *recent* authentication and
   reject bearer-sourced sessions (§4, §13).

When the sign-in was triggered by an inbound OAuth authorize redirect, the login
page carries the opaque signed query through **verbatim** and the post-login
target is the constant `/api/auth/oauth2/authorize` — never a redirect
parameter read from the request (§19.5 step 1; see
[05-inbound-connect.md](05-inbound-connect.md)).

## Device approval

The trigger is external: a device-flow client (RFC 8628, e.g. `pmcp login`,
§10) showed the owner a user code and this page's URL.

1. The owner — signed in per the flow above — opens `/device` and enters the
   code (`Device`). The page shows the requesting IP and user-agent and states
   plainly that approval grants **full admin CLI control of the namespace**:
   the user-code channel is unauthenticated, so this page is the phishing
   defense (§13).
2. Approve is a CSRF-tokened POST; the approved state is `AuthStates`' "Device
   approved". Device codes live ~10 minutes — an expired or wrong code fails
   the entry form inline.
