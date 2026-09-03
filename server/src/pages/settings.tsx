// settings.tsx — /settings: §13's six panes behind one rail.
//
// Pure (props) => JSX per model.ts's contract: no fetching, no cookies, no
// Date.now() — every relative timestamp below is a function of `now` and an
// ISO field already on the props. Every URL comes from `paths`; every
// mutating control is a real <form method="post"> carrying `csrfToken`, and
// every destructive one goes through `confirm` (Dialogs.dc.html) as
// server-rendered dialog state rather than firing on click.
//
// ONE component draws all six panes and the rail, because §13 makes them one page:
// the rail's markers are the LENGTHS of the lists the panes render, so they are read
// off the same props — a marker computed any other way is a number that can disagree
// with the pane beside it. `props.pane` says which pane the URL asked for; the rail
// and the pill row are drawn identically whichever it is.
//
// The two-factor card is one of three mutually exclusive shapes
// (SettingsStates.dc.html): not-enrolled, mid-enrollment (QR + code), or
// enabled — plus a transient fourth "backup codes" card that appears
// alongside it exactly once, whenever `revealedBackupCodes` is set.

import type { Child, FC } from "hono/jsx";
import type {
  ConnectionRow,
  SettingsConfirm,
  SettingsPane,
  SettingsProps,
  Notice,
  PasskeyRow,
  PasswordField,
  SessionRow,
  TokenRow,
  TotpEnrollment,
  TwoFactorSummary,
} from "./model";
import { PASSWORD_MIN_LENGTH, paths, SETTINGS_CONFIRM_PANE, SETTINGS_PANES } from "./model";
import type { PaneEntry } from "./layout";
import { ConfirmShell, Layout, OtpBoxes, PaneRail, PanePills, paneGroups } from "./layout";
import { formatDate, formatStamp, sessionLabel } from "./format";

/**
 * The accessible names of this page's two pane navigations (§13's shell rule). They are
 * how a reader — and the suite — tells the rail from the pill row, which repeat each
 * other's destinations by design and would otherwise be one landmark said twice.
 */
const RAIL_NAV_LABEL = "Settings panes";
const PILL_NAV_LABEL = "Settings panes, compact";

/* ------------------------------------------------------------------ time --- */

/* `formatDate` / `formatStamp` — "Aug 24, 2026", the absolute stamp this page's tables
 * and /apps/<slug>'s Created row both print — come from `format.ts`. Only the relative
 * spelling below is this page's own: §13 gives it to /settings and to nothing else. */

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

/* ------------------------------------------------------------------ rail --- */

/**
 * The rows the Tokens pane lists at a given `?kind=` — the narrowing is the PAGE's, since
 * `token_list` takes no filter (§8 unchanged). Named once because the rail and the table
 * must not disagree: §13 reads every marker as "the number of rows its pane lists", so a
 * filtered pane narrows both from this one list rather than from two that could drift.
 */
function listedTokens(tokens: TokenRow[], kind: TokenRow["kind"] | null): TokenRow[] {
  return kind === null ? tokens : tokens.filter((token) => token.kind === kind);
}

/**
 * §13's rail table, as data: the six panes in the one order both navigations draw, each
 * with the marker its own pane's list produces. The Password entry's `null` is the
 * table's `none` cell, and Two-factor's is the one marker that is a status — said in
 * words as well as in colour, since a dot alone is a state only a sighted reader has.
 */
function paneEntries(props: SettingsProps): PaneEntry[] {
  const markers: Record<SettingsPane, PaneEntry["marker"]> = {
    password: null,
    "two-factor": props.twoFactor.enabled
      ? { text: "enabled", dot: "on" }
      : { text: "not enabled", dot: "off" },
    passkeys: { text: String(props.passkeys.length) },
    sessions: { text: String(props.sessions.length) },
    tokens: { text: String(listedTokens(props.tokens, props.tokenKind).length) },
    clients: { text: String(props.connections.length) },
  };
  return SETTINGS_PANES.map((entry) => ({
    href: entry.href,
    label: entry.label,
    short: entry.short,
    marker: markers[entry.pane],
    current: entry.pane === props.pane,
    // §13's own table says which heading each pane sits under, and the shell groups on
    // it — so the sign-in-then-holdings order is the table's order, not a second list.
    group: entry.group,
  }));
}

