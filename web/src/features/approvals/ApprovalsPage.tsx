import { keepPreviousData, useMutation, useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { NoticeBanner, useFlash } from "@/chrome/Notice";
import { Actions } from "@/chrome/Actions";
import { Page, PageHead, PageSubtitle, PageTitle, Section, SectionTitle } from "@/chrome/Page";
import { Shell, useDocumentTitle } from "@/chrome/Shell";
import { QueryState, Skeleton } from "@/chrome/States";
import { CodeBlock, Muted, Note, RowTitle } from "@/chrome/Text";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyTitle } from "@/components/ui/empty";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useApi, useAppEnv } from "@/lib/api-context";
import { ApiError } from "@/lib/http";
import { paths } from "@/lib/paths";
import { approvalHistoryQuery, pendingApprovalsQuery, useOp } from "@/lib/queries";
import type { ApprovalRow, ApprovalsResponse, PushSubscribeBody } from "@/lib/types";
import type { SearchBag } from "@/router";
import {
  decisionLanding,
  historyLimitOf,
  historyOf,
  historyOutcome,
  historyReadLimit,
  listStamp,
  minutesUntil,
  principalOf,
} from "./derive";

/**
 * `/approvals` — the requests awaiting a decision, the recent decision history, and this
 * browser's notifications opt-in.
 *
 * The port of `server/src/pages/approvals.tsx`, element for element and class for class: one
 * template for both artboards, a `max-md:hidden` / `md:hidden` pair picking which spelling
 * shows. What differs is only what a client has to do differently:
 *
 *   - the two halves are two reads (`?status=pending`, then `?limit=`), where the server made
 *     them in one handler — the pending read is the SAME cache entry the nav badge polls, so
 *     the list and the badge cannot disagree, and the history read waits on it because its
 *     limit pays for the pending rows (`derive.historyReadLimit`);
 *   - Approve and Reject call `approval_decide` rather than posting a form, and then land on
 *     `/approvals` carrying the flash keys the 303 carried, so the outcome reads identically;
 *   - the notifications control is a component rather than the page's inline script.
 */
export function ApprovalsPage(): ReactNode {
  useDocumentTitle("Approvals");
  const api = useApi();
  const search = useSearch({ strict: false }) as SearchBag;
  const notice = useFlash(search);
  const historyLimit = historyLimitOf(typeof search.limit === "string" ? search.limit : undefined);
  const pending = useQuery(pendingApprovalsQuery(api));
  const history = useQuery({
    ...approvalHistoryQuery(api, historyReadLimit(historyLimit, pending.data?.approvals.length ?? 0)),
    enabled: pending.isSuccess,
    // A new pending row (the badge's poll) or "Older →" changes the key; the rows already
    // drawn stay until the wider read lands, rather than the section blinking to a skeleton.
    placeholderData: keepPreviousData,
  });
  // The render instant, read once so every card's "expires in" counts against one clock —
  // and so the gallery's frozen `Date.now` reaches all of them.
  const now = Date.now();

  return (
    <Shell active="approvals">
      <Page shape="document">
        {notice === null ? null : <NoticeBanner notice={notice} flushUntitled />}

        <PageHead>
          <div>
            <PageTitle>Approvals</PageTitle>
            <PageSubtitle className="max-md:hidden">
              Approval-gated requests from your agents. Approving lets the agent retry the exact call once;
              approvals expire after an hour.
            </PageSubtitle>
            <PageSubtitle className="md:hidden">Single use · expire after an hour</PageSubtitle>
          </div>
          <PushToggle />
        </PageHead>

        <Section>
          <SectionTitle>Pending</SectionTitle>
          <QueryState
            query={pending}
            skeleton={<Skeleton rows={3} />}
            empty={{
              when: (data) => data.approvals.length === 0,
              render: (
                <Empty>
                  <EmptyTitle>No pending requests</EmptyTitle>
                  <EmptyDescription>Approval-gated calls appear here the moment an agent hits one.</EmptyDescription>
                </Empty>
              ),
            }}
          >
            {(data: ApprovalsResponse) => data.approvals.map((row) => <PendingCard key={row.id} row={row} now={now} />)}
          </QueryState>
        </Section>

        <Section>
          <SectionTitle>History</SectionTitle>
          <QueryState query={history} skeleton={<Skeleton rows={6} />}>
            {(data: ApprovalsResponse) => <History {...historyOf(data.approvals, historyLimit)} limit={historyLimit} />}
          </QueryState>
          <Note render={<div />}>
            History prunes with the audit trail after 7 days. Times are UTC.
          </Note>
        </Section>
      </Page>
    </Shell>
  );
}

