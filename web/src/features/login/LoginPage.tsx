import { useState } from "react";
import type { ReactNode } from "react";
import { OtpBoxes } from "@/chrome/OtpBoxes";
import { useDocumentTitle } from "@/chrome/Shell";
import { readLoginIsland } from "@/lib/bootstrap";
import type { LoginIsland } from "@/lib/bootstrap";
import { loginUrl, passkeyAuthentication, paths } from "@/lib/paths";

/**
 * `/login` — username and password, the TOTP / backup-code challenge, and the passkey button,
 * as one page (Login.dc.html, TwoFactor.dc.html, AuthStates.dc.html). CHROMELESS: there is no
 * session yet to draw a nav for.
 *
 * The port of what `server/src/pages/login.tsx` drew, element for element — with every
 * judgement left on the server, where it was (routes design §5):
 *
 *   - which card, and where a sign-in lands, come from the `#pmcp-login` island the Worker
 *     computes per request (the relative-only rule, §19.5's signed authorize landing); the
 *     client reads them and decides neither;
 *   - the three forms are REAL form posts to the kept `/login/*` routes, which answer a 303
 *     carrying better-auth's cookie — only a navigation can follow that;
 *   - "Use a backup code instead" and "Back to sign in" are DOCUMENT navigations, so the next
 *     card's island is computed afresh on the server, exactly as a GET recomputed the page;
 *   - the page makes no `/api/hub` call and draws no Shell: with no session, the API's 401
 *     would send /login to /login.
 *
 * `error`, `username` and `redirectTo` are untrusted — any link sets them — and are drawn as
 * text nodes and attribute values only.
 */
export function LoginPage(): ReactNode {
  const [island] = useState(readLoginIsland);
  const { step, redirectTo } = island;
  useDocumentTitle(STEP_TITLE[step.kind]);
  const landing = redirectTo ?? paths.apps;

  return (
    <div className="auth">
      <div className="brand">
        <BrandMark />
        <span>personal-mcps</span>
      </div>

      {step.kind === "credentials" ? <CredentialsCard step={step} landing={landing} /> : null}
      {step.kind === "totp" ? <TotpCard error={step.error} redirectTo={redirectTo} landing={landing} /> : null}
      {step.kind === "backup-code" ? <BackupCodeCard error={step.error} redirectTo={redirectTo} landing={landing} /> : null}

      {step.kind === "credentials" ? (
        <div className="auth-foot">Lost your password? Reset it with the users script on the server.</div>
      ) : (
        <div className="auth-foot">
          <a href={paths.login}>Back to sign in</a>
        </div>
      )}
    </div>
  );
}

/** The tab title per card — the shell's own title for the same step, kept on a client render. */
const STEP_TITLE: Record<LoginIsland["step"]["kind"], string> = {
  credentials: "Sign in",
  totp: "Two-factor code",
  "backup-code": "Use a backup code",
};

/** Username and password, then the passkey alternative. A refused attempt comes back with the
 *  username kept and focus on the password, so only the password is retyped. */
function CredentialsCard({
  step,
  landing,
}: {
  step: Extract<LoginIsland["step"], { kind: "credentials" }>;
  /** Where a sign-in goes: the hidden `callbackURL`, and the passkey's landing. */
  landing: string;
}): ReactNode {
  return (
    <div className="auth-card">
      <div>
        <div className="auth-title">Sign in</div>
        <div className="auth-desc">Use your username and password.</div>
      </div>
      <form className="form" method="post" action={paths.signIn}>
        <input type="hidden" name="callbackURL" value={landing} />
        <div className="field">
          <label htmlFor="username">Username</label>
          <input
            id="username"
            name="username"
            type="text"
            defaultValue={step.username}
            autoComplete="username"
            required
            autoFocus={step.username === ""}
          />
        </div>
        <div className="field">
          <label htmlFor="password">Password</label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            aria-invalid={step.error === null ? undefined : "true"}
            autoFocus={step.username !== ""}
          />
          {step.error === null ? null : <p className="field-error">{step.error}</p>}
        </div>
        <button type="submit" className="btn btn--primary btn--block">
          Sign in
        </button>
      </form>
      <div className="divider">
        <span>or</span>
      </div>
      {/* A WebAuthn assertion, not a form post — a button, and better-auth's own endpoints. */}
      <button type="button" className="btn btn--outline btn--block" onClick={() => void passkeySignIn(landing)}>
        <PasskeyIcon />
        <span>Sign in with a passkey</span>
      </button>
    </div>
  );
}

/** The six-box TOTP challenge. `.contents` on the form, so its children take the card's own
 *  rhythm rather than `.form`'s. */
