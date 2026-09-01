/**
 * /device — the RFC 8628 device-flow phishing-defense page (§13). Chromeless,
 * like /login and /apps/new: no shell, no nav, just a centered card, because
 * it is reached from a raw CLI-printed URL or a deep link, not from inside the
 * signed-in app.
 *
 * The whole point of this page is what §7 calls out: the user-code channel is
 * unauthenticated, so everything about the pending request (`DeviceRequest`) is
 * attacker-influenced except the signed-in `username`. The page's job is to make
 * the blast radius impossible to miss — the requesting IP, the client, and a
 * plain-English statement that approving grants full admin CLI control of the
 * namespace — before the one CSRF-checked POST that decides it.
 *
 * Pure: (props) => JSX. No fetching, no cookies, no Date.now() — `now` arrives in
 * props and every relative timestamp is derived from it.
 */

import { html } from "hono/html";
import type { FC } from "hono/jsx";
import type { DeviceProps, DeviceRequest, DeviceStep } from "./model";
import { paths } from "./model";

const STYLESHEET = "/styles.css";

/** Not exported by ./layout — the same mark, redrawn here for this chromeless page. */
const BrandMark: FC = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
    <circle cx="12" cy="12" r="3.5" />
    <path d="M12 8.5V3.5" />
    <path d="M14.5 14.5L18.5 18.5" />
    <path d="M9.5 14.5L5.5 18.5" />
  </svg>
);

const WarningIcon: FC = () => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="var(--warning)"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path d="m21.73 18-8-14a2 2 0 0 0-3.46 0l-8 14A2 2 0 0 0 4 20h16a2 2 0 0 0 1.73-2Z" />
    <path d="M12 9v4" />
    <path d="M12 17h.01" />
  </svg>
);

const ApprovedIcon: FC = () => (
  <svg width="48" height="48" viewBox="0 0 48 48" fill="none" aria-hidden="true">
    <circle cx="24" cy="24" r="23" fill="var(--success-bg)" stroke="var(--success-border)" stroke-width="1.5" />
    <path d="M16 24.5 21.5 30 32 19" stroke="var(--success)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" />
  </svg>
);

/** Not in the artboards (only DEVICE — APPROVED is drawn) — same circle, an X in the danger palette. */
const DeniedIcon: FC = () => (
  <svg width="48" height="48" viewBox="0 0 48 48" fill="none" aria-hidden="true">
    <circle cx="24" cy="24" r="23" fill="var(--danger-bg)" stroke="var(--danger-border)" stroke-width="1.5" />
    <path d="M18 18 30 30M30 18 18 30" stroke="var(--danger-fg)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" />
  </svg>
);

/**
 * "Just now" / "N mins ago" / "N hours ago" — the only clock this file reads is
 * `now` from props, so a fixture renders byte-identically every time (model.ts's
 * pure-template rule).
 */
function relativeTime(fromIso: string, nowIso: string): string {
  const deltaMs = Date.parse(nowIso) - Date.parse(fromIso);
  const seconds = Math.max(0, Math.round(deltaMs / 1000));
  if (seconds < 45) return "Just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  return `${hours} hour${hours === 1 ? "" : "s"} ago`;
}

/**
 * AuthStates "DEVICE — ENTER CODE" / "DEVICE — EXPIRED CODE": the owner arrived at
 * /device with no code (or a bad one) and has to type what the CLI printed. A GET
 * back to /device — not a mutation, so no CSRF field — the same way a search box
 * would resubmit; `user_code` is the CLI's own deep-link query param (model.ts's
 * DeviceRequest comment).
 */
const EnterCodeCard: FC<{ step: Extract<DeviceStep, { kind: "enter-code" }> }> = ({ step }) => (
  <div class="auth-card">
    <div class="auth-title">Approve a device</div>
    <form method="get" action={paths.device} class="form">
      <div class="field">
        <label class="label" for="user_code">
          Device code
        </label>
        <input
          id="user_code"
          type="text"
          name="user_code"
          class="input--mono"
          placeholder="XXXX-XXXX"
          value={step.userCode}
          aria-invalid={step.error ? "true" : undefined}
        />
        {step.error ? (
          <div class="field-error">{step.error}</div>
        ) : (
          <div class="field-hint">Enter the code the pmcp CLI printed.</div>
        )}
      </div>
      <button type="submit" class="btn btn--primary btn--block">
        Continue
      </button>
    </form>
    <div class="center" style="font-size:var(--text-sm)">
      <a href={paths.apps}>Cancel</a>
    </div>
  </div>
);