/**
 * One request awaiting a decision. The wide artboard sets tool and app on one baseline with
 * the principal and request time under them; the narrow one puts the tool alone and folds the
 * rest into one compact line — two spellings of the same fields, not two data shapes.
 *
 * The arguments are `CodeBlock` on a `<div>` (the detail page's is its `<pre>`). Either way it
 * is `pre-wrap`, as legacy `.code` was: `JSON.stringify`'s indentation stays, and a bulky body
 * wraps anywhere instead of overflowing the card.
 */
function PendingCard({ row, now }: { row: ApprovalRow; now: number }): ReactNode {
  const decide = useDecision(row);
  return (
    <Card size="flush" className="flex flex-col gap-3.5 p-5 max-md:gap-3 max-md:p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-baseline gap-2 max-md:hidden">
            <div className="font-mono text-md font-semibold">{row.tool}</div>
            <Muted render={<div />}>on {row.appSlug}</Muted>
          </div>
          <div className="font-mono text-md font-semibold md:hidden">{row.tool}</div>
          <Muted render={<div />} className="mt-0.5 max-md:hidden">
            {principalOf(row)} · requested {listStamp(row.createdAt)}
          </Muted>
          <Note render={<div />} className="md:hidden">
            {row.appSlug} · {principalOf(row)} · {listStamp(row.createdAt)}
          </Note>
        </div>
        <div className="flex shrink-0 items-center gap-2.5 max-md:flex-col max-md:items-end max-md:gap-1">
          <Badge variant="warning">pending</Badge>
          <div className="text-xs text-muted-foreground">expires in {minutesUntil(now, row.expiresAt)} min</div>
        </div>
      </div>
      <CodeBlock render={<div />}>
        {JSON.stringify(row.args, null, 2)}
      </CodeBlock>
      <Actions grow>
        <Button type="button" variant="danger-outline" size="sm" disabled={decide.pending} onClick={() => decide.run("reject")}>
          Reject
        </Button>
        <Button type="button" size="sm" disabled={decide.pending} onClick={() => decide.run("approve")}>
          Approve
        </Button>
      </Actions>
    </Card>
  );
}

/**
 * Approve or Reject one request, then land where the form's 303 did — `/approvals` carrying
 * `done=` or `failed=` — from whichever page asked. A lost race (the request was decided or
 * expired between the render and the click) is the op's one 422, and lands as the warning
 * `lib/notice.ts` keys on the op.
 *
 * Exported because the detail page decides through the same door and must land the same way.
 */
export function useDecision(row: ApprovalRow): { pending: boolean; run: (decision: "approve" | "reject") => void } {
  const navigate = useNavigate();
  const decide = useOp<{ id: string; decision: "approve" | "reject" }>("approval_decide", { agent: row.agentSlug });
  return {
    pending: decide.isPending,
    // `mutateAsync` rather than a per-call callback: the op's invalidation refetches the
    // pending list, which unmounts this card, and a per-call callback belongs to the
    // observer that goes with it — the promise settles regardless.
    run: (decision) => {
      decide.mutateAsync({ id: row.id, decision }).then(
        () => void navigate({ to: paths.approvals, search: decisionLanding({ ok: true }) }),
        (error: unknown) => {
          // A 401 is already a navigation to /login (`lib/http.ts`); landing here too would
          // race it.
          if (error instanceof ApiError && error.status === 401) return;
          const reason = error instanceof Error ? error.message : String(error);
          void navigate({ to: paths.approvals, search: decisionLanding({ ok: false, reason }) });
        },
      );
    },
  };
}

/** The History section's card and its footnote line. Both vanish together when nothing has
 *  been decided yet, because "Showing 0 decisions" under the empty state would say it twice. */
function History({
  history,
  hasMore,
  limit,
}: {
  history: ApprovalRow[];
  hasMore: boolean;
  /** The cap this history was read under: the N in "Showing last N decisions". */
  limit: number;
}): ReactNode {
  if (history.length === 0) {
    return (
      <Empty>
        <EmptyTitle>No decisions yet</EmptyTitle>
        <EmptyDescription>Approved and rejected requests are kept here for 7 days.</EmptyDescription>
      </Empty>
    );
  }
  return (
    <>
      <Card size="flush">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Decided</TableHead>
              <TableHead>Principal</TableHead>
              <TableHead>App</TableHead>
              <TableHead>Tool</TableHead>
              <TableHead>Outcome</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {history.map((row) => (
              <HistoryRow key={row.id} row={row} />
            ))}
          </TableBody>
        </Table>
      </Card>
      <Muted render={<div />}>
        {hasMore ? (
          <>
            Showing last {limit} decisions ·{" "}
            <Link to={paths.approvals} search={{ limit: String(limit * 2) }}>
              Older →
            </Link>
          </>
        ) : (
          <>
            Showing {history.length} decision{history.length === 1 ? "" : "s"}
          </>
        )}
      </Muted>
    </>
  );
}