/* -------------------------------------------------------------- password --- */

const AddPasskeyButton: FC = () => (
  <button type="button" class="btn btn--outline btn--sm" data-add-passkey>
    <PlusIcon />
    <span>Add passkey</span>
  </button>
);

/**
 * §13's **Add passkey** — the one credential control on this page that is NOT a form,
 * because a WebAuthn registration is not a POST: it is better-auth's options endpoint,
 * `navigator.credentials.create`, and better-auth's verify endpoint, with the browser's
 * own authenticator between them. There is no form body to translate, so these two ride
 * better-auth's mount directly (pages/model's `paths.auth`) and nothing here posts at a
 * hub route.
 *
 * Hand-written rather than bundled: the whole ceremony is two fetches and a base64url
 * codec, which is the only wire form WebAuthn JSON has — the options arrive with
 * `challenge`, `user.id` and every `excludeCredentials[].id` encoded, and the attestation
 * must go back encoded the same way. /login's sign-in ceremony carries its own copy of
 * that codec on purpose: the two are inline scripts in two different documents (one of
 * them chromeless), and a module shared between them would need a bundle step this hub
 * does not have.
 *
 * Static apart from the two URLs, which are interpolated from `paths` as JSON literals.
 */
const ADD_PASSKEY_SCRIPT = `(function () {
  var buttons = document.querySelectorAll('[data-add-passkey]');
  if (!buttons.length || !window.PublicKeyCredential) return;
  var OPTIONS = ${JSON.stringify(paths.auth.passkeyRegister)};
  var VERIFY = ${JSON.stringify(paths.auth.passkeyVerifyRegistration)};
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
  function add() {
    fetch(OPTIONS, { credentials: 'same-origin', headers: { Accept: 'application/json' } })
      .then(function (answer) {
        if (!answer.ok) throw new Error('options ' + answer.status);
        return answer.json();
      })
      .then(function (options) {
        options.challenge = decode(options.challenge);
        options.user.id = decode(options.user.id);
        (options.excludeCredentials || []).forEach(function (row) { row.id = decode(row.id); });
        return navigator.credentials.create({ publicKey: options });
      })
      .then(function (credential) {
        return fetch(VERIFY, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            response: {
              id: credential.id,
              rawId: encode(credential.rawId),
              type: credential.type,
              authenticatorAttachment: credential.authenticatorAttachment,
              clientExtensionResults: credential.getClientExtensionResults(),
              response: {
                clientDataJSON: encode(credential.response.clientDataJSON),
                attestationObject: encode(credential.response.attestationObject),
                transports: credential.response.getTransports
                  ? credential.response.getTransports()
                  : []
              }
            }
          })
        });
      })
      .then(function (answer) {
        if (!answer.ok) throw new Error('verify ' + answer.status);
        location.reload();
      })
      .catch(function (failure) {
        // A cancelled prompt and a refused attestation are the same thing from here: the
        // list simply does not grow. Logged rather than swallowed so it is diagnosable.
        console.error('Add passkey did not complete', failure);
      });
  }
  Array.prototype.forEach.call(buttons, function (button) {
    button.addEventListener('click', add);
  });
})();`;

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
 *
 * Named for the re-authentication it asks for, NOT for the Password pane: the imported
 * `PasswordField` is that pane's three control names (model.ts), and one word for two
 * unrelated things is a word a reader has to disambiguate every time.
 */
const ConfirmPasswordField: FC<{ autofocus?: boolean }> = ({ autofocus }) => (
  <label class="field">
    <span class="label">Password</span>
    <input type="password" name="password" required autofocus={autofocus} />
  </label>
);

