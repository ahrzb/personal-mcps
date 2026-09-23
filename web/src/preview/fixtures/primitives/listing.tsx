import type { ReactNode } from "react";
import type { PrimitiveState } from "../../seed";
import { Card } from "@/components/ui/card";
import { Kv, KvList } from "@/chrome/Kv";
import {
  Details,
  DetailsBody,
  DetailsHead,
  GroupHead,
  GroupHeadNote,
  Listing,
  ListingHead,
  ListingMore,
  ListingScroll,
  ListingTitle,
  ListRow,
  ListRowControl,
  ListRowDetail,
  SaveBar,
  SaveBarCount,
  SaveBarEnd,
  Sum,
  Via,
} from "@/chrome/Listing";
import { Page, Pane, TitleRow, TitleRowEnd, Workspace } from "@/chrome/Page";
import { Columns } from "./Columns";

/**
 * The split pane's bench (`chrome/Listing`, in `chrome/Page`'s workspace): the agent page's
 * listing — head, sticky group heading with a note, rows plain, dimmed, dormant, nested and
 * with a `via`, the paged foot, the save bar — beside its details column, each beside
 * legacy.css's `.listing`, `.lh`, `.gh`, `.cr`, `.more`, `.save`, `.details`, `.dh`, `.db`.
 *
 * Shot at each narrow level: at 1280 all three states draw the framed box; at 390 level 2 is
 * the listing alone and level 3 the details alone. `listing-wide` is the listing alone in its
 * pane, with its `.kv--pad` block and its capped details body.
 */
export const listingStates: Record<string, PrimitiveState> = {
  listing: () => <Split level={2} />,
  "listing-details": () => <Split level={3} />,

  "listing-wide": () => (
    <Columns
      legacy={
        <main className="page--workspace w-full" data-level="2">
          <div className="paned paned--framed">
            <div className="pane pane--split">
              <div className="listing listing--wide">
                <div className="lh">
                  <span className="listing-title">Overview</span>
                </div>
                <div className="kv kv--pad">
                  <div className="kv-row">
                    <div className="kv-key">Upstream</div>
                    <div className="mono">mcp.example.com</div>
                  </div>
                </div>
                <div className="db">
                  <div className="card card--pad">A capped details body.</div>
                </div>
              </div>
            </div>
          </div>
        </main>
      }
      next={
        <Page shape="workspace" level={2} className="w-full">
          <Workspace>
            <Pane split>
              <Listing wide>
                <ListingHead>
                  <ListingTitle render={<span />}>Overview</ListingTitle>
                </ListingHead>
                <KvList variant="block" className="max-w-pane p-4">
                  <Kv k="Upstream">
                    <span className="mono">mcp.example.com</span>
                  </Kv>
                </KvList>
                <DetailsBody>
                  <Card size="sm">A capped details body.</Card>
                </DetailsBody>
              </Listing>
            </Pane>
          </Workspace>
        </Page>
      }
    />
  ),
};

