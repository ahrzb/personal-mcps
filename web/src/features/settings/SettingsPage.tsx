import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { QueryKey } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { ConfirmDialog, useDropSearchKeys } from "@/chrome/Confirm";
import { useFlashParams } from "@/chrome/Notice";
import { OtpBoxes } from "@/chrome/OtpBoxes";
import { PanePills, PaneRail, paneGroups } from "@/chrome/Panes";
import type { PaneEntry } from "@/chrome/Panes";
import { Shell, useDocumentTitle } from "@/chrome/Shell";
import { QueryState, Skeleton } from "@/chrome/States";
import { useApi, useAppEnv } from "@/lib/api-context";
import { alertClass, formatStamp } from "@/lib/format";
import { ApiError } from "@/lib/http";
import { noticeOf } from "@/lib/notice";
import type { Notice } from "@/lib/notice";
import { passkeyRegistration, paths, SETTINGS_CONFIRM_PANE, settingsApi } from "@/lib/paths";
import type { SettingsPane } from "@/lib/paths";
import { keys, settingsQuery } from "@/lib/queries";
import type {
  BackupCodesRevealed,
  ChangePasswordBody,
  ConnectionRow,
  ExecutionUpdateBody,
  PasskeyRow,
  Redirected,
  SessionRow,
  SettingsRead,
  SettingsTokenRow,
  TotpEnabled,
  TotpEnrollment,
} from "@/lib/types";
import { usePreviewTransient } from "@/preview/transient";
import type { SearchBag } from "@/router";
import {
  confirmedLine,
  executionErrors,
  formatDate,
  formatRelative,
  listedTokens,
  passwordErrorOf,
  passwordRefusal,
  railEntries,
  sessionLabel,
  settingsConfirm,
  timeoutLabel,
  tokenKindOf,
} from "./derive";
import type { ExecutionErrors, PasswordField, SettingsConfirm } from "./derive";

/**
 * `/settings` and its six pane URLs — §13's seven panes behind one rail.
 *
 * The port of `server/src/pages/settings.tsx`, element for element and class for class: the
 * rail beside the pane on a wide screen, the pill row above it on a phone, one card per pane,
 * and the destructive confirmations as dialogs that ride the owning pane's `?confirm=` URL.
 * What differs is only what a client has to do differently:
 *
 *   - ONE read (`GET /api/hub/settings`) feeds the rail and every pane, as the server's one
 *     props builder did — a marker is the length of the list its pane draws, never a second
 *     query. The pane, `?kind=`, `?confirm=`, the flash and `?field=` are read off the URL;
 *   - every form posts JSON to `/api/hub/settings/*` and follows the answer's `next` where
 *     the form followed a 303 — as a document load when `reload` says the session (and the
 *     CSRF token with it) was replaced, client-side otherwise;
 *   - the two answers that reveal a secret — enabling two-factor, regenerating backup codes —
 *     land in component state and nowhere else (§4/§15), where the server rendered them into
 *     the POST's own 200.
 *
 * Keyed by pane at the route (`SettingsRoute`), so a pane switch starts from nothing exactly
 * as a GET did: no held notice, no typed password, no half-finished enrolment.
 */
export function SettingsPage({ pane }: { pane: SettingsPane }): ReactNode {
  useDocumentTitle("Settings · personal-mcps");
  const api = useApi();
  const { bootstrap } = useAppEnv();
  const search = useSearch({ strict: false }) as SearchBag;
  const flash = useFlashParams(search);
  const read = useQuery(settingsQuery(api));

  return (
    <Shell active="settings">
      <main className="page--workspace">
        <div className="page-head">
          <div>
            <h1 className="page-title">Settings</h1>
            <p className="page-subtitle">Sign-in and access for {bootstrap.username}.</p>
          </div>
        </div>
        <QueryState query={read} skeleton={<Skeleton rows={7} />}>
          {(data: SettingsRead) => <Board read={data} pane={pane} search={search} flash={flash} />}
        </QueryState>
      </main>
    </Shell>
  );
}

/** The accessible names of the page's two pane navigations — how a reader tells the rail
 *  from the pill row, which repeat each other's destinations by design. */
const RAIL_NAV_LABEL = "Settings panes";
const PILL_NAV_LABEL = "Settings panes, compact";

/** Everything under the title that needs the read: the pills, the flash, the framed rail and
 *  pane, and the dialog the URL asks for. */
function Board({
  read,
  pane,
  search,
  flash,
}: {
  read: SettingsRead;
  pane: SettingsPane;
  search: SearchBag;
  /** The search the last flash arrived on, latched past its strip — or null. */
  flash: URLSearchParams | null;
}): ReactNode {
  const kind = tokenKindOf(search);
  const entries: PaneEntry[] = railEntries(read, pane, kind).map((entry) => ({
    ...entry,
    href: paths.settingsPane(entry.pane),
  }));
  const notice = flash === null ? null : noticeOf(flash);
  const confirm = settingsConfirm(search, pane, read);

  return (
    <>
      <PanePills label={PILL_NAV_LABEL} entries={entries} />
      {notice === null ? null : <SettingsNotice notice={notice} />}
      {/* `--framed`: the rail and the pane are ONE box, as on the agent page, so the paned
          pages read as one family (design/layout-and-density.md §2). */}
      <div className="paned paned--framed">
        <PaneRail label={RAIL_NAV_LABEL} groups={paneGroups(entries)} />
        {/* Password is the one pane the boards hold narrow — a form, where the others are
            tables that need every pixel the rail leaves. */}
        <div className={pane === "password" ? "pane pane--narrow" : "pane"}>
          <Pane read={read} pane={pane} kind={kind} passwordError={passwordErrorOf(flash, pane)} />
        </div>
      </div>
      {confirm === null ? null : <SettingsDialog confirm={confirm} />}
    </>
  );
}

