/**
 * `/agents/<slug>/credentials` — what the agent presents to get in: its keys, and the OAuth
 * clients that sign in as it.
 *
 * A port of `pages/agent-detail.tsx`'s `CredentialsPane` / `TokenRow` / `ClientRow` /
 * `CredentialsDetails` and `model.ts`'s `credentialsPaneView`. Both lists were already read
 * for the rail, so this pane reads nothing of its own.
 *
 * The minted key is COMPONENT STATE and is never written to the query cache: it exists in
 * one render and a reload must lose it (§4/§15). The server needed a 200-answering route for
 * exactly that reason — a plaintext key may not ride a URL — and here there is no redirect to
 * avoid, only a value to hold.
 */

import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import type { ReactNode } from "react";
import { paths } from "@/lib/paths";
import { formatLastSeen, formatStamp } from "@/lib/format";
import { auditQuery, useOp } from "@/lib/queries";
import { useApi } from "@/lib/api-context";
import { ConfirmDialog, useDropSearchKeys } from "@/chrome/Confirm";
import { TokenReveal } from "@/chrome/Reveal";
import { Skeleton } from "@/chrome/States";
import { usePreviewTransient } from "@/preview/transient";
import type { AgentClient, AgentToken } from "../derive";
import type { AgentPageData } from "../AgentFrame";
import { Kv } from "./Kv";

/** §8's four expiries, as the control beside Issue offers them. `never` is the op's own word
 *  for "no expiry", passed through unchanged; the rest are seconds, which is what
 *  `token_issue`'s `expires_in` takes. */
const EXPIRIES: { value: string; label: string }[] = [
  { value: "2592000", label: "30d" },
  { value: "7776000", label: "90d · default" },
  { value: "31536000", label: "1y" },
  { value: "never", label: "never" },
];

/** The expiry the control starts on — §8's default for an agent key, said in the label. */
const DEFAULT_EXPIRY = "7776000";

/** What the token dialogs are addressed by. */
const CONFIRM_KEYS = ["confirm", "id"];

/** Which token dialog the URL opened, if any — validated against the keys this pane holds,
 *  because a dialog is about a row and a guessed id names none. */
export type TokenConfirm =
  | { kind: "revoke-token"; row: AgentToken }
  | { kind: "remove-token"; row: AgentToken }
  | null;

export function tokenConfirmOf(kind: string, id: string, tokens: AgentToken[]): TokenConfirm {
  if (kind !== "revoke-token" && kind !== "remove-token") return null;
  const row = tokens.find((token) => token.id === id);
  return row === undefined ? null : { kind, row };
}

/** The row `?sel=` picked, as the level header names it — a key by its prefix, a client by
 *  its name, and nothing at all for a `sel` naming neither. */
export function credentialsSelectedName(data: AgentPageData, sel: string): string | null {
  if (sel.startsWith("token:")) return data.tokens.find((row) => row.id === sel.slice(6))?.prefix ?? null;
  if (sel.startsWith("client:")) return data.clients.find((row) => row.id === sel.slice(7))?.name ?? null;
  return null;
}