/**
 * §13's three mapped refusals, as the words that go beside the control each names. The
 * new-password one IS the length hint — §13 maps `PASSWORD_TOO_SHORT` onto the hint
 * rather than onto a second sentence, which is also why that hint renders from
 * `PASSWORD_MIN_LENGTH` and never from a literal (§4: one constant, no drift).
 */
const PASSWORD_REFUSAL: Record<PasswordField, string> = {
  currentPassword: "That password is not right.",
  newPassword: `At least ${PASSWORD_MIN_LENGTH} characters.`,
  confirmPassword: "The two entries do not match.",
};

/** §13's "Confirmed your identity N minutes ago." — whole minutes since the session's
 *  `createdAt`, which is the same value `requireOwnerSession` judges freshness on, so the
 *  line explains a bounce rather than approximating one. Built as ONE string because a
 *  sentence split across JSX children is a sentence whose spacing the transform owns. */
function confirmedLine(iso: string, nowIso: string): string {
  const minutes = Math.max(0, Math.floor((Date.parse(nowIso) - Date.parse(iso)) / 60_000));
  return `Confirmed your identity ${minutes} minute${minutes === 1 ? "" : "s"} ago.`;
}

/**
 * §13's Password pane. The hint's number is `identity.PASSWORD_MIN_LENGTH` and nothing
 * else — better-auth is configured from the same constant, so the number that refuses and
 * the number that is shown cannot drift apart. `error` is the control the last refusal
 * named; the sentence beside it comes from the table above, never from the URL.
 */
const PasswordCard: FC<{
  csrfToken: string;
  error: PasswordField | null;
  confirmedAt: string | null;
  now: string;
}> = ({ csrfToken, error, confirmedAt, now }) => (
  <div class="card card--pad">
    <div>
      <div class="card-title">Password</div>
      <div class="card-desc">Used with your username at sign-in. App and agent tokens are unaffected.</div>
    </div>
    <form method="post" action={paths.auth.changePassword} class="form">
      <input type="hidden" name="csrf" value={csrfToken} />
      <label class="field">
        <span class="label">Current password</span>
        <input
          type="password"
          name="currentPassword"
          autocomplete="current-password"
          required
          aria-invalid={error === "currentPassword" ? "true" : undefined}
        />
        {error === "currentPassword" ? (
          <span class="field-error">{PASSWORD_REFUSAL.currentPassword}</span>
        ) : null}
      </label>
      <label class="field">
        <span class="label">New password</span>
        <input
          type="password"
          name="newPassword"
          autocomplete="new-password"
          required
          aria-invalid={error === "newPassword" ? "true" : undefined}
        />
        {/* One sentence, two roles: the standing hint, and — when the refusal named this
            control — the refusal itself, which is why it is the same string. */}
        <span class={error === "newPassword" ? "field-error" : "field-hint"}>
          {PASSWORD_REFUSAL.newPassword}
        </span>
      </label>
      <label class="field">
        <span class="label">Confirm new password</span>
        <input
          type="password"
          name="confirmPassword"
          autocomplete="new-password"
          required
          aria-invalid={error === "confirmPassword" ? "true" : undefined}
        />
        {error === "confirmPassword" ? (
          <span class="field-error">{PASSWORD_REFUSAL.confirmPassword}</span>
        ) : null}
      </label>
      {/* Default ON: a password is most often changed on suspicion, so the safe default
          ends every session the old one may have opened (§13). */}
      <label class="checkbox">
        <input type="checkbox" name="revokeOtherSessions" value="on" checked />
        <span>Sign out my other sessions</span>
      </label>
      {/* §13 pins this cost because the checkbox's label is gentler than the mechanism:
          every CLI session is among the "others", and a CLI signs back in by hand. §13
          quotes no sentence for it, so the wording is the board's (Settings.dc.html). */}
      <span class="field-hint checkbox-hint">
        CLI sessions included — each machine runs <code class="code-inline">pmcp login</code> again. This
        browser stays signed in.
      </span>
      {/* Beside the button, not under it (Settings.dc.html): it is the reason the button
          will be allowed to work, so it belongs on the same line. It wraps below at the
          narrow breakpoint, which is where MobileSettings.dc.html draws it. */}
      <div class="actions actions--start">
        <button type="submit" class="btn btn--primary">
          Update password
        </button>
        {confirmedAt === null ? null : <p class="field-hint">{confirmedLine(confirmedAt, now)}</p>}
      </div>
    </form>
  </div>
);

