import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import type { ReactNode, RefObject } from "react";
import { useApi } from "@/lib/api-context";
import { ApiError } from "@/lib/http";
import { auditRecordQuery } from "@/lib/queries";
import { usePreviewTransient } from "@/preview/transient";
import type { AuditEventRow, AuditWindowRow } from "@/lib/types";
import {
  NO_BODIES_SENTENCE,
  fmtClock,
  fmtDuration,
  fmtStamp,
  outcomeClass,
  outcomeRow,
  outcomeSentence,
  siblingsOf,
  titleOf,
  treeSearch,
} from "./derive";
import type { Filter } from "./derive";
import { JsonTree } from "./JsonTree";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyTitle } from "@/components/ui/empty";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import {
  BACK,
  EYEBROW,
  HOVER_RING,
  LEVEL_HEAD,
  NOTE,
  OutcomeBadge,
  SearchBox,
  SkelBar,
  Swatch,
  Titled,
  useCopied,
} from "./parts";

/**
 * The record — one event as a request inspector, in a right-hand drawer at wide and a
 * full-screen level on the phone.
 *
 * A **Sheet** (a Base UI Dialog), not a hand-rolled panel: focus is trapped, Escape closes, the page
 * behind it is inert, and `finalFocus` puts the caret back on the row that opened it. A reader
 * who opened the fortieth row with the keyboard must not be returned to the top of the table.
 *
 * TWO reads make one screen, and the split is the point. The field table draws from the slim
 * row the window already holds, so it is on screen in the same frame as the drawer; the bodies
 * are a one-row read made when the drawer opens, and the body sections show a skeleton until
 * they land. That read does not need the window, which is what lets an `?expand=` link from a
 * month-old email open a record the loaded window never reached.
 */
export function RecordDrawer({
  /** The row id from `?expand=`. */
  id,
  /** The slim row, when the loaded window happens to hold it — absent for a deep link. */
  row,
  /** Every loaded row, for a chain record's sibling timeline. */
  rows,
  retentionDays,
  opener,
  onClose,
  onFilter,
  onShowSession,
  onOpenRecord,
}: {
  id: string;
  row: AuditWindowRow | undefined;
  rows: AuditWindowRow[];
  retentionDays: number;
  /** What focus returns to when the drawer closes. */
  opener: RefObject<HTMLElement | null>;
  onClose: () => void;
  /** An id button: filters by it and closes the drawer. */
  onFilter: (filter: Filter) => void;
  onShowSession: (sessionId: string) => void;
  onOpenRecord: (row: AuditWindowRow) => void;
}): ReactNode {
  const api = useApi();
  const record = useQuery(auditRecordQuery(api, id));
  // The search's INITIAL value only. In production the context is empty and this is "", which is
  // the same code path a fresh mount takes — there is no preview branch here.
  const [needle, setNeedle] = useState(usePreviewTransient().recordSearch ?? "");
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [copied, markCopied] = useCopied();

  // The full row once it lands, else the slim one, else nothing at all — which is the deep-link
  // case while the read is in flight, and the only case with no head to draw.
  const full = record.data?.row;
  const head: AuditWindowRow | AuditEventRow | undefined = full ?? row;
  const gone = record.isError && record.error instanceof ApiError && record.error.status === 404;

  return (
    <Sheet open onOpenChange={(next) => (next ? undefined : onClose())}>
      <SheetContent variant="panel" finalFocus={opener}>
          {gone || head === undefined ? (
            <>
              <Head title={{ title: gone ? `Record ${id}` : "Record", secondary: null }} onClose={onClose} />
              <div className={BODY}>
                {gone ? (
                  <Empty variant="inline">
                    <EmptyTitle>That record is gone</EmptyTitle>
                    <EmptyDescription>Audit rows are kept for {retentionDays} days.</EmptyDescription>
                    <Button variant="outline" size="sm" className="mt-4" onClick={onClose}>
                      Close
                    </Button>
                  </Empty>
                ) : (
                  <p className={NOTE}>Reading the record…</p>
                )}
              </div>
            </>
          ) : (
            <>
              <Head title={titleOf(head)} time={fmtStamp(head.ts)} cls={outcomeClass(head.outcome)} onClose={onClose} />
              <div className={BODY}>
                {/* No debounce here: this search filters a body already in hand, so there is
                    nothing to wait for and every keystroke can highlight at once. */}
                <SearchBox
                  initial={needle}
                  onSettled={setNeedle}
                  debounceMs={0}
                  placeholder="Search this record…"
                  label="Search this record"
                />

                <div>
                  <p className={EYEBROW}>Record</p>
                  <Fields row={head} onFilter={onFilter} />
                </div>

                {record.isPending ? (
                  <>
                    <BodySkeleton label="Arguments" />
                    <BodySkeleton label="Result" />
                    <p className={NOTE}>Bodies are read on their own, by id — the fields above came with the row.</p>
                  </>
                ) : (
                  <>
                    <Section label="Arguments" value={full?.args} open={open} setOpen={setOpen} needle={needle} />
                    <Section label="Result" value={full?.result} open={open} setOpen={setOpen} needle={needle} />
                    {full?.noBodies === undefined ? null : <p className={NOTE}>{NO_BODIES_SENTENCE[full.noBodies]}</p>}
                    <Section label="Detail" value={head.detail} open={open} setOpen={setOpen} needle={needle} />
                    {/* Said once for the whole record rather than per section: three "no
                        matches" under three headings reads as three failures. */}
                    {needle.trim() !== "" && matchesIn([full?.args, full?.result, head.detail], needle) === 0 ? (
                      <p className={NOTE}>No matches in this record.</p>
                    ) : null}
                  </>
                )}

                <Chain row={head} rows={rows} onOpenRecord={onOpenRecord} />

                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={head.client?.sessionId === undefined}
                    onClick={() => {
                      const sessionId = head.client?.sessionId;
                      if (sessionId !== undefined) onShowSession(sessionId);
                    }}
                  >
                    Show this session
                  </Button>
                  {/* The clipboard gets the FULL row where it has landed and the slim one
                      otherwise — never a mixture, which would be a shape no read answers. */}
                  <Button
                    variant="outline"
                    size="sm"
                    aria-live="polite"
                    onClick={() => {
                      void navigator.clipboard?.writeText(JSON.stringify(full ?? head, null, 1)).then(markCopied, () => undefined);
                    }}
                  >
                    {copied ? "Copied" : "Copy as JSON"}
                  </Button>
                </div>
              </div>
            </>
          )}
      </SheetContent>
    </Sheet>
  );
}

