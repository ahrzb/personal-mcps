/**
 * /agents — the list (the `Agents` board, 2026-09-16): one row per agent, the whole row a
 * link to the agent page, and Delete as the only row control. Granting lives on the agent
 * page, so nothing here opens an editor and nothing here reads a catalog.
 *
 * The stretched anchor is the row's link with no script: the anchor covers the row through
 * `::after`, and the Delete cell sits above it so it still deletes (styles.css). Delete is
 * behind the list's own `?confirm=delete-agent&slug=` dialog, addressable state exactly as
 * /apps's is — it works with scripting off and a fixture can render it.
 */

import type { FC } from "hono/jsx";
import { ConfirmShell, Layout } from "./layout";
import { paths, type AgentRow, type AgentsConfirm, type AgentsProps } from "./model";
import { alertClass, formatLastSeen, formatStamp } from "./format";

const DIALOG_ID = "confirm-delete-agent";

/** §13's Delete copy — the same sentence the list's footer and the danger zone carry. */
export const DELETE_AGENT_TEXT = "Deleting an agent deletes its tokens and removes its grants everywhere.";

/** The Access line: one line of totals over every grant set, or the empty arm. Dormant
 *  counts what a declaration can prove dead — an archived app, an undeclared role. */
function accessText(row: AgentRow): string {
  const { apps, allowed, askFirst, dormant } = row.access;
  if (apps === 0) return "no grants";
  return `${apps} apps · ${allowed} allowed · ${askFirst} ask first · ${dormant} dormant`;
}

/** `N active · used <relative>` / `N active · never used` / `none` (§13). */
function tokensCell(row: AgentRow, now: string): string {
  if (row.tokens.active === 0) return "none";
  const used = row.tokens.lastUsedAt === null ? "never used" : `used ${formatLastSeen(row.tokens.lastUsedAt, now)}`;
  return `${row.tokens.active} active · ${used}`;
}

/** The chevron at the row's end — decoration for where the row goes; the anchor is the
 *  thing that goes there, so this is hidden from anyone listing the page's links. */
const Chevron: FC = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="m9 6 6 6-6 6" />
  </svg>
);

const AgentRowView: FC<{ row: AgentRow; now: string }> = ({ row, now }) => (
  <tr class="agent-row">
    <td>
      <div class="cell-name mono">
        {/* The row's link: stretched over the whole row by styles.css, no script. */}
        <a class="row-link" href={paths.agentDetail(row.slug)}>
          {row.slug}
        </a>
      </div>
      {row.description === "" ? null : <div class="list-meta">{row.description}</div>}
    </td>
    <td class="cell-muted">{accessText(row)}</td>
    <td class="cell-muted">{tokensCell(row, now)}</td>
    <td class="cell-muted">{formatStamp(row.createdAt)}</td>
    <td class="cell-actions">
      {/* Delete never mutates directly — it opens this page with the confirm dialog. */}
      <a class="btn btn--danger-outline btn--sm" href={paths.agentsConfirmDelete(row.slug)}>
        Delete
      </a>
      <span class="row-chevron">
        <Chevron />
      </span>
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
            <p class="page-subtitle">Identities that call your apps — each holds grants and keys.</p>
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
                  <th>Access</th>
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
