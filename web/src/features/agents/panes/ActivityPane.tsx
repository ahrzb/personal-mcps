/**
 * `/agents/<slug>/activity` — every approval request this agent has made, and one page of
 * its own calls out of the ledger.
 *
 * A port of `pages/agent-detail.tsx`'s `ActivityPane` / `ApprovalRowView` / `ActivityDetails`
 * and `model.ts`'s `activityPaneView` (`:3740`) and `whyItWaits`. Both reads are the ops the
 * approvals page and the audit page make, filtered to this agent (§8: no second read path).
 *
 * The request list is NOT the pending one the rail counts: a decision has to stay on screen
 * after it is made, dimmed and badged, or pressing Approve would look like the request
 * vanished. `pending` below is what the heading counts and what the rail marks.
 *
 * Calls are paged by `?calls=`, one page at a time, and paging is a LINK — so every page of
 * the week is a URL somebody can come back to, which is the property the server's own walk
 * had.
 */

import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useApi } from "@/lib/api-context";
import { approvalHistoryQuery, auditQuery, useOp } from "@/lib/queries";
import { paths } from "@/lib/paths";
import { formatLastSeen, formatUntil } from "@/lib/format";
import { Skeleton } from "@/chrome/States";
// The explorer's pure module owns §13's three no-bodies sentences: "no bodies" has three
// causes, telling an owner the wrong one is worse than saying nothing, and two copies of the
// three would eventually be two answers to one question.
import { NO_BODIES_SENTENCE } from "@/features/audit/derive";
import type { ApprovalRow, AuditRow, NoBodiesReason } from "@/lib/types";
import { effectiveRolesOf, grantEntryOf, reachabilityFor, spelledOf } from "../door";
import type { AgentPageData } from "../AgentFrame";
import { Kv, KvList } from "@/chrome/Kv";
import {
  Details,
  DetailsBody,
  DetailsHead,
  GroupHead,
  GroupHeadNote,
  Listing,
  ListingHead,
  ListingMore,
  ListingScroll,
  ListingTitle,
  ListRow,
  ListRowControl,
  ListRowDetail,
  RowLink,
  Sum,
} from "@/chrome/Listing";
import { TitleRow, TitleRowEnd } from "@/chrome/Page";
import { Actions } from "@/chrome/Actions";
import { CodeBlock, Eyebrow, Muted, Note } from "@/chrome/Text";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

/** One page of Recent calls, and the step **Load 20 more** takes. */
const ACTIVITY_PAGE = 20;

/** How many pending-and-decided requests the pane keeps above the calls. Not paged: a
 *  namespace's approvals expire in an hour, so this list is short by design. */
const ACTIVITY_REQUESTS = 50;

/**
 * The window the pane claims and the read asks for. §15 keeps seven days, so the walk is
 * capped by the week rather than by any number this page picks — and it is spelled as the
 * audit API's own preset so the client sends no clock of its own.
 */
const ACTIVITY_RANGE = "7d";

/**
 * The ledger's outcome as a WORD. A row stores the JSON-RPC code §7 answered with, and a code
 * is not something a reader is owed — /audit says the same thing in its own shorter labels,
 * and this pane says it in the fuller ones §13 pins for an agent's own history.
 */
const OUTCOME_WORD: Record<string, string> = {
  ok: "ok",
  "-32003": "approval required",
  "-32002": "app archived",
  "-32001": "not permitted",
  "-32000": "app unavailable",
  error: "error",
};

/** §15's four refusal outcomes — a refusal never had bodies, whatever the app's setting. */
const REFUSAL_OUTCOMES = ["-32000", "-32001", "-32002", "-32003"];

/** `?calls=` as a page size: a positive multiple of `ACTIVITY_PAGE`, defaulting to one page.
 *  Anything else — a negative, a half-page, a word — is that default rather than a refusal:
 *  this is a read control on a URL, and an edited one should show the pane. */
export function callsShown(raw: string): number {
  const asked = Number(raw);
  return Number.isInteger(asked) && asked > 0 && asked % ACTIVITY_PAGE === 0 ? asked : ACTIVITY_PAGE;
}