function TotpCard({
  error,
  redirectTo,
  landing,
}: {
  error: string | null;
  /** The island's landing, carried by the switch link so the next card posts the same one. */
  redirectTo: string | null;
  landing: string;
}): ReactNode {
  return (
    <div className="auth-card">
      <div>
        <div className="auth-title">Two-factor code</div>
        <div className="auth-desc">Enter the 6-digit code from your authenticator app.</div>
      </div>
      <form method="post" action={paths.totpVerify} className="contents" data-otp-form>
        <input type="hidden" name="callbackURL" value={landing} />
        <OtpBoxes invalid={error !== null} />
        {error === null ? null : <p className="field-error center">{error}</p>}
        <button type="submit" className="btn btn--primary btn--block">
          Verify
        </button>
      </form>
      {/* A full-width bordered button on the phone (`.switch-method`), a plain link wide. */}
      <p className="muted center switch-method">
        <a href={loginUrl({ method: "backup-code", next: redirectTo })}>Use a backup code instead</a>
      </p>
    </div>
  );
}

/** The same challenge, spelled with a single-use backup code. */
function BackupCodeCard({
  error,
  redirectTo,
  landing,
}: {
  error: string | null;
  redirectTo: string | null;
  landing: string;
}): ReactNode {
  return (
    <div className="auth-card">
      <div>
        <div className="auth-title">Use a backup code</div>
        <div className="auth-desc">Each backup code works once.</div>
      </div>
      <form method="post" action={paths.backupCodeVerify} className="contents">
        <input type="hidden" name="callbackURL" value={landing} />
        <div className="field">
          <label htmlFor="backup-code">Backup code</label>
          <input
            id="backup-code"
            name="code"
            type="text"
            className="input--mono"
            placeholder="xxxx-xxxx-xxxx"
            autoComplete="one-time-code"
            required
            aria-invalid={error === null ? undefined : "true"}
            autoFocus
          />
          {error === null ? null : <p className="field-error">{error}</p>}
        </div>
        <button type="submit" className="btn btn--primary btn--block">
          Verify
        </button>
      </form>
      <p className="muted center">
        <a href={loginUrl({ method: "totp", next: redirectTo })}>Use your authenticator app instead</a>
      </p>
    </div>
  );
}

/**
 * §13's passkey sign-in: better-auth's options endpoint, `navigator.credentials.get`, and its
 * verify endpoint — whose answer IS the session cookie — then a document load of the landing.
 * Base64url both ways, the only wire form WebAuthn JSON has. A cancelled prompt and a refused
 * assertion read the same from here: the page stays, and the password form is still the way in.
 */
async function passkeySignIn(landing: string): Promise<void> {
  if (!("PublicKeyCredential" in window)) return;
  try {
    const answer = await fetch(passkeyAuthentication.options, {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    });
    if (!answer.ok) throw new Error(`options ${answer.status}`);
    const options = (await answer.json()) as { challenge: string; allowCredentials?: { id: string }[] } & Record<
      string,
      unknown
    >;
    const publicKey = {
      ...options,
      challenge: decode(options.challenge),
      allowCredentials: (options.allowCredentials ?? []).map((row) => ({ ...row, id: decode(row.id) })),
    } as unknown as PublicKeyCredentialRequestOptions;
    const assertion = (await navigator.credentials.get({ publicKey })) as PublicKeyCredential | null;
    if (assertion === null) throw new Error("no assertion");
    const response = assertion.response as AuthenticatorAssertionResponse;
    const verified = await fetch(passkeyAuthentication.verify, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        response: {
          id: assertion.id,
          rawId: encode(assertion.rawId),
          type: assertion.type,
          authenticatorAttachment: assertion.authenticatorAttachment,
          clientExtensionResults: assertion.getClientExtensionResults(),
          response: {
            clientDataJSON: encode(response.clientDataJSON),
            authenticatorData: encode(response.authenticatorData),
            signature: encode(response.signature),
            userHandle: response.userHandle === null ? undefined : encode(response.userHandle),
          },
        },
      }),
    });
    if (!verified.ok) throw new Error(`verify ${verified.status}`);
    location.assign(landing);
  } catch (failure) {
    console.error("Passkey sign-in did not complete", failure);
  }
}

function decode(value: string): Uint8Array<ArrayBuffer> {
  const raw = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function encode(buffer: ArrayBuffer): string {
  let text = "";
  for (const byte of new Uint8Array(buffer)) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The hub mark — duplicated from the Shell, which /login does not render. */
function BrandMark(): ReactNode {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <circle cx="12" cy="12" r="3.5" />
      <path d="M12 8.5V3.5" />
      <path d="M14.5 14.5L18.5 18.5" />
      <path d="M9.5 14.5L5.5 18.5" />
    </svg>
  );
}

function PasskeyIcon(): ReactNode {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="7.5" cy="15.5" r="3.5" />
      <path d="m21 2-9.6 9.6" />
      <path d="m15.5 7.5 3 3L22 7l-3-3" />
    </svg>
  );
}
