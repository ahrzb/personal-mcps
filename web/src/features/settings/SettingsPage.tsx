import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { QueryKey } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { ConfirmDialog, useDropSearchKeys } from "@/chrome/Confirm";
import { useFlashParams } from "@/chrome/Notice";
import { OtpBoxes } from "@/chrome/OtpBoxes";
import { Page, PageHead, PageSubtitle, PageTitle, Pane as PaneFrame, Workspace } from "@/chrome/Page";
import { PanePills, PaneRail, paneGroups } from "@/chrome/Panes";
import type { PaneEntry } from "@/chrome/Panes";
import { Shell, useDocumentTitle } from "@/chrome/Shell";
import { QueryState, Skeleton } from "@/chrome/States";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge, BadgeDot } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { DialogFooter } from "@/components/ui/dialog";
import { Empty, EmptyDescription } from "@/components/ui/empty";
import { Field, FieldDescription, FieldError, FieldGroup } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { tabsListVariants, tabsTriggerVariants } from "@/components/ui/tabs";
import { useApi, useAppEnv } from "@/lib/api-context";
import { cn } from "@/lib/cn";
import { formatStamp } from "@/lib/format";
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
 * The port of `server/src/pages/settings.tsx`, element for element, drawn since pass 2 through
 * `components/ui`, `chrome` and utilities to the look its legacy classes had: the rail beside
 * the pane on a wide screen, the pill row above it on a phone, one card per pane, and the
 * destructive confirmations as dialogs that ride the owning pane's `?confirm=` URL.
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
      <Page shape="workspace">
        <PageHead>
          <div>
            <PageTitle>Settings</PageTitle>
            <PageSubtitle>Sign-in and access for {bootstrap.username}.</PageSubtitle>
          </div>
        </PageHead>
        <QueryState query={read} skeleton={<Skeleton rows={7} />}>
          {(data: SettingsRead) => <Board read={data} pane={pane} search={search} flash={flash} />}
        </QueryState>
      </Page>
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
      {/* The rail and the pane are ONE box, as on the agent page, so the paned pages read as
          one family (design/layout-and-density.md §2). */}
      <Workspace>
        <PaneRail label={RAIL_NAV_LABEL} groups={paneGroups(entries)} />
        {/* Password is the one pane the boards hold narrow — a form, where the others are
            tables that need every pixel the rail leaves. */}
        <PaneFrame narrow={pane === "password"}>
          <Pane read={read} pane={pane} kind={kind} passwordError={passwordErrorOf(flash, pane)} />
        </PaneFrame>
      </Workspace>
      {confirm === null ? null : <SettingsDialog confirm={confirm} />}
    </>
  );
}

/** This page's banner: `settings.tsx`'s, which draws NO icon, and parts the message from its
 *  title only when there is one — unlike `chrome/Notice`'s, which the other pages share. */
function SettingsNotice({ notice }: { notice: Notice }): ReactNode {
  return (
    <Alert variant={notice.tone} role="alert">
      {notice.title === undefined ? (
        <div>{notice.message}</div>
      ) : (
        <div>
          <AlertTitle>{notice.title}</AlertTitle>
          <AlertDescription>{notice.message}</AlertDescription>
        </div>
      )}
    </Alert>
  );
}

/* ---------------------------------------------------------- shared looks --- */

/** `.actions.actions--start`: a row of controls 12px apart, from the left. */
const ACTIONS = "flex flex-wrap items-center gap-3";

/** legacy.css's narrow `.actions .btn { flex: 1 }`: each button in an `ACTIONS` row takes an
 *  equal share of the phone's width. Written on the button, since the row may hold other
 *  things (a hint) that do not grow. */
const GROW = "max-md:flex-1";

/** `.note`: the muted small print under a card, capped at a readable measure. */
const NOTE = "max-w-[72ch] text-xs text-muted-foreground";

/** `.table .cell-*`, spelled as `preview/fixtures/primitives/table.tsx` spells them. */
const CELL = {
  /** `.cell-muted` */
  muted: "text-muted-foreground",
  /** `.cell-mono`: breaks anywhere, so a key prefix or slug never widens the card. */
  mono: "font-mono text-xs wrap-anywhere",
  /** `.cell-actions`: right-aligned wide; its own row, left-aligned, under the card on a phone. */
  actions: "text-right whitespace-nowrap max-md:mt-2.5 max-md:flex max-md:gap-2.5 max-md:text-left",
  /** `.table .cell-actions .btn`, over a `sm` button: 10px sides wide, a 44px half-row on a phone. */
  button: "ml-1 px-2.5 max-md:ml-0 max-md:flex-1 max-md:px-3",
};

