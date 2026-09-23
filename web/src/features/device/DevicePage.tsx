import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useState } from "react";
import type { ReactNode } from "react";
import { ConfirmActions } from "@/chrome/Actions";
import { AuthFrame } from "@/chrome/AuthFrame";
import { Kv, KvList } from "@/chrome/Kv";
import { useDocumentTitle } from "@/chrome/Shell";
import { NoticeIcon } from "@/chrome/Notice";
import { Failure, Skeleton } from "@/chrome/States";
import { Eyebrow, Muted } from "@/chrome/Text";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldError, FieldGroup } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useApi, useAppEnv } from "@/lib/api-context";
import { ApiError } from "@/lib/http";
import { deviceApi, paths } from "@/lib/paths";
import { deviceQuery } from "@/lib/queries";
import type { DeviceDecideBody, DeviceRequest, Redirected } from "@/lib/types";
import type { SearchBag } from "@/router";
import { deviceViewOf, relativeTime } from "./derive";

/**
 * `/device` — the RFC 8628 device-flow verdict page (§13), reached from a URL the CLI printed.
 * CHROMELESS, as the server page was: `AuthFrame`'s column, the brand, one `Card size="auth"`.
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
      <Card size="auth">
        <Skeleton rows={5} />
      </Card>
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
    <AuthFrame foot={view.kind === "decided" ? undefined : "Codes expire after 10 minutes."}>{card}</AuthFrame>
  );
}

/**
 * AuthStates "DEVICE — ENTER CODE" and "— EXPIRED CODE". A real `<form method="get">`, left
 * to the browser: submitting it is a DOCUMENT load of `/device?user_code=<typed>`, as today —
 * not a mutation, so no CSRF, and a fresh document is where the typed code is first read.
 */
function EnterCodeCard({ userCode, error }: { userCode: string; error: string | null }): ReactNode {
  return (
    <Card size="auth">
      <CardTitle>Approve a device</CardTitle>
      <FieldGroup render={<form method="get" action={paths.device} />}>
        <Field>
          <Label htmlFor="user_code">Device code</Label>
          <Input
            id="user_code"
            type="text"
            name="user_code"
            placeholder="XXXX-XXXX"
            defaultValue={userCode}
            aria-invalid={error === null ? undefined : "true"}
          />
          {error === null ? (
            <FieldDescription>Enter the code the pmcp CLI printed.</FieldDescription>
          ) : (
            <FieldError>{error}</FieldError>
          )}
        </Field>
        <Button type="submit" className="w-full">
          Continue
        </Button>
      </FieldGroup>
      <div className="text-center text-sm">
        <Link to={paths.apps}>Cancel</Link>
      </div>
    </Card>
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
    <Card size="auth">
      <div>
        <CardTitle>Approve CLI sign-in</CardTitle>
        <CardDescription>A device is asking to sign in with this code.</CardDescription>
      </div>

      <div className="flex flex-col gap-1.5">
        <Eyebrow>Device code</Eyebrow>
        <div className="flex h-11 items-center justify-center rounded-md bg-muted font-mono text-lg font-semibold tracking-[3px] max-md:h-code-display-touch">
          {request.userCode}
        </div>
      </div>

      <KvList variant="block">
        <Kv k="IP address">
          <span className="font-mono">{request.ip}</span>
        </Kv>
        <Kv k="Client">{request.client}</Kv>
        <Kv k="Requested">{relativeTime(request.requestedAt, Date.now())}</Kv>
      </KvList>

      <Alert variant="warning">
        <NoticeIcon tone="warning" />
        <div>
          <AlertTitle>Grants full admin access</AlertTitle>
          <AlertDescription>
            Approving signs this device in as {bootstrap.username} with full control of your namespace — apps, grants,
            and tokens.
          </AlertDescription>
        </div>
      </Alert>

      <ConfirmActions>
        <Button
          type="button"
          variant="danger-outline"
          disabled={pending}
          onClick={() => void decide("deny")}
        >
          Deny
        </Button>
        <Button type="button" disabled={pending} onClick={() => void decide("approve")}>
          Approve
        </Button>
      </ConfirmActions>
    </Card>
  );
}

/**
 * AuthStates "DEVICE — APPROVED", and its twin: the verdict already landed, so there is nothing
 * to decide — the outcome, and where to look next.
 */
function DecidedCard({ decision }: { decision: "approved" | "denied" }): ReactNode {
  return (
    <Card size="auth" className="items-center gap-3 text-center">
      {decision === "approved" ? <ApprovedIcon /> : <DeniedIcon />}
      <div className="flex flex-col items-center gap-1.5">
        <CardTitle>{decision === "approved" ? "Device approved" : "Device denied"}</CardTitle>
        <Muted render={<div />} className="leading-normal">
          {decision === "approved"
            ? "You can return to your terminal — the CLI finishes sign-in on its own."
            : "You can close this tab. The CLI sign-in was cancelled."}
        </Muted>
      </div>
    </Card>
  );
}


function ApprovedIcon(): ReactNode {
  return (
    <svg width="48" height="48" viewBox="0 0 48 48" fill="none" aria-hidden="true">
      <circle cx="24" cy="24" r="23" fill="var(--color-success-bg)" stroke="var(--color-success-border)" strokeWidth="1.5" />
      <path d="M16 24.5 21.5 30 32 19" stroke="var(--color-success)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Not in the artboards (only APPROVED is drawn) — the same circle, an X in the danger palette. */
function DeniedIcon(): ReactNode {
  return (
    <svg width="48" height="48" viewBox="0 0 48 48" fill="none" aria-hidden="true">
      <circle cx="24" cy="24" r="23" fill="var(--color-danger-bg)" stroke="var(--color-danger-border)" strokeWidth="1.5" />
      <path d="M18 18 30 30M30 18 18 30" stroke="var(--color-danger-fg)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
