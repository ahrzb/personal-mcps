import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useDocumentTitle } from "@/chrome/Shell";
import { QueryState, Skeleton } from "@/chrome/States";
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
 * CHROMELESS, as the server page was: no header and no nav, just the `.auth` column with the
 * brand, one card and the way back to the dashboard. `approval.status` alone selects what the
 * card shows — pending draws Approve / Reject, every other status reads as a record with its
 * own sentence.
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
    <div className="auth">
      <div className="brand">
        <BrandMark />
        <span>personal-mcps</span>
      </div>
      <QueryState
        query={read}
        skeleton={
          <div className="auth-card">
            <Skeleton rows={6} />
          </div>
        }
      >
        {(data: ApprovalDetailRead) => <DetailCard approval={data.approval} now={now} />}
      </QueryState>
      <p className="auth-foot">
        All requests: <Link to={paths.approvals}>Approvals dashboard</Link>
      </p>
    </div>
  );
}

/** The card itself: heading with the status badge, the identity and time rows, the
 *  arguments, the status's sentence, and — while it is still pending — the decision. */
function DetailCard({ approval, now }: { approval: DetailApproval; now: number }): ReactNode {
  const badge = detailBadge(approval.status);
  return (
    <div className="auth-card">
      <div>
        <div style={{ display: "flex", alignItems: "center", gap: "var(--space-4)" }}>
          <h1 className="card-title">Approve this request?</h1>
          <span className={`badge badge--${badge.tone}`}>{badge.label}</span>
        </div>
        <p className="card-desc">An agent wants to run an approval-gated tool.</p>
      </div>

      <div className="kv">
        <div className="kv-row">
          <span className="kv-key">Principal</span>
          <span className="mono">agent:{approval.agentSlug}</span>
        </div>
        <div className="kv-row">
          <span className="kv-key">App</span>
          <span>{approval.appSlug}</span>
        </div>
        <div className="kv-row">
          <span className="kv-key">Tool</span>
          <span className="mono">{approval.tool}</span>
        </div>
        {timeRows(approval, now).map((row) => (
          <div className="kv-row" key={row.label}>
            <span className="kv-key">{row.label}</span>
            <span>{row.value}</span>
          </div>
        ))}
      </div>

      <div className="field">
        <div className="eyebrow">Arguments</div>
        <pre className="code">{formatArgs(approval.args)}</pre>
      </div>

      <p className="muted">{explanation(approval)}</p>

      {approval.status === "pending" ? <Decide approval={approval} /> : null}
    </div>
  );
}

/** Reject and Approve, full width and side by side. A component of its own so the decision
 *  hook exists only while there is something to decide. */
function Decide({ approval }: { approval: DetailApproval }): ReactNode {
  const decide = useDecision(approval);
  return (
    <div className="actions">
      <button
        type="button"
        className="btn btn--danger-outline"
        style={{ flex: 1 }}
        disabled={decide.pending}
        onClick={() => decide.run("reject")}
      >
        Reject
      </button>
      <button
        type="button"
        className="btn btn--primary"
        style={{ flex: 1 }}
        disabled={decide.pending}
        onClick={() => decide.run("approve")}
      >
        Approve
      </button>
    </div>
  );
}

/** The hub mark from the artboards. Duplicated from the Shell, which does not export it and
 *  whose header this page deliberately does not render. */
const BrandMark = (): ReactNode => (
  <svg
    width="20"
    height="20"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    aria-hidden="true"
  >
    <circle cx="12" cy="12" r="3.5" />
    <path d="M12 8.5V3.5" />
    <path d="M14.5 14.5L18.5 18.5" />
    <path d="M9.5 14.5L5.5 18.5" />
  </svg>
);
