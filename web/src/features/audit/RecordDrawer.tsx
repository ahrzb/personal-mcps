import { Dialog } from "@base-ui/react/dialog";
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
  siblingsOf,
  titleOf,
  treeSearch,
} from "./derive";
import type { Filter } from "./derive";
import { JsonTree } from "./JsonTree";
import { OutcomeBadge, SearchBox, Swatch, Titled, useCopied } from "./parts";

/**
 * The record — one event as a request inspector, in a right-hand drawer at wide and a
 * full-screen level on the phone.
 *
 * A Base UI **Dialog**, not a hand-rolled panel: focus is trapped, Escape closes, the page
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
    <Dialog.Root open onOpenChange={(next) => (next ? undefined : onClose())}>
      <Dialog.Portal>
        <Dialog.Backdrop className="audit-scrim" />
        <Dialog.Popup className="audit-drawer" finalFocus={opener} data-slot="dialog-content">
          {gone || head === undefined ? (
            <>
              <Head title={{ title: gone ? `Record ${id}` : "Record", secondary: null }} onClose={onClose} />
              <div className="a-dbody">
                {gone ? (
                  <div className="empty empty--inline">
                    <div className="empty-title">That record is gone</div>
                    <div className="empty-text">Audit rows are kept for {retentionDays} days.</div>
                    <button type="button" className="btn btn--outline btn--sm" onClick={onClose}>
                      Close
                    </button>
                  </div>
                ) : (
                  <p className="note">Reading the record…</p>
                )}
              </div>
            </>
          ) : (
            <>
              <Head title={titleOf(head)} time={fmtStamp(head.ts)} cls={outcomeClass(head.outcome)} onClose={onClose} />
              <div className="a-dbody">
                <SearchBox
                  value={needle}
                  onChange={setNeedle}
                  placeholder="Search this record…"
                  label="Search this record"
                />

                <div>
                  <p className="eyebrow">Record</p>
                  <Fields row={head} onFilter={onFilter} />
                </div>

                {record.isPending ? (
                  <>
                    <BodySkeleton label="Arguments" />
                    <BodySkeleton label="Result" />
                    <p className="note">Bodies are read on their own, by id — the fields above came with the row.</p>
                  </>
                ) : (
                  <>
                    <Section label="Arguments" value={full?.args} open={open} setOpen={setOpen} needle={needle} />
                    <Section label="Result" value={full?.result} open={open} setOpen={setOpen} needle={needle} />
                    {full?.noBodies === undefined ? null : <p className="note">{NO_BODIES_SENTENCE[full.noBodies]}</p>}
                    <Section label="Detail" value={head.detail} open={open} setOpen={setOpen} needle={needle} />
                    {/* Said once for the whole record rather than per section: three "no
                        matches" under three headings reads as three failures. */}
                    {needle.trim() !== "" && matchesIn([full?.args, full?.result, head.detail], needle) === 0 ? (
                      <p className="note">No matches in this record.</p>
                    ) : null}
                  </>
                )}

                <Chain row={head} rows={rows} onOpenRecord={onOpenRecord} />

                <div className="a-actions">
                  <button
                    type="button"
                    className="btn btn--outline btn--sm"
                    disabled={head.client?.sessionId === undefined}
                    onClick={() => {
                      const sessionId = head.client?.sessionId;
                      if (sessionId !== undefined) onShowSession(sessionId);
                    }}
                  >
                    Show this session
                  </button>
                  {/* The clipboard gets the FULL row where it has landed and the slim one
                      otherwise — never a mixture, which would be a shape no read answers. */}
                  <button
                    type="button"
                    className="btn btn--outline btn--sm"
                    aria-live="polite"
                    onClick={() => {
                      void navigator.clipboard?.writeText(JSON.stringify(full ?? head, null, 1)).then(markCopied, () => undefined);
                    }}
                  >
                    {copied ? "Copied" : "Copy as JSON"}
                  </button>
                </div>
              </div>
            </>
          )}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
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
    <div className="a-dhead">
      <button type="button" className="a-dback" onClick={onClose}>
        ‹ Audit
      </button>
      {cls === undefined ? null : <Swatch cls={cls} />}
      <Dialog.Title render={<span />} className="a-dtitle mono">
        <Titled of={title} />
      </Dialog.Title>
      {time === undefined ? null : <span className="note a-dtime">{time}</span>}
      <button type="button" className="btn btn--outline btn--sm a-dclose wide-only" onClick={onClose}>
        Close
      </button>
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
  const cls = outcomeClass(row.outcome);
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
      "outcome",
      <span key="o">
        <OutcomeBadge cls={cls} /> <span className="a-dim mono">{row.outcome}</span>
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
    <table className="a-ftab">
      <tbody>
        {rows.map(([key, value]) => (
          <tr key={key}>
            <td className="a-ftab-k">{key}</td>
            <td className="a-ftab-v">{value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function IdButton({ value, onPick }: { value: string; onPick: () => void }): ReactNode {
  return (
    <button type="button" onClick={onPick} title={`Filter by ${value}`}>
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
      <p className="eyebrow">{label}</p>
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
      <p className="eyebrow">{label}</p>
      <span className="a-skel" style={{ width: "70%", display: "block" }} />
      <span className="a-skel" style={{ width: "52%", display: "block", marginTop: 6 }} />
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
      <p className="eyebrow">This approval, end to end</p>
      <div className="a-tl">
        {siblings.map((sibling) => (
          <button type="button" key={sibling.id} onClick={() => onOpenRecord(sibling)}>
            <span className="a-tl-t">{fmtClock(sibling.ts)}</span>
            <span className={sibling.id === row.id ? "a-tl-e a-tl--now" : "a-tl-e"}>
              <Titled of={titleOf(sibling)} />
            </span>
            <OutcomeBadge cls={outcomeClass(sibling.outcome)} />
            <span className="a-tl-r">{sibling.principal}</span>
          </button>
        ))}
      </div>
      <p className="note">
        Every row carrying this <span className="mono">detail.approvalId</span>, oldest first — the refused call, the
        request, your answer, and the dispatch that followed.
      </p>
    </div>
  );
}
