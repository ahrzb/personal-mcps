/**
 * /login — username + password, the TOTP/backup-code second-factor challenge, and the
 * passkey button, as one page (Login.dc.html, TwoFactor.dc.html, AuthStates.dc.html).
 * `step.kind` selects which of the three cards renders; nothing else about the page
 * changes shape.
 *
 * Chromeless: unlike every other page this one is not a child of ../layout's shell (no
 * session exists yet to draw a nav for), so it renders its own minimal document — same
 * stylesheet and font link, no header, no manifest/service-worker registration.
 *
 * Pure: (props) => JSX. Every form posts straight to better-auth (`paths.auth.*`), which
 * is also why there is no CSRF field here — LoginProps carries none (see model.ts).
 */

import { html } from "hono/html";
import type { FC } from "hono/jsx";
import type { LoginProps, LoginStep } from "./model";
import { paths } from "./model";

/** Not exported by ./layout — the same mark, redrawn here for this chromeless page. */
const BrandMark: FC = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
    <circle cx="12" cy="12" r="3.5" />
    <path d="M12 8.5V3.5" />
    <path d="M14.5 14.5L18.5 18.5" />
    <path d="M9.5 14.5L5.5 18.5" />
  </svg>
);

const PasskeyIcon: FC = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <circle cx="7.5" cy="15.5" r="3.5" />
    <path d="m21 2-9.6 9.6" />
    <path d="m15.5 7.5 3 3L22 7l-3-3" />
  </svg>
);

const STEP_TITLE: Record<LoginStep["kind"], string> = {
  credentials: "Sign in",
  totp: "Two-factor code",
  "backup-code": "Use a backup code",
};

/**
 * There is no §13 path for switching between the totp and backup-code sub-views of a
 * pending challenge — `paths` only names the two verify targets, not this. The pending
 * challenge itself lives in better-auth's own session, not in this query string; `method`
 * only tells GET /login which card to draw, so this is additive to `paths.login` rather
 * than a route of its own. Flagged in this task's returned styleGaps for the model owner.
 */
function switchMethod(method: "totp" | "backup-code"): string {
  return `${paths.login}?method=${method}`;
}

/** The always-present redirect target, spelled out even when `redirectTo` is null. */
function landingUrl(redirectTo: string | null): string {
  return redirectTo ?? paths.apps;
}

const CredentialsCard: FC<{ step: Extract<LoginStep, { kind: "credentials" }>; redirectTo: string | null }> = ({
  step,
  redirectTo,
}) => (
  <div class="auth-card">
    <div>
      <div class="auth-title">Sign in</div>
      <div class="auth-desc">Use your username and password.</div>
    </div>
    <form class="form" method="post" action={paths.auth.signIn}>
      <input type="hidden" name="callbackURL" value={landingUrl(redirectTo)} />
      <div class="field">
        <label for="username">Username</label>
        <input
          id="username"
          name="username"
          type="text"
          value={step.username}
          autocomplete="username"
          required
          autofocus={step.username === "" ? true : undefined}
        />
      </div>
      <div class="field">
        <label for="password">Password</label>
        <input
          id="password"
          name="password"
          type="password"
          autocomplete="current-password"
          required
          aria-invalid={step.error ? "true" : undefined}
          autofocus={step.username !== "" ? true : undefined}
        />
        {step.error ? <p class="field-error">{step.error}</p> : null}
      </div>
      <button type="submit" class="btn btn--primary btn--block">
        Sign in
      </button>
    </form>
    <div class="divider">
      <span>or</span>
    </div>
    {/* Passkey sign-in is a WebAuthn ceremony (navigator.credentials.get against
        paths.auth.signInPasskey) — inert here on purpose: wiring it is client script,
        not a template concern, and belongs with whatever owns clients/. */}
    <button type="button" class="btn btn--outline btn--block">
      <PasskeyIcon />
      <span>Sign in with a passkey</span>
    </button>
  </div>
);

