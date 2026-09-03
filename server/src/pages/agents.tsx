/**
 * /agents — §13's list (2026-09-03, roadmap step 9; the `Agents` board): every agent with
 * its grants per app and its live keys, New agent, and Delete behind the list's own
 * confirm dialog (`?confirm=delete-agent&slug=`), which is addressable state exactly as
 * /apps's is — it works with scripting off and a fixture can render it.
 *
 * Reads through agent_list and token_list only; the one mutation here is agent_delete,
 * through the generic dispatch, landing back on this list with the notice.
 */

import type { FC } from "hono/jsx";
import { ConfirmShell, Layout } from "./layout";
import { paths, type AgentRow, type AgentsConfirm, type AgentsProps } from "./model";
import { alertClass, formatLastSeen, formatStamp } from "./format";

const DIALOG_ID = "confirm-delete-agent";

/** §13's Delete copy — the same sentence the list's footer and the agent page carry. */
export const DELETE_AGENT_TEXT = "Deleting an agent deletes its tokens and removes its grants everywhere.";

/** `<app>: role, role` per app, in slug order, or `none` (§13). */
const GrantsCell: FC<{ row: AgentRow }> = ({ row }) =>
  row.grants.length === 0 ? (
    <span class="muted">none</span>
  ) : (
    <div class="stack-tight">
      {row.grants.map((grant) => (
        <div>
          <span class="mono">{grant.app}</span>: {grant.roles.join(", ")}
        </div>
      ))}
    </div>
  );

/** `N active · used <relative>` / `N active · never used` / `none` (§13). */
function tokensCell(row: AgentRow, now: string): string {
  if (row.tokens.active === 0) return "none";
  const used = row.tokens.lastUsedAt === null ? "never used" : `used ${formatLastSeen(row.tokens.lastUsedAt, now)}`;
  return `${row.tokens.active} active · ${used}`;
}

const AgentRowView: FC<{ row: AgentRow; now: string }> = ({ row, now }) => (
  <tr>
    <td>
      <div class="cell-name mono">
        <a href={paths.agentDetail(row.slug)}>{row.slug}</a>
      </div>
      {row.description === "" ? null : <div class="list-meta">{row.description}</div>}
    </td>
    <td>
      <GrantsCell row={row} />
    </td>
    <td class="cell-muted">{tokensCell(row, now)}</td>
    <td class="cell-muted">{formatStamp(row.createdAt)}</td>
    <td class="cell-actions">
      <a class="btn btn--ghost btn--sm" href={paths.agentDetail(row.slug)}>
        View
      </a>
      {/* Delete never mutates directly — it opens this page with the confirm dialog. */}
      <a class="btn btn--danger-outline btn--sm" href={paths.agentsConfirmDelete(row.slug)}>
        Delete
      </a>
    </td>
  </tr>
);

const DeleteAgentDialog: FC<{ confirm: AgentsConfirm; csrfToken: string }> = ({ confirm, csrfToken }) => (
  <ConfirmShell id={DIALOG_ID} title={`Delete agent “${confirm.row.slug}”?`} text={DELETE_AGENT_TEXT}>
    <form method="post" action={paths.agentDelete(confirm.row.slug)} class="actions">
      <input type="hidden" name="csrf" value={csrfToken} />
      <a class="btn btn--ghost" href={paths.agents}>
        Cancel
      </a>
      <button type="submit" class="btn btn--danger">
        Delete
      </button>
    </form>
  </ConfirmShell>
);

export function AgentsPage(props: AgentsProps) {
  const { notice, agents, confirm, csrfToken, now } = props;
  return (
    <Layout title="Agents · personal-mcps" active="agents" username={props.username} pendingApprovals={props.pendingApprovals}>
      <main class="page">
        {notice ? (
          <div class={alertClass(notice.tone)}>
            {notice.title ? <div class="alert-title">{notice.title}</div> : null}
            <div>{notice.message}</div>
          </div>
        ) : null}
        <div class="page-head">
          <div>
            <h1 class="page-title">Agents</h1>
            <p class="page-subtitle">Identities that call your apps — each holds grants and tokens.</p>
          </div>
          <a class="btn btn--primary" href={paths.agentNew}>
            New agent
          </a>
        </div>

        {agents.length === 0 ? (
          <div class="empty">
            <div class="empty-title">No agents yet.</div>
            <div class="empty-text">Create one to give an AI agent its own grants and keys.</div>
            <a class="btn btn--primary" href={paths.agentNew}>
              New agent
            </a>
          </div>
        ) : (
          <div class="card">
            <table class="table">
              <thead>
                <tr>
                  <th>Agent</th>
                  <th>Grants</th>
                  <th>Tokens</th>
                  <th>Created</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {agents.map((row) => (
                  <AgentRowView row={row} now={now} />
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p class="note">{DELETE_AGENT_TEXT}</p>
      </main>
      {confirm === null ? null : <DeleteAgentDialog confirm={confirm} csrfToken={csrfToken} />}
    </Layout>
  );
}
