/**
 * `/agents/<slug>/grant` — one card per ACTIVE app the agent holds nothing on, and Grant as
 * the step that opens that app's editor with nothing granted yet.
 *
 * A port of `pages/agent-detail.tsx`'s `GrantPane` / `GrantCard` and `model.ts`'s
 * `grantPaneView` / `grantEndpoints` / `countsText`.
 *
 * A card's endpoint list is a catalog read — three round trips to a live app — so it happens
 * for cards that need one only: the one `?show=` opens, and, while a search is running, every
 * card being searched, because searching endpoints is what searching endpoints costs. That is
 * the server's own rule, and it is why the reads live here in ONE `useQueries` rather than
 * inside each card: the heading counts how many cards a search kept, so the verdicts have to
 * be in the hands of the thing that draws the heading.
 */

import { Link } from "@tanstack/react-router";
import { useQueries } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useApi } from "@/lib/api-context";
import { appCatalogQuery } from "@/lib/queries";
import { paths } from "@/lib/paths";
import type { AppRow } from "@/lib/types";
import { effectiveRolesOf, reachabilityFor, ROLE_FAMILIES } from "../door";
import { itemProse, KIND_OF_FAMILY, subjectOf } from "../grant-editor";
import { statusOf } from "../derive";
import type { AgentPageData } from "../AgentFrame";
import { FilterForm } from "./FilterForm";

/** One endpoint of a grantable app, with the declared roles that grant it — read through the
 *  door, so `only via all or by name` is what the door actually says. */
type EndpointRow = {
  /** The family's singular word, as the entry prefix spells it. */
  family: string;
  name: string;
  description: string;
  roles: string[];
};

/** One card: the app, and whatever this render learned about its endpoints. */
type GrantCardView = {
  app: AppRow;
  /** Open cards show their endpoints; a closed one has read no catalog and says so by
   *  offering to. */
  open: boolean;
  /** `T tools · P prompts · R resources` over everything read, or "" for a closed card. */
  counts: string;
  /** The declared role names, which a closed card already knows from the app row. */
  roles: string[];
  /** What the card draws — every endpoint, or only the ones a search matched. */
  endpoints: EndpointRow[];
};

export function GrantPane({
  data,
  q,
  shown,
}: {
  data: AgentPageData;
  /** `?q=`, trimmed by the caller. */
  q: string;
  /** `?show=<app>` — the one card the owner opened. */
  shown: string;
}): ReactNode {
  const api = useApi();
  const agent = data.agent.slug;
  const needle = q.toLowerCase();
  const searching = needle !== "";

  // Which apps this render reads a catalog for, and the three reads each. One flat list, so
  // the queries are a function of the URL rather than of a card's own lifecycle.
  const reading = data.grantable.filter((app) => searching || app.slug === shown);
  const catalogs = useQueries({
    queries: reading.flatMap((app) =>
      ROLE_FAMILIES.map((family) => ({ ...appCatalogQuery(api, app.slug, family), retry: false })),
    ),
  });

  const endpointsOf = (app: AppRow): EndpointRow[] => {
    const at = reading.findIndex((each) => each.slug === app.slug);
    if (at < 0) return [];
    const declared = effectiveRolesOf(app);
    const doors = reachabilityFor(
      declared,
      Object.fromEntries(Object.keys(declared).map((role) => [role, [role]])),
    );
    const rows: EndpointRow[] = [];
    ROLE_FAMILIES.forEach((family, index) => {
      // A family that could not be read contributes nothing, exactly as the server's
      // `if (!answered.ok) continue` did: this card is an invitation, not an audit.
      const answer = catalogs[at * ROLE_FAMILIES.length + index]?.data;
      if (answer === undefined) return;
      for (const item of answer.items) {
        const name = subjectOf(item, family);
        rows.push({
          family: KIND_OF_FAMILY[family],
          name,
          // The PLAIN form: this line is a `title` and an `aria-label`, and an attribute
          // holds text and nothing else — a tooltip cannot carry a fence. It is also what
          // the search matches on.
          description: itemProse(item, family, answer.derived.find((each) => each.subject === name)).text,
          roles: doors.reach(name, family).map((each) => each.agent),
        });
      }
    });
    return rows;
  };

  const cards: GrantCardView[] = [];
  for (const app of data.grantable) {
    const endpoints = endpointsOf(app);
    const matches = (endpoint: EndpointRow): boolean =>
      endpoint.name.toLowerCase().includes(needle) || endpoint.description.toLowerCase().includes(needle);
    const matchedEndpoint = searching && endpoints.some(matches);
    const matchedApp =
      !searching ||
      app.slug.toLowerCase().includes(needle) ||
      app.name.toLowerCase().includes(needle) ||
      app.description.toLowerCase().includes(needle);
    if (!matchedApp && !matchedEndpoint) continue;
    // A search that matched INSIDE a card opens it: the match is in the endpoints, so hiding
    // them would hide the reason the card is there.
    const open = shown === app.slug || matchedEndpoint;
    cards.push({
      app,
      open,
      counts: open ? countsText(endpoints) : "",
      roles: Object.keys(effectiveRolesOf(app)),
      endpoints: open ? (matchedEndpoint ? endpoints.filter(matches) : endpoints) : [],
    });
  }
  const total = data.grantable.length;

  return (
    <div className="listing listing--wide">
      <div className="lh">
        <div className="title-row">
          <span className="listing-title">Grant another app</span>
          <span className="note">apps {agent} holds nothing on</span>
        </div>
        <FilterForm
          to={paths.agentPane(agent, "grant")}
          keep={shown === "" ? {} : { show: shown }}
          q={q}
          placeholder="search apps and endpoints…"
          label="Search"
        />
        <div className="sum">
          What each app does; open it to see every endpoint and which roles grant it. Grant opens the app with nothing
          granted yet.
        </div>
      </div>
      <div className="scroll">
        {total === 0 ? (
          <p className="note gh-state">
            {agent} already holds a grant on every active app. Archived apps are not listed; unarchive one to grant it.
          </p>
        ) : (
          <>
            <div className="gh">
              <span>Apps · {cards.length === total ? total : `${cards.length} of ${total}`}</span>
              <span className="gh-note">active, not archived · nothing is written until you save</span>
            </div>
            {cards.map((card) => (
              <GrantCard key={card.app.slug} card={card} agent={agent} q={q} />
            ))}
          </>
        )}
      </div>
    </div>
  );
}

