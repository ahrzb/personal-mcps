/**
 * /agents/<slug> — §13's agent page (2026-09-03, roadmap step 9; the `AgentDetail`
 * board): one scroll of three cards and a danger zone, NOT a paned page — an agent has
 * three holdings and nothing to browse, so a rail would carry nothing.
 *
 * Grants (read here; edited on the pair's own editor page), Tokens (Issue answering 200
 * in place with the once-only reveal, Revoke behind the page's own dialog), Connected
 * clients (read-only, linking to the pane that revokes — §19.6: one place revokes), and
 * Delete agent behind the same dialog the list draws.
 */

import type { FC } from "hono/jsx";
import { ConfirmShell, Layout, TokenReveal } from "./layout";
import { paths, type AgentConfirm, type AgentDetailProps, type AgentGrantRow, type AppGrantChip } from "./model";
import { alertClass, formatLastSeen, formatStamp } from "./format";
import { DELETE_AGENT_TEXT } from "./agents";

const DIALOG_ID = "confirm-agent";

/** One grant, as §13 spells it: `<role> · <mode>`, with the built-in `all` marked — the
 *  same chip the app page's Agents pane draws, read from the same spelling. */
const GrantChip: FC<{ chip: AppGrantChip }> = ({ chip }) => (
  <span class="badge badge--outline">
    <span class="mono">{chip.role}</span> · {chip.mode}
    {chip.builtin ? <span class="muted"> built-in</span> : null}
  </span>
);