/** The flush card's head above a table: `.card-head` at 24px sides and top, 16px under. */
const TABLE_CARD_HEAD = "px-6 pt-6 pb-4";

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
          <p className={NOTE}>
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
          <p className={NOTE}>
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
    <Field render={<label />}>
      <Label render={<span />}>Password</Label>
      <Input type="password" name="password" required autoFocus={autoFocus} />
    </Field>
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
    <Card>
      <div>
        <CardTitle>Password</CardTitle>
        <CardDescription>Used with your username at sign-in. App and agent tokens are unaffected.</CardDescription>
      </div>
      <FieldGroup render={<form onSubmit={submit} />}>
        <Field render={<label />}>
          <Label render={<span />}>Current password</Label>
          <Input
            type="password"
            name="currentPassword"
            autoComplete="current-password"
            required
            aria-invalid={error === "currentPassword" ? "true" : undefined}
          />
          {error === "currentPassword" ? <FieldError render={<span />}>{refusal.currentPassword}</FieldError> : null}
        </Field>
        <Field render={<label />}>
          <Label render={<span />}>New password</Label>
          <Input
            type="password"
            name="newPassword"
            autoComplete="new-password"
            required
            aria-invalid={error === "newPassword" ? "true" : undefined}
          />
          {/* One sentence, two roles: the standing hint, and the refusal when it named this. */}
          {error === "newPassword" ? (
            <FieldError render={<span />}>{refusal.newPassword}</FieldError>
          ) : (
            <FieldDescription render={<span />}>{refusal.newPassword}</FieldDescription>
          )}
        </Field>
        <Field render={<label />}>
          <Label render={<span />}>Confirm new password</Label>
          <Input
            type="password"
            name="confirmPassword"
            autoComplete="new-password"
            required
            aria-invalid={error === "confirmPassword" ? "true" : undefined}
          />
          {error === "confirmPassword" ? <FieldError render={<span />}>{refusal.confirmPassword}</FieldError> : null}
        </Field>
        {/* Default ON: a password is most often changed on suspicion (§13). */}
        <Field orientation="horizontal" render={<label />}>
          <Checkbox name="revokeOtherSessions" value="on" defaultChecked />
          <span>Sign out my other sessions</span>
        </Field>
        {/* The box's own small print, not the form's: pulled 12px up into the form's gap and
            indented past the 16px box and its 10px gap. */}
        <FieldDescription render={<span />} className="-mt-3 pl-6.5">
          CLI sessions included — each machine runs <code className={CODE_INLINE}>pmcp login</code> again. This
          browser stays signed in.
        </FieldDescription>
        <div className={ACTIONS}>
          <Button type="submit" className={GROW} disabled={write.pending}>
            Update password
          </Button>
          {confirmedAt === null ? null : (
            <FieldDescription render={<p />}>{confirmedLine(confirmedAt, Date.now())}</FieldDescription>
          )}
        </div>
      </FieldGroup>
    </Card>
  );
}

/** `.code-inline`: a command or identifier set in running text, on a muted chip. */
const CODE_INLINE = "rounded-sm bg-muted px-2 py-[3px] font-mono text-sm";