/** `T tools · P prompts · R resources`, the empty families left out. */
function countsText(endpoints: EndpointRow[]): string {
  return ROLE_FAMILIES.map((family) => {
    const count = endpoints.filter((endpoint) => endpoint.family === KIND_OF_FAMILY[family]).length;
    return count === 0 ? null : `${count} ${family}`;
  })
    .filter((part): part is string => part !== null)
    .join(" · ");
}


function GrantCard({ card, agent, q }: { card: GrantCardView; agent: string; q: string }): ReactNode {
  const { app } = card;
  const status = statusOf(app);
  // The toggle is this pane's URL with `show=` set or dropped, keeping the filter — so
  // opening a card is a place, not a gesture.
  const toggleSearch: Record<string, string> = {
    ...(card.open ? {} : { show: app.slug }),
    ...(q === "" ? {} : { q }),
  };
  return (
    <div className="appcard">
      <div className="appcard-main">
        <div className="title-row">
          <span className="listing-title">{app.name}</span>
          <span className="badge badge--mono">{app.slug}</span>
          <span className="badge badge--mono">{app.kind}</span>
          {status === null ? null : <span className="badge badge--muted">{status}</span>}
        </div>
        {app.description === "" ? null : <div>{app.description}</div>}
        <div className="note">
          {card.counts === "" ? null : `${card.counts} · `}roles{" "}
          {card.roles.length === 0 ? "none" : card.roles.join(", ")} ·{" "}
          <Link to={paths.agentPane(agent, "grant")} search={toggleSearch}>
            {card.open ? "hide" : "show endpoints"}
          </Link>
        </div>
        {card.open ? (
          <div className="eps">
            {card.endpoints.map((endpoint) => (
              <div className="ep" key={`${endpoint.family}/${endpoint.name}`}>
                <div>
                  <span className="ep-family">{endpoint.family}</span>
                  <span className="mono">{endpoint.name}</span>
                  {endpoint.description === "" ? null : (
                    // An attribute holds text and nothing else — a `title` cannot carry a
                    // fence, so the app's Markdown rides here as the source it is.
                    <span className="ep-info" title={endpoint.description} aria-label={endpoint.description}>
                      i
                    </span>
                  )}
                </div>
                <div className="ep-roles">
                  {endpoint.roles.length === 0 ? (
                    <span className="muted">only via all or by name</span>
                  ) : (
                    endpoint.roles.map((role) => (
                      <span className="badge badge--mono" key={role}>
                        {role}
                      </span>
                    ))
                  )}
                </div>
              </div>
            ))}
          </div>
        ) : null}
      </div>
      <div className="appcard-end">
        <Link className="btn btn--primary btn--sm" to={paths.agentApp(agent, app.slug)}>
          Grant
        </Link>
      </div>
    </div>
  );
}
