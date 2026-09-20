/**
 * The Token pane — what a tunneled app presents to dial in, and the one place a new key is
 * ever shown.
 *
 * A port of `pages/app-detail.tsx`'s `TokenPane` and `model.ts:tokenPane`. Two rules from
 * that page survive intact and are the reason this file is not a table:
 *
 *  - a PROXIED app has no tokens at all, for §2's reason and not as a missing feature: the
 *    hub dials the upstream, nothing dials in. The pane says so and draws no control.
 *  - a minted plaintext is shown EXACTLY ONCE and is never written to the query cache
 *    (§4/§15). It lives in component state, so a navigation or a reload loses it — which is
 *    the contract, not a limitation.
 */

import { Link, useSearch } from "@tanstack/react-router";
import { useState } from "react";
import type { ReactNode } from "react";
import { TokenReveal } from "@/chrome/Reveal";
import { ApiError } from "@/lib/http";
import { formatLastSeen, formatStamp } from "@/lib/format";
import { paths } from "@/lib/paths";
import { useOp } from "@/lib/queries";
import type { TokenInfo } from "@/lib/types";
import { usePreviewTransient } from "@/preview/transient";
import { liveTokenId, searchValue } from "../derive";
import type { AppPaneProps } from "../derive";

export function TokenPane(props: AppPaneProps): ReactNode {
  const { slug, app, kind, tokens, now } = props;
  const search = useSearch({ strict: false }) as Record<string, string | string[] | undefined>;
  const transient = usePreviewTransient();

  // The minted plaintext, and the id of the row it belongs to. Component state on purpose:
  // the cache is where server data lives, and this is the one value the server will never
  // answer with again. The id rides with it because a mint draws TWO things — the reveal
  // and the `new` badge on its own row — and holding only the secret would show one and
  // not the other. `useState`'s initializer seeds the state gallery and nothing else.
  const [minted, setMinted] = useState<{ id: string; token: string } | null>(
    () => transient.revealedToken ?? null,
  );
  const issue = useOp<{ kind: "app"; slug: string }>("token_issue", { app: slug });

  const holdingSocket = liveTokenId(tokens, kind === "tunnel" && app.status === "online" && !app.archived);

  if (kind === "proxy") {
    return (
      <div className="listing listing--wide">
        <div className="lh">
          <span className="listing-title">Token</span>
        </div>
        <div className="scroll">
          <p className="note gh-state">Proxied apps hold no tokens — the hub dials the upstream; nothing dials in.</p>
        </div>
      </div>
    );
  }

  const base = paths.appPane(slug, "token");
  const sel = searchValue(search, "sel");
  const picked = sel.startsWith("token:") ? sel.slice("token:".length) : "";
  const selected = tokens.find((token) => token.id === picked) ?? null;
  const refusal = issue.error instanceof ApiError ? issue.error : null;

  return (
    <>
      <div className="listing">
        <div className="lh">
          <div className="title-row title-row--split">
            <span className="listing-title">Token</span>
            <span className="note">what the app presents to dial in</span>
            <span className="title-row-end">
              <button
                type="button"
                className="btn btn--outline btn--sm"
                disabled={issue.isPending}
                onClick={() => {
                  issue.mutate(
                    { kind: "app", slug },
                    {
                      onSuccess: (answer) => {
                        const value = mintedOf(answer.value);
                        if (value !== null) setMinted(value);
                      },
                    },
                  );
                }}
              >
                Issue new token
              </button>
            </span>
          </div>
          <div className="sum">
            {tokens.length} live · app tokens have no expiry — rotate by issuing, then revoking the old one. Revoking
            the key a live socket used closes it.
          </div>
        </div>
        {refusal === null ? null : (
          <div className="alert alert--danger" role="alert">
            <div className="alert-text">{refusal.message}</div>
          </div>
        )}
        <div className="scroll">
          {tokens.length === 0 ? (
            <p className="note gh-state">No live token — the app cannot connect until one is issued.</p>
          ) : (
            tokens.map((row) => (
              <div className="cr" key={row.id}>
                <div>
                  <Link className="row-link mono" to={base} search={{ sel: `token:${row.id}` }}>
                    {row.prefix}
                  </Link>
                  {row.id === holdingSocket ? (
                    <>
                      {" "}
                      <span className="badge badge--success">holds the live socket</span>
                    </>
                  ) : null}
                  {row.id === minted?.id ? (
                    <>
                      {" "}
                      <span className="badge badge--success badge--dashed">new</span>
                    </>
                  ) : null}
                  <div className="cr-detail">
                    issued {formatLastSeen(row.createdAt, now)} ·{" "}
                    {row.lastUsedAt === null ? "never used" : `used ${formatLastSeen(row.lastUsedAt, now)}`}
                  </div>
                </div>
                <div className="cr-control">
                  <Link
                    className="btn btn--danger-outline btn--sm"
                    to={base}
                    search={{ confirm: "revoke-token", id: row.id }}
                  >
                    Revoke
                  </Link>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
      <div className="details">
        {selected === null ? (
          <div className="dh">
            <div className="listing-title">Token</div>
            <p className="note">Select a token for its details.</p>
          </div>
        ) : (
          <Selected row={selected} slug={slug} now={now} holdingSocket={holdingSocket} minted={minted} />
        )}
      </div>
    </>
  );
}

/** The selected key's card, and the reveal when this render is the one that minted it. */
function Selected({
  row,
  slug,
  now,
  holdingSocket,
  minted,
}: {
  row: TokenInfo;
  slug: string;
  now: number;
  /** The id of the key the live socket presented, or null. */
  holdingSocket: string | null;
  /** The plaintext this render is holding, or null. */
  minted: { id: string; token: string } | null;
}): ReactNode {
  // Shown on the row it belongs to and nowhere else — which is why the id rides with the
  // plaintext rather than the pane assuming the newest row is the minted one.
  const reveal = minted !== null && minted.id === row.id ? minted.token : null;
  return (
    <>
      <div className="dh">
        <div className="title-row">
          <span className="listing-title mono">{row.prefix}</span>
          <span className="badge badge--muted">app token</span>
        </div>
        <p className="note">Only valid for opening the reverse WebSocket as {slug}.</p>
      </div>
      <div className="db">
        {reveal === null ? null : (
          <section className="card card--pad">
            <div className="eyebrow">Shown once — copy it now</div>
            <TokenReveal token={reveal}>
              <p className="note">The previous token keeps working until you revoke it.</p>
            </TokenReveal>
          </section>
        )}
        <section className="card card--pad">
          <div className="kv">
            <div className="kv-row">
              <div className="kv-key">Issued</div>
              <div>{formatStamp(row.createdAt)}</div>
            </div>
            <div className="kv-row">
              <div className="kv-key">Expires</div>
              <div>never — revoke on compromise</div>
            </div>
            <div className="kv-row">
              <div className="kv-key">Last used</div>
              <div>{row.lastUsedAt === null ? "never" : formatLastSeen(row.lastUsedAt, now)}</div>
            </div>
            <div className="kv-row">
              <div className="kv-key">Connection</div>
              <div>{row.id === holdingSocket ? "holds the live socket now" : "none"}</div>
            </div>
          </div>
        </section>
      </div>
    </>
  );
}

/**
 * `token_issue`'s answer, read for the one field the cache must never hold. Read rather than
 * asserted: `OpValue.value` is the op's own shape, and a mint that answered without a
 * plaintext must leave the reveal closed rather than render `undefined` as a key.
 */
function mintedOf(value: unknown): { id: string; token: string } | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.token !== "string") return null;
  return { id: typeof record.id === "string" ? record.id : "", token: record.token };
}
