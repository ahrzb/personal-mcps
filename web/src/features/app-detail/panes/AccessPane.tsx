/**
 * `/apps/<slug>/access` — which agents can call this app, and the grant editor for whichever
 * one `?sel=agent:<slug>` (or the confirm dialog's `?agent=`) names.
 *
 * A port of `server/src/pages/app-detail.tsx`'s Agents pane and `model.ts`'s `accessPane` /
 * `accessDetails`. §6 calls this pane "the agent page's grant editor, verbatim", and verbatim
 * is taken literally: the rows, the groups, the three-way control and the reach line are the
 * SHARED ones under `@/features/agents`, over the shared `grantEditorOf` builder, because two
 * copies of that editor would be two editors that drift. This file contributes only what is
 * this page's own — the listing of granted agents, the per-agent call count, the Remove
 * dialog, and where a row's `?sel=` points (at the AGENT page, whose details column is what
 * explains a role, a pattern or an item).
 *
 * The editor's state is the pair's WHOLE entry set as a `GrantDraft`, seeded from the stored
 * one. `grant_set` replaces that set, so there is no delta and no hidden carry: an entry no
 * row drew is still in the draft and still goes back on Save, which is what keeps a filtered
 * or unread family from dropping an undrawn literal. `"none"` contributes nothing, which is
 * how a row revokes, and `clear: true` is the Remove dialog — the same call with nothing to
 * compose.
 */

import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useSearch } from "@tanstack/react-router";
import { useApi } from "@/lib/api-context";
import { ApiError } from "@/lib/http";
import { paths } from "@/lib/paths";
import { auditQuery, useGrantEditor } from "@/lib/queries";
import type { AuditRow, ListedAgent, RoleDeclaration, RoleFamily, Violation } from "@/lib/types";
import { ConfirmDialog, useDropSearchKeys } from "@/chrome/Confirm";
import { KvList } from "@/chrome/Kv";
import {
  Details,
  DetailsBody,
  DetailsHead,
  Listing,
  ListingHead,
  ListingScroll,
  ListingTitle,
  ListRow,
  ListRowControl,
  ListRowDetail,
  SaveBar,
  SaveBarEnd,
  Sum,
} from "@/chrome/Listing";
import { TitleRow } from "@/chrome/Page";
import { QueryState, Refreshing, Skeleton } from "@/chrome/States";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { DialogFooter } from "@/components/ui/dialog";
import { usePreviewTransient } from "@/preview/transient";
import { GrantGroup, reachLine } from "@/features/agents/GrantRows";
import type { RowLink } from "@/features/agents/GrantRows";
import { draftOf, grantEditorOf } from "@/features/agents/grant-editor";
import type { GrantDraft } from "@/features/agents/grant-editor";
import { grantEntryOf, reachabilityFor } from "@/features/agents/door";
import type { AppPaneProps, FamilyView } from "@/features/app-detail/derive";
import { grantsOn, plural, searchValue, subjectsOf } from "@/features/app-detail/derive";

/** `PUT /apps/:slug/grants`' body. `entries` is the pair's WHOLE set, keyed by the stored
 *  entry string; `clear` is the Remove dialog and carries no entries at all. */
type GrantBody = {
  /** Which agent's set is being written — the app-side route takes it in the body, because
   *  the URL names the app. */
  agent: string;
  /** Remove every entry. The server composes nothing when it is set. */
  clear?: true;
  /** Stored entry string → its mode. `"none"` contributes nothing, which is the revoke. */
  entries?: GrantDraft;
};

/** A refused write as this pane holds it: the sentence, plus §8's field-scoped list where the
 *  op reported one. Held locally so the draft survives the refusal. */
type Refusal = { reason: string; violations?: Violation[] };

/** How far back the per-agent call count looks, and what a row's `· 7 d` means. */
const CALL_WINDOW_DAYS = 7;

/**
 * The Agents pane. Reads one thing of its own — the app's `tools/call` ledger over the call
 * window, for the `N calls` each row prints. Everything else arrives from `AppDetailPage`.
 */