/** §13's footer, verbatim: change is not reset, and where a forgotten one is recovered. */
const PasswordFooter: FC<{ username: string }> = ({ username }) => (
  <p class="note">
    No email is on file, so there is no reset link: a forgotten password is recovered on the
    server with <span class="code-inline">pnpm users reset-password {username}</span> (§12). Changing
    it here needs the current one.
  </p>
);

/* ------------------------------------------------------------- two-factor --- */

const TwoFactorCard: FC<{
  twoFactor: TwoFactorSummary;
  enrollment: TotpEnrollment | null;
  revealedBackupCodes: string[] | null;
  csrfToken: string;
}> = ({ twoFactor, enrollment, revealedBackupCodes, csrfToken }) => {
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
        {/* csrf makes this a real credential now (totpVerifySettings, not /login's
            translation) — totpuri and codes carry the enrolment forward so a refusal can
            redraw it in place (web.ts's `reveal`; neither ever touches a URL, §15). */}
        <form method="post" action={paths.auth.totpVerifySettings} class="form" data-otp-form>
          <input type="hidden" name="csrf" value={csrfToken} />
          <input type="hidden" name="totpuri" value={enrollment.totpUri} />
          <input type="hidden" name="codes" value={(revealedBackupCodes ?? []).join("\n")} />
          <OtpBoxes invalid={enrollment.error !== null} />
          {enrollment.error ? <p class="field-error center">{enrollment.error}</p> : null}
          <div class="actions actions--start">
            <button type="submit" class="btn btn--primary">
              Verify
            </button>
            <a class="btn btn--ghost" href={paths.settingsTwoFactor}>
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
            SettingsConfirm arm (model.ts) this card has no other use for — add one if a
            third password-gated control ever appears here. */}
        <form method="post" action={paths.auth.totpEnable} class="form">
          <input type="hidden" name="csrf" value={csrfToken} />
          <ConfirmPasswordField />
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
      {/* Two long labels ("Regenerate backup codes", "Disable two-factor") overflow the
          generic `.actions .btn{flex:1}` narrow rule (flex items don't shrink below their
          nowrap content width) — MobileSettings stacks them full-width instead, so wide and
          narrow render as two separate rows rather than one flexing row. */}
      {/* Bottom-aligned: the Regenerate form is a column (its own password field, §4), so
          centring would leave Disable floating beside that FIELD and reading as its
          control. Aligned to the bottom, the two buttons sit side by side as the board
          draws them and the field belongs plainly to the one above it. */}
      <div class="actions actions--start actions--bottom wide-only">
        <form method="post" action={paths.auth.backupCodesGenerate} class="form">
          <input type="hidden" name="csrf" value={csrfToken} />
          <ConfirmPasswordField />
          <button type="submit" class="btn btn--outline btn--sm">
            Regenerate backup codes
          </button>
        </form>
        <a
          class="btn btn--danger-outline btn--sm"
          href={paths.settingsConfirm("two-factor", "disable-two-factor")}
        >
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
            <ConfirmPasswordField />
            <button type="submit" class="btn btn--outline btn--block">
              Regenerate backup codes
            </button>
          </form>
          <a
            class="btn btn--danger-outline btn--block"
            href={paths.settingsConfirm("two-factor", "disable-two-factor")}
          >
            Disable two-factor
          </a>
        </div>
      </div>
    </div>
  );
};

