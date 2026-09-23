import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { AuthFrame } from "@/chrome/AuthFrame";
import { Kv, KvList } from "@/chrome/Kv";
import { useDocumentTitle } from "@/chrome/Shell";
import { QueryState, Skeleton } from "@/chrome/States";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { useApi } from "@/lib/api-context";
import { paths } from "@/lib/paths";
import { approvalQuery } from "@/lib/queries";
import type { ApprovalDetailRead, DetailApproval } from "@/lib/types";
import { useDecision } from "./ApprovalsPage";
import { detailBadge, explanation, formatArgs, timeRows } from "./derive";

/**
 * `/approvals/<id>` — the page a -32003 hands an agent's user (§7), opened from a push
 * notification or an error string, often on a phone, with one job: decide, or read, one
 * request.
 *
 * CHROMELESS, as the server page was: no header and no nav, just `AuthFrame`'s column with the
 * brand, one `Card size="auth"` and the way back to the dashboard. `approval.status` alone
 * selects what the card shows — pending draws Approve / Reject, every other status reads as a
 * record with its own sentence.
 *
 * The port of `server/src/pages/approval-detail.tsx`, element for element. The id the URL
 * names was already checked against this owner's listing before the document was served, so
 * the read's 404 (a row pruned in between, or a client-side navigation) is the only refusal
 * this can draw, and it draws it as the read's own sentence.
 */
export function ApprovalDetailPage(): ReactNode {
  useDocumentTitle("Approve request · personal-mcps");
  const api = useApi();
  const { id = "" } = useParams({ strict: false }) as { id?: string };
  const read = useQuery(approvalQuery(api, id));
  const now = Date.now();

  return (
    <AuthFrame
      foot={
        <>
          All requests: <Link to={paths.approvals}>Approvals dashboard</Link>
        </>
      }
    >
      <QueryState
        query={read}
        skeleton={
          <Card size="auth">
            <Skeleton rows={6} />
          </Card>
        }
      >
        {(data: ApprovalDetailRead) => <DetailCard approval={data.approval} now={now} />}
      </QueryState>
    </AuthFrame>
  );
}

/** The card itself: heading with the status badge, the identity and time rows, the
 *  arguments, the status's sentence, and — while it is still pending — the decision. */
function DetailCard({ approval, now }: { approval: DetailApproval; now: number }): ReactNode {
  const badge = detailBadge(approval.status);
  return (
    <Card size="auth">
      <div>
        <div className="flex items-center gap-2">
          <CardTitle render={<h1 />}>Approve this request?</CardTitle>
          <Badge variant={badge.tone}>{badge.label}</Badge>
        </div>
        <CardDescription>An agent wants to run an approval-gated tool.</CardDescription>
      </div>

      <KvList variant="block">
        <Kv k="Principal">
          <span className="font-mono">agent:{approval.agentSlug}</span>
        </Kv>
        <Kv k="App">{approval.appSlug}</Kv>
        <Kv k="Tool">
          <span className="font-mono">{approval.tool}</span>
        </Kv>
        {timeRows(approval, now).map((row) => (
          <Kv key={row.label} k={row.label}>
            {row.value}
          </Kv>
        ))}
      </KvList>

      <div className="flex flex-col gap-1.5">
        <div className="text-2xs font-medium tracking-[0.06em] text-muted-foreground uppercase">Arguments</div>
        <pre className="m-0 overflow-x-auto rounded-md bg-muted px-3.5 py-3 font-mono text-xs leading-[1.6] wrap-anywhere whitespace-pre-wrap text-fg-subtle">
          {formatArgs(approval.args)}
        </pre>
      </div>

      <p className="text-sm text-muted-foreground">{explanation(approval)}</p>

      {approval.status === "pending" ? <Decide approval={approval} /> : null}
    </Card>
  );
}

/** Reject and Approve, full width and side by side. A component of its own so the decision
 *  hook exists only while there is something to decide. */
function Decide({ approval }: { approval: DetailApproval }): ReactNode {
  const decide = useDecision(approval);
  return (
    <div className="flex flex-wrap justify-end gap-3">
      <Button type="button" variant="danger-outline" className="flex-1" disabled={decide.pending} onClick={() => decide.run("reject")}>
        Reject
      </Button>
      <Button type="button" className="flex-1" disabled={decide.pending} onClick={() => decide.run("approve")}>
        Approve
      </Button>
    </div>
  );
}
