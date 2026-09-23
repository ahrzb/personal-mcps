import type { PrimitiveState } from "../../seed";
import { Crumb, CrumbSep, Page, PageHead, PageSubtitle, PageTitle, Pane, TitleRow, TitleRowEnd, Workspace } from "@/chrome/Page";
import { Tiles } from "@/chrome/Listing";
import { Note } from "@/chrome/Text";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardTitle } from "@/components/ui/card";
import { Bench } from "./Bench";

/**
 * The page frames' bench (`chrome/Page`): the three `<main>` shapes, the head with a crumb, a
 * subtitle, badges, totals and actions, and the workspace's framed box holding a stack pane.
 * The split pane and its levels are `listing.tsx`'s.
 *
 * The rail in the framed box is a plain column of the rail's width: the real one
 * (`chrome/Panes`) is made of router links, which the bench has no router for, and is gated
 * on the pages that draw it.
 */
export const pageStates: Record<string, PrimitiveState> = {
  page: () => (
    <Bench>
      <Page shape="table">
        <PageHead>
          <div>
            <PageTitle>Apps</PageTitle>
            <PageSubtitle>MCP servers this hub proxies for your agents.</PageSubtitle>
          </div>
          <Button className="max-md:flex-[1_1_100%]">Add app</Button>
        </PageHead>
        <Card>A table would sit here.</Card>
      </Page>
      <Page shape="document">
        <PageHead>
          <div>
            <TitleRow>
              <Crumb href="#agents">Agents</Crumb>
              <CrumbSep />
              <PageTitle className="font-mono">triage-bot</PageTitle>
              <PageSubtitle render={<span />}>Sorts the inbox</PageSubtitle>
            </TitleRow>
            <PageSubtitle>Created Aug 24, 2026</PageSubtitle>
          </div>
          <Tiles>3 apps · 5 allow · 2 ask first · 0 dormant</Tiles>
        </PageHead>
      </Page>
      <Page shape="workspace">
        <PageHead>
          <TitleRow split>
            <PageTitle>Activity</PageTitle>
            <Badge>12</Badge>
            <TitleRowEnd>
              <Button variant="outline" size="sm">
                Open in Audit
              </Button>
            </TitleRowEnd>
          </TitleRow>
        </PageHead>
      </Page>
    </Bench>
  ),

  // /settings' shape: the framed box with a stack pane of cards, the Password pane's 640px cap.
  "page-workspace": () => (
    <Bench>
      <Page shape="workspace" className="w-full">
        <Workspace>
          <div className={RAIL_STAND_IN} />
          <Pane narrow>
            <Card>
              <CardTitle>Password</CardTitle>
              <Note>At least twelve characters.</Note>
            </Card>
            <Card>Another card in the stack.</Card>
          </Pane>
        </Workspace>
      </Page>
    </Bench>
  ),
};

/** The rail's box without the rail: its width, ground and rule. */
const RAIL_STAND_IN = "w-rail shrink-0 border-r bg-sunken max-lg:hidden";