export function AccessPane({ slug, views, refreshing, roles, agents, now }: AppPaneProps): ReactNode {
  const api = useApi();
  const search = useSearch({ strict: false });
  const dropKeys = useDropSearchKeys();
  const held = grantsOn(slug, agents);

  // ONE ledger read for the pane, not one per agent: the rows are counted client-side off the
  // same window. The server-rendered pane asked per agent because it held no answer to count
  // twice.
  const calls = useQuery(
    auditQuery(api, {
      app: slug,
      event: "tools/call",
      since: String(now - CALL_WINDOW_DAYS * 86_400_000),
      until: String(now),
    }),
  );
  const counts = useMemo(() => callsByAgent(calls.data?.page.rows ?? []), [calls.data]);

  const sel = searchValue(search, "sel");
  const named = sel.startsWith("agent:") ? sel.slice("agent:".length) : searchValue(search, "agent");
  // A `?sel=` or `?agent=` naming no granted agent selects nothing, exactly as the loader's
  // own validation did: the parameter is a pointer into a live set.
  const picked = held.agents.find((agent) => agent.slug === named) ?? null;
  const confirming = searchValue(search, "confirm") === "remove-agent" && picked !== null;

  if (roles === null) {
    return (
      <Listing>
        <ListingHead>
          <TitleRow>
            <ListingTitle render={<span />}>Agents</ListingTitle>
            <span className="max-w-[72ch] text-xs text-muted-foreground">who can call this app, and how</span>
          </TitleRow>
        </ListingHead>
        <ListingScroll>
          <Skeleton rows={4} />
        </ListingScroll>
      </Listing>
    );
  }

  return (
    <>
      <Listing>
        <ListingHead>
          <TitleRow>
            <ListingTitle render={<span />}>Agents</ListingTitle>
            <span className="max-w-[72ch] text-xs text-muted-foreground">who can call this app, and how</span>
            <Refreshing active={refreshing} />
          </TitleRow>
          <Sum>
            {`${plural(held.agents.length, "agent")} ${held.agents.length === 1 ? "holds" : "hold"} a grant · open one to edit its grant on ${slug}`}
          </Sum>
          {/* The ledger's five states, in ONE place rather than once per row: a per-row
              failure would draw the same alert as many times as there are agents, and the
              rows do not depend on it — they simply print no call count until it lands. */}
          <QueryState
            query={calls}
            skeleton={<span className="text-sm text-muted-foreground">counting calls…</span>}
            children={() => null}
          />
        </ListingHead>
        <ListingScroll>
          {held.agents.map((agent) => (
            <AgentRow
              key={agent.slug}
              slug={slug}
              agent={agent}
              effective={roles.effective}
              views={views}
              calls={calls.isSuccess ? (counts[agent.slug] ?? 0) : null}
            />
          ))}
          <p className="max-w-[72ch] p-4 text-xs text-muted-foreground">
            Granting a new agent starts from the agent's own page — <a href={paths.agents}>Agents</a> → the agent →
            Grant another app.
          </p>
        </ListingScroll>
      </Listing>
      {picked === null ? (
        <UnselectedDetails slug={slug} views={views} effective={roles.effective} grants={held.grants} />
      ) : (
        // Keyed to the (app, agent) pair, so a draft can never cross agents: a different
        // selection is a different editor, seeded from the set it belongs to.
        <GrantEditorPane
          key={`${slug}\u0000${picked.slug}`}
          slug={slug}
          agent={picked}
          effective={roles.effective}
          views={views}
          stored={held.grants[picked.slug] ?? []}
        />
      )}
      {confirming && picked !== null ? (
        <RemoveDialog slug={slug} agent={picked.slug} onClose={() => dropKeys(["confirm", "agent"])} />
      ) : null}
    </>
  );
}

/* ---------------------------------------------------------------- the listing --- */

/** One granted agent: what it holds, spelled both ways, and how far that reaches today. */
function AgentRow({
  slug,
  agent,
  effective,
  views,
  calls,
}: {
  slug: string;
  agent: ListedAgent;
  effective: RoleDeclaration;
  views: Record<RoleFamily, FamilyView>;
  /** The ledger's count over the window, or null while it is unread. */
  calls: number | null;
}): ReactNode {
  const stored = agent.grants[slug] ?? [];
  // The same builder the editor uses, over the agent's STORED set — the row's reach numbers
  // and the editor's reach line are then one computation asked twice, exactly as the
  // server-rendered pane asked it.
  const reach = grantEditorOf({
    app: slug,
    roles: effective,
    views,
    savedSpelled: stored,
    draft: draftOf(stored),
    q: "",
    offerPattern: false,
  }).reach;
  const entries = stored.map(grantEntryOf);
  const allowed = entries.filter((entry) => entry.mode === "allow");
  const askFirst = entries.filter((entry) => entry.mode === "approval");
  const parts = [`reaches ${reach.tools.reached} of ${reach.tools.total} tools`, `${reach.tools.approval} ask first`];
  if (reach.prompts.total > 0) parts.push(`${reach.prompts.reached} of ${reach.prompts.total} prompts`);
  if (reach.resources.total > 0) parts.push(`${reach.resources.reached} of ${reach.resources.total} resources`);
  if (calls !== null) parts.push(`${calls} calls`, `${CALL_WINDOW_DAYS} d`);
  return (
    <ListRow>
      <div>
        <Link className="font-mono after:absolute after:inset-0" to="." search={{ sel: `agent:${agent.slug}` }}>
          {agent.slug}
        </Link>{" "}
        <span className="max-w-[72ch] text-xs text-muted-foreground">{agent.description}</span>
        <ListRowDetail>
          <div>
            <span className="text-sm text-muted-foreground">allowed</span>{" "}
            {allowed.length === 0 ? (
              <span className="text-sm text-muted-foreground">—</span>
            ) : (
              allowed.map((entry) => (
                <Badge variant="mono" size="wrap" key={entry.entry}>
                  {entry.entry}
                </Badge>
              ))
            )}
          </div>
          <div>
            <span className="text-sm text-muted-foreground">ask first</span>{" "}
            {askFirst.length === 0 ? (
              <span className="text-sm text-muted-foreground">—</span>
            ) : (
              askFirst.map((entry) => (
                <Badge variant="warning" size="wrap" key={entry.entry}>
                  {entry.entry}
                </Badge>
              ))
            )}
          </div>
          <div>{parts.join(" · ")}</div>
        </ListRowDetail>
      </div>
      <ListRowControl />
    </ListRow>
  );
}

