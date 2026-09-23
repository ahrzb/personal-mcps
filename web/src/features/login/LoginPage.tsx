import { useState } from "react";
import type { ReactNode } from "react";
import { AuthFrame } from "@/chrome/AuthFrame";
import { OtpBoxes } from "@/chrome/OtpBoxes";
import { useDocumentTitle } from "@/chrome/Shell";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { Field, FieldError, FieldGroup } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { readLoginIsland } from "@/lib/bootstrap";
import type { LoginIsland } from "@/lib/bootstrap";
import { loginUrl, passkeyAuthentication, paths } from "@/lib/paths";

/**
 * `/login` — username and password, the TOTP / backup-code challenge, and the passkey button,
 * as one page (Login.dc.html, TwoFactor.dc.html, AuthStates.dc.html). CHROMELESS: there is no
 * session yet to draw a nav for, so the page is `AuthFrame` (the brand, one card, a foot line)
 * rather than `Shell`.
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
    <AuthFrame
      foot={
        step.kind === "credentials" ? (
          "Lost your password? Reset it with the users script on the server."
        ) : (
          <a href={paths.login}>Back to sign in</a>
        )
      }
    >
      {step.kind === "credentials" ? <CredentialsCard step={step} landing={landing} /> : null}
      {step.kind === "totp" ? <TotpCard error={step.error} redirectTo={redirectTo} landing={landing} /> : null}
      {step.kind === "backup-code" ? <BackupCodeCard error={step.error} redirectTo={redirectTo} landing={landing} /> : null}
    </AuthFrame>
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
    <Card size="auth">
      <div>
        <CardTitle>Sign in</CardTitle>
        <CardDescription>Use your username and password.</CardDescription>
      </div>
      <FieldGroup render={<form method="post" action={paths.signIn} />}>
        <input type="hidden" name="callbackURL" value={landing} />
        <Field>
          <Label htmlFor="username">Username</Label>
          <Input
            id="username"
            name="username"
            type="text"
            defaultValue={step.username}
            autoComplete="username"
            required
            autoFocus={step.username === ""}
          />
        </Field>
        <Field>
          <Label htmlFor="password">Password</Label>
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            aria-invalid={step.error === null ? undefined : "true"}
            autoFocus={step.username !== ""}
          />
          {step.error === null ? null : <FieldError render={<p />}>{step.error}</FieldError>}
        </Field>
        <Button type="submit" className="w-full">
          Sign in
        </Button>
      </FieldGroup>
      <div className="flex items-center gap-3 text-xs text-muted-foreground before:h-px before:flex-1 before:bg-border before:content-[''] after:h-px after:flex-1 after:bg-border after:content-['']">
        <span>or</span>
      </div>
      {/* A WebAuthn assertion, not a form post — a button, and better-auth's own endpoints. */}
      <Button type="button" variant="outline" className="w-full" onClick={() => void passkeySignIn(landing)}>
        <PasskeyIcon />
        <span>Sign in with a passkey</span>
      </Button>
    </Card>
  );
}

/** The switch link below the TOTP and backup-code cards: a plain link wide, a full-width
 *  bordered button on the phone (legacy.css's `.switch-method a`, narrow only). */
const SWITCH_LINK_NARROW =
  "max-md:flex max-md:h-control-touch max-md:w-full max-md:items-center max-md:justify-center max-md:rounded-md max-md:border max-md:border-border max-md:bg-background max-md:px-4 max-md:text-base max-md:font-medium max-md:text-foreground max-md:no-underline max-md:shadow-xs";

/** The six-box TOTP challenge. `contents` on the form (Tailwind's own utility, matching
 *  legacy.css's identical `.contents`), so its children take the card's own rhythm rather
 *  than `FieldGroup`'s. */
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
    <Card size="auth">
      <div>
        <CardTitle>Two-factor code</CardTitle>
        <CardDescription>Enter the 6-digit code from your authenticator app.</CardDescription>
      </div>
      <form method="post" action={paths.totpVerify} className="contents" data-otp-form>
        <input type="hidden" name="callbackURL" value={landing} />
        <OtpBoxes invalid={error !== null} />
        {error === null ? null : (
          <FieldError render={<p />} className="text-center">
            {error}
          </FieldError>
        )}
        <Button type="submit" className="w-full">
          Verify
        </Button>
      </form>
      <p className="text-center text-sm text-muted-foreground">
        <a href={loginUrl({ method: "backup-code", next: redirectTo })} className={SWITCH_LINK_NARROW}>
          Use a backup code instead
        </a>
      </p>
    </Card>
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
    <Card size="auth">
      <div>
        <CardTitle>Use a backup code</CardTitle>
        <CardDescription>Each backup code works once.</CardDescription>
      </div>
      <form method="post" action={paths.backupCodeVerify} className="contents">
        <input type="hidden" name="callbackURL" value={landing} />
        <Field>
          <Label htmlFor="backup-code">Backup code</Label>
          <Input
            id="backup-code"
            name="code"
            type="text"
            placeholder="xxxx-xxxx-xxxx"
            autoComplete="one-time-code"
            required
            aria-invalid={error === null ? undefined : "true"}
            autoFocus
          />
          {error === null ? null : <FieldError render={<p />}>{error}</FieldError>}
        </Field>
        <Button type="submit" className="w-full">
          Verify
        </Button>
      </form>
      <p className="text-center text-sm text-muted-foreground">
        <a href={loginUrl({ method: "totp", next: redirectTo })}>Use your authenticator app instead</a>
      </p>
    </Card>
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

function PasskeyIcon(): ReactNode {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="7.5" cy="15.5" r="3.5" />
      <path d="m21 2-9.6 9.6" />
      <path d="m15.5 7.5 3 3L22 7l-3-3" />
    </svg>
  );
}
