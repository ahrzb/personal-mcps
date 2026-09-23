import type { PrimitiveState } from "../../seed";
import { Crumb, CrumbSep, Page, PageHead, PageSubtitle, PageTitle, Pane, TitleRow, TitleRowEnd, Workspace } from "@/chrome/Page";
import { Tiles } from "@/chrome/Listing";
import { Columns } from "./Columns";

/**
 * The page frames' bench (`chrome/Page`): the three `<main>` shapes, the head with a crumb, a
 * subtitle, badges, totals and actions, and the workspace's framed box holding a stack pane —
 * each beside legacy.css's `.page--*`, `.page-head`, `.title-row`, `.crumb`, `.paned--framed`
 * and `.pane`. The split pane and its levels are `listing.tsx`'s.
 *
 * The rail in the framed box is a plain column of the rail's width on both sides: the real
 * one (`chrome/Panes`) is made of router links, which the bench has no router for, and is
 * gated on the pages that draw it.
 */
export const pageStates: Record<string, PrimitiveState> = {
  page: () => (
    <Columns
      legacy={
        <>
          <main className="page--table">
            <div className="page-head">
              <div>
                <h1 className="page-title">Apps</h1>
                <p className="page-subtitle">MCP servers this hub proxies for your agents.</p>
              </div>
              <button type="button" className="btn btn--primary">
                Add app
              </button>
            </div>
            <div className="card card--pad">A table would sit here.</div>
          </main>
          <main className="page--document">
            <div className="page-head">
              <div>
                <div className="title-row">
                  <a className="crumb" href="#agents">
                    Agents
                  </a>
                  <span className="crumb-sep" aria-hidden="true">
                    ›
                  </span>
                  <h1 className="page-title mono">triage-bot</h1>
                  <span className="page-subtitle">Sorts the inbox</span>
                </div>
                <p className="page-subtitle">Created Aug 24, 2026</p>
              </div>
              <div className="tiles">3 apps · 5 allow · 2 ask first · 0 dormant</div>
            </div>
          </main>
          <main className="page--workspace">
            <div className="page-head">
              <div className="title-row title-row--split">
                <h1 className="page-title">Activity</h1>
                <span className="badge">12</span>
                <div className="title-row-end">
                  <button type="button" className="btn btn--outline btn--sm">
                    Open in Audit
                  </button>
                </div>
              </div>
            </div>
          </main>
        </>
      }
      next={
        <>
          <Page shape="table">
            <PageHead>
              <div>
                <PageTitle>Apps</PageTitle>
                <PageSubtitle>MCP servers this hub proxies for your agents.</PageSubtitle>
              </div>
              <button type="button" className="btn btn--primary max-md:flex-[1_1_100%]">
                Add app
              </button>
            </PageHead>
            <div className="card card--pad">A table would sit here.</div>
          </Page>
          <Page shape="document">
            <PageHead>
              <div>
                <TitleRow>
                  <Crumb href="#agents">Agents</Crumb>
                  <CrumbSep />
                  <PageTitle className="mono">triage-bot</PageTitle>
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
                <span className="badge">12</span>
                <TitleRowEnd>
                  <button type="button" className="btn btn--outline btn--sm">
                    Open in Audit
                  </button>
                </TitleRowEnd>
              </TitleRow>
            </PageHead>
          </Page>
        </>
      }
    />
  ),

  // /settings' shape: the framed box with a stack pane of cards, the Password pane's 640px cap.
  "page-workspace": () => (
    <Columns
      legacy={
        <main className="page--workspace w-full">
          <div className="paned paned--framed">
            <div className={RAIL_STAND_IN} />
            <div className="pane pane--narrow">
              <div className="card card--pad">
                <div className="card-title">Password</div>
                <p className="note">At least twelve characters.</p>
              </div>
              <div className="card card--pad">Another card in the stack.</div>
            </div>
          </div>
        </main>
      }
      next={
        <Page shape="workspace" className="w-full">
          <Workspace>
            <div className={RAIL_STAND_IN} />
            <Pane narrow>
              <div className="card card--pad">
                <div className="card-title">Password</div>
                <p className="note">At least twelve characters.</p>
              </div>
              <div className="card card--pad">Another card in the stack.</div>
            </Pane>
          </Workspace>
        </Page>
      }
    />
  ),
};

/** The rail's box without the rail: its width, ground and rule. */
const RAIL_STAND_IN = "w-rail shrink-0 border-r bg-sunken max-lg:hidden";