/** How many tools the unselected details names before deferring to the Catalog. */
const PER_TOOL_ROWS = 6;

/** The details column with no agent selected: which agents reach the first few tools, which is
 *  the one thing worth saying about the APP rather than about one grant. */
function UnselectedDetails({
  slug,
  views,
  effective,
  grants,
}: {
  slug: string;
  views: Record<RoleFamily, FamilyView>;
  effective: RoleDeclaration;
  /** Agent slug → its stored entries on this app: the whole-app door, so the card names every
   *  agent that reaches a tool and not just the selected one. */
  grants: Record<string, string[]>;
}): ReactNode {
  const door = reachabilityFor(effective, grants);
  const subjects = subjectsOf(views.tools);
  return (
    <Details>
      <DetailsHead>
        <div className="text-lg font-semibold">Agents</div>
        <p className="max-w-[72ch] text-xs text-muted-foreground">Select an agent to edit what it may call on {slug}.</p>
      </DetailsHead>
      <DetailsBody>
        <Card size="sm" render={<section />}>
          <div className="text-2xs font-medium tracking-[0.06em] text-muted-foreground uppercase">Per tool</div>
          <KvList>
            {subjects.slice(0, PER_TOOL_ROWS).map((subject) => {
              const reached = door.reach(subject, "tools");
              // A details pair, but keyed by the tool's own name at its natural width and in
              // the body colour, rather than `Kv`'s fixed muted key column.
              return (
                <div
                  className="flex items-baseline gap-3 text-xs [[data-level]_&]:max-lg:flex-col [[data-level]_&]:max-lg:items-start [[data-level]_&]:max-lg:gap-0.5"
                  key={subject}
                >
                  <span>{subject}</span>
                  <span className="min-w-0 wrap-anywhere">
                    {reached.length === 0
                      ? "no agent"
                      : reached.map((each) => `${each.agent}${each.mode === "approval" ? " (ask)" : ""}`).join(", ")}
                  </span>
                </div>
              );
            })}
          </KvList>
          {subjects.length <= PER_TOOL_ROWS ? null : (
            <p className="max-w-[72ch] text-xs text-muted-foreground">… {subjects.length - PER_TOOL_ROWS} more in the Catalog</p>
          )}
        </Card>
      </DetailsBody>
    </Details>
  );
}

/* ----------------------------------------------------------------- the editor --- */