/** This page's banner: `settings.tsx`'s, which draws NO icon, and parts the message from its
 *  title only when there is one — unlike `chrome/Notice`'s, which the other pages share. */
function SettingsNotice({ notice }: { notice: Notice }): ReactNode {
  return (
    <div className={alertClass(notice.tone)} role="alert">
      <div>
        {notice.title === undefined ? null : <div className="alert-title">{notice.title}</div>}
        <div className={notice.title === undefined ? undefined : "alert-text"}>{notice.message}</div>
      </div>
    </div>
  );
}

/** The pane the URL asked for, and only it — the rail beside it is drawn from the same read
 *  whichever this is. */
function Pane({
  read,
  pane,
  kind,
  passwordError,
}: {
  read: SettingsRead;
  pane: SettingsPane;
  kind: SettingsTokenRow["kind"] | null;
  passwordError: PasswordField | null;
}): ReactNode {
  switch (pane) {
    case "password":
      return (
        <>
          <PasswordCard
            error={passwordError}
            minLength={read.limits.passwordMinLength}
            confirmedAt={read.sessions.find((session) => session.current)?.createdAt ?? null}
          />
          <PasswordFooter />
        </>
      );
    case "two-factor":
      return <TwoFactorPane enabled={read.twoFactor.enabled} />;
    case "passkeys":
      return <PasskeysCard passkeys={read.passkeys} />;
    case "sessions":
      return <SessionsCard sessions={read.sessions} />;
    case "tokens":
      return (
        <>
          <TokensCard tokens={read.tokens} kind={kind} />
          <p className="note">
            Revoking an app token closes that app's live connection. Keys are shown only once, at issue time.
          </p>
        </>
      );
    case "execution":
      return <ExecutionCard read={read} />;
    case "clients":
      return (
        <>
          <ClientsCard connections={read.connections} />
          <p className="note">
            A client registers itself the first time you approve it on the consent screen — that screen is a step
            inside the sign-in redirect, never a page you navigate to. Revoking stops its tokens working; the agent it
            acted as, and that agent's grants, are untouched.
          </p>
        </>
      );
  }
}

/* -------------------------------------------------------------- password --- */

/**
 * The password a credential change re-asks for. WRAPPED by its label rather than pointed at
 * by `for`, so it needs no id: the two-factor card draws it twice (wide and narrow), and an id
 * would have to be unique per instance.
 */
function ConfirmPasswordField({ autoFocus = false }: { autoFocus?: boolean }): ReactNode {
  return (
    <label className="field">
      <span className="label">Password</span>
      <input type="password" name="password" required autoFocus={autoFocus} />
    </label>
  );
}

/**
 * §13's Password pane. `error` is the control the last refusal named; the sentence beside it
 * is this pane's own (`derive.passwordRefusal`), never the URL's. The form is uncontrolled and
 * emptied the moment it is sent, as a redirect-back redrew it empty.
 */
function PasswordCard({
  error,
  minLength,
  confirmedAt,
}: {
  error: PasswordField | null;
  /** The server's one password minimum — the hint's number. */
  minLength: number;
  /** The current session's `createdAt`, or null if the read somehow carries no current row. */
  confirmedAt: string | null;
}): ReactNode {
  const write = useSettingsWrite("password");
  const refusal = passwordRefusal(minLength);
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    event.currentTarget.reset();
    void write.send(
      settingsApi.changePassword,
      {
        currentPassword: String(form.get("currentPassword") ?? ""),
        newPassword: String(form.get("newPassword") ?? ""),
        confirmPassword: String(form.get("confirmPassword") ?? ""),
        // A checkbox is present only when ticked — the form's own reading of its state.
        revokeOtherSessions: form.get("revokeOtherSessions") !== null,
      } satisfies ChangePasswordBody,
      "change_password",
    );
  };

  return (
    <div className="card card--pad">
      <div>
        <div className="card-title">Password</div>
        <div className="card-desc">Used with your username at sign-in. App and agent tokens are unaffected.</div>
      </div>
      <form className="form" onSubmit={submit}>
        <label className="field">
          <span className="label">Current password</span>
          <input
            type="password"
            name="currentPassword"
            autoComplete="current-password"
            required
            aria-invalid={error === "currentPassword" ? "true" : undefined}
          />
          {error === "currentPassword" ? <span className="field-error">{refusal.currentPassword}</span> : null}
        </label>
        <label className="field">
          <span className="label">New password</span>
          <input
            type="password"
            name="newPassword"
            autoComplete="new-password"
            required
            aria-invalid={error === "newPassword" ? "true" : undefined}
          />
          {/* One sentence, two roles: the standing hint, and the refusal when it named this. */}
          <span className={error === "newPassword" ? "field-error" : "field-hint"}>{refusal.newPassword}</span>
        </label>
        <label className="field">
          <span className="label">Confirm new password</span>
          <input
            type="password"
            name="confirmPassword"
            autoComplete="new-password"
            required
            aria-invalid={error === "confirmPassword" ? "true" : undefined}
          />
          {error === "confirmPassword" ? <span className="field-error">{refusal.confirmPassword}</span> : null}
        </label>
        {/* Default ON: a password is most often changed on suspicion (§13). */}
        <label className="checkbox">
          <input type="checkbox" name="revokeOtherSessions" value="on" defaultChecked />
          <span>Sign out my other sessions</span>
        </label>
        <span className="field-hint checkbox-hint">
          CLI sessions included — each machine runs <code className="code-inline">pmcp login</code> again. This
          browser stays signed in.
        </span>
        <div className="actions actions--start">
          <button type="submit" className="btn btn--primary" disabled={write.pending}>
            Update password
          </button>
          {confirmedAt === null ? null : <p className="field-hint">{confirmedLine(confirmedAt, Date.now())}</p>}
        </div>
      </form>
    </div>
  );
}