/** One decided, expired or spent request: five columns wide, one summary cell narrow. A row
 *  that lapsed unattended has no decision instant, so "Decided" falls back to when it was
 *  requested rather than leaving the cell blank. */
function HistoryRow({ row }: { row: ApprovalRow }): ReactNode {
  const outcome = historyOutcome(row.status);
  const when = listStamp(row.decidedAt ?? row.createdAt);
  return (
    <TableRow>
      <TableCell className="max-md:hidden font-mono text-xs whitespace-nowrap text-muted-foreground">{when}</TableCell>
      <TableCell variant="mono" className="max-md:hidden">{principalOf(row)}</TableCell>
      <TableCell className="max-md:hidden">{row.appSlug}</TableCell>
      <TableCell variant="mono" className="max-md:hidden">
        <Link to={paths.approval(row.id)}>{row.tool}</Link>
      </TableCell>
      <TableCell className="max-md:hidden">
        <Badge variant={outcome.tone}>{outcome.label}</Badge>
      </TableCell>
      <TableCell className="hidden max-md:flex max-md:items-center max-md:justify-between max-md:gap-3">
        <div>
          <RowTitle className="font-mono" render={<Link to={paths.approval(row.id)} />}>
            {row.tool}
          </RowTitle>
          <Note render={<div />}>
            {when} · {principalOf(row)} · {row.appSlug}
          </Note>
        </div>
        <Badge variant={outcome.tone}>{outcome.label}</Badge>
      </TableCell>
    </TableRow>
  );
}

/**
 * This browser's Web Push opt-in (§13) — `approvals.tsx`'s inline script, as a component.
 *
 * Whether THIS browser is subscribed is knowable only here, so the control asks the service
 * worker on mount and says "Notifications on" when it already is. A browser with no push
 * support gets the control disabled; a refused permission and a refused save read
 * differently, because only the second is the hub's to fix (G18: a failed save is never a
 * silent no-op).
 *
 * The label is written into BOTH spans once it changes — the script did the same — so the
 * wide and narrow spellings only differ while the control still offers to enable.
 */
function PushToggle(): ReactNode {
  const { api, bootstrap } = useAppEnv();
  const [state, setState] = useState<"offer" | "unsupported" | "on" | "blocked" | "failed">("offer");
  const save = useMutation({
    mutationFn: (body: PushSubscribeBody) => api.post<null>("/approvals/push", body),
  });

  useEffect(() => {
    if (!pushSupported()) {
      setState("unsupported");
      return;
    }
    let live = true;
    navigator.serviceWorker.ready
      .then((registration) => registration.pushManager.getSubscription())
      .then((subscription) => {
        if (live && subscription !== null) setState("on");
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  const enable = async (): Promise<void> => {
    try {
      // Apple's documented order, harmless everywhere else: ask for permission INSIDE the
      // gesture, then subscribe. Safari answers `subscribe()` on a "default" permission with
      // NotAllowedError rather than prompting. (The `||` reads the current state for a
      // pre-16 Safari whose `requestPermission` takes a callback and returns nothing.)
      const permission = await Promise.resolve(Notification.requestPermission());
      if ((permission || Notification.permission) !== "granted") {
        setState("blocked");
        return;
      }
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: base64UrlBytes(bootstrap.vapidPublicKey),
      });
      await save.mutateAsync({ subscription: subscription.toJSON() as PushSubscribeBody["subscription"] });
      setState("on");
    } catch (error) {
      setState(error instanceof Error && error.name === "NotAllowedError" ? "blocked" : "failed");
    }
  };

  const label = LABELS[state];
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={state === "unsupported" || state === "on"}
      aria-disabled={state === "unsupported" || state === "on" ? true : undefined}
      onClick={() => void enable()}
    >
      <BellIcon />
      <span className="max-md:hidden">{label ?? "Enable notifications"}</span>
      <span className="md:hidden">{label ?? "Notifications"}</span>
    </Button>
  );
}

/** What the control says once it is no longer offering, or null while it is. */
const LABELS: Record<"offer" | "unsupported" | "on" | "blocked" | "failed", string | null> = {
  offer: null,
  unsupported: null,
  on: "Notifications on",
  blocked: "Notifications blocked",
  failed: "Notifications failed",
};

/** The three browser features a push subscription needs; any one missing and there is
 *  nothing the control could do. */
function pushSupported(): boolean {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

/** A base64url VAPID key as the bytes `applicationServerKey` takes. */
function base64UrlBytes(base64: string): Uint8Array<ArrayBuffer> {
  const padded = (base64 + "=".repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(padded);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

const BellIcon = (): ReactNode => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
    <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
  </svg>
);