function GrantEditorPane({
  slug,
  agent,
  effective,
  views,
  stored,
}: {
  slug: string;
  agent: ListedAgent;
  effective: RoleDeclaration;
  views: Record<RoleFamily, FamilyView>;
  /** The agent's stored entries on this app, in §8's wire spelling. */
  stored: string[];
}): ReactNode {
  const transient = usePreviewTransient();
  const save = useGrantEditor<GrantBody>({ app: slug, agent: agent.slug, from: "app" });
  const [refusal, setRefusal] = useState<Refusal | null>(() => transient.refusal ?? null);
  const [draft, setDraft] = useState<GrantDraft>(() => draftOf(stored));

  const editor = useMemo(
    () =>
      grantEditorOf({
        app: slug,
        roles: effective,
        views,
        savedSpelled: stored,
        draft,
        // No filter on this pane, so nothing to offer as a pattern either (§6).
        q: "",
        offerPattern: false,
      }),
    [slug, effective, views, stored, draft],
  );

  // A row's `?sel=` belongs to the AGENT page, whose details column explains a role, a pattern
  // or an item; here `sel` already names the agent being edited.
  const link: RowLink = (sel) => ({ to: paths.agentApp(agent.slug, slug), search: { sel } });

  return (
    <Details>
      <DetailsHead>
        <TitleRow>
          <span className="font-mono text-lg font-semibold">{agent.slug}</span>
          <Badge variant="muted">agent</Badge>
          {agent.description === "" ? null : (
            <span className="max-w-[72ch] text-xs text-muted-foreground">{agent.description}</span>
          )}
          {stored.length === 0 ? (
            <Badge variant="warning" className="border-dashed">
              new grant · nothing saved yet
            </Badge>
          ) : null}
          {/* `TitleRowEnd`'s placement, on the link itself rather than on a wrapper. */}
          <Link
            className="ml-auto [[data-level]_&]:max-lg:ml-0 [[data-level]_&]:max-lg:basis-full"
            to={paths.agentApp(agent.slug, slug)}
          >
            open agent page
          </Link>
        </TitleRow>
        <p className="max-w-[72ch] text-xs text-muted-foreground">
          {agent.slug}'s grant on {slug}. Solid: set on the row · hollow: implied by a role · a row cannot lower
          what a role grants.
        </p>
        <Sum>{reachLine(agent.slug, editor.reach)}</Sum>
      </DetailsHead>
      {refusal === null ? null : (
        <Alert variant="danger" role="alert">
          <AlertDescription>
            {refusal.reason}
            {(refusal.violations ?? []).map((each) => (
              <div key={`${each.field}:${each.reason}`}>
                <span className="font-mono">{each.field}</span> {each.reason}
              </div>
            ))}
          </AlertDescription>
        </Alert>
      )}
      {/* The editor's rows and its save bar, laid out as the details column's own children. */}
      <div className="contents">
        <ListingScroll>
          {editor.groups.map((group) => (
            <GrantGroup
              key={`${group.title}\u0000${group.count}`}
              group={group}
              link={link}
              onChoose={(entry, choice) => setDraft((current) => ({ ...current, [entry]: choice }))}
            />
          ))}
        </ListingScroll>
        <SaveBar>
          <Link
            className={buttonVariants({ variant: "danger-outline", size: "sm" })}
            to="."
            search={{ confirm: "remove-agent", agent: agent.slug }}
          >
            Remove {agent.slug}
          </Link>
          <SaveBarEnd render={<span />}>
            <Link className={buttonVariants({ variant: "ghost", size: "sm" })} to="." search={{}}>
              Discard
            </Link>
            <Button
              size="sm"
              disabled={save.isPending}
              onClick={() => {
                setRefusal(null);
                save.mutate(
                  { agent: agent.slug, entries: draft },
                  // A refusal stays HERE, field-scoped, with the draft on screen: the
                  // server-rendered page had to redraw the form from what was submitted, and
                  // a held draft is what makes that arm unnecessary.
                  { onError: (error) => setRefusal(refusalOf(error)) },
                );
              }}
            >
              Save
            </Button>
          </SaveBarEnd>
        </SaveBar>
      </div>
    </Details>
  );
}

/** The Remove dialog: the same editor call with nothing to compose, because `grant_set`
 *  replaces the pair's whole set and an empty one IS the removal. */
function RemoveDialog({
  slug,
  agent,
  onClose,
}: {
  slug: string;
  agent: string;
  onClose: () => void;
}): ReactNode {
  const save = useGrantEditor<GrantBody>({ app: slug, agent, from: "app" });
  return (
    <ConfirmDialog
      title={`Remove ${agent} from ${slug}?`}
      text={`${agent} loses every entry on ${slug}. History stays; a waiting request expires.`}
      onClose={onClose}
    >
      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="danger"
          disabled={save.isPending}
          onClick={() => save.mutate({ agent, clear: true }, { onSuccess: onClose })}
        >
          Remove
        </Button>
      </DialogFooter>
    </ConfirmDialog>
  );
}

/* ------------------------------------------------------------ the derivations --- */

/**
 * One page of the ledger counted per agent — the `N calls` each row prints.
 *
 * Counted over the rows the page RETURNED, which is what the server-rendered pane counted
 * too: `audit_query` answers rows and counts nothing, so a window busier than one page reads
 * as a floor rather than a total. The rows are this app's `tools/call` rows already, because
 * the query filtered on both, so the only reading left is which agent acted.
 */
function callsByAgent(rows: AuditRow[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of rows) {
    if (!row.principal.startsWith(AGENT_PRINCIPAL)) continue;
    const agent = row.principal.slice(AGENT_PRINCIPAL.length);
    counts[agent] = (counts[agent] ?? 0) + 1;
  }
  return counts;
}

/** How an agent is spelled in the ledger's `principal` column (§15). */
const AGENT_PRINCIPAL = "agent:";

/** A failed write as the editor renders it: an `ApiError` contributes §8's field list beside
 *  its sentence, and a transport failure contributes the sentence alone. */
function refusalOf(error: Error): Refusal {
  return error instanceof ApiError
    ? { reason: error.message, violations: error.violations }
    : { reason: error.message };
}
