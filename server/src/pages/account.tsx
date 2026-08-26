// account.tsx — /account: TOTP/passkey enrollment, active sessions.
//
// Pure (props) => JSX per model.ts's contract: no fetching, no cookies, no
// Date.now() — every relative timestamp below is a function of `now` and an
// ISO field already on the props. Every URL comes from `paths`; every
// mutating control is a real <form method="post"> carrying `csrfToken`, and
// every destructive one goes through `confirm` (Dialogs.dc.html) as
// server-rendered dialog state rather than firing on click.
//
// The two-factor card is one of three mutually exclusive shapes
// (AccountStates.dc.html): not-enrolled, mid-enrollment (QR + code), or
// enabled — plus a transient fourth "backup codes" card that appears
// alongside it exactly once, whenever `revealedBackupCodes` is set.

import type { FC } from "hono/jsx";
import type {
  AccountConfirm,
  AccountProps,
  Notice,
  PasskeyRow,
  SessionRow,
  TotpEnrollment,
  TwoFactorSummary,
} from "./model";
import { paths } from "./model";
import { Layout } from "./layout";

/* ------------------------------------------------------------------ time --- */

/** "Aug 24, 2026" — UTC so a fixture renders identically regardless of host TZ. */
function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** Calendar-day difference in UTC — "yesterday" means the previous date, not "within 24h". */
function calendarDaysBetween(fromIso: string, toIso: string): number {
  const from = new Date(fromIso);
  const to = new Date(toIso);
  const a = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
  const b = Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate());
  return Math.round((b - a) / 86_400_000);
}

/** "Now" / "N minutes ago" / "N hours ago" / "yesterday" / "N days ago" / a date past a week out. */
function formatRelative(iso: string, nowIso: string): string {
  const diffMs = Date.parse(nowIso) - Date.parse(iso);
  const dayDiff = calendarDaysBetween(iso, nowIso);
  if (dayDiff <= 0) {
    if (diffMs < 60_000) return "Now";
    if (diffMs < 3_600_000) {
      const m = Math.max(1, Math.floor(diffMs / 60_000));
      return `${m} minute${m === 1 ? "" : "s"} ago`;
    }
    const h = Math.floor(diffMs / 3_600_000);
    return `${h} hour${h === 1 ? "" : "s"} ago`;
  }
  if (dayDiff === 1) return "yesterday";
  if (dayDiff < 7) return `${dayDiff} days ago`;
  return formatDate(iso);
}

/* ----------------------------------------------------------------- icons --- */

const KeyIcon: FC = () => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    style="color: var(--muted-fg); flex-shrink: 0;"
    aria-hidden="true"
  >
    <circle cx="7.5" cy="15.5" r="3.5" />
    <path d="m21 2-9.6 9.6" />
    <path d="m15.5 7.5 3 3L22 7l-3-3" />
  </svg>
);

const PlusIcon: FC = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
    <path d="M5 12h14" />
    <path d="M12 5v14" />
  </svg>
);

/* ---------------------------------------------------------------- notice --- */

const NOTICE_CLASS: Record<Notice["tone"], string> = {
  info: "alert",
  success: "alert alert--success",
  warning: "alert alert--warning",
  danger: "alert alert--danger",
};

function noticeClass(tone: Notice["tone"]): string {
  return NOTICE_CLASS[tone];
}

const NoticeBanner: FC<{ notice: Notice }> = ({ notice }) => (
  <div class={noticeClass(notice.tone)} role="alert">
    <div>
      {notice.title ? <div class="alert-title">{notice.title}</div> : null}
      <div class={notice.title ? "alert-text" : undefined}>{notice.message}</div>
    </div>
  </div>
);

/* ------------------------------------------------------------- two-factor --- */

const AddPasskeyButton: FC = () => (
  <button type="button" class="btn btn--outline btn--sm">
    <PlusIcon />
    <span>Add passkey</span>
  </button>
);

/**
 * The password every credential change on this page is asked for. It is a control rather
 * than a courtesy: the route behind each of these forms reads `password` and better-auth
 * refuses the change without it, so a form drawn without this field is a button that
 * cannot work whatever the owner types.
 *
 * The input is WRAPPED by its label rather than pointed at by `for`, so it needs no id:
 * the two-factor card renders twice into one document (wide and narrow), and an id would
 * have to be unique per instance — a duplicate points every label at one input. Wrapping
 * makes that hazard not exist rather than making each caller manage it. `.field` moves
 * onto the label and `.label` onto a span so the rendered boxes are the ones styles.css
 * already lays out.
 */