/** §13's footer, verbatim: change is not reset, and where a forgotten one is recovered. */
function PasswordFooter(): ReactNode {
  const { bootstrap } = useAppEnv();
  return (
    <p className={NOTE}>
      No email is on file, so there is no reset link: a forgotten password is recovered on the server with{" "}
      <span className={CODE_INLINE}>pnpm users reset-password {bootstrap.username}</span> (§12). Changing it here needs
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
        <Card>
          <div>
            <CardTitle>Two-factor authentication</CardTitle>
            <CardDescription>Add a second factor from an authenticator app.</CardDescription>
          </div>
          {/* ponytail: the password sits inline rather than behind a dialog like Disable's —
              enabling destroys nothing (settings.tsx's own note). */}
          <FieldGroup render={<form onSubmit={enable} />}>
            <ConfirmPasswordField />
            <div className={ACTIONS}>
              <Button type="submit" className={GROW} disabled={write.pending}>
                Enable two-factor
              </Button>
            </div>
          </FieldGroup>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <div>
              <CardTitle>Two-factor authentication</CardTitle>
              <CardDescription>TOTP via an authenticator app.</CardDescription>
            </div>
            <Badge variant="success">
              <BadgeDot />
              enabled
            </Badge>
          </CardHeader>
          {/* Two layouts, not one flexing row: the two long labels overflow a phone's
              half-width buttons, so the phone stacks them full width. Bottom-aligned wide, so
              Disable sits beside the Regenerate BUTTON and not beside its field. */}
          <div className={cn(ACTIONS, "items-end max-md:hidden")}>
            <FieldGroup render={<form onSubmit={regenerate} />}>
              <ConfirmPasswordField />
              <Button type="submit" variant="outline" size="sm" disabled={write.pending}>
                Regenerate backup codes
              </Button>
            </FieldGroup>
            <Link
              className={buttonVariants({ variant: "danger-outline", size: "sm" })}
              to={paths.settingsConfirm("two-factor", "disable-two-factor")}
            >
              Disable two-factor
            </Link>
          </div>
          <div className="hidden flex-col gap-2.5 max-md:flex">
            <FieldGroup render={<form onSubmit={regenerate} />}>
              <ConfirmPasswordField />
              <Button type="submit" variant="outline" className="w-full" disabled={write.pending}>
                Regenerate backup codes
              </Button>
            </FieldGroup>
            <Link
              className={`${buttonVariants({ variant: "danger-outline" })} w-full`}
              to={paths.settingsConfirm("two-factor", "disable-two-factor")}
            >
              Disable two-factor
            </Link>
          </div>
        </Card>
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
    <Card>
      <div>
        <CardTitle>Set up two-factor</CardTitle>
        <CardDescription>Scan the QR code, then enter the 6-digit code.</CardDescription>
      </div>
      <img
        src={enrollment.qrDataUri}
        width={140}
        height={140}
        alt="Scan this code with your authenticator app"
        className="self-center rounded-lg"
      />
      {/* Spaced out and centred under the QR, so the owner can copy it by eye. */}
      <div className="text-center font-mono text-sm tracking-[0.08em]">{enrollment.secret}</div>
      <FieldGroup
        render={
          <form
            data-otp-form
            onSubmit={(event) => {
              event.preventDefault();
              onVerify(String(new FormData(event.currentTarget).get("code") ?? ""));
            }}
          />
        }
      >
        <OtpBoxes invalid={enrollment.error !== null} />
        {enrollment.error === null ? null : (
          <FieldError render={<p />} className="text-center">
            {enrollment.error}
          </FieldError>
        )}
        <div className={ACTIONS}>
          <Button type="submit" className={GROW} disabled={pending}>
            Verify
          </Button>
          <Link
            className={`${buttonVariants({ variant: "ghost" })} ${GROW}`}
            to={paths.settingsPane("two-factor")}
            onClick={onCancel}
          >
            Cancel
          </Link>
        </div>
      </FieldGroup>
    </Card>
  );
}

/** SettingsStates "Backup codes" — the one render that ever shows the plaintext set. */
function BackupCodesCard({ codes, onDone }: { codes: string[]; onDone: () => void }): ReactNode {
  return (
    <Card>
      <CardTitle>Backup codes</CardTitle>
      <div className="grid grid-cols-2 gap-2">
        {codes.map((code) => (
          <div className="flex h-code-chip items-center justify-center rounded-sm bg-muted font-mono text-sm" data-code key={code}>
            {code}
          </div>
        ))}
      </div>
      <FieldDescription render={<p />} className="text-warning">
        Store these somewhere safe — they are shown only once.
      </FieldDescription>
      <div className={ACTIONS}>
        {/* Newline-joined, the reveal's own shape, so the pasted set matches the screen. */}
        <Button variant="outline" className={GROW} onClick={() => void navigator.clipboard.writeText(codes.join("\n"))}>
          Copy codes
        </Button>
        <Link className={`${buttonVariants()} ${GROW}`} to={paths.settingsPane("two-factor")} onClick={onDone}>
          Done
        </Link>
      </div>
    </Card>
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
    <Button type="button" variant="outline" size="sm" className={GROW} onClick={add}>
      <PlusIcon />
      <span>Add passkey</span>
    </Button>
  );

  return (
    <Card>
      <div>
        <CardTitle>Passkeys</CardTitle>
        <CardDescription>Sign in with a security key or platform authenticator.</CardDescription>
      </div>
      {passkeys.length === 0 ? (
        <div className="flex flex-col items-center gap-3 py-2">
          <p className="max-w-[280px] text-center text-sm text-muted-foreground">
            No passkeys yet. Add one to sign in without a password.
          </p>
          <div className={ACTIONS}>{addButton}</div>
        </div>
      ) : (
        <>
          <div className="flex flex-col">
            {passkeys.map((pk) => (
              <div className={LIST_ITEM} key={pk.id}>
                <div className="flex items-center gap-3">
                  <KeyIcon />
                  <div>
                    <div className={LIST_TITLE}>{pk.name}</div>
                    <div className={LIST_META}>
                      Added {formatDate(pk.addedAt)} ·{" "}
                      {pk.lastUsedAt === null ? "never used" : `last used ${formatRelative(pk.lastUsedAt, now)}`}
                    </div>
                  </div>
                </div>
                <Link
                  className={buttonVariants({ variant: "danger-ghost", size: "sm" })}
                  to={paths.settingsConfirm("passkeys", "remove-passkey", pk.id)}
                >
                  Remove
                </Link>
              </div>
            ))}
          </div>
          <div className={ACTIONS}>{addButton}</div>
        </>
      )}
    </Card>
  );
}

