/**
 * `/agents/<slug>/apps/<app>` — one (agent × app) pair's grant editor, and the pane the
 * agent page's LANDING renders in place.
 *
 * A port of `pages/agent-detail.tsx`'s `AppPane` and `model.ts`'s `appPaneView` (`:2972`).
 * The rows come from the ONE builder both pages that edit a grant set call
 * (`grant-editor.ts`), so `/apps/<slug>/access` draws the same rows for the same pair — which
 * is what §6's "the agent page's grant editor, verbatim" means by construction rather than by
 * agreement.
 *
 * The whole pane is one DRAFT: the pair's entry set, held as UI state, written by every row's
 * control and PUT whole by Save — because `grant_set` replaces the pair's set, so the thing
 * being edited is the set and not a diff. That is what makes a filtered listing safe (a row
 * the filter hid is still in the draft) and an unread family's save harmless (so is every
 * literal in it).
 *
 * `null` renders as the page's own not-found, which is the document 404 the server answered:
 * an app that is not this owner's, the builtin (no agent may hold a grant on it, §8), and an
 * archived app the agent holds nothing on — an archived app it DOES hold something on stays
 * reachable, because the set has to remain editable after the app is shelved.
 */

import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import type { ReactNode } from "react";
import { useApi } from "@/lib/api-context";
import { appQuery, useGrantEditor } from "@/lib/queries";
import { ApiError } from "@/lib/http";
import { paths } from "@/lib/paths";
import { useDocumentTitle } from "@/chrome/Shell";
import { useFlash } from "@/chrome/Notice";
import { ConfirmDialog, useDropSearchKeys } from "@/chrome/Confirm";
import type { Notice } from "@/lib/notice";
import type { Violation } from "@/lib/types";
import { usePreviewTransient } from "@/preview/transient";
import {
  AgentFrame,
  AgentPageFailed,
  AgentPageNotFound,
  AgentPagePending,
  useAgentPage,
} from "./AgentFrame";
import type { AgentPageData } from "./AgentFrame";
import { agentLevelOf, agentRailOf, oneOf, readingState, statusOf } from "./derive";
import { draftOf, grantEditorOf, useGrantFamilies } from "./grant-editor";
import type { GrantDraft } from "./grant-editor";
import { effectiveRolesOf } from "./door";
import { GrantGroup, reachLine } from "./GrantRows";
import type { GrantChoice, RowLink } from "./GrantRows";
import { AppGrantDetails } from "./AppGrantDetails";
import { FilterForm } from "./panes/FilterForm";

/** What the Save PUT carries. `clear` is the Remove dialog: the same op with nothing to
 *  compose, which is how an empty set IS the removal. */
type GrantSave = { clear?: true; entries: GrantDraft };

export function AgentAppPage(): ReactNode {
  const params = useParams({ strict: false }) as { slug?: string; app?: string };
  const slug = params.slug ?? "";
  const app = params.app ?? "";
  const search = useSearch({ strict: false }) as Record<string, string | string[] | undefined>;
  const notice = useFlash(search);
  const page = useAgentPage(slug);
  useDocumentTitle(`${app} · ${slug} · Agents · personal-mcps`);

  if (page.kind === "pending") return <AgentPagePending />;
  if (page.kind === "notFound") {
    return <AgentPageNotFound what={`There is no agent “${slug}” in this namespace.`} />;
  }
  if (page.kind === "failed") return <AgentPageFailed message={page.message} retry={page.retry} />;
  return (
    // Keyed to the pair: the draft below is seeded from the stored set at MOUNT, and walking
    // the rail from one app to the next reuses this component — so without the key, app B's
    // editor would open holding app A's unsaved edits.
    <AgentAppView
      key={`${slug}/${app}`}
      data={page.data}
      app={app}
      landing={false}
      notice={notice}
      refreshing={page.refreshing}
      search={search}
    />
  );
}

/**
 * The page for one pair — the frame included, because the level header's title is the APP's
 * name and its level-3 title is the row this pane drew, neither of which the page around it
 * can know.
 *
 * `landing` is the one bit the URL cannot say for itself: `/agents/<slug>` renders this pane
 * for the first granted app, and that render is level 1 while the app's own URL is level 2.
 */