/** §13's footer, verbatim: change is not reset, and where a forgotten one is recovered. */
function PasswordFooter(): ReactNode {
  const { bootstrap } = useAppEnv();
  return (
    <p className="note">
      No email is on file, so there is no reset link: a forgotten password is recovered on the server with{" "}
      <span className="code-inline">pnpm users reset-password {bootstrap.username}</span> (§12). Changing it here needs
      the current one.
    </p>
  );
}

/* ------------------------------------------------------------- two-factor --- */

/**
 * The Two-factor pane: one of three cards — not enrolled, mid-enrolment (QR and code), or
 * enabled — plus the backup-codes card beside it whenever a fresh set is in hand.
 *
 * The enrolment and the codes are the answers to a POST and exist nowhere else (§4/§15): not
 * in the cache, not in a URL. So they are this component's state, dropped by Cancel and Done
 * — the server page forgot them on the next GET — and seeded from the preview transient,
 * which is empty in production.
 */
function TwoFactorPane({ enabled }: { enabled: boolean }): ReactNode {
  const transient = usePreviewTransient();
  const [enrollment, setEnrollment] = useState<TotpEnrollment | null>(() => transient.enrollment ?? null);
  const [codes, setCodes] = useState<string[] | null>(() => transient.backupCodes ?? null);
  const write = useSettingsWrite("two-factor");
  const forget = (): void => {
    setEnrollment(null);
    setCodes(null);
  };

  const enable = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const password = String(new FormData(event.currentTarget).get("password") ?? "");
    void write.send(settingsApi.totpEnable, { password }, "two_factor_enable", {
      reveal: (answer) => {
        const enabled = answer as TotpEnabled;
        setEnrollment(enabled.enrollment);
        setCodes(enabled.backupCodes);
      },
    });
  };

  const regenerate = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const password = String(new FormData(event.currentTarget).get("password") ?? "");
    void write.send(settingsApi.backupCodesGenerate, { password }, "backup_codes_generate", {
      reveal: (answer) => setCodes((answer as BackupCodesRevealed).backupCodes),
    });
  };

  return (
    <>
      {enrollment !== null ? (
        <EnrollmentCard
          enrollment={enrollment}
          pending={write.pending}
          onCancel={forget}
          onVerify={(code) =>
            void write.send(settingsApi.totpVerify, { code }, "two_factor_enable", {
              // A wrong code redraws the SAME enrolment: it cannot be minted again without
              // rotating the secret the owner has already scanned.
              refused: (error) => {
                setEnrollment({ ...enrollment, error: error.message });
                return true;
              },
            })
          }
        />
      ) : !enabled ? (
        <div className="card card--pad">
          <div>
            <div className="card-title">Two-factor authentication</div>
            <div className="card-desc">Add a second factor from an authenticator app.</div>
          </div>
          {/* ponytail: the password sits inline rather than behind a dialog like Disable's —
              enabling destroys nothing (settings.tsx's own note). */}
          <form className="form" onSubmit={enable}>
            <ConfirmPasswordField />
            <div className="actions actions--start">
              <button type="submit" className="btn btn--primary" disabled={write.pending}>
                Enable two-factor
              </button>
            </div>
          </form>
        </div>
      ) : (
        <div className="card card--pad">
          <div className="card-head">
            <div>
              <div className="card-title">Two-factor authentication</div>
              <div className="card-desc">TOTP via an authenticator app.</div>
            </div>
            <span className="badge badge--success">
              <span className="dot" />
              enabled
            </span>
          </div>
          {/* Two rows, not one flexing row: the two long labels overflow the narrow
              `.actions .btn{flex:1}` rule, so the phone stacks them full width. Bottom-aligned
              wide, so Disable sits beside the Regenerate BUTTON and not beside its field. */}
          <div className="actions actions--start actions--bottom wide-only">
            <form className="form" onSubmit={regenerate}>
              <ConfirmPasswordField />
              <button type="submit" className="btn btn--outline btn--sm" disabled={write.pending}>
                Regenerate backup codes
              </button>
            </form>
            <Link className="btn btn--danger-outline btn--sm" to={paths.settingsConfirm("two-factor", "disable-two-factor")}>
              Disable two-factor
            </Link>
          </div>
          {/* The layout lives on a nested div: an inline `display` on the `narrow-only`
              element itself would beat the class's `display: none` at wide widths. */}
          <div className="narrow-only">
            <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-5)" }}>
              <form className="form" onSubmit={regenerate}>
                <ConfirmPasswordField />
                <button type="submit" className="btn btn--outline btn--block" disabled={write.pending}>
                  Regenerate backup codes
                </button>
              </form>
              <Link
                className="btn btn--danger-outline btn--block"
                to={paths.settingsConfirm("two-factor", "disable-two-factor")}
              >
                Disable two-factor
              </Link>
            </div>
          </div>
        </div>
      )}
      {codes === null ? null : <BackupCodesCard codes={codes} onDone={forget} />}
    </>
  );
}