/** SettingsStates "Backup codes" — the one render that ever shows the plaintext set. */
const BackupCodesCard: FC<{ codes: string[] }> = ({ codes }) => (
  <div class="card card--pad">
    <div class="card-title">Backup codes</div>
    <div class="code-grid">
      {codes.map((code) => (
        <div class="code-chip" data-code key={code}>
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
      <button type="button" class="btn btn--outline" id="copy-codes">
        Copy codes
      </button>
      <a class="btn btn--primary" href={paths.settingsTwoFactor}>
        Done
      </a>
    </div>
    {/* layout.tsx's TokenReveal copy handler, one shape over: every [data-code] chip's
        textContent, newline-joined — the reveal's own shape, so the pasted set matches
        what's on screen digit for digit. */}
    <script
      dangerouslySetInnerHTML={{
        __html: `(function(){var b=document.getElementById("copy-codes");if(!b)return;b.addEventListener("click",function(){var chips=document.querySelectorAll("[data-code]");var text=Array.prototype.map.call(chips,function(c){return c.textContent||"";}).join("\\n");navigator.clipboard.writeText(text);});})();`,
      }}
    />
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
              <a
                class="btn btn--danger-ghost btn--sm"
                href={paths.settingsConfirm("passkeys", "remove-passkey", pk.id)}
              >
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
    <script dangerouslySetInnerHTML={{ __html: ADD_PASSKEY_SCRIPT }} />
  </div>
);

/* --------------------------------------------------------------- sessions --- */

/** §13's **Revoke all others**: the header control beside the sessions list, and the one
 *  destructive control on this page that names no row. */
const RevokeAllOthers: FC = () => (
  <a
    class="btn btn--danger-outline btn--sm"
    href={paths.settingsConfirm("sessions", "revoke-other-sessions")}
  >
    Revoke all others
  </a>
);

const SessionsCard: FC<{ sessions: SessionRow[]; now: string }> = ({ sessions, now }) => (
  <div class="card">
    {/* wide: header padded like a card, table full-bleed to the card's edges (Settings.dc.html) */}
    <div class="card-head wide-only" style="padding: var(--space-10) var(--space-10) var(--space-8);">
      <div>
        <div class="card-title">Active sessions</div>
        <div class="card-desc">Web and CLI sessions currently signed in.</div>
      </div>
      <RevokeAllOthers />
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
                <a
                  class="btn btn--danger-ghost btn--sm"
                  href={paths.settingsConfirm("sessions", "revoke-session", session.id)}
                >
                  Revoke
                </a>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>

    {/* narrow: MobileSettings's list-item rows — one combined meta line, no columns */}
    <div class="card--pad narrow-only" style="gap: var(--space-3);">
      <div class="card-head">
        <div>
          <div class="card-title">Active sessions</div>
          <div class="card-desc">Web and CLI sessions currently signed in.</div>
        </div>
        <RevokeAllOthers />
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
              <a
                class="btn btn--danger-ghost btn--sm"
                href={paths.settingsConfirm("sessions", "revoke-session", session.id)}
              >
                Revoke
              </a>
            )}
          </div>
        ))}
      </div>
    </div>
  </div>
);

/* ----------------------------------------------------------------- tokens --- */

/** §13's **All · Agents · Apps** filter, as three links to this same pane — /audit's own
 *  range segment said again, so the two read alike. Nothing here posts and nothing is
 *  scripted: the filter is a URL (`?kind=agent|app`), so a narrowed listing is a page a
 *  browser can bookmark and the back button undoes. */
const TOKEN_KINDS: readonly { kind: TokenRow["kind"] | null; label: string }[] = [
  { kind: null, label: "All" },
  { kind: "agent", label: "Agents" },
  { kind: "app", label: "Apps" },
];

const TokenKindFilter: FC<{ kind: TokenRow["kind"] | null }> = ({ kind }) => (
  <div class="segmented" style="flex-shrink: 0;">
    {TOKEN_KINDS.map((option) => (
      <a
        key={option.label}
        href={paths.settingsTokensWith(option.kind ?? undefined)}
        aria-current={option.kind === kind ? "page" : undefined}
      >
        {option.label}
      </a>
    ))}
  </div>
);