const TotpCard: FC<{ step: Extract<LoginStep, { kind: "totp" }>; redirectTo: string | null }> = ({ step, redirectTo }) => (
  <div class="auth-card">
    <div>
      <div class="auth-title">Two-factor code</div>
      <div class="auth-desc">Enter the 6-digit code from your authenticator app.</div>
    </div>
    {/* .contents so the form's own children take the card's 20px rhythm instead
        of .form's 16px — the one geometry .form doesn't fit here. */}
    <form method="post" action={paths.auth.totpVerify} class="contents" data-otp-form>
      <input type="hidden" name="callbackURL" value={landingUrl(redirectTo)} />
      <input type="hidden" name="code" data-otp-value />
      <div class="otp" data-otp>
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <input
            type="text"
            inputmode="numeric"
            pattern="[0-9]*"
            maxlength={1}
            autocomplete="one-time-code"
            aria-label={`Digit ${i + 1}`}
            aria-invalid={step.error ? "true" : undefined}
            autofocus={i === 0 ? true : undefined}
          />
        ))}
      </div>
      {step.error ? <p class="field-error center">{step.error}</p> : null}
      <button type="submit" class="btn btn--primary btn--block">
        Verify
      </button>
    </form>
    {/* MobileTwoFactor.dc.html: this becomes a full-width bordered button at
        the narrow breakpoint (.switch-method in styles.css); desktop keeps it
        a plain link (TwoFactor.dc.html). */}
    <p class="muted center switch-method">
      <a href={switchMethod("backup-code")}>Use a backup code instead</a>
    </p>
  </div>
);

const BackupCodeCard: FC<{ step: Extract<LoginStep, { kind: "backup-code" }>; redirectTo: string | null }> = ({
  step,
  redirectTo,
}) => (
  <div class="auth-card">
    <div>
      <div class="auth-title">Use a backup code</div>
      <div class="auth-desc">Each backup code works once.</div>
    </div>
    <form method="post" action={paths.auth.backupCodeVerify} class="contents">
      <input type="hidden" name="callbackURL" value={landingUrl(redirectTo)} />
      <div class="field">
        <label for="backup-code">Backup code</label>
        <input
          id="backup-code"
          name="code"
          type="text"
          class="input--mono"
          placeholder="xxxx-xxxx-xxxx"
          autocomplete="one-time-code"
          required
          aria-invalid={step.error ? "true" : undefined}
          autofocus
        />
        {step.error ? <p class="field-error">{step.error}</p> : null}
      </div>
      <button type="submit" class="btn btn--primary btn--block">
        Verify
      </button>
    </form>
    <p class="muted center">
      <a href={switchMethod("totp")}>Use your authenticator app instead</a>
    </p>
  </div>
);

/**
 * Combines the six digit boxes into the hidden `code` field better-auth's verify-totp
 * expects, with auto-advance and backspace-back — the one bit of behavior the six-box
 * layout cannot deliver without it, since the form posts straight past web.ts to
 * better-auth (no stitching happens server-side). Static text, no interpolated data.
 */
const OTP_SCRIPT = `(function(){
  var form = document.querySelector('[data-otp-form]');
  if (!form) return;
  var boxes = Array.prototype.slice.call(form.querySelectorAll('[data-otp] input'));
  var hidden = form.querySelector('[data-otp-value]');
  function sync() { hidden.value = boxes.map(function (b) { return b.value; }).join(''); }
  boxes.forEach(function (box, i) {
    box.addEventListener('input', function () {
      box.value = box.value.replace(/[^0-9]/g, '').slice(-1);
      sync();
      if (box.value && boxes[i + 1]) boxes[i + 1].focus();
    });
    box.addEventListener('keydown', function (e) {
      if (e.key === 'Backspace' && !box.value && boxes[i - 1]) boxes[i - 1].focus();
    });
    box.addEventListener('paste', function (e) {
      var text = (e.clipboardData || window.clipboardData).getData('text').replace(/[^0-9]/g, '');
      if (!text) return;
      e.preventDefault();
      for (var j = 0; j < boxes.length; j++) boxes[j].value = text[j] || '';
      sync();
      (boxes[Math.min(text.length, boxes.length) - 1] || boxes[0]).focus();
    });
  });
})();`;

const STYLESHEET = "/styles.css";

export const Login: FC<LoginProps> = ({ step, redirectTo }) => (
  <>
    {html`<!doctype html>`}
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="theme-color" content="#fafafa" />
        <title>{STEP_TITLE[step.kind]}</title>
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

          {step.kind === "credentials" ? <CredentialsCard step={step} redirectTo={redirectTo} /> : null}
          {step.kind === "totp" ? <TotpCard step={step} redirectTo={redirectTo} /> : null}
          {step.kind === "backup-code" ? <BackupCodeCard step={step} redirectTo={redirectTo} /> : null}

          {step.kind === "credentials" ? (
            <div class="auth-foot">Lost your password? Reset it with the users script on the server.</div>
          ) : (
            <div class="auth-foot">
              <a href={paths.login}>Back to sign in</a>
            </div>
          )}
        </div>
        {step.kind === "totp" ? <script dangerouslySetInnerHTML={{ __html: OTP_SCRIPT }} /> : null}
      </body>
    </html>
  </>
);
