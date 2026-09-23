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
import { Kv, KvList } from "@/chrome/Kv";
import {
  Details,
  DetailsBody,
  DetailsHead,
  Listing,
  ListingHead,
  ListingNote,
  ListingScroll,
  ListingTitle,
  ListRow,
  ListRowControl,
  ListRowDetail,
  RowLink,
  Sum,
} from "@/chrome/Listing";
import { TitleRow, TitleRowEnd } from "@/chrome/Page";
import { TokenReveal } from "@/chrome/Reveal";
import { Eyebrow, Note } from "@/chrome/Text";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
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
      <Listing wide>
        <ListingHead>
          <ListingTitle render={<span />}>Token</ListingTitle>
        </ListingHead>
        <ListingScroll>
          <ListingNote>
            Proxied apps hold no tokens — the hub dials the upstream; nothing dials in.
          </ListingNote>
        </ListingScroll>
      </Listing>
    );
  }

  const base = paths.appPane(slug, "token");
  const sel = searchValue(search, "sel");
  const picked = sel.startsWith("token:") ? sel.slice("token:".length) : "";
  const selected = tokens.find((token) => token.id === picked) ?? null;
  const refusal = issue.error instanceof ApiError ? issue.error : null;

  return (
    <>
      <Listing>
        <ListingHead>
          <TitleRow split>
            <ListingTitle render={<span />}>Token</ListingTitle>
            <Note render={<span />}>what the app presents to dial in</Note>
            <TitleRowEnd>
              <Button
                variant="outline"
                size="sm"
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
              </Button>
            </TitleRowEnd>
          </TitleRow>
          <Sum>
            {tokens.length} live · app tokens have no expiry — rotate by issuing, then revoking the old one. Revoking
            the key a live socket used closes it.
          </Sum>
        </ListingHead>
        {refusal === null ? null : (
          <Alert variant="danger" role="alert">
            <AlertDescription>{refusal.message}</AlertDescription>
          </Alert>
        )}
        <ListingScroll>
          {tokens.length === 0 ? (
            <ListingNote>
              No live token — the app cannot connect until one is issued.
            </ListingNote>
          ) : (
            tokens.map((row) => (
              <ListRow key={row.id}>
                <div>
                  <RowLink className="font-mono" render={<Link to={base} search={{ sel: `token:${row.id}` }} />}>
                    {row.prefix}
                  </RowLink>
                  {row.id === holdingSocket ? (
                    <>
                      {" "}
                      <Badge variant="success">holds the live socket</Badge>
                    </>
                  ) : null}
                  {row.id === minted?.id ? (
                    <>
                      {" "}
                      <Badge variant="success" className="border-dashed">
                        new
                      </Badge>
                    </>
                  ) : null}
                  <ListRowDetail>
                    issued {formatLastSeen(row.createdAt, now)} ·{" "}
                    {row.lastUsedAt === null ? "never used" : `used ${formatLastSeen(row.lastUsedAt, now)}`}
                  </ListRowDetail>
                </div>
                <ListRowControl>
                  <Link
                    className={buttonVariants({ variant: "danger-outline", size: "sm" })}
                    to={base}
                    search={{ confirm: "revoke-token", id: row.id }}
                  >
                    Revoke
                  </Link>
                </ListRowControl>
              </ListRow>
            ))
          )}
        </ListingScroll>
      </Listing>
      <Details>
        {selected === null ? (
          <DetailsHead>
            <ListingTitle>Token</ListingTitle>
            <Note>Select a token for its details.</Note>
          </DetailsHead>
        ) : (
          <Selected row={selected} slug={slug} now={now} holdingSocket={holdingSocket} minted={minted} />
        )}
      </Details>
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
      <DetailsHead>
        <TitleRow>
          <ListingTitle render={<span />} className="font-mono">{row.prefix}</ListingTitle>
          <Badge variant="muted">app token</Badge>
        </TitleRow>
        <Note>Only valid for opening the reverse WebSocket as {slug}.</Note>
      </DetailsHead>
      <DetailsBody>
        {reveal === null ? null : (
          <Card size="sm" render={<section />}>
            <Eyebrow>
              Shown once — copy it now
            </Eyebrow>
            <TokenReveal token={reveal}>
              <Note>
                The previous token keeps working until you revoke it.
              </Note>
            </TokenReveal>
          </Card>
        )}
        <Card size="sm" render={<section />}>
          <KvList>
            <Kv k="Issued">{formatStamp(row.createdAt)}</Kv>
            <Kv k="Expires">never — revoke on compromise</Kv>
            <Kv k="Last used">{row.lastUsedAt === null ? "never" : formatLastSeen(row.lastUsedAt, now)}</Kv>
            <Kv k="Connection">{row.id === holdingSocket ? "holds the live socket now" : "none"}</Kv>
          </KvList>
        </Card>
      </DetailsBody>
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