/**
 * §13's Tokens pane. The one pane whose control is NOT behind a dialog — §13 puts
 * Revoke/Remove inline here — and the word differs by what the row still is: a live key
 * is revoked, an expired one is only removed from the listing, and both post the same op.
 *
 * `tokens` is the namespace's whole unrevoked set and `kind` narrows it through
 * `listedTokens` — the same call the rail's marker counts, so the two never disagree.
 */
const TokensCard: FC<{ tokens: TokenRow[]; kind: TokenRow["kind"] | null; csrfToken: string }> = ({
  tokens: listed,
  kind,
  csrfToken,
}) => {
  const tokens = listedTokens(listed, kind);
  return (
  <div class="card">
    {/* wide: header padded like a card, table full-bleed to the card's edges — the same
        shape the Sessions card uses, and what SettingsTokens.dc.html draws. */}
    <div class="card-head" style="padding: var(--space-10) var(--space-10) var(--space-8);">
      <div style="display: flex; flex-direction: column; gap: var(--space-1);">
        <div class="card-title">Tokens</div>
        <div class="card-desc">Every key issued in this namespace. Issue new keys from an app or agent page.</div>
      </div>
      <TokenKindFilter kind={kind} />
    </div>
    {tokens.length === 0 ? (
      <div class="empty empty--inline">
        {/* Two empty states, because they are two different facts: nothing has ever been
            issued, or the FILTER is hiding what has. Saying "No keys issued yet." under
            `?kind=` would be false whenever the other kind exists — and would hide the one
            thing that explains the blank table. An empty namespace under a filter is the
            first fact, not the second: there is nothing to clear the filter back to. */}
        {kind === null || listed.length === 0 ? (
          <div class="empty-text">No keys issued yet.</div>
        ) : (
          <div class="empty-text">
            No {kind} keys. <a href={paths.settingsTokens}>Show all {listed.length}</a>.
          </div>
        )}
      </div>
    ) : (
      <table class="table">
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
          {tokens.map((token) => (
            /* SettingsTokens.dc.html draws an expired row receded behind the live ones,
               with the amber badge below as the one thing that still reads at full
               contrast — the control's word ("Remove") is the only other difference, and
               a word is not a marker you can see from across the table. */
            <tr key={token.id} class={token.expired ? "row--dim" : undefined}>
              <td class="cell-mono">{token.prefix}</td>
              <td>
                <span class="badge badge--mono">{token.kind}</span>
              </td>
              <td class="cell-mono">
                {token.kind === "app" ? (
                  <a href={paths.appDetail(token.boundTo)}>{token.boundTo}</a>
                ) : (
                  token.boundTo
                )}
              </td>
              <td class="cell-muted">{formatStamp(token.createdAt)}</td>
              <td class="cell-muted">
                {token.expired ? (
                  <span class="badge badge--warning">expired</span>
                ) : token.expiresAt === null ? (
                  "never"
                ) : (
                  formatStamp(token.expiresAt)
                )}
              </td>
              <td class="cell-muted">
                {token.lastUsedAt === null ? "never" : formatStamp(token.lastUsedAt)}
              </td>
              <td class="cell-actions">
                <form method="post" action={paths.tokenRevoke(token.id)}>
                  <input type="hidden" name="csrf" value={csrfToken} />
                  <button type="submit" class="btn btn--danger-outline btn--sm">
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
};

/* -------------------------------------------------------- connected clients --- */

/** §13's Connected clients pane: one row per client, revoked ones kept with no control
 *  because re-consent revives the same row (§19.4's UNIQUE pair). */
const ClientsCard: FC<{ connections: ConnectionRow[] }> = ({ connections }) => (
  <div class="card">
    <div class="card--pad" style="gap: var(--space-1);">
      <div class="card-title">Connected clients</div>
      <div class="card-desc">Outside software you approved to reach this hub, and the agent each one acts as.</div>
    </div>
    {connections.length === 0 ? (
      <div class="empty empty--inline">
        <div class="empty-text">A client that completes the consent screen appears here.</div>
      </div>
    ) : (
      <table class="table">
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
                <div style="display: flex; align-items: center; gap: var(--space-4);">
                  <span class="cell-name">{row.clientName ?? row.clientId}</span>
                  {/* §19.5's second identity string, repeated here for the same reason:
                      nobody vouched for this name but the client that chose it. */}
                  {row.selfRegistered ? <span class="badge badge--warning">unverified</span> : null}
                </div>
                <div class="cell-slug">{row.redirectOrigin}</div>
              </td>
              <td class="cell-mono">{row.agentSlug}</td>
              <td class="cell-muted">{formatStamp(row.createdAt)}</td>
              <td class="cell-muted">
                {row.lastUsedAt === null ? "never" : formatStamp(row.lastUsedAt)}
              </td>
              <td>
                {row.revokedAt === null ? (
                  <span class="badge badge--success">
                    <span class="dot" />
                    active
                  </span>
                ) : (
                  <span class="badge badge--muted">revoked</span>
                )}
              </td>
              <td class="cell-actions">
                {row.revokedAt === null ? (
                  <a
                    class="btn btn--danger-outline btn--sm"
                    href={paths.settingsConfirm("clients", "revoke-connection", row.id)}
                  >
                    Revoke
                  </a>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    )}
  </div>
);

/* ---------------------------------------------------------------- dialogs --- */

const DIALOG_ID = "confirm-settings";

/** Dialogs.dc.html's destructive confirmations, as server-rendered `<dialog open>` state.
 *  Every one of them rides — and cancels back to — the URL of the pane that drew it. */
const ConfirmDialog: FC<{ confirm: SettingsConfirm; csrfToken: string }> = ({ confirm, csrfToken }) => {
  // Cancel goes back to the pane that OWNS this dialog — the same table the link that
  // opened it was built from, so the two cannot name different URLs (§13).
  const pane = paths.settingsPane(SETTINGS_CONFIRM_PANE[confirm.kind]);
  let title: string;
  let text: string;
  // `Child`, not `ReturnType<FC>`: this is what ConfirmShell takes, and the two differ —
  // a component's return type carries a Promise arm the children slot does not.
  let body: Child;
  if (confirm.kind === "disable-two-factor") {
    title = "Disable two-factor?";
    text = "You'll no longer need a code from your authenticator app to sign in. Enter your password to confirm.";
    body = (
      <form method="post" action={paths.auth.totpDisable} class="form">
        <input type="hidden" name="csrf" value={csrfToken} />
        <ConfirmPasswordField autofocus />
        <div class="actions">
          <a class="btn btn--ghost" href={pane}>
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
        <a class="btn btn--ghost" href={pane}>
          Cancel
        </a>
        <button type="submit" class="btn btn--danger">
          Remove
        </button>
      </form>
    );
  } else if (confirm.kind === "revoke-other-sessions") {
    title = "Revoke all other sessions?";
    text = "Every other browser and CLI session is signed out immediately. This one stays.";
    body = (
      <form method="post" action={paths.auth.revokeOtherSessions} class="actions">
        <input type="hidden" name="csrf" value={csrfToken} />
        <a class="btn btn--ghost" href={pane}>
          Cancel
        </a>
        <button type="submit" class="btn btn--danger">
          Revoke all others
        </button>
      </form>
    );
  } else if (confirm.kind === "revoke-connection") {
    title = `Revoke “${confirm.client}”?`;
    text = "Its tokens stop working immediately. The agent it acted as, and that agent's grants, are untouched.";
    body = (
      <form method="post" action={paths.connectionRevoke(confirm.id)} class="actions">
        <input type="hidden" name="csrf" value={csrfToken} />
        <a class="btn btn--ghost" href={pane}>
          Cancel
        </a>
        <button type="submit" class="btn btn--danger">
          Revoke
        </button>
      </form>
    );
  } else {
    title = `Revoke “${confirm.label}”?`;
    text = "This session is signed out immediately and can't be restored — whoever's using it will need to sign in again.";
    body = (
      <form method="post" action={paths.auth.sessionRevoke} class="actions">
        <input type="hidden" name="csrf" value={csrfToken} />
        <input type="hidden" name="id" value={confirm.id} />
        <a class="btn btn--ghost" href={pane}>
          Cancel
        </a>
        <button type="submit" class="btn btn--danger">
          Revoke
        </button>
      </form>
    );
  }

  return (
    <ConfirmShell id={DIALOG_ID} title={title} text={text}>
      {body}
    </ConfirmShell>
  );
};

/* ------------------------------------------------------------------ panes --- */

/** The pane the URL asked for, and only it — the rail beside it is drawn from the same
 *  props whichever this is. */
const Pane: FC<SettingsProps> = (props) => {
  switch (props.pane) {
    case "password":
      return (
        <>
          <PasswordCard
            csrfToken={props.csrfToken}
            error={props.passwordError}
            // The gate's own clock: the session rendering this page is the one it judges.
            confirmedAt={props.sessions.find((session) => session.current)?.createdAt ?? null}
            now={props.now}
          />
          <PasswordFooter username={props.username} />
        </>
      );
    case "two-factor":
      return (
        <>
          <TwoFactorCard
            twoFactor={props.twoFactor}
            enrollment={props.enrollment}
            revealedBackupCodes={props.revealedBackupCodes}
            csrfToken={props.csrfToken}
          />
          {props.revealedBackupCodes ? <BackupCodesCard codes={props.revealedBackupCodes} /> : null}
        </>
      );
    case "passkeys":
      return <PasskeysCard passkeys={props.passkeys} now={props.now} />;
    case "sessions":
      return <SessionsCard sessions={props.sessions} now={props.now} />;
    case "tokens":
      return (
        <>
          <TokensCard tokens={props.tokens} kind={props.tokenKind} csrfToken={props.csrfToken} />
          <p class="note">
            Revoking an app token closes that app's live connection. Keys are shown only once,
            at issue time.
          </p>
        </>
      );
    default:
      return (
        <>
          <ClientsCard connections={props.connections} />
          <p class="note">
            A client registers itself the first time you approve it on the consent screen —
            that screen is a step inside the sign-in redirect, never a page you navigate to.
            Revoking stops its tokens working; the agent it acted as, and that agent's grants,
            are untouched.
          </p>
        </>
      );
  }
};

/* ------------------------------------------------------------------ page --- */

export const SettingsPage: FC<SettingsProps> = (props) => {
  const entries = paneEntries(props);

  return (
    <Layout
      title="Settings · personal-mcps"
      active={props.section}
      username={props.username}
      pendingApprovals={props.pendingApprovals}
    >
      <main class="page page--paned">
        <div class="page-head">
          <div>
            <h1 class="page-title">Settings</h1>
            <p class="page-subtitle">Sign-in and access for {props.username}.</p>
          </div>
        </div>

        <PanePills label={PILL_NAV_LABEL} entries={entries} />

        {props.notice ? <NoticeBanner notice={props.notice} /> : null}

        <div class="paned">
          <PaneRail label={RAIL_NAV_LABEL} groups={paneGroups(entries)} />
          {/* Password is the one pane the boards hold narrow — it is a form, and the five
              others are tables that need every pixel the rail leaves (Settings.dc.html at
              640 against SettingsTokens/OauthConnections at full width). */}
          <div class={props.pane === "password" ? "pane pane--narrow" : "pane"}>
            <Pane {...props} />
          </div>
        </div>
      </main>

      {props.confirm ? (
        <ConfirmDialog confirm={props.confirm} csrfToken={props.csrfToken} />
      ) : null}
    </Layout>
  );
};