const PasswordField: FC<{ autofocus?: boolean }> = ({ autofocus }) => (
  <label class="field">
    <span class="label">Password</span>
    <input type="password" name="password" required autofocus={autofocus} />
  </label>
);

const TwoFactorCard: FC<{
  twoFactor: TwoFactorSummary;
  enrollment: TotpEnrollment | null;
  csrfToken: string;
}> = ({ twoFactor, enrollment, csrfToken }) => {
  if (enrollment) {
    return (
      <div class="card card--pad">
        <div>
          <div class="card-title">Set up two-factor</div>
          <div class="card-desc">Scan the QR code, then enter the 6-digit code.</div>
        </div>
        <img
          src={enrollment.qrDataUri}
          width={140}
          height={140}
          alt="Scan this code with your authenticator app"
          style="align-self: center; border-radius: var(--radius-lg);"
        />
        <div class="secret">{enrollment.secret}</div>
        <form method="post" action={paths.auth.totpVerify} class="form">
          <input type="hidden" name="csrf" value={csrfToken} />
          <div class="otp">
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <input
                key={i}
                type="text"
                inputmode="numeric"
                autocomplete="one-time-code"
                maxlength={1}
                name={`digit${i}`}
                aria-label={`Digit ${i + 1} of 6`}
                aria-invalid={enrollment.error ? "true" : undefined}
              />
            ))}
          </div>
          {enrollment.error ? <p class="field-error center">{enrollment.error}</p> : null}
          <div class="actions actions--start">
            <button type="submit" class="btn btn--primary">
              Verify
            </button>
            <a class="btn btn--ghost" href={paths.account}>
              Cancel
            </a>
          </div>
        </form>
      </div>
    );
  }

  if (!twoFactor.enabled) {
    return (
      <div class="card card--pad">
        <div>
          <div class="card-title">Two-factor authentication</div>
          <div class="card-desc">Add a second factor from an authenticator app.</div>
        </div>
        {/* ponytail: the password sits inline rather than behind a confirm dialog like
            Disable's. Enabling destroys nothing, and the dialog route would need an
            AccountConfirm arm (model.ts) this card has no other use for — add one if a
            third password-gated control ever appears here. */}
        <form method="post" action={paths.auth.totpEnable} class="form">
          <input type="hidden" name="csrf" value={csrfToken} />
          <PasswordField />
          <div class="actions actions--start">
            <button type="submit" class="btn btn--primary">
              Enable two-factor
            </button>
          </div>
        </form>
      </div>
    );
  }

  return (
    <div class="card card--pad">
      <div class="card-head">
        <div>
          <div class="card-title">Two-factor authentication</div>
          <div class="card-desc">TOTP via an authenticator app.</div>
        </div>
        <span class="badge badge--success">
          <span class="dot" />
          enabled
        </span>
      </div>
      <p class="muted">
        {twoFactor.backupCodesRemaining} backup code{twoFactor.backupCodesRemaining === 1 ? "" : "s"} remaining · generated{" "}
        {formatDate(twoFactor.generatedAt)}
      </p>
      {/* Two long labels ("Regenerate backup codes", "Disable two-factor") overflow the
          generic `.actions .btn{flex:1}` narrow rule (flex items don't shrink below their
          nowrap content width) — MobileAccount stacks them full-width instead, so wide and
          narrow render as two separate rows rather than one flexing row. */}
      <div class="actions actions--start wide-only">
        <form method="post" action={paths.auth.backupCodesGenerate} class="form">
          <input type="hidden" name="csrf" value={csrfToken} />
          <PasswordField />
          <button type="submit" class="btn btn--outline btn--sm">
            Regenerate backup codes
          </button>
        </form>
        <a class="btn btn--danger-outline btn--sm" href={paths.accountConfirm("disable-two-factor")}>
          Disable two-factor
        </a>
      </div>
      {/* `narrow-only` only ever toggles `display`, never carries its own display-setting
          inline style — an inline `display` here would out-specificity the class's
          `display: none` at wide widths, so the flex layout lives on a nested div instead. */}
      <div class="narrow-only">
        <div style="display: flex; flex-direction: column; gap: var(--space-5);">
          <form method="post" action={paths.auth.backupCodesGenerate} class="form">
            <input type="hidden" name="csrf" value={csrfToken} />
            <PasswordField />
            <button type="submit" class="btn btn--outline btn--block">
              Regenerate backup codes
            </button>
          </form>
          <a class="btn btn--danger-outline btn--block" href={paths.accountConfirm("disable-two-factor")}>
            Disable two-factor
          </a>
        </div>
      </div>
    </div>
  );
};