/** The agent page's split pane at one narrow level, legacy beside the frames. */
function Split({ level }: { level: 2 | 3 }): ReactNode {
  return (
    <Columns
      legacy={
        <main className="page--workspace w-full" data-level={String(level)}>
          <div className="paned paned--framed">
            <div className="pane pane--split">
              <div className="listing">
                <div className="lh">
                  <div className="title-row title-row--split">
                    <span className="listing-title mono">github</span>
                    <div className="title-row-end">
                      <button type="button" className="btn btn--outline btn--sm">
                        Open in Audit
                      </button>
                    </div>
                  </div>
                  <div className="sum">Reaches 12 tools · 2 ask first</div>
                </div>
                <div className="scroll">
                  <div className="gh sticky">
                    <span>Tools · 4</span>
                    <span className="gh-note">newest first</span>
                  </div>
                  <div className="cr">
                    <div>
                      <div className="mono">create_issue</div>
                      <div className="cr-detail">asked 3 times this week</div>
                    </div>
                    <div className="cr-control">
                      <span className="via">via reader</span>
                      <button type="button" className="btn btn--outline btn--sm">
                        Allow
                      </button>
                    </div>
                  </div>
                  <div className="cr cr--sub">
                    <div className="mono">github/create_issue_with_a_very_long_unbroken_pattern_name</div>
                    <div className="cr-control">
                      <span className="badge">ask</span>
                    </div>
                  </div>
                  <div className="cr cr--dim">
                    <div>
                      <div className="mono">delete_repo</div>
                      <div className="cr-detail cr-detail--warn">matches nothing today</div>
                    </div>
                    <div className="cr-control">
                      <span className="badge">off</span>
                    </div>
                  </div>
                  <div className="more">
                    <button type="button" className="btn btn--outline btn--sm">
                      Load more
                    </button>
                    <span className="note">4 of 12 tools.</span>
                  </div>
                </div>
                <div className="save">
                  <button type="button" className="btn btn--danger-ghost btn--sm">
                    Revoke
                  </button>
                  <span className="save-end">
                    <span className="muted">2 saved</span>
                    <button type="button" className="btn btn--primary btn--sm">
                      Save
                    </button>
                  </span>
                </div>
              </div>
              <div className="details">
                <div className="dh">
                  <div className="mono">create_issue</div>
                </div>
                <div className="db">
                  <div className="card card--pad">
                    <div className="eyebrow">Standing</div>
                    <div className="kv">
                      <div className="kv-row">
                        <div className="kv-key">Standing</div>
                        <div>in Allowed</div>
                      </div>
                      <div className="kv-row">
                        <div className="kv-key">Reachable by</div>
                        <div>triage-bot, release-bot and every agent granted reader</div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </main>
      }
      next={
        <Page shape="workspace" level={level} className="w-full">
          <Workspace>
            <Pane split>
              <Listing>
                <ListingHead>
                  <TitleRow split>
                    <ListingTitle render={<span />} className="mono">
                      github
                    </ListingTitle>
                    <TitleRowEnd>
                      <button type="button" className="btn btn--outline btn--sm">
                        Open in Audit
                      </button>
                    </TitleRowEnd>
                  </TitleRow>
                  <Sum>Reaches 12 tools · 2 ask first</Sum>
                </ListingHead>
                <ListingScroll>
                  <GroupHead sticky>
                    <span>Tools · 4</span>
                    <GroupHeadNote render={<span />}>newest first</GroupHeadNote>
                  </GroupHead>
                  <ListRow>
                    <div>
                      <div className="mono">create_issue</div>
                      <ListRowDetail>asked 3 times this week</ListRowDetail>
                    </div>
                    <ListRowControl>
                      <Via>via reader</Via>
                      <button type="button" className="btn btn--outline btn--sm">
                        Allow
                      </button>
                    </ListRowControl>
                  </ListRow>
                  <ListRow sub>
                    <div className="mono">github/create_issue_with_a_very_long_unbroken_pattern_name</div>
                    <ListRowControl>
                      <span className="badge">ask</span>
                    </ListRowControl>
                  </ListRow>
                  <ListRow dim>
                    <div>
                      <div className="mono">delete_repo</div>
                      <ListRowDetail warn>matches nothing today</ListRowDetail>
                    </div>
                    <ListRowControl>
                      <span className="badge">off</span>
                    </ListRowControl>
                  </ListRow>
                  <ListingMore>
                    <button type="button" className="btn btn--outline btn--sm">
                      Load more
                    </button>
                    <span className="note">4 of 12 tools.</span>
                  </ListingMore>
                </ListingScroll>
                <SaveBar>
                  <button type="button" className="btn btn--danger-ghost btn--sm">
                    Revoke
                  </button>
                  <SaveBarEnd render={<span />}>
                    <SaveBarCount>2 saved</SaveBarCount>
                    <button type="button" className="btn btn--primary btn--sm">
                      Save
                    </button>
                  </SaveBarEnd>
                </SaveBar>
              </Listing>
              <Details>
                <DetailsHead>
                  <div className="mono">create_issue</div>
                </DetailsHead>
                <DetailsBody>
                  <Card size="sm">
                    <div className="eyebrow">Standing</div>
                    <KvList>
                      <Kv k="Standing">in Allowed</Kv>
                      <Kv k="Reachable by">triage-bot, release-bot and every agent granted reader</Kv>
                    </KvList>
                  </Card>
                </DetailsBody>
              </Details>
            </Pane>
          </Workspace>
        </Page>
      }
    />
  );
}