/** SettingsStates "TOTP setup": the QR, the secret for manual entry, and the six boxes. */
function EnrollmentCard({
  enrollment,
  pending,
  onCancel,
  onVerify,
}: {
  enrollment: TotpEnrollment;
  pending: boolean;
  /** Drops the enrolment — Cancel is still a link to the pane, as the server's was. */
  onCancel: () => void;
  onVerify: (code: string) => void;
}): ReactNode {
  return (
    <div className="card card--pad">
      <div>
        <div className="card-title">Set up two-factor</div>
        <div className="card-desc">Scan the QR code, then enter the 6-digit code.</div>
      </div>
      <img
        src={enrollment.qrDataUri}
        width={140}
        height={140}
        alt="Scan this code with your authenticator app"
        style={{ alignSelf: "center", borderRadius: "var(--radius-lg)" }}
      />
      <div className="secret">{enrollment.secret}</div>
      <form
        className="form"
        data-otp-form
        onSubmit={(event) => {
          event.preventDefault();
          onVerify(String(new FormData(event.currentTarget).get("code") ?? ""));
        }}
      >
        <OtpBoxes invalid={enrollment.error !== null} />
        {enrollment.error === null ? null : <p className="field-error center">{enrollment.error}</p>}
        <div className="actions actions--start">
          <button type="submit" className="btn btn--primary" disabled={pending}>
            Verify
          </button>
          <Link className="btn btn--ghost" to={paths.settingsPane("two-factor")} onClick={onCancel}>
            Cancel
          </Link>
        </div>
      </form>
    </div>
  );
}

/** SettingsStates "Backup codes" — the one render that ever shows the plaintext set. */
function BackupCodesCard({ codes, onDone }: { codes: string[]; onDone: () => void }): ReactNode {
  return (
    <div className="card card--pad">
      <div className="card-title">Backup codes</div>
      <div className="code-grid">
        {codes.map((code) => (
          <div className="code-chip" data-code key={code}>
            {code}
          </div>
        ))}
      </div>
      {/* No warning-coloured text utility exists outside the boxed `.alert`: the hint's
          sizing with the token's colour. */}
      <p className="field-hint" style={{ color: "var(--warning)" }}>
        Store these somewhere safe — they are shown only once.
      </p>
      <div className="actions actions--start">
        {/* Newline-joined, the reveal's own shape, so the pasted set matches the screen. */}
        <button type="button" className="btn btn--outline" onClick={() => void navigator.clipboard.writeText(codes.join("\n"))}>
          Copy codes
        </button>
        <Link className="btn btn--primary" to={paths.settingsPane("two-factor")} onClick={onDone}>
          Done
        </Link>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- passkeys --- */

/**
 * The Passkeys pane. **Add passkey** is the one credential control here that is not a form:
 * a WebAuthn registration is better-auth's options endpoint, the browser's authenticator and
 * better-auth's verify endpoint, so it calls better-auth's mount directly and nothing posts
 * at a hub route. A cancelled prompt and a refused attestation read the same from here — the
 * list simply does not grow.
 */
function PasskeysCard({ passkeys }: { passkeys: PasskeyRow[] }): ReactNode {
  const client = useQueryClient();
  const now = Date.now();
  const add = (): void => {
    if (!("PublicKeyCredential" in window)) return;
    registerPasskey().then(
      () => void client.invalidateQueries({ queryKey: keys.settings() }),
      (failure: unknown) => console.error("Add passkey did not complete", failure),
    );
  };
  const addButton = (
    <button type="button" className="btn btn--outline btn--sm" onClick={add}>
      <PlusIcon />
      <span>Add passkey</span>
    </button>
  );

  return (
    <div className="card card--pad">
      <div>
        <div className="card-title">Passkeys</div>
        <div className="card-desc">Sign in with a security key or platform authenticator.</div>
      </div>
      {passkeys.length === 0 ? (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: "var(--space-6)",
            padding: "var(--space-4) 0",
          }}
        >
          <p className="muted center" style={{ maxWidth: 280 }}>
            No passkeys yet. Add one to sign in without a password.
          </p>
          <div className="actions actions--start">{addButton}</div>
        </div>
      ) : (
        <>
          <div className="list">
            {passkeys.map((pk) => (
              <div className="list-item" key={pk.id}>
                <div style={{ display: "flex", alignItems: "center", gap: "var(--space-6)" }}>
                  <KeyIcon />
                  <div>
                    <div className="list-title">{pk.name}</div>
                    <div className="list-meta">
                      Added {formatDate(pk.addedAt)} ·{" "}
                      {pk.lastUsedAt === null ? "never used" : `last used ${formatRelative(pk.lastUsedAt, now)}`}
                    </div>
                  </div>
                </div>
                <Link
                  className="btn btn--danger-ghost btn--sm"
                  to={paths.settingsConfirm("passkeys", "remove-passkey", pk.id)}
                >
                  Remove
                </Link>
              </div>
            ))}
          </div>
          <div className="actions actions--start">{addButton}</div>
        </>
      )}
    </div>
  );
}