export function AgentAppView({
  data,
  app,
  landing,
  notice,
  refreshing,
  search,
}: {
  data: AgentPageData;
  app: string;
  landing: boolean;
  notice: Notice | null;
  refreshing: boolean;
  search: Record<string, string | string[] | undefined>;
}): ReactNode {
  const api = useApi();
  const agent = data.agent.slug;
  const navigate = useNavigate();
  const dropKeys = useDropSearchKeys();
  const transient = usePreviewTransient();

  const row = data.byslug.get(app);
  const savedSpelled = data.agent.grants[app] ?? [];
  // The three 404s, decided before anything is read: an app that is not this owner's or is
  // the builtin, and an archived app with nothing granted on it.
  const reachable = row !== undefined && row.kind !== "builtin" && !(row.archived && savedSpelled.length === 0);

  const families = useGrantFamilies(app, reachable);
  // `app_get`'s own row and §23.6's rendered diagnostics. The row is re-read here rather than
  // taken from the list for the reason the server re-read it: a successful tools listing
  // COMMITS generated reservations, so the identities this pane prints must come from a read
  // that saw them.
  const detail = useQuery({ ...appQuery(api, app), enabled: reachable });
  const save = useGrantEditor<GrantSave>({ app, agent, from: "agent" });
  // The draft is seeded from the stored set at mount and is the only thing the controls
  // write. Its identity is the (agent × app) pair, which the CALLER pins with a `key` — this
  // component holds no effect that would notice the pair changing under it.
  const [draft, setDraft] = useState<GrantDraft>(() => draftOf(savedSpelled));
  // A refused save, where this render IS one: the initial value only, read once.
  const [seeded] = useState(() => transient.refusal);

  if (!reachable || row === undefined) {
    return <AgentPageNotFound what={`${agent} has no grant to edit on “${app}”.`} />;
  }

  const q = oneOf(search.q).trim();
  const sel = oneOf(search.sel);
  const confirming = oneOf(search.confirm) === "remove-app";
  const current = detail.data?.app ?? row;
  const status = statusOf(current);
  const editor = grantEditorOf({
    app,
    roles: effectiveRolesOf(current),
    views: families.views,
    savedSpelled,
    draft,
    q,
    offerPattern: true,
  });

  const choose = (entry: string, choice: GrantChoice): void => setDraft({ ...draft, [entry]: choice });
  const base = paths.agentApp(agent, app);
  // A row's details are this page's own URL plus `?sel=`, the filter kept: picking a row does
  // not drop the listing the reader picked it from.
  const link: RowLink = (picked) => ({ to: base, search: { ...(q === "" ? {} : { q }), sel: picked } });

  const rail = agentRailOf({
    slug: agent,
    held: data.held,
    apps: data.byslug,
    grants: data.agent.grants,
    at: { pane: "app", app },
    counts: {
      grantable: data.grantable.length,
      tokens: data.tokens.filter((token) => !token.expired).length,
      clients: data.clients.length,
      pending: data.pending.length,
    },
  });
  const { level, levelHeader } = agentLevelOf({
    slug: agent,
    landing,
    paneTitle: current.name,
    paneHref: { to: base, search: readingState(search) },
    selectedName: selectedNameOf(sel),
    hasSel: sel !== "",
  });

  // The refusal the editor draws: this render's own, or the one the gallery seeded for a
  // state that IS a refused save. A refusal never navigates, so it is drawn beside the draft
  // that caused it either way.
  const refusal =
    save.error instanceof ApiError
      ? refusalText(save.error)
      : save.error?.message ?? (seeded === undefined ? null : refusalOf(seeded));

  return (
    <AgentFrame
      data={data}
      rail={rail}
      level={level}
      levelHeader={levelHeader}
      notice={notice}
      refreshing={refreshing || families.refreshing}
    >
      <div className="listing">
        <div className="lh">
          <div className="title-row">
            <span className="listing-title">{current.name}</span>
            <span className="badge badge--mono">{app}</span>
            <span className="badge badge--mono">{current.kind}</span>
            {status === null ? null : <span className="badge badge--muted">{status}</span>}
          </div>
          <div className="sum">
            {savedSpelled.length === 0 ? (
              <span className="badge badge--warning badge--dashed">new grant · nothing saved yet</span>
            ) : null}
            {reachLine(agent, editor.reach)}
          </div>
          {/* The filter is its own form and a navigation, for the reason the server gave it:
              `?q=` is the page's input, and a form cannot nest inside the editor below. */}
          <FilterForm to={base} keep={{}} q={q} placeholder="filter, or type a pattern…" label="Filter" />
        </div>

        {refusal === null ? null : (
          <div className="alert alert--danger" role="alert">
            <div className="alert-text">{refusal}</div>
          </div>
        )}

        {/* No `<form class="listing-form">` around the rows and the save row: the server
            needed one element to submit, and its own rule was `display: contents`, so the
            box tree here is the same one the sheet lays out. */}
        <div className="scroll">
          {editor.groups.map((group) => (
            <GrantGroup key={`${group.title}/${group.count}`} group={group} link={link} onChoose={choose} />
          ))}
          {editor.offer === null ? null : (
            <>
              <div className="gh">
                <span>As a pattern</span>
              </div>
              <div className="cr">
                <div>
                  <span className="mono">{editor.offer.entry}</span>
                  <div className="cr-detail">{editor.offer.detail}</div>
                </div>
                <div className="cr-control">
                  {/* Ask and Allow SAVE, as the server's two submit buttons did: accepting an
                      offer is a decision about the set, not a pending edit. */}
                  {(["approval", "allow"] as const).map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      className="btn btn--outline btn--sm"
                      disabled={save.isPending}
                      onClick={() => {
                        const entry = editor.offer?.entry;
                        if (entry === undefined) return;
                        const next = { ...draft, [entry]: mode };
                        setDraft(next);
                        save.mutate({ entries: next });
                      }}
                    >
                      {mode === "approval" ? "Ask" : "Allow"}
                    </button>
                  ))}
                </div>
              </div>
            </>
          )}
          {editor.nothingMatches ? <p className="note gh-state">Nothing matches “{q}”.</p> : null}
        </div>

        <div className="save">
          <button
            type="button"
            className="btn btn--danger-outline btn--sm"
            onClick={() => void navigate({ to: base, search: { ...(q === "" ? {} : { q }), confirm: "remove-app" } })}
          >
            Remove from {agent}
          </button>
          <span className="save-end">
            <span className="muted">
              saved · {editor.saved.allow} allow · {editor.saved.approval} ask
            </span>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => {
                setDraft(draftOf(savedSpelled));
                void navigate({ to: base, search: {} });
              }}
            >
              Discard
            </button>
            <button
              type="button"
              className="btn btn--primary btn--sm"
              disabled={save.isPending}
              onClick={() => save.mutate({ entries: draft })}
            >
              {save.isPending ? "Saving…" : "Save"}
            </button>
          </span>
        </div>
      </div>
      <AppGrantDetails
        agent={agent}
        agents={data.agents}
        row={current}
        kind={detail.data?.kind ?? (current.kind === "builtin" ? "tunnel" : current.kind)}
        app={app}
        editor={editor}
        views={families.views}
        diagnostics={detail.data?.diagnostics ?? []}
        sel={sel}
      />
      {confirming ? (
        <ConfirmDialog
          title={`Remove ${app} from ${agent}?`}
          text={`${agent} loses every entry on ${app}. History stays; a waiting request expires.`}
          onClose={() => dropKeys(["confirm"])}
        >
          <div className="actions">
            <button type="button" className="btn btn--ghost" onClick={() => dropKeys(["confirm"])}>
              Cancel
            </button>
            <button
              type="button"
              className="btn btn--danger"
              disabled={save.isPending}
              onClick={() =>
                save.mutate(
                  // The whole set, cleared: `grant_set` replaces it, so an empty one IS the
                  // removal — the same op Save posts, with nothing to compose.
                  { clear: true, entries: {} },
                  {
                    onSuccess: () => {
                      setDraft({});
                      void navigate({ to: paths.agentDetail(agent) });
                    },
                  },
                )
              }
            >
              Remove
            </button>
          </div>
        </ConfirmDialog>
      ) : null}
    </AgentFrame>
  );
}

/** The row `?sel=` named, as the level header says it: a catalog member by its own name, a
 *  role or a pattern by its entry — which is what the `<kind>:<name>` spelling already
 *  carries, so this reads the URL rather than the listing. A `sel` naming nothing falls back
 *  to the pane's title, which `agentLevelOf` does with null. */
function selectedNameOf(sel: string): string | null {
  const at = sel.indexOf(":");
  return at < 0 ? null : sel.slice(at + 1);
}

/** A refusal as the editor draws it: the reason, and every field-scoped sentence under it.
 *  The draft is untouched, so the row that caused it is still on screen to fix. */
function refusalOf(refusal: { reason: string; violations?: Violation[] }): string {
  const violations = refusal.violations ?? [];
  return violations.length === 0
    ? refusal.reason
    : `${refusal.reason} — ${violations.map((each) => `${each.field}: ${each.reason}`).join("; ")}`;
}

function refusalText(error: ApiError): string {
  return refusalOf({ reason: error.message, ...(error.violations === undefined ? {} : { violations: error.violations }) });
}
