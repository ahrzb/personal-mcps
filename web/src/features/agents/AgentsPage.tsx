/**
 * `/agents` — the list: one row per agent, the whole row a link to the agent page, and
 * Delete as the only row control. Granting lives on the agent page, so nothing here opens an
 * editor and nothing here reads a catalog.
 *
 * A port of `server/src/pages/agents.tsx` with its props builder's derivations
 * (`model.ts`'s `agentsProps` / `agentListRow` / `accessOf`) moved into `derive.ts` and
 * computed from the three reads the builder made: `agent_list`, `app_list` and `token_list`.
 *
 * The stretched anchor is kept: the row's link covers the row through `::after`
 * (`styles.css`), and the Delete cell sits above it so it still deletes. Delete stays behind
 * the list's own `?confirm=delete-agent&slug=` state — addressable exactly as /apps's is, so
 * a shared URL opens the same dialog and the state gallery can render it.
 */

import { Link, useSearch } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useApi } from "@/lib/api-context";
import { agentsQuery, appsQuery, keys, tokensQuery, useOp } from "@/lib/queries";
import { paths } from "@/lib/paths";
import { NoticeBanner, useFlash } from "@/chrome/Notice";
import { formatStamp } from "@/lib/format";
import { Shell, useDocumentTitle } from "@/chrome/Shell";
import { ConfirmDialog, useDropSearchKeys } from "@/chrome/Confirm";
import { QueryState, Skeleton } from "@/chrome/States";
import type { AgentsResponse, ListedAgent } from "@/lib/types";
import { accessOf, accessText, agentTokensOf, oneOf, tokensText } from "./derive";
import type { AgentAccess, AgentToken } from "./derive";

/** §13's Delete copy — the same sentence the list's footer and the danger zone carry. */
export const DELETE_AGENT_TEXT = "Deleting an agent deletes its tokens and removes its grants everywhere.";

/** The search keys the delete dialog is addressed by, dropped together when it closes. */
const CONFIRM_KEYS = ["confirm", "slug"];

/** One row of the list, with the two summary cells already read off the three reads. */
type AgentRow = {
  agent: ListedAgent;
  access: AgentAccess;
  tokens: AgentToken[];
};