/**
 * One WebAuthn registration against better-auth's two endpoints. Base64url is the only wire
 * form WebAuthn JSON has: the options arrive with `challenge`, `user.id` and every excluded
 * credential's `id` encoded, and the attestation goes back encoded the same way.
 */
async function registerPasskey(): Promise<void> {
  const answer = await fetch(passkeyRegistration.options, {
    credentials: "same-origin",
    headers: { Accept: "application/json" },
  });
  if (!answer.ok) throw new Error(`options ${answer.status}`);
  const options = (await answer.json()) as {
    challenge: string;
    user: { id: string };
    excludeCredentials?: { id: string }[];
  } & Record<string, unknown>;
  const publicKey = {
    ...options,
    challenge: decode(options.challenge),
    user: { ...options.user, id: decode(options.user.id) },
    excludeCredentials: (options.excludeCredentials ?? []).map((row) => ({ ...row, id: decode(row.id) })),
  } as unknown as PublicKeyCredentialCreationOptions;
  const credential = (await navigator.credentials.create({ publicKey })) as PublicKeyCredential | null;
  if (credential === null) throw new Error("no credential");
  const response = credential.response as AuthenticatorAttestationResponse;
  const verified = await fetch(passkeyRegistration.verify, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      response: {
        id: credential.id,
        rawId: encode(credential.rawId),
        type: credential.type,
        authenticatorAttachment: credential.authenticatorAttachment,
        clientExtensionResults: credential.getClientExtensionResults(),
        response: {
          clientDataJSON: encode(response.clientDataJSON),
          attestationObject: encode(response.attestationObject),
          transports: response.getTransports(),
        },
      },
    }),
  });
  if (!verified.ok) throw new Error(`verify ${verified.status}`);
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

/* --------------------------------------------------------------- sessions --- */

/** §13's **Revoke all others** — the one destructive control that names no row. */
function RevokeAllOthers(): ReactNode {
  return (
    <Link className="btn btn--danger-outline btn--sm" to={paths.settingsConfirm("sessions", "revoke-other-sessions")}>
      Revoke all others
    </Link>
  );
}

/** The Sessions pane: a full-bleed table wide, list rows with one combined meta line narrow —
 *  two markups of the same rows, as the server drew them. */