export function ActivityPane({
  data,
  sel,
  calls: callsParam,
}: {
  data: AgentPageData;
  /** `?sel=approval:<id>` / `?sel=call:<id>`, or "". */
  sel: string;
  /** `?calls=`, verbatim. */
  calls: string;
}): ReactNode {
  const api = useApi();
  const agent = data.agent.slug;
  const shown = callsShown(callsParam);
  const decide = useOp<{ id: string; decision: "approve" | "reject" }>("approval_decide", { agent });

  // The requests: pending AND decided, which is why this is the history read rather than the
  // pending one the rail counts.
  const history = useQuery(approvalHistoryQuery(api, ACTIVITY_REQUESTS));
  const trail = useQuery(
    auditQuery(api, {
      principal: `agent:${agent}`,
      event: "tools/call",
      range: ACTIVITY_RANGE,
      limit: String(shown),
    }),
  );

  const requests = (history.data?.approvals ?? []).filter((row) => row.agentSlug === agent);
  const pending = requests.filter((row) => row.status === "pending").length;
  const rows = trail.data?.page.rows ?? [];
  const total = trail.data?.page.total ?? 0;
  const more = rows.length < total;
  const ok = rows.filter((row) => row.outcome === "ok").length;
  const denied = rows.filter((row) => row.outcome === "-32001").length;

  // Where this pane's window ends and the ledger's begins — named once, because the header
  // offers it and so does the foot of the walk.
  const auditHref = paths.audit({ principal: `agent:${agent}` });
  const selected = selectionOf(sel, requests, rows);

  return (
    <>
      <Listing>
        <ListingHead>
          <TitleRow split>
            <ListingTitle render={<span />}>Activity</ListingTitle>
            <Note render={<span />}>the last 7 days, the retention window</Note>
            {/* The window ends here and the ledger goes on: a control rather than a note,
                because leaving for the full trail is a thing the reader DOES. The link is the
                row's end itself rather than a box around it, so on a page with levels below
                1024px the button spans the line. */}
            <TitleRowEnd
              render={<a className={buttonVariants({ variant: "outline", size: "sm" })} href={auditHref} title={auditHref} />}
            >
              Open in Audit
              <IconExternal />
            </TitleRowEnd>
          </TitleRow>
          {/* `last N` rather than `N`: N is what this page drew, and a bare count would read
              as the week's total. */}
          <Sum>
            last {rows.length} calls · {ok} ok · {denied} denied · {pending} awaiting approval
          </Sum>
        </ListingHead>
        <ListingScroll>
          <GroupHead>
            <span>Awaiting approval · {pending}</span>
            <GroupHeadNote render={<span />}>each expires an hour after it was asked</GroupHeadNote>
          </GroupHead>
          {history.isPending ? <Skeleton rows={2} /> : null}
          {requests.map((row) => (
            <ApprovalRowView
              key={row.id}
              row={row}
              agent={agent}
              now={data.now}
              onDecide={(decision) => decide.mutate({ id: row.id, decision })}
              deciding={decide.isPending}
            />
          ))}
          <GroupHead>
            <span>Recent calls · {rows.length}</span>
            <GroupHeadNote render={<span />}>newest first</GroupHeadNote>
          </GroupHead>
          {trail.isPending ? <Skeleton rows={3} /> : null}
          {rows.map((row) => (
            <CallRow key={row.id} row={row} agent={agent} now={data.now} />
          ))}
          {/* The walk's own foot: a link, never a script — and it always says something,
              because "the list stopped" and "the week stopped" are different facts and only
              one of them is the end. */}
          <ListingMore>
            {more ? (
              <>
                <Link
                  to={paths.agentPane(agent, "activity")}
                  search={{
                    calls: String(shown + ACTIVITY_PAGE),
                    // `sel` rides along so walking back through the week does not close the
                    // row the reader is reading.
                    ...(sel === "" ? {} : { sel }),
                  }}
                >
                  Load {ACTIVITY_PAGE} more
                </Link>
                <Note render={<span />}>
                  more older calls in the last 7 days · everything before that is in{" "}
                  <a href={auditHref}>Audit</a>
                </Note>
              </>
            ) : (
              <Note render={<span />}>
                That is the whole week — older calls are in <a href={auditHref}>Audit</a>.
              </Note>
            )}
          </ListingMore>
        </ListingScroll>
      </Listing>
      <ActivityDetails
        data={data}
        selected={selected}
        onDecide={(id, decision) => decide.mutate({ id, decision })}
        deciding={decide.isPending}
        summary={{ calls: rows.length, ok, denied, pending }}
      />
    </>
  );
}

/** What `?sel=` picked: a request, a drawn call, or nothing. A `sel` naming a row the listing
 *  did not draw falls back to the summary — the probe past the end of a page is not a row the
 *  reader saw. */
type ActivitySelection =
  | { kind: "approval"; row: ApprovalRow }
  | { kind: "call"; row: AuditRow }
  | { kind: "none" };

function selectionOf(sel: string, requests: ApprovalRow[], rows: AuditRow[]): ActivitySelection {
  if (sel.startsWith("approval:")) {
    const row = requests.find((each) => each.id === sel.slice(9));
    return row === undefined ? { kind: "none" } : { kind: "approval", row };
  }
  if (sel.startsWith("call:")) {
    const row = rows.find((each) => String(each.id) === sel.slice(5));
    return row === undefined ? { kind: "none" } : { kind: "call", row };
  }
  return { kind: "none" };
}

