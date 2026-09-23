/**
 * §23.6's alias rows: one `<tr>` per row, the canonical name beside its alias, paired by
 * index exactly as the composer reads them.
 *
 * ONE definition, drawn by BOTH editors of an app's TypeScript names: `/apps/new`'s form and
 * the app page's Overview pane. Each owns its draft and its spare-row padding; this draws
 * whatever rows it is handed and adds, removes and reorders none of them.
 *
 * A row's canonical name is an editable input, not a label: a spare row is how the owner
 * names a tool the hub has not seen, and retargeting a prefilled row is the same statement.
 * Each input carries its own `aria-label` because the narrow treatment hides the header row,
 * and a stacked pair of bare inputs with only a placeholder would have no name at all.
 *
 * Pure: props in, JSX out.
 */

import type { ReactNode } from "react";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { AliasRow } from "./derive";

export function AliasRows({
  rows,
  onRows,
}: {
  rows: readonly AliasRow[];
  /** The whole row list after one edit, because a row is two controls and the pair is the
   *  unit — the same length and order as `rows`, with the edited row replaced. */
  onRows: (rows: AliasRow[]) => void;
}): ReactNode {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Canonical tool name</TableHead>
          <TableHead>TypeScript alias</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row, index) => (
          // Index, because a row's canonical name is editable and therefore not an identity:
          // keying on it would remount the input being typed into.
          <TableRow key={index}>
            <TableCell>
              <Input
                type="text"
                value={row.canonicalName}
                placeholder="canonical tool name"
                aria-label={`Canonical tool name, row ${index + 1}`}
                onChange={(event) =>
                  onRows(
                    rows.map((held, at) =>
                      at === index ? { ...held, canonicalName: event.target.value } : held,
                    ),
                  )
                }
              />
            </TableCell>
            {/* Stacked under the first below 768px, where the cells lose their padding. */}
            <TableCell className="max-md:mt-2">
              <Input
                type="text"
                value={row.alias}
                placeholder="alias"
                aria-label={`TypeScript alias, row ${index + 1}`}
                onChange={(event) =>
                  onRows(rows.map((held, at) => (at === index ? { ...held, alias: event.target.value } : held)))
                }
              />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
