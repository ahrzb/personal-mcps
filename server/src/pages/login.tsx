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
import { loginUrl, paths } from "./model";

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
 * The link between the totp and backup-code sub-views of a pending challenge. The pending
 * challenge itself lives in better-auth's own session, not in this query string: `method`
 * only tells GET /login which card to draw, which is why this is additive to `paths.login`
 * rather than a route of its own.
 *
 * It carries the LANDING as well, because the card it opens has to post the same
 * `callbackURL` the card it left was posting — a switch that dropped it would silently
 * turn a deep link (and §19.5's signed authorize landing) into /apps. `loginUrl` encodes
 * the value and `loginProps` reads it back byte for byte, so the round trip is lossless.
 */
function switchMethod(method: "totp" | "backup-code", redirectTo: string | null): string {
  return loginUrl({ method, next: redirectTo });
}

/** The always-present redirect target, spelled out even when `redirectTo` is null. */
function landingUrl(redirectTo: string | null): string {
  return redirectTo ?? paths.apps;
}

/**
 * One value as a JavaScript literal inside an inline `<script>` — a JSON literal is one,
 * with the three characters an HTML parser or a JS parser reads differently escaped:
 *
 *  - `<` → `\u003c`, which is what closes the `</script>` and `<!--` doors. `/` buys
 *    nothing once `<` is gone and is deliberately left alone.
 *  - U+2028 / U+2029, legal in JSON strings and line TERMINATORS in JavaScript source,
 *    which would otherwise end the statement mid-literal.
 *
 * Every embed in this file's scripts goes through it, the compile-time constants included,
 * so the rule is "a script literal is `jsLiteral`" rather than "this one variable". It
 * lives here rather than in ./format because no other page embeds a non-constant value:
 * layout.tsx's `id`, settings.tsx's two paths and apps.tsx's dialog id are all constants.
 */
function jsLiteral(value: string): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
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
    {/* A WebAuthn assertion, not a form post — so this is a button the script below
        drives, and its two endpoints ride better-auth's own mount (paths.auth). */}
    <button type="button" class="btn btn--outline btn--block" data-passkey-signin>
      <PasskeyIcon />
      <span>Sign in with a passkey</span>
    </button>
    <script dangerouslySetInnerHTML={{ __html: passkeySignInScript(landingUrl(redirectTo)) }} />
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
      <a href={switchMethod("backup-code", redirectTo)}>Use a backup code instead</a>
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
      <a href={switchMethod("totp", redirectTo)}>Use your authenticator app instead</a>
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

/**
 * §13's passkey button, made live. A sign-in by passkey is an assertion ceremony rather
 * than a POST — better-auth's options endpoint, `navigator.credentials.get`, and its
 * verify endpoint, which answers with the session cookie — so there is no form body for a
 * hub route to translate and both endpoints are better-auth's own (`paths.auth`).
 *
 * base64url both ways: `challenge` and every `allowCredentials[].id` arrive encoded and
 * the assertion goes back encoded. The same codec lives in settings.tsx's registration
 * ceremony; the duplication is deliberate — these are inline scripts in two documents,
 * one of them this chromeless page, and sharing them would need a bundle step the hub
 * does not have.
 *
 * `landing` is where a verified assertion goes, which is the same deep link the password
 * form carries through the round trip.
 */
function passkeySignInScript(landing: string): string {
  return `(function () {
  var buttons = document.querySelectorAll('[data-passkey-signin]');
  if (!buttons.length || !window.PublicKeyCredential) return;
  var OPTIONS = ${jsLiteral(paths.auth.passkeyAuthenticateOptions)};
  var VERIFY = ${jsLiteral(paths.auth.passkeyVerifyAuthentication)};
  var LANDING = ${jsLiteral(landing)};
  function decode(value) {
    var raw = atob(String(value).replace(/-/g, '+').replace(/_/g, '/'));
    var out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }
  function encode(buffer) {
    var view = new Uint8Array(buffer);
    var text = '';
    for (var i = 0; i < view.length; i++) text += String.fromCharCode(view[i]);
    return btoa(text).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
  }
  function signIn() {
    fetch(OPTIONS, { credentials: 'same-origin', headers: { Accept: 'application/json' } })
      .then(function (answer) {
        if (!answer.ok) throw new Error('options ' + answer.status);
        return answer.json();
      })
      .then(function (options) {
        options.challenge = decode(options.challenge);
        (options.allowCredentials || []).forEach(function (row) { row.id = decode(row.id); });
        return navigator.credentials.get({ publicKey: options });
      })
      .then(function (assertion) {
        return fetch(VERIFY, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            response: {
              id: assertion.id,
              rawId: encode(assertion.rawId),
              type: assertion.type,
              authenticatorAttachment: assertion.authenticatorAttachment,
              clientExtensionResults: assertion.getClientExtensionResults(),
              response: {
                clientDataJSON: encode(assertion.response.clientDataJSON),
                authenticatorData: encode(assertion.response.authenticatorData),
                signature: encode(assertion.response.signature),
                userHandle: assertion.response.userHandle
                  ? encode(assertion.response.userHandle)
                  : undefined
              }
            }
          })
        });
      })
      .then(function (answer) {
        if (!answer.ok) throw new Error('verify ' + answer.status);
        location.assign(LANDING);
      })
      .catch(function (failure) {
        // A cancelled prompt and a refused assertion look alike from here: the page stays
        // where it is and the password form is still the way in. Logged, not swallowed.
        console.error('Passkey sign-in did not complete', failure);
      });
  }
  Array.prototype.forEach.call(buttons, function (button) {
    button.addEventListener('click', signIn);
  });
})();`;
}

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