/** The row `?sel=` picked, as the level header names it — both kinds are named by their
 *  tool, which is what the row itself is titled with. */
export function activitySelectedName(sel: string, requests: ApprovalRow[], rows: AuditRow[]): string | null {
  const selected = selectionOf(sel, requests, rows);
  return selected.kind === "none" ? null : selected.row.tool ?? null;
}

/**
 * One request. A decided one stays listed — dimmed, wearing its status instead of the two
 * buttons — because the row is the evidence that the decision landed; dropping it would read
 * as the request having disappeared.
 */
function ApprovalRowView({
  row,
  agent,
  now,
  onDecide,
  deciding,
}: {
  row: ApprovalRow;
  agent: string;
  now: number;
  onDecide: (decision: "approve" | "reject") => void;
  deciding: boolean;
}): ReactNode {
  return (
    <ListRow dim={row.status !== "pending"}>
      <div>
        <Muted className="font-mono">{row.appSlug}</Muted>{" "}
        <RowLink
          className="font-mono"
          render={<Link to={paths.agentPane(agent, "activity")} search={{ sel: `approval:${row.id}` }} />}
        >
          {row.tool}
        </RowLink>
        <ListRowDetail className="font-mono">{JSON.stringify(row.args)}</ListRowDetail>
      </div>
      <ListRowControl>
        <Muted>{formatLastSeen(Date.parse(row.createdAt), now)}</Muted>
        {row.status === "pending" ? (
          <>
            <Button variant="outline" size="sm" disabled={deciding} onClick={() => onDecide("reject")}>
              Reject
            </Button>
            <Button size="sm" disabled={deciding} onClick={() => onDecide("approve")}>
              Approve
            </Button>
          </>
        ) : (
          <Badge variant={row.status === "approved" || row.status === "used" ? "success" : "muted"}>{row.status}</Badge>
        )}
      </ListRowControl>
    </ListRow>
  );
}

function CallRow({ row, agent, now }: { row: AuditRow; agent: string; now: number }): ReactNode {
  return (
    <ListRow>
      <div>
        <Muted className="font-mono">{row.app ?? ""}</Muted>{" "}
        <RowLink
          className="font-mono"
          render={<Link to={paths.agentPane(agent, "activity")} search={{ sel: `call:${row.id}` }} />}
        >
          {row.tool ?? ""}
        </RowLink>
        <ListRowDetail>
          {formatLastSeen(row.ts, now)}
          {row.durationMs === undefined ? "" : ` · ${row.durationMs} ms`}
        </ListRowDetail>
      </div>
      <ListRowControl>
        <Badge variant={outcomeVariant(row.outcome)}>{OUTCOME_WORD[row.outcome] ?? "error"}</Badge>
      </ListRowControl>
    </ListRow>
  );
}

/** A call's outcome word as a badge — green for the one that ran, amber for the one the owner
 *  can still act on, red for everything the door refused. */
function outcomeVariant(outcome: string): "success" | "warning" | "danger" {
  if (outcome === "ok") return "success";
  if (outcome === "-32003") return "warning";
  return "danger";
}

