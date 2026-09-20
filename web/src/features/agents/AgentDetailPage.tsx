/**
 * `/agents/<slug>` and `/agents/<slug>/<pane>` — the agent's page, whichever of its
 * single-segment panes the URL asked for, and the LANDING.
 *
 * A port of `pages/agent-detail.tsx`'s page component and the parts of `model.ts`'s
 * `agentDetailProps` that decide where the page is: the pane target, the rail, the dialogs
 * and §13's three narrow levels.
 *
 * ONE route component serves both URLs, because the landing is a RENDER of another pane and
 * not a redirect to it (§13's pane rule — an alias URL would be a second spelling of one
 * screen): `/agents/<slug>` draws the first app in slug order the agent holds a grant on, in
 * place, or the grant step when it holds none. Which is why `pane` is read with
 * `strict: false` and may be absent.
 */

import { useParams, useSearch } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useApi } from "@/lib/api-context";
import { approvalHistoryQuery, auditQuery } from "@/lib/queries";
import { AGENT_PANES, paths } from "@/lib/paths";
import type { AgentPane } from "@/lib/paths";
import { useDocumentTitle } from "@/chrome/Shell";
import { useFlash } from "@/chrome/Notice";
import {
  AgentFrame,
  AgentPageFailed,
  AgentPageNotFound,
  AgentPagePending,
  useAgentPage,
} from "./AgentFrame";
import type { AgentPageData } from "./AgentFrame";
import { AGENT_PANE_TITLE, agentLevelOf, agentRailOf, oneOf, readingState } from "./derive";
import type { AgentTarget } from "./derive";
import { AgentAppView } from "./AgentAppPage";
import { GrantPane } from "./panes/GrantPane";
import { CredentialsPane, credentialsSelectedName, tokenConfirmOf } from "./panes/CredentialsPane";
import { ActivityPane, activitySelectedName, callsShown } from "./panes/ActivityPane";
import { DangerPane } from "./panes/DangerPane";

/** How many pending-and-decided requests the Activity pane reads — the same page size the
 *  pane itself asks for, so the two reads are ONE cache entry. */
const ACTIVITY_REQUESTS = 50;

export function AgentDetailPage(): ReactNode {
  // `strict: false`, because this component serves a route with a `pane` segment and one
  // without: the landing has no pane of its own to name.
  const params = useParams({ strict: false }) as { slug?: string; pane?: string };
  const slug = params.slug ?? "";
  const search = useSearch({ strict: false }) as Record<string, string | string[] | undefined>;
  const api = useApi();
  const notice = useFlash(search);
  const page = useAgentPage(slug);
  useDocumentTitle(`${slug} · Agents · personal-mcps`);

  // Narrowed against §13's own table rather than trusted from the URL. A segment outside it
  // never reaches this component — the route redirects first — so this is the type's proof
  // and not a second gate.
  const pane: AgentPane | null =
    params.pane !== undefined && (AGENT_PANES as readonly string[]).includes(params.pane)
      ? (params.pane as AgentPane)
      : null;
  const sel = oneOf(search.sel);
  const calls = oneOf(search.calls);

  // The Activity pane's two reads, asked here as well so the LEVEL HEADER can name the row
  // the pane drew. Identical query keys, so these are the pane's own cache entries rather
  // than a second round trip — and they are gated to the pane that has them, so no other
  // pane pays for a read it does not draw.
  const onActivity = pane === "activity";
  const history = useQuery({ ...approvalHistoryQuery(api, ACTIVITY_REQUESTS), enabled: onActivity });
  const trail = useQuery({
    ...auditQuery(api, {
      principal: `agent:${slug}`,
      event: "tools/call",
      range: "7d",
      limit: String(callsShown(calls)),
    }),
    enabled: onActivity,
  });

  if (page.kind === "pending") return <AgentPagePending />;
  if (page.kind === "notFound") {
    return <AgentPageNotFound what={`There is no agent “${slug}” in this namespace.`} />;
  }
  if (page.kind === "failed") return <AgentPageFailed message={page.message} retry={page.retry} />;
  const data = page.data;

  // The landing pane, resolved before anything is built.
  const at: AgentTarget =
    pane !== null
      ? { pane }
      : data.held.length === 0
        ? { pane: "grant" }
        : { pane: "app", app: data.held[0] as string };

  // The landing on a granted app IS the app pane, drawn in place — so it is the same
  // component the `/agents/<slug>/apps/<app>` route renders, told that it is the landing.
  if (at.pane === "app") {
    return (
      <AgentAppView
        key={`${slug}/${at.app}`}
        data={data}
        app={at.app}
        landing={pane === null}
        notice={notice}
        refreshing={page.refreshing}
        search={search}
      />
    );
  }

  const rail = agentRailOf({
    slug,
    held: data.held,
    apps: data.byslug,
    grants: data.agent.grants,
    at,
    counts: {
      grantable: data.grantable.length,
      tokens: data.tokens.filter((token) => !token.expired).length,
      clients: data.clients.length,
      pending: data.pending.length,
    },
  });

  const requests = (history.data?.approvals ?? []).filter((row) => row.agentSlug === slug);
  const { level, levelHeader } = agentLevelOf({
    slug,
    landing: pane === null,
    paneTitle: AGENT_PANE_TITLE[at.pane],
    paneHref: { to: paths.agentPane(slug, at.pane), search: readingState(search) },
    selectedName:
      at.pane === "credentials"
        ? credentialsSelectedName(data, sel)
        : at.pane === "activity"
          ? activitySelectedName(sel, requests, trail.data?.page.rows ?? [])
          : null,
    hasSel: sel !== "",
  });

  return (
    <AgentFrame
      data={data}
      rail={rail}
      level={level}
      levelHeader={levelHeader}
      notice={notice}
      refreshing={page.refreshing}
    >
      <Pane data={data} at={at} search={search} sel={sel} calls={calls} />
    </AgentFrame>
  );
}

/**
 * Whichever of the three single-segment panes the URL named, plus the danger zone. Each
 * dialog belongs to the pane that draws its control, so the same `?confirm=` carried to
 * another pane opens nothing — and a token dialog naming no listed key opens nothing either.
 */
function Pane({
  data,
  at,
  search,
  sel,
  calls,
}: {
  data: AgentPageData;
  at: Exclude<AgentTarget, { pane: "app" }>;
  search: Record<string, string | string[] | undefined>;
  sel: string;
  calls: string;
}): ReactNode {
  const confirm = oneOf(search.confirm);
  if (at.pane === "grant") {
    return <GrantPane data={data} q={oneOf(search.q).trim()} shown={oneOf(search.show)} />;
  }
  if (at.pane === "credentials") {
    return (
      <CredentialsPane data={data} sel={sel} confirm={tokenConfirmOf(confirm, oneOf(search.id), data.tokens)} />
    );
  }
  if (at.pane === "activity") return <ActivityPane data={data} sel={sel} calls={calls} />;
  return <DangerPane data={data} confirming={confirm === "delete-agent"} />;
}
