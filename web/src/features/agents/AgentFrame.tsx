/**
 * `/agents/<slug>`'s five reads and the chrome every one of its panes renders inside.
 *
 * ONE component draws the header, the rail and whichever pane the URL asked for, because §13
 * makes them one page: the rail's markers are read from the same data the pane is, so they
 * cannot disagree with it. That is why the reads live in a hook the two route components
 * share — `AgentDetailPage` (the landing and the four single-segment panes) and
 * `AgentAppPage` (one app's grant editor) — rather than in either of them.
 *
 * A port of `server/src/pages/model.ts`'s `agentDetailProps` (`:2693`) and the frame of
 * `pages/agent-detail.tsx`. The server's five reads were `agent_list`, `app_list`,
 * `token_list`, `connection_list` and `approval_list`; the first and fourth arrive together
 * here, because `/api/hub/agents/:slug` answers the agent, every agent and the connections in
 * one resource.
 */

import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useApi } from "@/lib/api-context";
import { agentQuery, appsQuery, pendingApprovalsQuery, tokensQuery } from "@/lib/queries";
import { ApiError } from "@/lib/http";
import { paths } from "@/lib/paths";
import { formatStamp } from "@/lib/format";
import type { Notice } from "@/lib/notice";
import { NoticeBanner } from "@/chrome/Notice";
import { Shell } from "@/chrome/Shell";
import { LevelHeader, PaneRail, paneGroups } from "@/chrome/Panes";
import type { LevelHeaderModel, PaneEntry } from "@/chrome/Panes";
import { Failure, Refreshing, Skeleton } from "@/chrome/States";
import type { AppRow, ApprovalRow, ListedAgent } from "@/lib/types";
import {
  accessOf,
  agentClientsOf,
  agentTokensOf,
  grantableAppsOf,
  heldAppsOf,
} from "./derive";
import type { AgentAccess, AgentClient, AgentToken } from "./derive";

/** The accessible name of this page's pane navigation. The pill row every OTHER paned page
 *  draws below the breakpoint is deliberately absent here: this page's narrow level 1 is the
 *  rail itself, as a list, which is the same destinations said once. */
const RAIL_NAV_LABEL = "Agent panes";

/** Everything every pane of the agent page reads, derived once. */
export type AgentPageData = {
  agent: ListedAgent;
  /** Every agent in the namespace — the "Reachable by" line asks the door for all of them. */
  agents: ListedAgent[];
  apps: AppRow[];
  /** The same list keyed by slug, which is how the rail and the panes ask about one app. */
  byslug: Map<string, AppRow>;
  /** The apps the agent holds at least one entry on, in slug order. */
  held: string[];
  /** The ACTIVE apps it holds nothing on — the grant step's cards, and its rail count. */
  grantable: AppRow[];
  /** Its live keys, newest first, expired ones marked. */
  tokens: AgentToken[];
  clients: AgentClient[];
  /** This agent's PENDING approvals — the rail's Activity marker, which is the very list the
   *  Activity pane draws above its decided rows. */
  pending: ApprovalRow[];
  /** The four header totals over the whole holding. */
  tiles: AgentAccess;
  /** The render instant, so a frozen preview clock reaches every pane. */
  now: number;
};

/**
 * What the page is: still reading, this owner's agent with everything it needs, an agent that
 * is not this owner's (the SSR page's document 404), or a read that failed and can be tried
 * again.
 */
export type AgentPageState =
  | { kind: "pending" }
  | { kind: "notFound" }
  | { kind: "failed"; message: string; retry: () => void }
  | { kind: "ready"; data: AgentPageData; refreshing: boolean };

export function useAgentPage(slug: string): AgentPageState {
  const api = useApi();
  const agent = useQuery(agentQuery(api, slug));
  const apps = useQuery(appsQuery(api));
  const tokens = useQuery(tokensQuery(api));
  const pending = useQuery(pendingApprovalsQuery(api));

  // A 404 is the answer, not a failure: the slug is not this owner's, which is the one thing
  // the page renders instead of itself.
  if (agent.isError && agent.error instanceof ApiError && agent.error.status === 404) {
    return { kind: "notFound" };
  }
  const failed = [agent, apps, tokens, pending].find((query) => query.isError);
  if (failed !== undefined) {
    return {
      kind: "failed",
      message: (failed.error as Error).message,
      retry: () => {
        void agent.refetch();
        void apps.refetch();
        void tokens.refetch();
        void pending.refetch();
      },
    };
  }
  if (
    agent.data === undefined ||
    apps.data === undefined ||
    tokens.data === undefined ||
    pending.data === undefined
  ) {
    return { kind: "pending" };
  }

  const now = Date.now();
  const row = agent.data.agent;
  return {
    kind: "ready",
    refreshing: [agent, apps, tokens, pending].some((query) => query.isFetching && !query.isPending),
    data: {
      agent: row,
      agents: agent.data.agents,
      apps: apps.data.apps,
      byslug: new Map(apps.data.apps.map((app) => [app.slug, app])),
      held: heldAppsOf(row),
      grantable: grantableAppsOf(row, apps.data.apps),
      tokens: agentTokensOf(tokens.data.tokens, slug, now),
      clients: agentClientsOf(agent.data.connections, slug),
      pending: pending.data.approvals.filter((approval) => approval.agentSlug === slug),
      tiles: accessOf(row.grants, apps.data.apps),
      now,
    },
  };
}