/** The drawer's head, which is also the phone's level header: `‹ Audit` on its own line above
 *  the swatch, the title and the time. */
function Head({
  title,
  time,
  cls,
  onClose,
}: {
  title: { title: string; secondary: string | null };
  time?: string;
  cls?: ReturnType<typeof outcomeClass>;
  onClose: () => void;
}): ReactNode {
  return (
    <div className={LEVEL_HEAD}>
      <button type="button" className={`${BACK} hidden max-md:inline-flex`} onClick={onClose}>
        ‹ Audit
      </button>
      {cls === undefined ? null : <Swatch cls={cls} />}
      {/* One line at wide, clipped; on the phone it wraps, since the level has the room. */}
      <SheetTitle
        render={<span />}
        className="min-w-0 truncate font-mono text-base font-semibold max-md:flex-[0_1_auto] max-md:overflow-visible max-md:whitespace-normal max-md:wrap-anywhere"
      >
        <Titled of={title} />
      </SheetTitle>
      {time === undefined ? null : <span className={`${NOTE} whitespace-nowrap`}>{time}</span>}
      <Button variant="outline" size="sm" className="ml-auto max-md:hidden" onClick={onClose}>
        Close
      </Button>
    </div>
  );
}

/**
 * The field table: what the ledger recorded about this event, in §13's order.
 *
 * Every id is a BUTTON that filters the list by it and closes the drawer — the one place the
 * page turns reading into narrowing, which is what makes "who else called this" one click
 * rather than a trip to the rail. The outcome shows its raw code beside the class, because the
 * class is the page's grouping and the code is what the ledger holds.
 */