export function CredentialsPane({
  data,
  sel,
  confirm,
}: {
  data: AgentPageData;
  /** `?sel=token:<id>` / `?sel=client:<id>`, or "". */
  sel: string;
  confirm: TokenConfirm;
}): ReactNode {
  const agent = data.agent.slug;
  const dropKeys = useDropSearchKeys();
  const transient = usePreviewTransient();
  const issue = useOp<{ kind: "agent"; slug: string; expires_in?: number | "never" }>("token_issue", { agent });
  const revoke = useOp<{ id: string }>("token_revoke", { agent });
  const [expiry, setExpiry] = useState(DEFAULT_EXPIRY);
  // The two things one Issue leaves behind: the key itself, shown once, and which row is the
  // new one. Neither is server state — a refetch of the token list cannot report either.
  const [minted, setMinted] = useState<{ token: string; id: string } | null>(
    () => transient.revealedToken ?? null,
  );

  const token = sel.startsWith("token:") ? data.tokens.find((row) => row.id === sel.slice(6)) : undefined;
  const client = sel.startsWith("client:") ? data.clients.find((row) => row.id === sel.slice(7)) : undefined;

  return (
    <>
      <div className="listing">
        <div className="lh">
          <div className="title-row">
            <span className="listing-title">Credentials</span>
            <span className="note">what {agent} presents to get in</span>
          </div>
          <div className="sum">
            Any of these carries the grants in the Apps list. A token expires on its date; a client stays in until
            revoked in Settings.
          </div>
        </div>
        {minted === null ? null : (
          <div className="lh">
            <TokenReveal token={minted.token}>
              <p className="note">Any earlier key keeps working until you revoke it.</p>
            </TokenReveal>
          </div>
        )}
        {issue.isError ? (
          <div className="alert alert--danger" role="alert">
            <div className="alert-text">{issue.error.message}</div>
          </div>
        ) : null}
        {revoke.isError ? (
          <div className="alert alert--danger" role="alert">
            <div className="alert-text">{revoke.error.message}</div>
          </div>
        ) : null}
        <div className="scroll">
          <div className="gh">
            <span>Tokens · {data.tokens.length}</span>
            <form
              className="gh-form"
              onSubmit={(event) => {
                event.preventDefault();
                issue.mutate(
                  {
                    kind: "agent",
                    slug: agent,
                    expires_in: expiry === "never" ? "never" : Number(expiry),
                  },
                  {
                    // `token_issue`'s answer is the one place the plaintext exists (§4/§15),
                    // and the op's `value` is untyped on the wire — so it is READ rather than
                    // asserted: no key, no reveal, and nothing invented in its place.
                    onSuccess: (answer) => {
                      const minted = mintedOf(answer.value);
                      if (minted !== null) setMinted(minted);
                    },
                  },
                );
              }}
            >
              <label className="gh-note" htmlFor="expires_in">
                expires in
              </label>
              <select id="expires_in" name="expires_in" value={expiry} onChange={(event) => setExpiry(event.target.value)}>
                {EXPIRIES.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              <button type="submit" className="btn btn--outline btn--sm" disabled={issue.isPending}>
                Issue token
              </button>
            </form>
          </div>
          {data.tokens.length === 0 ? (
            <p className="note gh-state">No key yet — this agent cannot call anything until one is issued.</p>
          ) : (
            data.tokens.map((row) => (
              <TokenRow key={row.id} row={row} agent={agent} now={data.now} isNew={row.id === minted?.id} />
            ))
          )}
          <div className="gh">
            <span>Connected clients · {data.clients.length}</span>
            <span className="gh-note">OAuth · managed in Settings</span>
          </div>
          {data.clients.map((row) => (
            <ClientRow key={row.id} row={row} agent={agent} now={data.now} />
          ))}
          <p className="note gh-state">
            One OAuth client signs in as this agent, so its calls carry these grants. Revoking lives with the other
            credentials in <a href="/settings/clients">Settings → Connected clients</a>.
          </p>
        </div>
      </div>
      <CredentialsDetails data={data} token={token} client={client} />
      {confirm === null ? null : (
        <ConfirmDialog
          title={
            confirm.kind === "revoke-token"
              ? `Revoke “${confirm.row.prefix}”?`
              : `Remove expired token ${confirm.row.prefix}?`
          }
          text={
            confirm.kind === "revoke-token"
              ? "Calls made with this key fail from now on."
              : `It expired ${confirm.row.expiresAt === null ? "already" : formatStamp(confirm.row.expiresAt)}; removing it keeps its history.`
          }
          onClose={() => dropKeys(CONFIRM_KEYS)}
        >
          <div className="actions">
            <button type="button" className="btn btn--ghost" onClick={() => dropKeys(CONFIRM_KEYS)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn btn--danger"
              disabled={revoke.isPending}
              onClick={() =>
                revoke.mutate({ id: confirm.row.id }, { onSuccess: () => dropKeys(CONFIRM_KEYS) })
              }
            >
              {confirm.kind === "revoke-token" ? "Revoke" : "Remove"}
            </button>
          </div>
        </ConfirmDialog>
      )}
    </>
  );
}

/** `Nov 10, 2026 (90 d)` — the expiry date and the LIFETIME it was issued for, which is the
 *  thing an owner compares keys by; `never` for a key with no expiry at all. */
function expiryText(row: AgentToken): string {
  if (row.expiresAt === null) return "never";
  const days = Math.round((row.expiresAt - row.createdAt) / 86_400_000);
  return `${formatStamp(row.expiresAt)} (${days} d)`;
}

function TokenRow({
  row,
  agent,
  now,
  isNew,
}: {
  row: AgentToken;
  agent: string;
  now: number;
  /** The row this render's own Issue produced — the dashed `new` badge, and nothing the
   *  token list could tell us. */
  isNew: boolean;
}): ReactNode {
  return (
    <div className={row.expired ? "cr cr--dim" : "cr"}>
      <div>
        <Link
          className="row-link mono"
          to={paths.agentPane(agent, "credentials")}
          search={{ sel: `token:${row.id}` }}
        >
          {row.prefix}
        </Link>
        {row.expired ? (
          <>
            {" "}
            <span className="badge badge--warning">expired</span>
          </>
        ) : null}
        {isNew ? (
          <>
            {" "}
            <span className="badge badge--success badge--dashed">new</span>
          </>
        ) : null}
        <div className="cr-detail">
          created {formatStamp(row.createdAt)} · expires {expiryText(row)} · used{" "}
          {row.lastUsedAt === null ? "never" : formatLastSeen(row.lastUsedAt, now)}
        </div>
      </div>
      <div className="cr-control">
        {/* Revoke never mutates directly — it opens this pane with the confirm dialog, whose
            verb is the row's own state: an expired key is removed, a live one revoked. */}
        <Link
          className="btn btn--danger-outline btn--sm"
          to={paths.agentPane(agent, "credentials")}
          search={{ confirm: row.expired ? "remove-token" : "revoke-token", id: row.id }}
        >
          {row.expired ? "Remove" : "Revoke"}
        </Link>
      </div>
    </div>
  );
}

function ClientRow({ row, agent, now }: { row: AgentClient; agent: string; now: number }): ReactNode {
  return (
    <div className="cr">
      <div>
        <Link
          className="row-link"
          to={paths.agentPane(agent, "credentials")}
          search={{ sel: `client:${row.id}` }}
        >
          {row.name}
        </Link>{" "}
        <span className="mono muted">{row.origin}</span>
        <div className="cr-detail">
          consented {formatStamp(row.createdAt)} · used{" "}
          {row.lastUsedAt === null ? "never" : formatLastSeen(row.lastUsedAt, now)}
        </div>
      </div>
      <div className="cr-control">
        <span className={row.revoked ? "badge badge--muted" : "badge badge--success"}>
          {row.revoked ? "revoked" : "active"}
        </span>
      </div>
    </div>
  );
}

/**
 * The details column: the selected key, the selected client, or the pane's own summary. A
 * `sel` naming neither falls back to the summary rather than to an error — `sel` is a pointer
 * into a live list, and a key can be revoked between two renders.
 */
function CredentialsDetails({
  data,
  token,
  client,
}: {
  data: AgentPageData;
  token: AgentToken | undefined;
  client: AgentClient | undefined;
}): ReactNode {
  if (token !== undefined) {
    return (
      <div className="details">
        <div className="dh">
          <div className="title-row">
            <span className="listing-title mono">{token.prefix}</span>
            <span className="badge badge--muted">token</span>
          </div>
        </div>
        <div className="db">
          <section className="card card--pad">
            <div className="eyebrow">This key</div>
            <div className="kv">
              <Kv k="Created">{formatStamp(token.createdAt)}</Kv>
              <Kv k="Expires">{token.expiresAt === null ? "never" : formatStamp(token.expiresAt)}</Kv>
              <Kv k="Last used">
                {token.lastUsedAt === null ? "never" : formatLastSeen(token.lastUsedAt, data.now)}
              </Kv>
              <Kv k="Carries">every grant in the Apps list — a key is the agent, not a subset of it</Kv>
            </div>
          </section>
          <RecentUse agent={data.agent.slug} now={data.now} />
        </div>
      </div>
    );
  }
  if (client !== undefined) {
    return (
      <div className="details">
        <div className="dh">
          <div className="title-row">
            <span className="listing-title">{client.name}</span>
            <span className="badge badge--muted">OAuth client</span>
          </div>
        </div>
        <div className="db">
          <section className="card card--pad">
            <div className="eyebrow">This client</div>
            <div className="kv">
              <Kv k="Redirect origin">
                <span className="mono">{client.origin}</span>
              </Kv>
              <Kv k="Consented">{formatStamp(client.createdAt)}</Kv>
              <Kv k="Last used">
                {client.lastUsedAt === null ? "never" : formatLastSeen(client.lastUsedAt, data.now)}
              </Kv>
              <Kv k="Registered">
                {client.selfRegistered ? "registered itself — identity unverified" : "by you, at consent"}
              </Kv>
            </div>
          </section>
        </div>
      </div>
    );
  }
  return (
    <div className="details">
      <div className="dh">
        <div className="listing-title">Credentials</div>
        <p className="note">Select a token or a client for its details.</p>
      </div>
      <div className="db">
        <section className="card card--pad">
          <div className="eyebrow">Summary</div>
          <div className="kv">
            <Kv k="Tokens">{data.tokens.length}</Kv>
            <Kv k="Clients">{data.clients.length}</Kv>
          </div>
        </section>
      </div>
    </div>
  );
}

/**
 * The selected key's "Recent use" card, named for what it actually is: the ledger records a
 * PRINCIPAL, never which credential presented it, so this is the agent's last three calls
 * rather than this key's — and the card's own eyebrow says so.
 *
 * `30d` is the widest window the audit resource offers and retention is seven days (§15), so
 * the preset covers the whole ledger — which is what "the last three" has to mean.
 */
function RecentUse({ agent, now }: { agent: string; now: number }): ReactNode {
  const api = useApi();
  const trail = useQuery(
    auditQuery(api, { principal: `agent:${agent}`, event: "tools/call", range: "30d", limit: "3" }),
  );
  const rows = trail.data?.page.rows ?? [];
  return (
    <section className="card card--pad">
      <div className="eyebrow">Recent use · the agent's last three calls</div>
      {trail.isPending ? (
        <Skeleton rows={3} />
      ) : rows.length === 0 ? (
        <p className="note">no calls yet</p>
      ) : (
        <div className="kv">
          {rows.map((row) => (
            <Kv key={row.id} k={formatLastSeen(row.ts, now)}>
              <span className="mono">{row.app ?? ""}</span> · <span className="mono">{row.tool ?? ""}</span>
            </Kv>
          ))}
        </div>
      )}
    </section>
  );
}

/**
 * `token_issue`'s answer, read: the plaintext key and the row it belongs to, or null when the
 * answer carries neither. The op's result reaches the client as `OpValue`'s untyped `value`,
 * and this is the only thing that reads it — a reveal drawn from an answer that did not carry
 * a key would be a blank box where a secret should be.
 */
function mintedOf(value: unknown): { token: string; id: string } | null {
  if (typeof value !== "object" || value === null) return null;
  const token = "token" in value ? value.token : undefined;
  const id = "id" in value ? value.id : undefined;
  return typeof token === "string" && typeof id === "string" ? { token, id } : null;
}
