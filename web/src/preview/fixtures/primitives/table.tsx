import type { ReactNode } from "react";
import type { PrimitiveState } from "../../seed";
import { buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Columns } from "./Columns";

/**
 * The Table bench: `.table` wide and stacked into cards at 390, with the cell shapes its pages
 * write, and /audit's `.a-etab` (`size="dense"`), each beside `<Table>`.
 *
 * The `next` side is also the recipe a page follows: `.table .cell-*` are descendant rules of
 * the `.table` class, so a converted page draws a link row with `TableRow link`, the actions
 * and mono cells with `TableCell`'s variants and the actions cell's buttons at `size="cell"`,
 * and spells the other cells in utilities, exactly as below (`CELL`). Classes that are not
 * scoped under `.table` (`.row-link`, `.cell-name`, `.mono`, `.badge`, `.row-chevron`,
 * audit's `a-tmono` and `a-who`) stay on both sides; they are other components' business.
 *
 * Hover is not benched: the compare never moves the pointer.
 */
export const tableStates: Record<string, PrimitiveState> = {
  // /agents: rows that are links (the stretched `.row-link`), a raised actions cell with a
  // button and a chevron, a muted cell, and /settings' receded (`.row--dim`) row.
  table: () => (
    <Columns
      legacy={
        <div className="card w-full">
          <table className="table">
            <thead>
              <tr>
                <th>Agent</th>
                <th>Access</th>
                <th>Created</th>
                <th />
              </tr>
            </thead>
            <tbody>
              <tr className="agent-row">
                <td>
                  <div className="cell-name mono">
                    <a className="row-link" href="#triage-bot">
                      triage-bot
                    </a>
                  </div>
                  <div className="list-meta">Sorts the support inbox every morning.</div>
                </td>
                <td className="cell-muted">3 apps</td>
                <td className="cell-muted">Aug 24, 2026</td>
                <td className="cell-actions">
                  <a className="btn btn--danger-outline btn--sm" href="#delete">
                    Delete
                  </a>
                  <span className="row-chevron">
                    <Chevron />
                  </span>
                </td>
              </tr>
              <tr className="row--dim">
                <td>
                  <a href="#release-bot">release-bot</a>
                </td>
                <td className="cell-muted">no grants</td>
                <td className="cell-time">Jul 02, 2026</td>
                <td className="cell-actions">
                  <span className="badge badge--muted">Expired</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      }
      next={
        <Card size="flush" className="w-full">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Agent</TableHead>
                <TableHead>Access</TableHead>
                <TableHead>Created</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow link>
                <TableCell>
                  <div className="cell-name mono">
                    <a className="row-link" href="#triage-bot">
                      triage-bot
                    </a>
                  </div>
                  <div className="list-meta">Sorts the support inbox every morning.</div>
                </TableCell>
                <TableCell className={CELL.muted}>3 apps</TableCell>
                <TableCell className={CELL.muted}>Aug 24, 2026</TableCell>
                <TableCell variant="actions">
                  <a className={buttonVariants({ variant: "danger-outline", size: "cell" })} href="#delete">
                    Delete
                  </a>
                  <span className="row-chevron">
                    <Chevron />
                  </span>
                </TableCell>
              </TableRow>
              <TableRow className={CELL.dimRow}>
                <TableCell>
                  <a href="#release-bot">release-bot</a>
                </TableCell>
                <TableCell className={CELL.muted}>no grants</TableCell>
                <TableCell className={CELL.time}>Jul 02, 2026</TableCell>
                <TableCell variant="actions">
                  <span className="badge badge--muted">Expired</span>
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </Card>
      }
    />
  ),

  // /approvals' history: five columns wide, one summary cell narrow, and a mono cell long
  // enough to break inside itself.
  "table-summary": () => (
    <Columns
      legacy={
        <div className="card w-full">
          <table className="table">
            <thead>
              <tr>
                <th>Decided</th>
                <th>Principal</th>
                <th>Tool</th>
                <th>Outcome</th>
              </tr>
            </thead>
            <tbody>
              {HISTORY.map((row) => (
                <tr key={row.tool}>
                  <td className="wide-only cell-time">{row.when}</td>
                  <td className="wide-only cell-mono">{row.principal}</td>
                  <td className="wide-only cell-mono">
                    <a href="#tool">{row.tool}</a>
                  </td>
                  <td className="wide-only">
                    <span className={`badge badge--${row.tone}`}>{row.outcome}</span>
                  </td>
                  <td className="cell-summary">
                    <div>
                      <a className="list-title mono" href="#tool">
                        {row.tool}
                      </a>
                      <div className="note">
                        {row.when} · {row.principal}
                      </div>
                    </div>
                    <span className={`badge badge--${row.tone}`}>{row.outcome}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      }
      next={
        <Card size="flush" className="w-full">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Decided</TableHead>
                <TableHead>Principal</TableHead>
                <TableHead>Tool</TableHead>
                <TableHead>Outcome</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {HISTORY.map((row) => (
                <TableRow key={row.tool}>
                  <TableCell className={`max-md:hidden ${CELL.time}`}>{row.when}</TableCell>
                  <TableCell variant="mono" className="max-md:hidden">{row.principal}</TableCell>
                  <TableCell variant="mono" className="max-md:hidden">
                    <a href="#tool">{row.tool}</a>
                  </TableCell>
                  <TableCell className="max-md:hidden">
                    <span className={`badge badge--${row.tone}`}>{row.outcome}</span>
                  </TableCell>
                  <TableCell className={CELL.summary}>
                    <div>
                      <a className="list-title mono" href="#tool">
                        {row.tool}
                      </a>
                      <div className="note">
                        {row.when} · {row.principal}
                      </div>
                    </div>
                    <span className={`badge badge--${row.tone}`}>{row.outcome}</span>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      }
    />
  ),

  // /audit's events: 11px uppercase heads, 6px rows, a selected row, the rule kept under the
  // last row, and the row-wide focus ring of the stretched title button (`data-focus`). At
  // 390 each row is a wrapping flex card, ordered by the page.
  "table-dense": () => (
    <Columns
      legacy={
        <div className="card w-full">
          <table className="a-etab">
            <thead>
              <tr>
                <th className="a-th-when">When</th>
                <th className="a-th-who">Who</th>
                <th>What happened</th>
                <th className="a-th-out">Outcome</th>
              </tr>
            </thead>
            <tbody>
              {EVENTS.map((row, index) => (
                <tr key={row.what} className={row.selected ? "a-ev a-ev--sel" : "a-ev"}>
                  <td className="a-when a-dim a-tmono">{row.when}</td>
                  <td className="a-who a-tmono">{row.who}</td>
                  <td className="a-what">
                    <div className="a-rowline">
                      <button type="button" className="a-rowlink a-tmono a-title" data-focus={index === 0 ? "" : undefined}>
                        {row.what}
                      </button>
                    </div>
                    <div className="note a-tmono">{row.args}</div>
                  </td>
                  <td className="a-out">
                    <span className="badge">{row.outcome}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      }
      next={
        <Card size="flush" className="w-full">
          <Table size="dense">
            <TableHeader>
              <TableRow>
                <TableHead className="a-th-when">When</TableHead>
                <TableHead className="a-th-who">Who</TableHead>
                <TableHead>What happened</TableHead>
                <TableHead className="a-th-out">Outcome</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {EVENTS.map((row, index) => (
                <TableRow
                  key={row.what}
                  data-state={row.selected ? "selected" : undefined}
                  className="relative cursor-pointer hover:bg-sunken max-md:flex max-md:flex-wrap max-md:items-center max-md:gap-x-2 max-md:gap-y-1.5"
                >
                  <TableCell className="a-dim font-mono whitespace-nowrap max-md:order-1">{row.when}</TableCell>
                  <TableCell className="a-who a-tmono whitespace-nowrap max-md:order-2">{row.who}</TableCell>
                  <TableCell className="wrap-anywhere max-md:order-4 max-md:min-w-0 max-md:flex-[0_0_100%]">
                    <div className="a-rowline">
                      <button type="button" className="a-rowlink a-tmono a-title" data-focus={index === 0 ? "" : undefined}>
                        {row.what}
                      </button>
                    </div>
                    <div className="note a-tmono">{row.args}</div>
                  </TableCell>
                  <TableCell className="max-md:order-3 max-md:ml-auto">
                    <span className="badge">{row.outcome}</span>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      }
    />
  ),
};

/**
 * legacy.css's `.table .cell-*` rules and the row modifiers, as the utilities a converted page
 * writes on its cells and rows. Each is its legacy rule at both widths.
 */
const CELL = {
  /** `.cell-muted` */
  muted: "text-muted-foreground",
  /** `.cell-time` */
  time: "font-mono text-xs text-muted-foreground whitespace-nowrap",
  /** `.cell-summary`: the one line a phone shows in place of the columns. */
  summary: "hidden max-md:flex max-md:items-center max-md:justify-between max-md:gap-3",
  /** `.row--dim`: every cell and link recedes, beating a cell's own colour. */
  dimRow: "[&>td]:text-ring [&>td_a]:text-ring",
};

const HISTORY = [
  { when: "Aug 24, 14:02", principal: "agent:triage-bot", tool: "github/create_issue", outcome: "Approved", tone: "success" },
  {
    when: "Aug 23, 09:41",
    principal: "agent:release-bot",
    tool: "cloudflare/workers_deploy_script_with_a_very_long_unbroken_name",
    outcome: "Rejected",
    tone: "danger",
  },
];

const EVENTS = [
  { when: "Aug 24 14:02:11", who: "agent:triage-bot", what: "github/create_issue", args: '{"title":"Crash on start"}', outcome: "ok", selected: false },
  { when: "Aug 24 14:01:57", who: "owner", what: "settings/token_revoke", args: '{"id":"tok_42"}', outcome: "ok", selected: true },
];

/** /agents' row chevron, 16px. */
function Chevron(): ReactNode {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m9 18 6-6-6-6" />
    </svg>
  );
}
