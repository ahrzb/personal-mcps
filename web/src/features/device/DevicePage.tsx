import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useState } from "react";
import type { ReactNode } from "react";
import { useDocumentTitle } from "@/chrome/Shell";
import { Failure, Skeleton } from "@/chrome/States";
import { useApi, useAppEnv } from "@/lib/api-context";
import { ApiError } from "@/lib/http";
import { deviceApi, paths } from "@/lib/paths";
import { deviceQuery } from "@/lib/queries";
import type { DeviceDecideBody, DeviceRequest, Redirected } from "@/lib/types";
import type { SearchBag } from "@/router";
import { deviceViewOf, relativeTime } from "./derive";

/**
 * `/device` — the RFC 8628 device-flow verdict page (§13), reached from a URL the CLI printed.
 * CHROMELESS, as the server page was: the `.auth` column, the brand, one card.
 *
 * The port of `server/src/pages/device.tsx`, element for element. The URL decides the moment
 * (`derive.deviceViewOf`); only a present `?user_code=` is read, and that read CLAIMS the code
 * for this owner exactly as rendering the URL did. Everything the read answers except the code
 * itself is attacker-influenced — the user-code channel is unauthenticated (§7) — and so is
 * `?error=`: all of it is drawn as text nodes, never markup and never a link. The card exists
 * so the owner can catch a client they do not recognise before the one click that hands a
 * device full admin control.
 */
export function DevicePage(): ReactNode {
  useDocumentTitle("Approve device");
  const api = useApi();
  const search = useSearch({ strict: false }) as SearchBag;
  const view = deviceViewOf(search);
  const code = view.kind === "verify" ? view.userCode : "";
  const read = useQuery({ ...deviceQuery(api, code), enabled: view.kind === "verify" });

  let card: ReactNode;
  if (view.kind === "decided") card = <DecidedCard decision={view.decision} />;
  else if (view.kind === "enter-code") card = <EnterCodeCard userCode="" error={view.error} />;
  else if (read.isPending) {
    card = (
      <div className="auth-card">
        <Skeleton rows={5} />
      </div>
    );
  } else if (read.isError) {
    // A 404 is the server's word that the code is not live — the enter-code card again, the
    // code kept in the field, the server's sentence under it. Anything else is a failure.
    card =
      read.error instanceof ApiError && read.error.status === 404 ? (
        <EnterCodeCard userCode={code} error={read.error.message} />
      ) : (
        <Failure message={read.error.message} onRetry={() => void read.refetch()} />
      );
  } else card = <ConfirmCard request={read.data.request} />;

  return (
    <div className="auth">
      <div className="brand">
        <BrandMark />
        <span>personal-mcps</span>
      </div>
      {card}
      {view.kind === "decided" ? null : <div className="auth-foot">Codes expire after 10 minutes.</div>}
    </div>
  );
}

/**
 * AuthStates "DEVICE — ENTER CODE" and "— EXPIRED CODE". A real `<form method="get">`, left
 * to the browser: submitting it is a DOCUMENT load of `/device?user_code=<typed>`, as today —
 * not a mutation, so no CSRF, and a fresh document is where the typed code is first read.
 */
function EnterCodeCard({ userCode, error }: { userCode: string; error: string | null }): ReactNode {
  return (
    <div className="auth-card">
      <div className="auth-title">Approve a device</div>
      <form method="get" action={paths.device} className="form">
        <div className="field">
          <label className="label" htmlFor="user_code">
            Device code
          </label>
          <input
            id="user_code"
            type="text"
            name="user_code"
            className="input--mono"
            placeholder="XXXX-XXXX"
            defaultValue={userCode}
            aria-invalid={error === null ? undefined : "true"}
          />
          {error === null ? (
            <div className="field-hint">Enter the code the pmcp CLI printed.</div>
          ) : (
            <div className="field-error">{error}</div>
          )}
        </div>
        <button type="submit" className="btn btn--primary btn--block">
          Continue
        </button>
      </form>
      <div className="center" style={{ fontSize: "var(--text-sm)" }}>
        <Link to={paths.apps}>Cancel</Link>
      </div>
    </div>
  );
}

/**
 * Device.dc.html: the live verdict. Every fact the read returned is shown, and the warning
 * says plainly what Approve grants — the signed-in `username` is the one string on this card
 * the device did not choose.
 */