function ActivityDetails({
  data,
  selected,
  onDecide,
  deciding,
  summary,
}: {
  data: AgentPageData;
  selected: ActivitySelection;
  onDecide: (id: string, decision: "approve" | "reject") => void;
  deciding: boolean;
  summary: { calls: number; ok: number; denied: number; pending: number };
}): ReactNode {
  const agent = data.agent.slug;
  if (selected.kind === "approval") {
    const row = selected.row;
    const why = whyItWaits(data, row);
    return (
      <Details>
        <DetailsHead>
          <TitleRow>
            <ListingTitle render={<span />} className="font-mono">{row.tool}</ListingTitle>
            <Badge variant="warning">{row.status}</Badge>
          </TitleRow>
          <Note>
            {agent} wants to call this on <span className="font-mono">{row.appSlug}</span> · asked{" "}
            {formatLastSeen(Date.parse(row.createdAt), data.now)} · expires in{" "}
            {formatUntil(Date.parse(row.expiresAt), data.now)}
          </Note>
        </DetailsHead>
        <DetailsBody>
          <Card size="sm" render={<section />}>
            <Eyebrow>Arguments · post-redaction</Eyebrow>
            <CodeBlock>{JSON.stringify(row.args)}</CodeBlock>
          </Card>
          {why === null ? null : (
            <Card size="sm" render={<section />}>
              <Eyebrow>Why it waits</Eyebrow>
              <KvList>
                <Kv k="Grant">{why}</Kv>
              </KvList>
            </Card>
          )}
          <Actions start grow>
            <Button variant="outline" size="sm" disabled={deciding} onClick={() => onDecide(row.id, "reject")}>
              Reject
            </Button>
            <Button size="sm" disabled={deciding} onClick={() => onDecide(row.id, "approve")}>
              Approve
            </Button>
          </Actions>
        </DetailsBody>
      </Details>
    );
  }
  if (selected.kind === "call") {
    const row = selected.row;
    const noBodies = noBodiesReason(row, data.byslug);
    return (
      <Details>
        <DetailsHead>
          <TitleRow>
            <ListingTitle render={<span />} className="font-mono">{row.tool ?? ""}</ListingTitle>
            <Badge variant={outcomeVariant(row.outcome)}>{OUTCOME_WORD[row.outcome] ?? "error"}</Badge>
          </TitleRow>
          <Note>
            <span className="font-mono">{row.app ?? ""}</span> · {formatLastSeen(row.ts, data.now)}
            {row.durationMs === undefined ? "" : ` · ${row.durationMs} ms`}
          </Note>
        </DetailsHead>
        <DetailsBody>
          {noBodies === null ? null : (
            <Card size="sm" render={<section />}>
              <Note>{NO_BODIES_SENTENCE[noBodies]}</Note>
            </Card>
          )}
          {row.args === undefined ? null : (
            <Card size="sm" render={<section />}>
              <Eyebrow>Arguments</Eyebrow>
              <CodeBlock>{JSON.stringify(row.args, null, 2)}</CodeBlock>
            </Card>
          )}
          {row.result === undefined ? null : (
            <Card size="sm" render={<section />}>
              <Eyebrow>Result</Eyebrow>
              <CodeBlock>{JSON.stringify(row.result, null, 2)}</CodeBlock>
            </Card>
          )}
          <Note>
            The same row the audit page shows.{" "}
            {/* The fragment names no element on the explorer and is inert rather than broken
                (§13, 2026-09-21); it stays because the shape is a deep link somebody has
                bookmarked, and `?expand=` is what opens the record. */}
            <a href={`${paths.audit({ expand: String(row.id) })}#event-${row.id}`}>Open in the audit trail</a>.
          </Note>
        </DetailsBody>
      </Details>
    );
  }
  return (
    <Details>
      <DetailsHead>
        <ListingTitle>Activity</ListingTitle>
        <Note>Select a request or a call for its details.</Note>
      </DetailsHead>
      <DetailsBody>
        <Card size="sm" render={<section />}>
          <Eyebrow>7 days</Eyebrow>
          <KvList>
            <Kv k="Calls">
              {summary.calls} · {summary.ok} ok
            </Kv>
            <Kv k="Denied">{summary.denied}</Kv>
            <Kv k="Awaiting approval">{summary.pending}</Kv>
          </KvList>
        </Card>
      </DetailsBody>
    </Details>
  );
}

/**
 * Why this row shows no bodies, or null when it has some or could never have had any. The
 * refusal check comes first for the reason §15 gives it: several refusals happen before any
 * redaction map exists, so no setting could have made bodies appear.
 */
function noBodiesReason(row: AuditRow, apps: AgentPageData["byslug"]): NoBodiesReason | null {
  if (row.args !== undefined || row.result !== undefined) return null;
  if (REFUSAL_OUTCOMES.includes(row.outcome)) return "refused";
  return row.app !== undefined && apps.get(row.app)?.logBodies === false ? "off" : "unrecorded";
}

/** Which granted entry put this request in the queue: the one that matches the tool in
 *  approval mode. Null where the set has since changed and none does. */
function whyItWaits(data: AgentPageData, approval: ApprovalRow): string | null {
  const app = data.byslug.get(approval.appSlug);
  if (app === undefined || app.kind === "builtin") return null;
  const held = (data.agent.grants[approval.appSlug] ?? []).map(grantEntryOf);
  const doors = reachabilityFor(
    effectiveRolesOf(app),
    Object.fromEntries(held.map((entry) => [entry.entry, [spelledOf(entry)]])),
  );
  const matched = doors.reach(approval.tool, "tools").find((each) => each.mode === "approval");
  return matched === undefined ? null : `${matched.agent} is in Ask first on ${approval.appSlug}`;
}

/** The arrow that marks a link leaving this page for another — decoration beside words that
 *  already say where it goes, so it is hidden from anyone listing the page's links. */
function IconExternal(): ReactNode {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M7 17 17 7" />
      <path d="M7 7h10v10" />
    </svg>
  );
}