const GrantsCard: FC<{ slug: string; grants: AgentGrantRow[] }> = ({ slug, grants }) => (
  <section class="card card--pad">
    <div class="card-head">
      <div>
        <h2 class="card-title">Grants</h2>
        <p class="card-desc">What this agent may call, per app.</p>
      </div>
    </div>
    {grants.length === 0 ? (
      <div class="empty empty--inline">
        <div class="empty-text">No grants yet — this agent can call nothing until one is set.</div>
      </div>
    ) : (
      <table class="table">
        <thead>
          <tr>
            <th>App</th>
            <th>Granted roles</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {grants.map((grant) => (
            <tr>
              <td>
                <div class="cell-name">
                  <a href={paths.appDetail(grant.app)}>{grant.appName}</a>
                </div>
                <div class="list-meta mono">{grant.app}</div>
              </td>
              <td class="badge-row">
                {grant.chips.map((chip) => (
                  <GrantChip chip={chip} />
                ))}
              </td>
              <td class="cell-actions">
                <a class="btn btn--ghost btn--sm" href={paths.agentGrants(slug, grant.app)}>
                  Edit
                </a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    )}
    <p class="note">Editing opens the pair's full grant set — saving replaces it entirely.</p>
  </section>
);

const TokensCard: FC<AgentDetailProps> = (props) => (
  <section class="card card--pad">
    <div class="card-head">
      <div>
        <h2 class="card-title">Tokens</h2>
        <p class="card-desc">The keys this agent presents. Agent tokens expire after 90 days by default.</p>
      </div>
    </div>
    {props.reveal === null ? null : (
      <TokenReveal token={props.reveal}>
        <p class="note">Any earlier key keeps working until you revoke it.</p>
      </TokenReveal>
    )}
    {props.tokens.length === 0 ? (
      <div class="empty empty--inline">
        <div class="empty-text">No key yet — this agent cannot call anything until one is issued.</div>
      </div>
    ) : (
      <table class="table">
        <thead>
          <tr>
            <th>Token</th>
            <th>Created</th>
            <th>Expires</th>
            <th>Last used</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {props.tokens.map((token) => (
            <tr class={token.expired ? "row--dim" : undefined}>
              <td class="cell-mono">
                {token.prefix}
                {token.expired ? <span class="badge badge--muted"> expired</span> : null}
              </td>
              <td class="cell-muted">{formatStamp(token.createdAt)}</td>
              <td class="cell-muted">{token.expiresAt === null ? "never" : formatStamp(token.expiresAt)}</td>
              <td class="cell-muted">
                {token.lastUsedAt === null ? "never" : formatLastSeen(token.lastUsedAt, props.now)}
              </td>
              <td class="cell-actions">
                {/* Behind the dialog §13 gives it: the destructive form exists only under
                    the page's own `?confirm=` URL. */}
                <a class="btn btn--danger-outline btn--sm" href={paths.agentConfirm(props.slug, "revoke-token", token.id)}>
                  Revoke
                </a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    )}
    {/* The one mutation here that answers 200 rather than the redirect-back: a plaintext
        key must never ride a URL (§15), so the reveal is rendered in place by its own route. */}
    <form method="post" action={paths.agentOp(props.slug, "token_issue", { kind: "agent", slug: props.slug })} class="actions actions--start">
      <input type="hidden" name="csrf" value={props.csrfToken} />
      <button type="submit" class="btn btn--outline btn--sm">
        Issue token
      </button>
    </form>
    <p class="note">Agent tokens expire after 90 days by default; issuing shows the key once.</p>
  </section>
);

const ClientsCard: FC<AgentDetailProps> = (props) =>
  props.clients === null ? null : (
    <section class="card card--pad">
      <div class="card-head">
        <div>
          <h2 class="card-title">Connected clients</h2>
          <p class="card-desc">
            Managed in <a href={paths.settingsClients}>Settings → Connected clients</a>
          </p>
        </div>
      </div>
      <table class="table">
        <thead>
          <tr>
            <th>Client</th>
            <th>Origin</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {props.clients.map((client) => (
            <tr>
              <td>
                <a href={paths.settingsClients}>{client.name}</a>
              </td>
              <td class="cell-slug">{client.origin}</td>
              <td>
                <span class={client.revoked ? "badge badge--muted" : "badge badge--success"}>
                  {client.revoked ? "revoked" : "active"}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p class="note">
        One OAuth client signs in as this agent, so its calls carry these grants. Read-only here — revoking
        lives with the other credentials.
      </p>
    </section>
  );

const AgentDialog: FC<{ confirm: AgentConfirm; slug: string; csrfToken: string }> = ({ confirm, slug, csrfToken }) => {
  const revoke = confirm.kind === "revoke-token";
  return (
    <ConfirmShell
      id={DIALOG_ID}
      title={revoke ? `Revoke “${confirm.prefix}”?` : `Delete agent “${slug}”?`}
      text={revoke ? "Calls made with this key fail from now on." : DELETE_AGENT_TEXT}
    >
      <form
        method="post"
        action={revoke ? paths.agentOp(slug, "token_revoke", { id: confirm.id }) : paths.agentOp(slug, "agent_delete", { slug })}
        class="actions"
      >
        <input type="hidden" name="csrf" value={csrfToken} />
        <a class="btn btn--ghost" href={paths.agentDetail(slug)}>
          Cancel
        </a>
        <button type="submit" class="btn btn--danger">
          {revoke ? "Revoke" : "Delete"}
        </button>
      </form>
    </ConfirmShell>
  );
};

export function AgentDetailPage(props: AgentDetailProps) {
  const { notice, slug, name, description, createdAt, confirm, csrfToken } = props;
  return (
    <Layout title={`${slug} · Agents · personal-mcps`} active="agents" username={props.username} pendingApprovals={props.pendingApprovals}>
      <main class="page">
        {notice ? (
          <div class={alertClass(notice.tone)}>
            {notice.title ? <div class="alert-title">{notice.title}</div> : null}
            <div>{notice.message}</div>
          </div>
        ) : null}
        <div class="page-head">
          <div>
            <p class="page-subtitle">
              <a href={paths.agents}>Agents</a> / {slug}
            </p>
            <h1 class="page-title">
              <span class="mono">{slug}</span> <span class="badge badge--outline">agent</span>
            </h1>
            {name === slug ? null : <p class="page-subtitle">{name}</p>}
            {description === "" ? null : <p class="page-subtitle">{description}</p>}
            <p class="page-subtitle">Created {formatStamp(createdAt)}</p>
          </div>
        </div>

        <GrantsCard slug={slug} grants={props.grants} />
        <TokensCard {...props} />
        <ClientsCard {...props} />

        <section class="card card--pad">
          <div class="card-head">
            <div>
              <h2 class="card-title">Danger zone</h2>
              <p class="card-desc">{DELETE_AGENT_TEXT}</p>
            </div>
          </div>
          <div class="actions actions--start">
            <a class="btn btn--danger-outline" href={paths.agentConfirm(slug, "delete-agent")}>
              Delete agent
            </a>
          </div>
        </section>
      </main>
      {confirm === null ? null : <AgentDialog confirm={confirm} slug={slug} csrfToken={csrfToken} />}
    </Layout>
  );
}
