import type { ReactNode } from "react";
import type { PrimitiveState } from "../../seed";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Eyebrow, Note } from "@/chrome/Text";
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
import { Bench } from "./Bench";

/**
 * The split pane's bench (`chrome/Listing`, in `chrome/Page`'s workspace): the agent page's
 * listing — head, sticky group heading with a note, rows plain, dimmed, dormant, nested and
 * with a `via`, the paged foot, the save bar — beside its details column.
 *
 * Shot at each narrow level: at 1280 all three states draw the framed box; at 390 level 2 is
 * the listing alone and level 3 the details alone. `listing-wide` is the listing alone in its
 * pane, with its padded key/value block and its capped details body.
 */
export const listingStates: Record<string, PrimitiveState> = {
  listing: () => <Split level={2} />,
  "listing-details": () => <Split level={3} />,

  "listing-wide": () => (
    <Bench>
      <Page shape="workspace" level={2} className="w-full">
        <Workspace>
          <Pane split>
            <Listing wide>
              <ListingHead>
                <ListingTitle render={<span />}>Overview</ListingTitle>
              </ListingHead>
              <KvList variant="block" className="max-w-pane p-4">
                <Kv k="Upstream">
                  <span className="font-mono">mcp.example.com</span>
                </Kv>
              </KvList>
              <DetailsBody>
                <Card size="sm">A capped details body.</Card>
              </DetailsBody>
            </Listing>
          </Pane>
        </Workspace>
      </Page>
    </Bench>
  ),
};

/** The agent page's split pane at one narrow level. */
function Split({ level }: { level: 2 | 3 }): ReactNode {
  return (
    <Bench>
      <Page shape="workspace" level={level} className="w-full">
        <Workspace>
          <Pane split>
            <Listing>
              <ListingHead>
                <TitleRow split>
                  <ListingTitle render={<span />} className="font-mono">
                    github
                  </ListingTitle>
                  <TitleRowEnd>
                    <Button variant="outline" size="sm">
                      Open in Audit
                    </Button>
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
                    <div className="font-mono">create_issue</div>
                    <ListRowDetail>asked 3 times this week</ListRowDetail>
                  </div>
                  <ListRowControl>
                    <Via>via reader</Via>
                    <Button variant="outline" size="sm">
                      Allow
                    </Button>
                  </ListRowControl>
                </ListRow>
                <ListRow sub>
                  <div className="font-mono">github/create_issue_with_a_very_long_unbroken_pattern_name</div>
                  <ListRowControl>
                    <Badge>ask</Badge>
                  </ListRowControl>
                </ListRow>
                <ListRow dim>
                  <div>
                    <div className="font-mono">delete_repo</div>
                    <ListRowDetail warn>matches nothing today</ListRowDetail>
                  </div>
                  <ListRowControl>
                    <Badge>off</Badge>
                  </ListRowControl>
                </ListRow>
                <ListingMore>
                  <Button variant="outline" size="sm">
                    Load more
                  </Button>
                  <Note render={<span />}>4 of 12 tools.</Note>
                </ListingMore>
              </ListingScroll>
              <SaveBar>
                <Button variant="danger-ghost" size="sm">
                  Revoke
                </Button>
                <SaveBarEnd render={<span />}>
                  <SaveBarCount>2 saved</SaveBarCount>
                  <Button size="sm">Save</Button>
                </SaveBarEnd>
              </SaveBar>
            </Listing>
            <Details>
              <DetailsHead>
                <div className="font-mono">create_issue</div>
              </DetailsHead>
              <DetailsBody>
                <Card size="sm">
                  <Eyebrow>Standing</Eyebrow>
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
    </Bench>
  );
}