export function AgentsPage(): ReactNode {
  useDocumentTitle("Agents · personal-mcps");
  const api = useApi();
  const search = useSearch({ strict: false }) as Record<string, string | string[] | undefined>;
  const dropKeys = useDropSearchKeys();
  const client = useQueryClient();
  // The op's subject is the row the dialog names, so a delete invalidates that agent's own
  // key beside the three lists.
  const remove = useOp<{ slug: string }>("agent_delete", { agent: oneOf(search.slug) });

  const agents = useQuery(agentsQuery(api));
  const apps = useQuery(appsQuery(api));
  const tokens = useQuery(tokensQuery(api));
  const notice = useFlash(search);
  const now = Date.now();

  const rowsOf = (data: AgentsResponse): AgentRow[] =>
    data.agents.map((agent) => ({
      agent,
      access: accessOf(agent.grants, apps.data?.apps ?? []),
      tokens: agentTokensOf(tokens.data?.tokens ?? [], agent.slug, now),
    }));

  // A `?confirm=` naming no row opens nothing: the dialog is about a row, and a guessed slug
  // names none — the same validation the loader did.
  const confirmed =
    oneOf(search.confirm) === "delete-agent"
      ? agents.data?.agents.find((agent) => agent.slug === oneOf(search.slug))
      : undefined;

  /**
   * Delete is OPTIMISTIC: the next state is fully known here — the row leaves the list — and
   * a rollback is meaningful, so the row goes at the click and comes back if the op refuses.
   * The refetch is what settles it either way.
   */
  const deleteAgent = (slug: string): void => {
    client.setQueryData<AgentsResponse>(keys.agents(), (held) =>
      held === undefined ? held : { agents: held.agents.filter((agent) => agent.slug !== slug) },
    );
    dropKeys(CONFIRM_KEYS);
    remove.mutate(
      { slug },
      {
        onError: () => {
          void client.invalidateQueries({ queryKey: keys.agents() });
        },
      },
    );
  };

  return (
    <Shell active="agents">
      <main className="page--table">
        {notice === null ? null : <NoticeBanner notice={notice} />}
        <div className="page-head">
          <div>
            <h1 className="page-title">Agents</h1>
            <p className="page-subtitle">Identities that call your apps — each holds grants and keys.</p>
          </div>
          <Link className="btn btn--primary" to={paths.agentNew}>
            New agent
          </Link>
        </div>

        {remove.isError ? (
          <div className="alert alert--danger" role="alert">
            {remove.error.message}
          </div>
        ) : null}

        <QueryState
          query={agents}
          skeleton={<Skeleton rows={4} />}
          empty={{
            when: (data) => data.agents.length === 0,
            render: (
              <div className="empty">
                <div className="empty-title">No agents yet.</div>
                <div className="empty-text">Create one to give an AI agent its own grants and keys.</div>
                <Link className="btn btn--primary" to={paths.agentNew}>
                  New agent
                </Link>
              </div>
            ),
          }}
        >
          {(data) =>
            // The two summary cells are functions of the other two reads, so the table waits
            // for them rather than printing `no grants` for an agent whose apps have simply
            // not arrived yet.
            apps.isPending || tokens.isPending ? (
              <Skeleton rows={4} />
            ) : (
              <div className="card">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Agent</th>
                      <th>Access</th>
                      <th>Tokens</th>
                      <th>Created</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {rowsOf(data).map((row) => (
                      <AgentRowView key={row.agent.slug} row={row} now={now} />
                    ))}
                  </tbody>
                </table>
              </div>
            )
          }
        </QueryState>
        <p className="note">{DELETE_AGENT_TEXT}</p>
      </main>
      {confirmed === undefined ? null : (
        <ConfirmDialog
          title={`Delete agent “${confirmed.slug}”?`}
          text={DELETE_AGENT_TEXT}
          onClose={() => dropKeys(CONFIRM_KEYS)}
        >
          <div className="actions">
            <button type="button" className="btn btn--ghost" onClick={() => dropKeys(CONFIRM_KEYS)}>
              Cancel
            </button>
            <button type="button" className="btn btn--danger" onClick={() => deleteAgent(confirmed.slug)}>
              Delete
            </button>
          </div>
        </ConfirmDialog>
      )}
    </Shell>
  );
}

function AgentRowView({ row, now }: { row: AgentRow; now: number }): ReactNode {
  const { agent } = row;
  return (
    <tr className="agent-row">
      <td>
        <div className="cell-name mono">
          {/* The row's link: stretched over the whole row by styles.css. */}
          <Link className="row-link" to={paths.agentDetail(agent.slug)}>
            {agent.slug}
          </Link>
        </div>
        {agent.description === "" ? null : <div className="list-meta">{agent.description}</div>}
      </td>
      <td className="cell-muted">{accessText(row.access)}</td>
      <td className="cell-muted">{tokensText(row.tokens, now)}</td>
      <td className="cell-muted">{formatStamp(agent.createdAt)}</td>
      <td className="cell-actions">
        {/* Delete never mutates directly — it opens this page with the confirm dialog. */}
        <Link
          className="btn btn--danger-outline btn--sm"
          to={paths.agents}
          search={{ confirm: "delete-agent", slug: agent.slug }}
        >
          Delete
        </Link>
        <span className="row-chevron">
          <Chevron />
        </span>
      </td>
    </tr>
  );
}

/** The chevron at the row's end — decoration for where the row goes; the anchor is the thing
 *  that goes there, so this is hidden from anyone listing the page's links. */
function Chevron(): ReactNode {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m9 6 6 6-6 6" />
    </svg>
  );
}
