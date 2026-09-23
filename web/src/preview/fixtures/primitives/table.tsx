import type { PrimitiveState } from "../../seed";
import { RowLink } from "@/chrome/Listing";
import { Note, RowMeta, RowTitle } from "@/chrome/Text";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableRowChevron,
} from "@/components/ui/table";
import { Bench } from "./Bench";

/**
 * The Table bench: `<Table>` wide and stacked into cards at 390, with the cell shapes its pages
 * write, and /audit's events table (`size="dense"`).
 *
 * It is also the recipe a page follows: a link row is `TableRow link`, the actions and mono
 * cells are `TableCell`'s variants and the actions cell's buttons are `size="cell"`, and the
 * other cells are spelled in utilities, exactly as below (`CELL`). What a cell holds is its
 * page's own markup, in that page's classes.
 *
 * Hover is not benched: the compare never moves the pointer.
 */
export const tableStates: Record<string, PrimitiveState> = {
  // /agents: rows that are links (the stretched `.row-link`), a raised actions cell with a
  // button and a chevron, a muted cell, and /settings' receded (`.row--dim`) row.
  table: () => (
    <Bench>
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
                <RowTitle className="font-mono">
                  <RowLink href="#triage-bot">triage-bot</RowLink>
                </RowTitle>
                <RowMeta>Sorts the support inbox every morning.</RowMeta>
              </TableCell>
              <TableCell className={CELL.muted}>3 apps</TableCell>
              <TableCell className={CELL.muted}>Aug 24, 2026</TableCell>
              <TableCell variant="actions">
                <a className={buttonVariants({ variant: "danger-outline", size: "cell" })} href="#delete">
                  Delete
                </a>
                <TableRowChevron />
              </TableCell>
            </TableRow>
            <TableRow className={CELL.dimRow}>
              <TableCell>
                <a href="#release-bot">release-bot</a>
              </TableCell>
              <TableCell className={CELL.muted}>no grants</TableCell>
              <TableCell className={CELL.time}>Jul 02, 2026</TableCell>
              <TableCell variant="actions">
                <Badge variant="muted">Expired</Badge>
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </Card>
    </Bench>
  ),

  // /approvals' history: five columns wide, one summary cell narrow, and a mono cell long
  // enough to break inside itself.
  "table-summary": () => (
    <Bench>
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
                  <Badge variant={row.tone}>{row.outcome}</Badge>
                </TableCell>
                <TableCell className={CELL.summary}>
                  <div>
                    <RowTitle className="font-mono" render={<a href="#tool" />}>
                      {row.tool}
                    </RowTitle>
                    <Note render={<div />}>
                      {row.when} · {row.principal}
                    </Note>
                  </div>
                  <Badge variant={row.tone}>{row.outcome}</Badge>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
    </Bench>
  ),

  // /audit's events: 11px uppercase heads, 6px rows, a selected row, the rule kept under the
  // last row, and the row-wide focus ring of the stretched title button (`data-focus`). At
  // 390 each row is a wrapping flex card, ordered by the page.
  "table-dense": () => (
    <Bench>
      <Card size="flush" className="w-full">
        <Table size="dense">
          <TableHeader>
            <TableRow>
              <TableHead className="w-[152px]">When</TableHead>
              <TableHead className="w-[128px]">Who</TableHead>
              <TableHead>What happened</TableHead>
              <TableHead className="w-[128px]">Outcome</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {EVENTS.map((row, index) => (
              <TableRow
                key={row.what}
                data-state={row.selected ? "selected" : undefined}
                className="relative cursor-pointer hover:bg-sunken max-md:flex max-md:flex-wrap max-md:items-center max-md:gap-x-2 max-md:gap-y-1.5"
              >
                <TableCell className="font-mono whitespace-nowrap text-muted-foreground max-md:order-1">{row.when}</TableCell>
                <TableCell className="font-mono font-semibold whitespace-nowrap max-md:order-2">{row.who}</TableCell>
                <TableCell className="wrap-anywhere max-md:order-4 max-md:min-w-0 max-md:flex-[0_0_100%]">
                  <div className="flex flex-wrap items-baseline gap-2">
                    <RowLink
                      render={<button type="button" />}
                      className={ROW_BUTTON}
                      data-focus={index === 0 ? "" : undefined}
                    >
                      {row.what}
                    </RowLink>
                  </div>
                  <Note render={<div />} className="font-mono">
                    {row.args}
                  </Note>
                </TableCell>
                <TableCell className="max-md:order-3 max-md:ml-auto">
                  <Badge>{row.outcome}</Badge>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
    </Bench>
  ),
};

/**
 * The cell shapes and the row modifier the pages write, in utilities: what legacy.css's
 * `.table .cell-*` and `.row--dim` drew, at both widths.
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

/** /audit's row title: a real button, stretched over the row by `RowLink`, with the row's ring
 *  on its `::after` (EventsView's `ROW_LINK`). */
const ROW_BUTTON =
  "cursor-pointer border-0 bg-transparent p-0 text-left font-mono text-xs font-semibold text-inherit focus-visible:shadow-none focus-visible:outline-none focus-visible:after:rounded-sm focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-ring";

const HISTORY = [
  { when: "Aug 24, 14:02", principal: "agent:triage-bot", tool: "github/create_issue", outcome: "Approved", tone: "success" },
  {
    when: "Aug 23, 09:41",
    principal: "agent:release-bot",
    tool: "cloudflare/workers_deploy_script_with_a_very_long_unbroken_name",
    outcome: "Rejected",
    tone: "danger",
  },
] as const;

const EVENTS = [
  { when: "Aug 24 14:02:11", who: "agent:triage-bot", what: "github/create_issue", args: '{"title":"Crash on start"}', outcome: "ok", selected: false },
  { when: "Aug 24 14:01:57", who: "owner", what: "settings/token_revoke", args: '{"id":"tok_42"}', outcome: "ok", selected: true },
];