/** AccountStates "Backup codes" — the one render that ever shows the plaintext set. */
const BackupCodesCard: FC<{ codes: string[] }> = ({ codes }) => (
  <div class="card card--pad">
    <div class="card-title">Backup codes</div>
    <div class="code-grid">
      {codes.map((code) => (
        <div class="code-chip" key={code}>
          {code}
        </div>
      ))}
    </div>
    {/* styles.css has no warning-colored text utility outside the boxed .alert
        component — closest fit is .field-hint's sizing with the token's color. */}
    <p class="field-hint" style="color: var(--warning);">
      Store these somewhere safe — they are shown only once.
    </p>
    <div class="actions actions--start">
      <button type="button" class="btn btn--outline">
        Copy codes
      </button>
      <a class="btn btn--primary" href={paths.account}>
        Done
      </a>
    </div>
  </div>
);

/* --------------------------------------------------------------- passkeys --- */

const PasskeysCard: FC<{ passkeys: PasskeyRow[]; now: string }> = ({ passkeys, now }) => (
  <div class="card card--pad">
    <div>
      <div class="card-title">Passkeys</div>
      <div class="card-desc">Sign in with a security key or platform authenticator.</div>
    </div>
    {passkeys.length === 0 ? (
      <div style="display: flex; flex-direction: column; align-items: center; gap: var(--space-6); padding: var(--space-4) 0;">
        <p class="muted center" style="max-width: 280px;">
          No passkeys yet. Add one to sign in without a password.
        </p>
        <div class="actions actions--start">
          <AddPasskeyButton />
        </div>
      </div>
    ) : (
      <>
        <div class="list">
          {passkeys.map((pk) => (
            <div class="list-item" key={pk.id}>
              <div style="display: flex; align-items: center; gap: var(--space-6);">
                <KeyIcon />
                <div>
                  <div class="list-title">{pk.name}</div>
                  <div class="list-meta">
                    Added {formatDate(pk.addedAt)} · {pk.lastUsedAt ? `last used ${formatRelative(pk.lastUsedAt, now)}` : "never used"}
                  </div>
                </div>
              </div>
              <a class="btn btn--danger-ghost btn--sm" href={paths.accountConfirm("remove-passkey", pk.id)}>
                Remove
              </a>
            </div>
          ))}
        </div>
        <div class="actions actions--start">
          <AddPasskeyButton />
        </div>
      </>
    )}
  </div>
);

/* --------------------------------------------------------------- sessions --- */

/** "pmcp CLI" -> "pmcp CLI · device flow" for CLI sessions (model.ts on `SessionRow`) —
 *  the one label suffix computed here rather than carried by the fixture, so the
 *  desktop row, the mobile card, and the revoke confirm dialog title all agree. */
function sessionLabel(session: SessionRow): string {
  return session.source === "cli" ? `${session.client} · device flow` : session.client;
}