function SessionsCard({ sessions }: { sessions: SessionRow[] }): ReactNode {
  const now = Date.now();
  return (
    <div className="card">
      <div className="card-head wide-only" style={{ padding: "var(--space-10) var(--space-10) var(--space-8)" }}>
        <div>
          <div className="card-title">Active sessions</div>
          <div className="card-desc">Web and CLI sessions currently signed in.</div>
        </div>
        <RevokeAllOthers />
      </div>
      <table className="table wide-only">
        <thead>
          <tr>
            <th>Client</th>
            <th>Created</th>
            <th>Last active</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {sessions.map((session) => (
            <tr key={session.id}>
              <td>
                <div style={{ display: "flex", alignItems: "center", gap: "var(--space-4)" }}>
                  <span>{sessionLabel(session)}</span>
                  {session.current ? <span className="badge badge--outline">current</span> : null}
                </div>
              </td>
              <td className="cell-muted">{formatDate(session.createdAt)}</td>
              <td className="cell-muted">{formatRelative(session.lastActiveAt, now)}</td>
              <td className="cell-actions">
                {session.current ? null : (
                  <Link
                    className="btn btn--danger-ghost btn--sm"
                    to={paths.settingsConfirm("sessions", "revoke-session", session.id)}
                  >
                    Revoke
                  </Link>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="card--pad narrow-only" style={{ gap: "var(--space-3)" }}>
        <div className="card-head">
          <div>
            <div className="card-title">Active sessions</div>
            <div className="card-desc">Web and CLI sessions currently signed in.</div>
          </div>
          <RevokeAllOthers />
        </div>
        <div className="list">
          {sessions.map((session) => (
            <div className="list-item" key={session.id}>
              <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-1)" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "var(--space-4)" }}>
                  <span className="list-title">{sessionLabel(session)}</span>
                  {session.current ? <span className="badge badge--outline">current</span> : null}
                </div>
                <div className="list-meta">
                  Created {formatDate(session.createdAt)} · active {formatRelative(session.lastActiveAt, now)}
                </div>
              </div>
              {session.current ? null : (
                <Link
                  className="btn btn--danger-ghost btn--sm"
                  to={paths.settingsConfirm("sessions", "revoke-session", session.id)}
                >
                  Revoke
                </Link>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------- tokens --- */

/** §13's **All · Agents · Apps**: three links to this same pane, so a narrowed listing is a
 *  URL a browser can bookmark and Back undoes. */
const TOKEN_KINDS: readonly { kind: SettingsTokenRow["kind"] | null; label: string }[] = [
  { kind: null, label: "All" },
  { kind: "agent", label: "Agents" },
  { kind: "app", label: "Apps" },
];

/**
 * §13's Tokens pane — the one pane whose control is inline rather than behind a dialog. The
 * word follows what the row still is: a live key is revoked, an expired one only removed from
 * the listing, and both are the same op.
 */
function TokensCard({ tokens, kind }: { tokens: SettingsTokenRow[]; kind: SettingsTokenRow["kind"] | null }): ReactNode {
  const write = useSettingsWrite("tokens");
  const listed = listedTokens(tokens, kind);
  return (
    <div className="card">
      <div className="card-head" style={{ padding: "var(--space-10) var(--space-10) var(--space-8)" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-1)" }}>
          <div className="card-title">Tokens</div>
          <div className="card-desc">Every key issued in this namespace. Issue new keys from an app or agent page.</div>
        </div>
        <div className="segmented" style={{ flexShrink: 0 }}>
          {TOKEN_KINDS.map((option) => (
            <Link
              key={option.label}
              to={paths.settingsPane("tokens")}
              search={option.kind === null ? {} : { kind: option.kind }}
              // The query IS this control's state, so the router's own "current" judgement
              // must match it exactly (`chrome/Panes`' reason, with the search counted).
              activeOptions={{ exact: true, includeSearch: true }}
              aria-current={option.kind === kind ? "page" : undefined}
            >
              {option.label}
            </Link>
          ))}
        </div>
      </div>
      {listed.length === 0 ? (
        <div className="empty empty--inline">
          {/* Two empty states for two facts: nothing was ever issued, or the FILTER hides
              what was — and under a filter an empty namespace is still the first fact. */}
          {kind === null || tokens.length === 0 ? (
            <div className="empty-text">No keys issued yet.</div>
          ) : (
            <div className="empty-text">
              No {kind} keys. <Link to={paths.settingsPane("tokens")}>Show all {tokens.length}</Link>.
            </div>
          )}
        </div>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Token</th>
              <th>Kind</th>
              <th>Bound to</th>
              <th>Created</th>
              <th>Expires</th>
              <th>Last used</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {listed.map((token) => (
              /* An expired row recedes behind the live ones; the amber badge is the one thing
                 in it still at full contrast. */
              <tr key={token.id} className={token.expired ? "row--dim" : undefined}>
                <td className="cell-mono">{token.prefix}</td>
                <td>
                  <span className="badge badge--mono">{token.kind}</span>
                </td>
                <td className="cell-mono">
                  <Link to={token.kind === "app" ? paths.appDetail(token.boundTo) : paths.agentDetail(token.boundTo)}>
                    {token.boundTo}
                  </Link>
                </td>
                <td className="cell-muted">{formatStamp(token.createdAt)}</td>
                <td className="cell-muted">
                  {token.expired ? (
                    <span className="badge badge--warning">expired</span>
                  ) : token.expiresAt === null ? (
                    "never"
                  ) : (
                    formatStamp(token.expiresAt)
                  )}
                </td>
                <td className="cell-muted">{token.lastUsedAt === null ? "never" : formatStamp(token.lastUsedAt)}</td>
                <td className="cell-actions">
                  {/* Still a <form> around the button, as the server drew it — and that is
                      layout, not habit: the form is the cell's flex item, so the phone's
                      `.cell-actions .btn { flex: 1 }` does not stretch the button across. */}
                  <form
                    onSubmit={(event) => {
                      event.preventDefault();
                      void write.send(settingsApi.tokenRevoke, { id: token.id }, "token_revoke", {
                        // A revoked key also leaves its app's or agent's own token list.
                        touches: [keys.tokens(), ["app"], ["agent"]],
                      });
                    }}
                  >
                    <button type="submit" className="btn btn--danger-outline btn--sm" disabled={write.pending}>
                      {token.expired ? "Remove" : "Revoke"}
                    </button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/* -------------------------------------------------------- connected clients --- */

/** §13's Connected clients pane: one row per client; a revoked row stays, with no control,
 *  because re-consent revives the same row (§19.4). */
function ClientsCard({ connections }: { connections: ConnectionRow[] }): ReactNode {
  return (
    <div className="card">
      <div className="card--pad" style={{ gap: "var(--space-1)" }}>
        <div className="card-title">Connected clients</div>
        <div className="card-desc">Outside software you approved to reach this hub, and the agent each one acts as.</div>
      </div>
      {connections.length === 0 ? (
        <div className="empty empty--inline">
          <div className="empty-text">A client that completes the consent screen appears here.</div>
        </div>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Client</th>
              <th>Acts as</th>
              <th>Created</th>
              <th>Last used</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {connections.map((row) => (
              <tr key={row.id}>
                <td>
                  <div style={{ display: "flex", alignItems: "center", gap: "var(--space-4)" }}>
                    <span className="cell-name">{row.clientName ?? row.clientId}</span>
                    {/* Nobody vouched for this name but the client that chose it (§19.5). */}
                    {row.selfRegistered ? <span className="badge badge--warning">unverified</span> : null}
                  </div>
                  <div className="cell-slug">{row.redirectOrigin}</div>
                </td>
                <td className="cell-mono">
                  <Link to={paths.agentDetail(row.agentSlug)}>{row.agentSlug}</Link>
                </td>
                <td className="cell-muted">{formatStamp(row.createdAt)}</td>
                <td className="cell-muted">{row.lastUsedAt === null ? "never" : formatStamp(row.lastUsedAt)}</td>
                <td>
                  {row.revokedAt === null ? (
                    <span className="badge badge--success">
                      <span className="dot" />
                      active
                    </span>
                  ) : (
                    <span className="badge badge--muted">revoked</span>
                  )}
                </td>
                <td className="cell-actions">
                  {row.revokedAt === null ? (
                    <Link
                      className="btn btn--danger-outline btn--sm"
                      to={paths.settingsConfirm("clients", "revoke-connection", row.id)}
                    >
                      Revoke
                    </Link>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/* -------------------------------------------------------------- execution --- */

/**
 * §23's Execution pane: the owner's timeout pair as two millisecond fields and one Save. The
 * fields hold the OWNER'S TEXT, never a parsed number, so a refused Save keeps what they typed
 * beside the op's sentence under the control it named. `draft` is null while untouched, which
 * means "show the committed pair" — and goes back to null once a Save lands, so the fields
 * read the committed values again, as the redirect-back drew them.
 */
function ExecutionCard({ read }: { read: SettingsRead }): ReactNode {
  const transient = usePreviewTransient();
  const [draft, setDraft] = useState<{ defaults: string; maximum: string } | null>(
    () => transient.executionDraft ?? null,
  );
  const [errors, setErrors] = useState<ExecutionErrors>(() =>
    transient.refusal === undefined
      ? {}
      : executionErrors(transient.refusal.violations ?? [{ field: "", reason: transient.refusal.reason }]),
  );
  const write = useSettingsWrite("execution");
  const shown = draft ?? {
    defaults: String(read.execution.defaultTimeoutMs),
    maximum: String(read.execution.maxTimeoutMs),
  };
  const { minTimeoutMs, maxTimeoutMs } = read.limits;

  const save = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const outcome = await write.send(
      settingsApi.executionUpdate,
      { default_timeout_ms: shown.defaults, max_timeout_ms: shown.maximum } satisfies ExecutionUpdateBody,
      "hub_settings_update",
      {
        refused: (error) => {
          setErrors(executionErrors(error.violations ?? [{ field: "", reason: error.message }]));
          return true;
        },
      },
    );
    if (outcome === "landed") {
      setDraft(null);
      setErrors({});
    }
  };

  return (
    <div className="card card--pad">
      <div>
        <div className="card-title">Execution</div>
        <div className="card-desc">
          How long a program run through this namespace's hub endpoint may take. Owner-wide, and measured in
          milliseconds.
        </div>
      </div>

      <form className="form" onSubmit={(event) => void save(event)}>
        {errors.form === undefined ? null : (
          <div className="alert alert--danger" role="alert">
            <div className="alert-text">{errors.form}</div>
          </div>
        )}

        <label className="field">
          <span className="label">Default timeout</span>
          <input
            type="number"
            name="default_timeout_ms"
            value={shown.defaults}
            min={minTimeoutMs}
            max={maxTimeoutMs}
            required
            aria-invalid={errors.defaults === undefined ? undefined : "true"}
            onChange={(event) => setDraft({ ...shown, defaults: event.target.value })}
          />
          {errors.defaults === undefined ? (
            <span className="field-hint">Used when a program sends no timeout of its own.</span>
          ) : (
            <span className="field-error">{errors.defaults}</span>
          )}
        </label>

        <label className="field">
          <span className="label">Maximum timeout</span>
          <input
            type="number"
            name="max_timeout_ms"
            value={shown.maximum}
            min={minTimeoutMs}
            max={maxTimeoutMs}
            required
            aria-invalid={errors.maximum === undefined ? undefined : "true"}
            onChange={(event) => setDraft({ ...shown, maximum: event.target.value })}
          />
          {errors.maximum === undefined ? (
            <span className="field-hint">
              The largest a program may request — never below the default, and never above {timeoutLabel(maxTimeoutMs)}.
            </span>
          ) : (
            <span className="field-error">{errors.maximum}</span>
          )}
        </label>

        <div className="actions actions--start">
          <button type="submit" className="btn btn--primary" disabled={write.pending}>
            Save
          </button>
        </div>
      </form>

      <p className="note">
        Each execution snapshots this pair when it is admitted, so a change governs new runs only — one already going
        keeps the deadline it started with.
      </p>
    </div>
  );
}

/* ---------------------------------------------------------------- dialogs --- */

/**
 * Dialogs.dc.html's destructive confirmations. Open because the URL says so (`?confirm=` on
 * the owning pane); Escape or the scrim drops the key by a replacing navigation, and Cancel is
 * a link back to the bare pane, as it was.
 */
function SettingsDialog({ confirm }: { confirm: SettingsConfirm }): ReactNode {
  const drop = useDropSearchKeys();
  const owner = SETTINGS_CONFIRM_PANE[confirm.kind];
  const write = useSettingsWrite(owner);
  const cancel = (
    <Link className="btn btn--ghost" to={paths.settingsPane(owner)}>
      Cancel
    </Link>
  );
  /** One dialog's act: its title, its sentence, its write, and the danger button's word. */
  const act = (
    title: string,
    text: string,
    word: string,
    run: () => void,
  ): ReactNode => (
    <ConfirmDialog title={title} text={text} onClose={() => drop(["confirm", "id"])}>
      <form
        className="actions"
        onSubmit={(event) => {
          event.preventDefault();
          run();
        }}
      >
        {cancel}
        <button type="submit" className="btn btn--danger" disabled={write.pending}>
          {word}
        </button>
      </form>
    </ConfirmDialog>
  );

  switch (confirm.kind) {
    case "disable-two-factor":
      return (
        <ConfirmDialog
          title="Disable two-factor?"
          text="You'll no longer need a code from your authenticator app to sign in. Enter your password to confirm."
          onClose={() => drop(["confirm", "id"])}
        >
          <form
            className="form"
            onSubmit={(event) => {
              event.preventDefault();
              const password = String(new FormData(event.currentTarget).get("password") ?? "");
              void write.send(settingsApi.totpDisable, { password }, "two_factor_disable");
            }}
          >
            <ConfirmPasswordField autoFocus />
            <div className="actions">
              {cancel}
              <button type="submit" className="btn btn--danger" disabled={write.pending}>
                Disable
              </button>
            </div>
          </form>
        </ConfirmDialog>
      );
    case "remove-passkey":
      return act(
        `Remove passkey “${confirm.name}”?`,
        "This passkey can't be restored — you'd have to add it again from that device.",
        "Remove",
        () => void write.send(settingsApi.passkeyDelete, { id: confirm.id }, "passkey_remove"),
      );
    case "revoke-other-sessions":
      return act(
        "Revoke all other sessions?",
        "Every other browser and CLI session is signed out immediately. This one stays.",
        "Revoke all others",
        () => void write.send(settingsApi.revokeOtherSessions, {}, "revoke_other_sessions"),
      );
    case "revoke-connection":
      return act(
        `Revoke “${confirm.client}”?`,
        "Its tokens stop working immediately. The agent it acted as, and that agent's grants, are untouched.",
        "Revoke",
        () =>
          void write.send(settingsApi.connectionRevoke, { id: confirm.id }, "connection_revoke", {
            // The agent page lists its own connections.
            touches: [["agent"]],
          }),
      );
    case "revoke-session":
      return act(
        `Revoke “${confirm.label}”?`,
        "This session is signed out immediately and can't be restored — whoever's using it will need to sign in again.",
        "Revoke",
        () => void write.send(settingsApi.sessionRevoke, { id: confirm.id }, "session_revoke"),
      );
  }
}

/* ------------------------------------------------------------ the writes --- */

/** How one settings write ended, for the caller that still has something to do after it. */
type WriteOutcome = "landed" | "revealed" | "refused" | "failed";

/**
 * Every /settings write, and where it lands — the one place the page's mutations meet the
 * server, so the landing rule is written once:
 *
 *   - a `{ next, reload }` answer is followed: `location.assign` when `reload` (the session,
 *     and the CSRF token this document holds, were just replaced), a client-side navigation
 *     otherwise — after the settings read is marked stale, so the rail and the pane redraw
 *     what the write changed;
 *   - any other 200 is a REVEAL (an enrolment, a code set) and goes to `reveal`;
 *   - a 422 the caller redraws in place (a wrong TOTP code, a refused timeout pair) goes to
 *     `refused`, which answers true when it took it;
 *   - anything else lands on the pane as the failure flash the old redirect-back wrote, under
 *     the same op word, so a 422 from a revoke reads exactly as it did; a 401 is already a
 *     navigation to /login (`lib/http`) and is left to it.
 */
function useSettingsWrite(pane: SettingsPane): {
  pending: boolean;
  send: (
    path: string,
    body: unknown,
    /** The op word the flash names — the server's own for this write. */
    op: string,
    options?: {
      reveal?: (answer: unknown) => void;
      refused?: (error: ApiError) => boolean;
      /** Cached reads besides the settings read that this write changes. */
      touches?: QueryKey[];
    },
  ) => Promise<WriteOutcome>;
} {
  const api = useApi();
  const navigate = useNavigate();
  const client = useQueryClient();
  const [pending, setPending] = useState(false);

  const send: ReturnType<typeof useSettingsWrite>["send"] = async (path, body, op, options = {}) => {
    setPending(true);
    let answer: unknown;
    try {
      answer = await api.post<unknown>(path, body);
    } catch (error) {
      setPending(false);
      if (error instanceof ApiError && error.status === 401) return "failed";
      if (error instanceof ApiError && error.status === 422 && options.refused?.(error) === true) return "refused";
      const reason = error instanceof Error ? error.message : String(error);
      void navigate({
        to: paths.settingsPane(pane),
        search: reason === "" ? { failed: op } : { failed: op, reason },
      });
      return "failed";
    }
    setPending(false);
    for (const key of [keys.settings(), ...(options.touches ?? [])]) void client.invalidateQueries({ queryKey: key });
    if (!isRedirected(answer)) {
      options.reveal?.(answer);
      return "revealed";
    }
    if (answer.reload) location.assign(answer.next);
    else void navigate({ href: answer.next });
    return "landed";
  };

  return { pending, send };
}

/** Whether an answer is a landing rather than a reveal — read by shape, the one thing the
 *  two kinds of 200 do not share. */
function isRedirected(answer: unknown): answer is Redirected {
  return typeof answer === "object" && answer !== null && "next" in answer && typeof answer.next === "string";
}

/* ----------------------------------------------------------------- icons --- */

function KeyIcon(): ReactNode {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ color: "var(--muted-fg)", flexShrink: 0 }}
      aria-hidden="true"
    >
      <circle cx="7.5" cy="15.5" r="3.5" />
      <path d="m21 2-9.6 9.6" />
      <path d="m15.5 7.5 3 3L22 7l-3-3" />
    </svg>
  );
}

function PlusIcon(): ReactNode {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M5 12h14" />
      <path d="M12 5v14" />
    </svg>
  );
}