/**
 * The page around a pane: the breadcrumb, the header and its four totals, the narrow level
 * header, the rail, and the pane itself.
 *
 * `--framed`: on THIS page the rail is a column of the three-pane box rather than a list
 * standing beside a card — /settings and /apps/<slug> keep the unframed shape.
 */
export function AgentFrame({
  data,
  rail,
  level,
  levelHeader,
  notice,
  refreshing,
  children,
}: {
  data: AgentPageData;
  rail: PaneEntry[];
  /** §13's narrow level, read by the narrow stylesheet ALONE. */
  level: 1 | 2 | 3;
  levelHeader: LevelHeaderModel;
  notice: Notice | null;
  /** A background re-read behind data already on screen, shown beside the header. */
  refreshing: boolean;
  children: ReactNode;
}): ReactNode {
  const { agent, tiles } = data;
  return (
    <Shell active="agents">
      <main className="page--workspace" data-level={String(level)}>
        <LevelHeader header={levelHeader} />
        <div className="page-head">
          <div>
            {/* ONE row: where the page sits, what it is, and what it is for. The pane the URL
                names is already the entry the rail marks, so neither the app nor the pane is
                repeated up here. */}
            <div className="title-row">
              <Link className="crumb" to={paths.agents}>
                Agents
              </Link>
              <span className="crumb-sep" aria-hidden="true">
                ›
              </span>
              <h1 className="page-title mono">{agent.slug}</h1>
              {agent.description === "" ? null : <span className="page-subtitle">{agent.description}</span>}
              <Refreshing active={refreshing} />
            </div>
            {agent.name === agent.slug ? null : <p className="page-subtitle">{agent.name}</p>}
            <p className="page-subtitle">Created {formatStamp(agent.createdAt)}</p>
          </div>
          {/* ONE line, the parts separated by the hub's own middot — four tiles side by side
              would read as four independent facts rather than one partition. */}
          <div className="tiles">
            {`${tiles.apps} apps · ${tiles.allowed} allow · ${tiles.askFirst} ask first · ${tiles.dormant} dormant`}
          </div>
        </div>

        {/* After the header, not before it: this page's alert sits between the title block
            and the three-pane box, which is where `pages/agent-detail.tsx` drew it. */}
        {notice === null ? null : <NoticeBanner notice={notice} />}

        <div className="paned paned--framed">
          <PaneRail label={RAIL_NAV_LABEL} groups={paneGroups(rail)} />
          <div className="pane pane--split">{children}</div>
        </div>
      </main>
    </Shell>
  );
}

/** The page while its five reads are in flight: the frame cannot be drawn yet, because the
 *  header's totals and the rail's entries are all read from them. */
export function AgentPagePending(): ReactNode {
  return (
    <Shell active="agents">
      <main className="page--workspace" data-level="2">
        <div className="page-head">
          <div>
            <h1 className="page-title mono">…</h1>
          </div>
        </div>
        <Skeleton rows={8} />
      </main>
    </Shell>
  );
}

/** A read that failed for a reason the owner can retry. */
export function AgentPageFailed({ message, retry }: { message: string; retry: () => void }): ReactNode {
  return (
    <Shell active="agents">
      <main className="page--table">
        <Failure message={message} onRetry={retry} />
      </main>
    </Shell>
  );
}

/**
 * The page's own not-found — an agent that is not this owner's, an app that is not either,
 * and an archived app the agent holds nothing on. The server answered a document 404 for all
 * three; the client is already inside its own document, so it says the same thing where the
 * page would have been.
 */
export function AgentPageNotFound({ what }: { what: string }): ReactNode {
  return (
    <Shell active="agents">
      <main className="page--document">
        <div className="empty">
          <div className="empty-title">No such page</div>
          <div className="empty-text">{what}</div>
          <Link className="btn btn--primary" to={paths.agents}>
            Back to Agents
          </Link>
        </div>
      </main>
    </Shell>
  );
}