/**
 * Device.dc.html / MobileDevice.dc.html: the live verdict screen. Every field in
 * `request` is shown because every field except `username` is attacker-supplied
 * (§7) — this card exists so the owner can catch a mismatched IP or client before
 * the one click that hands a device full admin control.
 */
const ConfirmCard: FC<{ request: DeviceRequest; username: string; csrfToken: string; now: string }> = ({
  request,
  username,
  csrfToken,
  now,
}) => (
  <div class="auth-card">
    <div>
      <div class="auth-title">Approve CLI sign-in</div>
      <div class="auth-desc">A device is asking to sign in with this code.</div>
    </div>

    <div class="field">
      <div class="eyebrow">Device code</div>
      <div class="code-display">{request.userCode}</div>
    </div>

    <div class="kv">
      <div class="kv-row">
        <div class="kv-key">IP address</div>
        <div class="mono">{request.ip}</div>
      </div>
      <div class="kv-row">
        <div class="kv-key">Client</div>
        <div>{request.client}</div>
      </div>
      <div class="kv-row">
        <div class="kv-key">Requested</div>
        <div>{relativeTime(request.requestedAt, now)}</div>
      </div>
    </div>

    <div class="alert alert--warning">
      <WarningIcon />
      <div>
        <div class="alert-title">Grants full admin access</div>
        <div class="alert-text">
          Approving signs this device in as {username} with full control of your namespace — apps, grants, and
          tokens.
        </div>
      </div>
    </div>

    <form method="post" action={paths.deviceDecide}>
      <input type="hidden" name="csrf" value={csrfToken} />
      <input type="hidden" name="user_code" value={request.userCode} />
      <div class="confirm-actions">
        <button type="submit" name="decision" value="deny" class="btn btn--danger-outline">
          Deny
        </button>
        <button type="submit" name="decision" value="approve" class="btn btn--primary">
          Approve
        </button>
      </div>
    </form>
  </div>
);

/**
 * AuthStates "DEVICE — APPROVED", and its unshown twin: the verdict already
 * landed, so there is nothing left to decide — no form, just the outcome and
 * where to look next (the terminal that is either finishing sign-in or already
 * moved on).
 */
const DecidedCard: FC<{ decision: "approved" | "denied" }> = ({ decision }) => (
  <div class="auth-card" style="align-items:center;text-align:center;gap:var(--space-6);">
    {decision === "approved" ? <ApprovedIcon /> : <DeniedIcon />}
    <div style="display:flex;flex-direction:column;gap:var(--space-3);align-items:center;">
      <div class="auth-title">{decision === "approved" ? "Device approved" : "Device denied"}</div>
      <div style="font-size:var(--text-sm);color:var(--muted-fg);line-height:1.5;">
        {decision === "approved"
          ? "You can return to your terminal — the CLI finishes sign-in on its own."
          : "You can close this tab. The CLI sign-in was cancelled."}
      </div>
    </div>
  </div>
);

export const Device: FC<DeviceProps> = ({ now, username, csrfToken, step }) => (
  <>
    {html`<!doctype html>`}
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="theme-color" content="#ffffff" />
        <title>Approve device</title>
        <link rel="stylesheet" href={STYLESHEET} />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="anonymous" />
        <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&display=swap" />
      </head>
      <body>
        <div class="auth">
          <div class="brand">
            <BrandMark />
            <span>personal-mcps</span>
          </div>

          {step.kind === "enter-code" && <EnterCodeCard step={step} />}
          {step.kind === "confirm" && (
            <ConfirmCard request={step.request} username={username} csrfToken={csrfToken} now={now} />
          )}
          {step.kind === "decided" && <DecidedCard decision={step.decision} />}

          {step.kind !== "decided" && <div class="auth-foot">Codes expire after 10 minutes.</div>}
        </div>
      </body>
    </html>
  </>
);