/** `.list-item`: a plain row inside a padded card — the thing on the left, its control on the
 *  right — ruled from the next, the last unruled against the card's edge. */
const LIST_ITEM = "flex items-center justify-between gap-3 border-b border-row-border py-3 last:border-b-0";

/** `.list-title` and `.list-meta`: a row's name, and the muted line under it. */
const LIST_TITLE = "text-base font-medium";
const LIST_META = "text-xs text-muted-foreground";

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
    <Link
      className={buttonVariants({ variant: "danger-outline", size: "sm" })}
      to={paths.settingsConfirm("sessions", "revoke-other-sessions")}
    >
      Revoke all others
    </Link>
  );
}

/** The Sessions pane: a full-bleed table wide, list rows with one combined meta line narrow —
 *  two markups of the same rows, as the server drew them. */
function SessionsCard({ sessions }: { sessions: SessionRow[] }): ReactNode {
  const now = Date.now();
  return (
    <Card size="flush">
      <CardHeader className={cn(TABLE_CARD_HEAD, "max-md:hidden")}>
        <div>
          <CardTitle>Active sessions</CardTitle>
          <CardDescription>Web and CLI sessions currently signed in.</CardDescription>
        </div>
        <RevokeAllOthers />
      </CardHeader>
      <Table className="max-md:hidden">
        <TableHeader>
          <TableRow>
            <TableHead>Client</TableHead>
            <TableHead>Created</TableHead>
            <TableHead>Last active</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {sessions.map((session) => (
            <TableRow key={session.id}>
              <TableCell>
                <div className="flex items-center gap-2">
                  <span>{sessionLabel(session)}</span>
                  {session.current ? <Badge variant="outline">current</Badge> : null}
                </div>
              </TableCell>
              <TableCell className={CELL.muted}>{formatDate(session.createdAt)}</TableCell>
              <TableCell className={CELL.muted}>{formatRelative(session.lastActiveAt, now)}</TableCell>
              <TableCell className={CELL.actions}>
                {session.current ? null : (
                  <Link
                    className={cn(buttonVariants({ variant: "danger-ghost", size: "sm" }), CELL.button)}
                    to={paths.settingsConfirm("sessions", "revoke-session", session.id)}
                  >
                    Revoke
                  </Link>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      {/* A BLOCK on a phone, not the padded card's flex column: legacy.css's `.narrow-only`
          showed it with `display: revert`, so its head and list stack with no gap between. */}
      <CardContent className="hidden max-md:block">
        <CardHeader>
          <div>
            <CardTitle>Active sessions</CardTitle>
            <CardDescription>Web and CLI sessions currently signed in.</CardDescription>
          </div>
          <RevokeAllOthers />
        </CardHeader>
        <div className="flex flex-col">
          {sessions.map((session) => (
            <div className={LIST_ITEM} key={session.id}>
              <div className="flex flex-col gap-0.5">
                <div className="flex items-center gap-2">
                  <span className={LIST_TITLE}>{sessionLabel(session)}</span>
                  {session.current ? <Badge variant="outline">current</Badge> : null}
                </div>
                <div className={LIST_META}>
                  Created {formatDate(session.createdAt)} · active {formatRelative(session.lastActiveAt, now)}
                </div>
              </div>
              {session.current ? null : (
                <Link
                  className={buttonVariants({ variant: "danger-ghost", size: "sm" })}
                  to={paths.settingsConfirm("sessions", "revoke-session", session.id)}
                >
                  Revoke
                </Link>
              )}
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
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
    <Card size="flush">
      <CardHeader className={TABLE_CARD_HEAD}>
        <div className="flex flex-col gap-0.5">
          <CardTitle>Tokens</CardTitle>
          <CardDescription>Every key issued in this namespace. Issue new keys from an app or agent page.</CardDescription>
        </div>
        {/* Drawn as the segmented control, but LINKS with `aria-current`, not tabs: each
            arm is a URL, so there is no in-page view for a tab to own (pass 2 ruling 1.5). */}
        <div className={cn(tabsListVariants(), "shrink-0")}>
          {TOKEN_KINDS.map((option) => (
            <Link
              key={option.label}
              className={tabsTriggerVariants()}
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
      </CardHeader>
      {listed.length === 0 ? (
        <Empty variant="inline">
          {/* Two empty states for two facts: nothing was ever issued, or the FILTER hides
              what was — and under a filter an empty namespace is still the first fact. */}
          {kind === null || tokens.length === 0 ? (
            <EmptyDescription>No keys issued yet.</EmptyDescription>
          ) : (
            <EmptyDescription>
              No {kind} keys. <Link to={paths.settingsPane("tokens")}>Show all {tokens.length}</Link>.
            </EmptyDescription>
          )}
        </Empty>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Token</TableHead>
              <TableHead>Kind</TableHead>
              <TableHead>Bound to</TableHead>
              <TableHead>Created</TableHead>
              <TableHead>Expires</TableHead>
              <TableHead>Last used</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {listed.map((token) => (
              /* An expired row recedes behind the live ones — every cell and link, over their
                 own colours; the amber badge is the one thing in it still at full contrast. */
              <TableRow key={token.id} className={token.expired ? "[&>td]:text-ring [&>td_a]:text-ring" : undefined}>
                <TableCell className={CELL.mono}>{token.prefix}</TableCell>
                <TableCell>
                  <Badge variant="mono">{token.kind}</Badge>
                </TableCell>
                <TableCell className={CELL.mono}>
                  <Link to={token.kind === "app" ? paths.appDetail(token.boundTo) : paths.agentDetail(token.boundTo)}>
                    {token.boundTo}
                  </Link>
                </TableCell>
                <TableCell className={CELL.muted}>{formatStamp(token.createdAt)}</TableCell>
                <TableCell className={CELL.muted}>
                  {token.expired ? (
                    <Badge variant="warning">expired</Badge>
                  ) : token.expiresAt === null ? (
                    "never"
                  ) : (
                    formatStamp(token.expiresAt)
                  )}
                </TableCell>
                <TableCell className={CELL.muted}>
                  {token.lastUsedAt === null ? "never" : formatStamp(token.lastUsedAt)}
                </TableCell>
                <TableCell className={CELL.actions}>
                  {/* Still a <form> around the button, as the server drew it — and that is
                      layout, not habit: the form is the cell's flex item, so the phone's
                      `flex-1` on a cell's button does not stretch this one across. */}
                  <form
                    onSubmit={(event) => {
                      event.preventDefault();
                      void write.send(settingsApi.tokenRevoke, { id: token.id }, "token_revoke", {
                        // A revoked key also leaves its app's or agent's own token list.
                        touches: [keys.tokens(), ["app"], ["agent"]],
                      });
                    }}
                  >
                    <Button
                      type="submit"
                      variant="danger-outline"
                      size="sm"
                      className={CELL.button}
                      disabled={write.pending}
                    >
                      {token.expired ? "Remove" : "Revoke"}
                    </Button>
                  </form>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Card>
  );
}

/* -------------------------------------------------------- connected clients --- */

/** §13's Connected clients pane: one row per client; a revoked row stays, with no control,
 *  because re-consent revives the same row (§19.4). */
function ClientsCard({ connections }: { connections: ConnectionRow[] }): ReactNode {
  return (
    <Card size="flush">
      <CardContent className="gap-0.5">
        <CardTitle>Connected clients</CardTitle>
        <CardDescription>Outside software you approved to reach this hub, and the agent each one acts as.</CardDescription>
      </CardContent>
      {connections.length === 0 ? (
        <Empty variant="inline">
          <EmptyDescription>A client that completes the consent screen appears here.</EmptyDescription>
        </Empty>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Client</TableHead>
              <TableHead>Acts as</TableHead>
              <TableHead>Created</TableHead>
              <TableHead>Last used</TableHead>
              <TableHead>Status</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {connections.map((row) => (
              <TableRow key={row.id}>
                <TableCell>
                  <div className="flex items-center gap-2">
                    <span className="text-base font-medium">{row.clientName ?? row.clientId}</span>
                    {/* Nobody vouched for this name but the client that chose it (§19.5). */}
                    {row.selfRegistered ? <Badge variant="warning">unverified</Badge> : null}
                  </div>
                  <div className="font-mono text-xs text-muted-foreground">{row.redirectOrigin}</div>
                </TableCell>
                <TableCell className={CELL.mono}>
                  <Link to={paths.agentDetail(row.agentSlug)}>{row.agentSlug}</Link>
                </TableCell>
                <TableCell className={CELL.muted}>{formatStamp(row.createdAt)}</TableCell>
                <TableCell className={CELL.muted}>
                  {row.lastUsedAt === null ? "never" : formatStamp(row.lastUsedAt)}
                </TableCell>
                <TableCell>
                  {row.revokedAt === null ? (
                    <Badge variant="success">
                      <BadgeDot />
                      active
                    </Badge>
                  ) : (
                    <Badge variant="muted">revoked</Badge>
                  )}
                </TableCell>
                <TableCell className={CELL.actions}>
                  {row.revokedAt === null ? (
                    <Link
                      className={cn(buttonVariants({ variant: "danger-outline", size: "sm" }), CELL.button)}
                      to={paths.settingsConfirm("clients", "revoke-connection", row.id)}
                    >
                      Revoke
                    </Link>
                  ) : null}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Card>
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
    <Card>
      <div>
        <CardTitle>Execution</CardTitle>
        <CardDescription>
          How long a program run through this namespace's hub endpoint may take. Owner-wide, and measured in
          milliseconds.
        </CardDescription>
      </div>

      <FieldGroup render={<form onSubmit={(event) => void save(event)} />}>
        {errors.form === undefined ? null : (
          <Alert variant="danger" role="alert">
            <AlertDescription>{errors.form}</AlertDescription>
          </Alert>
        )}

        <Field render={<label />}>
          <Label render={<span />}>Default timeout</Label>
          <Input
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
            <FieldDescription render={<span />}>Used when a program sends no timeout of its own.</FieldDescription>
          ) : (
            <FieldError render={<span />}>{errors.defaults}</FieldError>
          )}
        </Field>

        <Field render={<label />}>
          <Label render={<span />}>Maximum timeout</Label>
          <Input
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
            <FieldDescription render={<span />}>
              The largest a program may request — never below the default, and never above {timeoutLabel(maxTimeoutMs)}.
            </FieldDescription>
          ) : (
            <FieldError render={<span />}>{errors.maximum}</FieldError>
          )}
        </Field>

        <div className={ACTIONS}>
          <Button type="submit" className={GROW} disabled={write.pending}>
            Save
          </Button>
        </div>
      </FieldGroup>

      <p className={NOTE}>
        Each execution snapshots this pair when it is admitted, so a change governs new runs only — one already going
        keeps the deadline it started with.
      </p>
    </Card>
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
    <Link className={buttonVariants({ variant: "ghost" })} to={paths.settingsPane(owner)}>
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
        onSubmit={(event) => {
          event.preventDefault();
          run();
        }}
      >
        <DialogFooter>
          {cancel}
          <Button type="submit" variant="danger" disabled={write.pending}>
            {word}
          </Button>
        </DialogFooter>
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
          <FieldGroup
            render={
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  const password = String(new FormData(event.currentTarget).get("password") ?? "");
                  void write.send(settingsApi.totpDisable, { password }, "two_factor_disable");
                }}
              />
            }
          >
            <ConfirmPasswordField autoFocus />
            <DialogFooter>
              {cancel}
              <Button type="submit" variant="danger" disabled={write.pending}>
                Disable
              </Button>
            </DialogFooter>
          </FieldGroup>
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
      className="shrink-0 text-muted-foreground"
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