function ConfirmCard({ request }: { request: DeviceRequest }): ReactNode {
  const { api, bootstrap } = useAppEnv();
  const navigate = useNavigate();
  const [pending, setPending] = useState(false);

  /** One decision, landing where the answer's `next` says — `?decided=` on success, `?error=`
   *  when better-auth refused (not the claimant, already decided, expired), as the 303 did. */
  const decide = async (decision: DeviceDecideBody["decision"]): Promise<void> => {
    setPending(true);
    try {
      const answer = await api.post<Redirected>(deviceApi.decide, {
        userCode: request.userCode,
        decision,
      } satisfies DeviceDecideBody);
      void navigate({ href: answer.next });
    } catch (error) {
      setPending(false);
      // A 401 is already a navigation to /login (`lib/http`).
      if (error instanceof ApiError && error.status === 401) return;
      void navigate({
        to: paths.device,
        search: { error: error instanceof Error ? error.message : String(error) },
      });
    }
  };

  return (
    <div className="auth-card">
      <div>
        <div className="auth-title">Approve CLI sign-in</div>
        <div className="auth-desc">A device is asking to sign in with this code.</div>
      </div>

      <div className="field">
        <div className="eyebrow">Device code</div>
        <div className="code-display">{request.userCode}</div>
      </div>

      <div className="kv">
        <div className="kv-row">
          <div className="kv-key">IP address</div>
          <div className="mono">{request.ip}</div>
        </div>
        <div className="kv-row">
          <div className="kv-key">Client</div>
          <div>{request.client}</div>
        </div>
        <div className="kv-row">
          <div className="kv-key">Requested</div>
          <div>{relativeTime(request.requestedAt, Date.now())}</div>
        </div>
      </div>

      <div className="alert alert--warning">
        <WarningIcon />
        <div>
          <div className="alert-title">Grants full admin access</div>
          <div className="alert-text">
            Approving signs this device in as {bootstrap.username} with full control of your namespace — apps, grants,
            and tokens.
          </div>
        </div>
      </div>

      <div className="confirm-actions">
        <button type="button" className="btn btn--danger-outline" disabled={pending} onClick={() => void decide("deny")}>
          Deny
        </button>
        <button type="button" className="btn btn--primary" disabled={pending} onClick={() => void decide("approve")}>
          Approve
        </button>
      </div>
    </div>
  );
}

/**
 * AuthStates "DEVICE — APPROVED", and its twin: the verdict already landed, so there is nothing
 * to decide — the outcome, and where to look next.
 */
function DecidedCard({ decision }: { decision: "approved" | "denied" }): ReactNode {
  return (
    <div className="auth-card" style={{ alignItems: "center", textAlign: "center", gap: "var(--space-6)" }}>
      {decision === "approved" ? <ApprovedIcon /> : <DeniedIcon />}
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)", alignItems: "center" }}>
        <div className="auth-title">{decision === "approved" ? "Device approved" : "Device denied"}</div>
        <div style={{ fontSize: "var(--text-sm)", color: "var(--muted-fg)", lineHeight: 1.5 }}>
          {decision === "approved"
            ? "You can return to your terminal — the CLI finishes sign-in on its own."
            : "You can close this tab. The CLI sign-in was cancelled."}
        </div>
      </div>
    </div>
  );
}

/** The hub mark — duplicated from the Shell, whose header this page does not render. */
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

function WarningIcon(): ReactNode {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--warning)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m21.73 18-8-14a2 2 0 0 0-3.46 0l-8 14A2 2 0 0 0 4 20h16a2 2 0 0 0 1.73-2Z" />
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
    </svg>
  );
}

function ApprovedIcon(): ReactNode {
  return (
    <svg width="48" height="48" viewBox="0 0 48 48" fill="none" aria-hidden="true">
      <circle cx="24" cy="24" r="23" fill="var(--success-bg)" stroke="var(--success-border)" strokeWidth="1.5" />
      <path d="M16 24.5 21.5 30 32 19" stroke="var(--success)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Not in the artboards (only APPROVED is drawn) — the same circle, an X in the danger palette. */
function DeniedIcon(): ReactNode {
  return (
    <svg width="48" height="48" viewBox="0 0 48 48" fill="none" aria-hidden="true">
      <circle cx="24" cy="24" r="23" fill="var(--danger-bg)" stroke="var(--danger-border)" strokeWidth="1.5" />
      <path d="M18 18 30 30M30 18 18 30" stroke="var(--danger-fg)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