const SessionsCard: FC<{ sessions: SessionRow[]; now: string }> = ({ sessions, now }) => (
  <div class="card">
    {/* wide: header padded like a card, table full-bleed to the card's edges (Account.dc.html) */}
    <div class="wide-only" style="padding: var(--space-10) var(--space-10) var(--space-8);">
      <div class="card-title">Active sessions</div>
      <div class="card-desc">Web and CLI sessions currently signed in.</div>
    </div>
    <table class="table wide-only">
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
              <div style="display: flex; align-items: center; gap: var(--space-4);">
                <span>{sessionLabel(session)}</span>
                {session.current ? <span class="badge badge--outline">current</span> : null}
              </div>
            </td>
            <td class="cell-muted">{formatDate(session.createdAt)}</td>
            <td class="cell-muted">{formatRelative(session.lastActiveAt, now)}</td>
            <td class="cell-actions">
              {session.current ? null : (
                <a class="btn btn--danger-ghost btn--sm" href={paths.accountConfirm("revoke-session", session.id)}>
                  Revoke
                </a>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>

    {/* narrow: MobileAccount's list-item rows — one combined meta line, no columns */}
    <div class="card--pad narrow-only" style="gap: var(--space-3);">
      <div>
        <div class="card-title">Active sessions</div>
        <div class="card-desc">Web and CLI sessions currently signed in.</div>
      </div>
      <div class="list">
        {sessions.map((session) => (
          <div class="list-item" key={session.id}>
            <div style="display: flex; flex-direction: column; gap: var(--space-1);">
              <div style="display: flex; align-items: center; gap: var(--space-4);">
                <span class="list-title">{sessionLabel(session)}</span>
                {session.current ? <span class="badge badge--outline">current</span> : null}
              </div>
              <div class="list-meta">
                Created {formatDate(session.createdAt)} · active {formatRelative(session.lastActiveAt, now)}
              </div>
            </div>
            {session.current ? null : (
              <a class="btn btn--danger-ghost btn--sm" href={paths.accountConfirm("revoke-session", session.id)}>
                Revoke
              </a>
            )}
          </div>
        ))}
      </div>
    </div>
  </div>
);

/* ---------------------------------------------------------------- dialogs --- */

const DIALOG_ID = "confirm-account";
const DIALOG_TITLE_ID = "confirm-account-title";

/** Dialogs.dc.html's three destructive confirmations, as server-rendered `<dialog open>` state. */
const ConfirmDialog: FC<{ confirm: AccountConfirm; csrfToken: string; sessions: SessionRow[] }> = ({
  confirm,
  csrfToken,
  sessions,
}) => {
  let title: string;
  let text: string;
  let body: ReturnType<FC>;
  if (confirm.kind === "disable-two-factor") {
    title = "Disable two-factor?";
    text = "You'll no longer need a code from your authenticator app to sign in. Enter your password to confirm.";
    body = (
      <form method="post" action={paths.auth.totpDisable} class="form">
        <input type="hidden" name="csrf" value={csrfToken} />
        <PasswordField autofocus />
        <div class="actions">
          <a class="btn btn--ghost" href={paths.account}>
            Cancel
          </a>
          <button type="submit" class="btn btn--danger">
            Disable
          </button>
        </div>
      </form>
    );
  } else if (confirm.kind === "remove-passkey") {
    title = `Remove passkey “${confirm.name}”?`;
    text = "This passkey can't be restored — you'd have to add it again from that device.";
    body = (
      <form method="post" action={paths.auth.passkeyDelete} class="actions">
        <input type="hidden" name="csrf" value={csrfToken} />
        <input type="hidden" name="id" value={confirm.id} />
        <a class="btn btn--ghost" href={paths.account}>
          Cancel
        </a>
        <button type="submit" class="btn btn--danger">
          Remove
        </button>
      </form>
    );
  } else {
    const matched = sessions.find((s) => s.id === confirm.id);
    title = `Revoke “${matched ? sessionLabel(matched) : confirm.client}”?`;
    text = "This session is signed out immediately and can't be restored — whoever's using it will need to sign in again.";
    body = (
      <form method="post" action={paths.auth.sessionRevoke} class="actions">
        <input type="hidden" name="csrf" value={csrfToken} />
        <input type="hidden" name="id" value={confirm.id} />
        <a class="btn btn--ghost" href={paths.account}>
          Cancel
        </a>
        <button type="submit" class="btn btn--danger">
          Revoke
        </button>
      </form>
    );
  }

  return (
    <>
      <dialog id={DIALOG_ID} open aria-labelledby={DIALOG_TITLE_ID}>
        <div class="dialog-body">
          <div>
            <div class="dialog-title" id={DIALOG_TITLE_ID}>
              {title}
            </div>
            <div class="dialog-text">{text}</div>
          </div>
          {body}
        </div>
      </dialog>
      {/* Progressive enhancement only: the `open` attribute above is the whole story
          with scripting off. Where JS runs, re-open as a real modal so it gets
          centered and styles.css's `dialog::backdrop` — otherwise unreachable from a
          plain `open` attribute, which never produces a backdrop — actually applies. */}
      <script
        dangerouslySetInnerHTML={{
          __html: `var d=document.getElementById(${JSON.stringify(DIALOG_ID)});if(d&&d.open){d.removeAttribute("open");d.showModal();}`,
        }}
      />
    </>
  );
};

/* ------------------------------------------------------------------ page --- */

export const AccountPage: FC<AccountProps> = (props) => {
  const { now, username, section, pendingApprovals, notice, csrfToken, twoFactor, enrollment, revealedBackupCodes, passkeys, sessions, confirm } =
    props;

  return (
    <Layout title="Account · personal-mcps" active={section} username={username} pendingApprovals={pendingApprovals}>
      <main class="page page--narrow">
        <div class="page-head">
          <div>
            <h1 class="page-title">Account</h1>
            <p class="page-subtitle">Security settings for {username}.</p>
          </div>
        </div>

        {notice ? <NoticeBanner notice={notice} /> : null}

        <TwoFactorCard twoFactor={twoFactor} enrollment={enrollment} csrfToken={csrfToken} />

        {revealedBackupCodes ? <BackupCodesCard codes={revealedBackupCodes} /> : null}

        <PasskeysCard passkeys={passkeys} now={now} />

        <SessionsCard sessions={sessions} now={now} />
      </main>

      {confirm ? <ConfirmDialog confirm={confirm} csrfToken={csrfToken} sessions={sessions} /> : null}
    </Layout>
  );
};