function Fields({ row, onFilter }: { row: AuditWindowRow | AuditEventRow; onFilter: (filter: Filter) => void }): ReactNode {
  const shown = outcomeRow(row.outcome);
  const sentence = outcomeSentence(row);
  const sessionId = row.client?.sessionId;
  const rows: [string, ReactNode][] = [
    ["when", `${fmtStamp(row.ts)} UTC`],
    ["principal", <IdButton key="p" value={row.principal} onPick={() => onFilter({ field: "principal", value: row.principal })} />],
    ["event", <IdButton key="e" value={row.event} onPick={() => onFilter({ field: "event", value: row.event })} />],
    [
      "app",
      row.app === undefined ? (
        "—"
      ) : (
        <IdButton key="a" value={row.app} onPick={() => onFilter({ field: "app", value: row.app as string })} />
      ),
    ],
    [
      "tool",
      row.tool === undefined || row.app === undefined ? (
        "—"
      ) : (
        <IdButton
          key="t"
          value={`${row.app}/${row.tool}`}
          onPick={() => onFilter({ field: "tool", value: `${row.app}/${row.tool}` })}
        />
      ),
    ],
    [
      // The ONE place a raw code is printed, and never on its own: the chip, then what the code
      // MEANS, then the code itself dim — because that last value is what `pmcp audit
      // --outcome` and the export take, and nothing else on the page would let a reader find it.
      // `outcomeRow` drops whichever of the three the one before it already said.
      "outcome",
      <span key="o">
        <OutcomeBadge cls={shown.cls} />
        {/* The label is WORDS, so it is set in words: a label in mono beside the mono ids
            reads as a second code. What the outcome MEANS goes under it, in prose, capped at
            the sheet's measure so a three-clause refusal does not run the drawer's width. */}
        {shown.label === null ? null : <> <span className="font-sans">{shown.label}</span></>}
        {shown.code === null ? null : <> <span className="font-mono text-muted-foreground">{shown.code}</span></>}
        {sentence === null ? null : <span className={WHY}>{sentence}</span>}
      </span>,
    ],
    ["duration", fmtDuration(row.durationMs)],
    ["client", row.client?.name === undefined ? "—" : `${row.client.name} ${row.client.version ?? ""}`],
    [
      "session",
      sessionId === undefined ? (
        "—"
      ) : (
        <IdButton key="s" value={sessionId} onPick={() => onFilter({ field: "session", value: sessionId })} />
      ),
    ],
    ["id", String(row.id)],
  ];
  return (
    <table className="w-full border-collapse max-md:block">
      <tbody className="max-md:block">
        {rows.map(([key, value]) => (
          /* The outcome row is the one whose value is TWO lines — a chip line and a sentence
             under it — so it is the one that must top-align. Centred, its key drifts down
             beside the sentence and the chip line is left with no key at all. Every other row
             is one line, where top and centre are the same thing. */
          <tr key={key} className={key === "outcome" ? `${FIELD_ROW} max-md:items-start` : FIELD_ROW}>
            <td className={`${cellOf(key)} w-[1%] whitespace-nowrap text-muted-foreground max-md:w-auto`}>{key}</td>
            <td className={`${cellOf(key)} font-mono break-all`}>{value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function IdButton({ value, onPick }: { value: string; onPick: () => void }): ReactNode {
  return (
    <button type="button" className={ID_BUTTON} onClick={onPick} title={`Filter by ${value}`}>
      {value}
    </button>
  );
}

/** One body section, or nothing at all: a row that recorded no arguments has no Arguments
 *  panel, and the no-bodies sentence beneath is what says why. */
function Section({
  label,
  value,
  open,
  setOpen,
  needle,
}: {
  label: string;
  value: unknown;
  open: Record<string, boolean>;
  setOpen: (next: (held: Record<string, boolean>) => Record<string, boolean>) => void;
  needle: string;
}): ReactNode {
  if (value === undefined) return null;
  const path = label.toLowerCase();
  return (
    <div>
      <p className={EYEBROW}>{label}</p>
      <JsonTree
        value={value}
        path={path}
        open={open}
        needle={needle}
        onToggle={(at) =>
          setOpen((held) => ({ ...held, [at]: !(held[at] ?? at.split(".").length <= 1) }))
        }
      />
    </div>
  );
}

/** How many leaves and keys the needle hits across the record's three bodies — nothing more
 *  than "is there anything to see", which is what the sentence below the trees turns on. */
function matchesIn(bodies: unknown[], needle: string): number {
  return bodies.reduce<number>(
    (total, body) => total + (body === undefined ? 0 : treeSearch(body, "", needle).matches),
    0,
  );
}

function BodySkeleton({ label }: { label: string }): ReactNode {
  return (
    <div aria-busy="true">
      <p className={EYEBROW}>{label}</p>
      <SkelBar width="70%" className="block" />
      <SkelBar width="52%" className="mt-1.5 block" />
    </div>
  );
}

/**
 * A chain record's siblings, oldest first — the refused call, the request, the answer and the
 * dispatch, each line opening its own record.
 *
 * Drawn only when the loaded window holds more than one row of the chain. A deep link into a
 * chain therefore shows no timeline, which is honest: the one-row read fetched one row, and
 * inventing the rest would need a read this drawer does not make.
 */
function Chain({
  row,
  rows,
  onOpenRecord,
}: {
  row: AuditWindowRow | AuditEventRow;
  rows: AuditWindowRow[];
  onOpenRecord: (row: AuditWindowRow) => void;
}): ReactNode {
  const approvalId = row.detail?.approvalId;
  if (typeof approvalId !== "string") return null;
  const siblings = siblingsOf(rows, approvalId);
  if (siblings.length <= 1) return null;
  return (
    <div>
      <p className={EYEBROW}>This approval, end to end</p>
      <div className="flex flex-col gap-0.5">
        {siblings.map((sibling) => (
          <button type="button" key={sibling.id} className={SIBLING} onClick={() => onOpenRecord(sibling)}>
            <span className="w-[52px] flex-none font-mono text-muted-foreground">{fmtClock(sibling.ts)}</span>
            <span className={sibling.id === row.id ? "font-mono font-semibold" : "font-mono"}>
              <Titled of={titleOf(sibling)} />
            </span>
            <OutcomeBadge cls={outcomeClass(sibling.outcome)} />
            <span className="ml-auto pl-2 text-muted-foreground">{sibling.principal}</span>
          </button>
        ))}
      </div>
      <p className={NOTE}>
        Every row carrying this <span className="font-mono">detail.approvalId</span>, oldest first — the refused call, the
        request, your answer, and the dispatch that followed.
      </p>
    </div>
  );
}

/** The drawer's scrolling body: its sections 14px apart. */
const BODY = "flex flex-1 flex-col gap-3.5 overflow-auto px-4 py-3.5 max-md:py-3";

/**
 * A row of the field table. On the phone it is one grid row per field, a fixed key column and
 * the value beside it, with a hairline under EVERY row. A `<table>` cannot be asked for that, so
 * its parts become blocks and the row becomes the grid.
 */
const FIELD_ROW =
  "max-md:grid max-md:min-h-control-touch max-md:grid-cols-[84px_minmax(0,1fr)] max-md:items-center max-md:border-b max-md:border-row-border";

/**
 * A field table cell, key or value. Both carry the same 20px line height, so the outcome row —
 * the one whose value runs to two lines, a chip line and a sentence — tops both cells: the
 * key's line lands on the chip line and the sentence hangs beneath it. Centred, the key would
 * drift down beside the sentence. On the phone a cell is a wrapping flex row.
 */
const cellOf = (key: string): string =>
  key === "outcome"
    ? `${CELL} align-top max-md:content-start max-md:items-start`
    : `${CELL} max-md:items-center`;

const CELL =
  "border-0 py-0.5 pr-2 pl-0 text-xs leading-5 max-md:flex max-md:flex-wrap max-md:gap-x-1.5 max-md:gap-y-1 max-md:self-stretch max-md:px-0 max-md:py-[5px] max-md:leading-[18px]";

/** An id in the field table: it filters the list by itself. On the phone it fills its row, so
 *  the tap target is the row and not the text. */
const ID_BUTTON =
  "cursor-pointer border-0 bg-transparent p-0 text-left font-mono text-xs leading-[inherit] text-inherit underline underline-offset-2 max-md:inline-flex max-md:items-center max-md:self-stretch";

/** What the outcome means, on its own line under the code. */
const WHY = `${NOTE} mt-0.5 block font-sans leading-normal [word-break:normal] wrap-anywhere max-md:mt-1 max-md:flex-[1_1_100%]`;

/** A line of the approval's timeline, opening that row's record. */
const SIBLING = `flex min-h-control-xs w-full cursor-pointer items-center gap-2 rounded-[5px] border-0 bg-transparent px-[5px] py-0 text-left font-[family-name:inherit] text-xs text-inherit ${HOVER_RING} max-md:min-h-control-touch`;
