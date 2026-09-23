/**
 * The Overview pane — `app_get`'s row as a definition list, plus §23.6's alias surface: the
 * ONE place the owner configures the hub-local TypeScript names, with the committed
 * reservation map (tombstones included) and the bounded diagnostics beside it.
 *
 * A port of `pages/app-detail.tsx`'s `OverviewPane` and `model.ts:overviewPane` /
 * `aliasViewOf`. The editor writes ONE `app_update { typescript_aliases }`; it never renames
 * the upstream, and a blank field keeps whatever name is already established — which is why
 * an untouched section changes nothing.
 *
 * A WIDE pane: the listing is all of it, so there is no details column and no level 3.
 */

import { useState } from "react";
import type { ReactNode } from "react";
import { Kv, KvList } from "@/chrome/Kv";
import { Listing, ListingHead, ListingScroll, ListingTitle } from "@/chrome/Listing";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge, BadgeDot } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Field, FieldDescription, FieldError, FieldGroup } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useAppEditor } from "@/lib/queries";
import { ApiError } from "@/lib/http";
import { formatLastSeen, formatStamp } from "@/lib/format";
import type { AliasDiagnostic, AppRow, Violation } from "@/lib/types";
import { usePreviewTransient } from "@/preview/transient";
import { subjectsOf } from "../derive";
import type { AppPaneProps } from "../derive";

/** A refused save, as this editor holds it: the op's own sentence, plus its field-scoped
 *  list where it reported one (§8). Held in STATE rather than read off the mutation so the
 *  state gallery can seed it — a refusal is the result of a submit a static render cannot
 *  perform. */
type Refusal = { reason: string; violations?: Violation[] };

/** One editable alias pair, as the form draws it and `composeTypescriptAliases` reads it.
 *  A row's canonical name is an INPUT rather than a label: naming a member the hub has not
 *  listed yet is how the owner reserves its name in advance. */
type AliasRow = { canonicalName: string; alias: string };

/** How many empty rows the editor draws after the prefilled ones — the spares are how the
 *  owner names something the hub has not seen yet. A blank row composes to nothing, so
 *  drawing them is free. */
const SPARE_ROWS = 3;

export function OverviewPane(props: AppPaneProps): ReactNode {
  const { slug, app, kind, views, now, diagnostics } = props;

  // The prefill is what the hub already knows: the owner's configured entries, plus every
  // tool this app's catalog lists. An unread or undeclared tools family contributes nothing
  // rather than emptying the editor — the configured entries stand on their own.
  const configured = app.typescriptAliases.tools ?? {};
  const names = new Set<string>(Object.keys(configured));
  for (const subject of subjectsOf(views.tools)) if (subject !== "") names.add(subject);
  const known: AliasRow[] = [...names]
    .sort()
    .map((canonicalName) => ({ canonicalName, alias: configured[canonicalName] ?? "" }));

  // `null` means "show the prefill": the draft exists only once the owner has typed, so a
  // background refetch of the app row is visible until then and stops being visible the
  // moment it would overwrite an edit.
  const [draft, setDraft] = useState<{ service: string; rows: AliasRow[] } | null>(null);
  // The initial value seeds the gallery and nothing else: outside it the context is empty,
  // which is what a first render holds anyway.
  const transient = usePreviewTransient();
  const [refusal, setRefusal] = useState<Refusal | null>(() => transient.refusal ?? null);
  const save = useAppEditor<{ service: string; rows: AliasRow[] }>(slug, "aliases");

  const service = draft?.service ?? app.typescriptAliases.service ?? "";
  const rows = padded(draft?.rows ?? known, known.length);

  /** Every edit writes the WHOLE draft, because the body is the whole set: the composer
   *  reads rows by index and a partial draft would compose to a partial map. */
  const edit = (next: Partial<{ service: string; rows: AliasRow[] }>): void => {
    setDraft({ service, rows, ...next });
  };

  return (
    <Listing wide>
      <ListingHead>
        <ListingTitle render={<span />}>Overview</ListingTitle>
      </ListingHead>
      <ListingScroll>
        <KvList variant="block" className="max-w-pane p-4">
          {factRows(app, kind, now).map((row) => (
            <Kv key={row.key} k={row.key}>
              {row.mono ? <span className="font-mono">{row.value}</span> : row.value}
            </Kv>
          ))}
        </KvList>

        {/* The same padding and measure as the pairs above: they are one listing's content,
            and the two must line up. */}
        <div className="flex max-w-pane flex-col gap-4 p-4">
          <Card render={<section />}>
            <div className="text-2xs font-medium tracking-[0.06em] text-muted-foreground uppercase">
              TypeScript aliases
            </div>
            <p className="max-w-[72ch] text-xs text-muted-foreground">
              Generated programs address this app through hub-local TypeScript names. The upstream keeps its
              canonical names — an alias never renames it — and a blank field keeps whatever name is already
              established.
            </p>
            {refusal === null ? null : (
              <Alert variant="danger" role="alert">
                <AlertDescription>{refusal.reason}</AlertDescription>
              </Alert>
            )}
            {/* Not a `<form method="post">`: the write is a PUT whose refusal is rendered in
                place with the draft intact, and a form submit would navigate away from the
                one thing a refusal has to keep. */}
            <FieldGroup>
              <Field render={<label />}>
                <Label render={<span />}>Service name</Label>
                <Input type="text" value={service} onChange={(event) => edit({ service: event.target.value })} />
                <FieldDescription render={<span />}>Names this app's namespace in generated programs.</FieldDescription>
                <FieldErrors refusal={refusal} field="typescript_aliases.service" />
              </Field>
              <Field>
                <Label render={<span />}>Tool aliases</Label>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Canonical tool name</TableHead>
                      <TableHead>TypeScript alias</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map((row, index) => (
                      // Index, because a row's canonical name is editable and therefore not
                      // an identity: keying on it would remount the input being typed into.
                      <TableRow key={index}>
                        <TableCell>
                          <Input
                            type="text"
                            value={row.canonicalName}
                            placeholder="canonical tool name"
                            aria-label={`Canonical tool name, row ${index + 1}`}
                            onChange={(event) =>
                              edit({ rows: replaced(rows, index, { ...row, canonicalName: event.target.value }) })
                            }
                          />
                        </TableCell>
                        {/* Stacked under the first on a phone, where the cells lose their padding. */}
                        <TableCell className="max-md:mt-2">
                          <Input
                            type="text"
                            value={row.alias}
                            placeholder="alias"
                            aria-label={`TypeScript alias, row ${index + 1}`}
                            onChange={(event) =>
                              edit({ rows: replaced(rows, index, { ...row, alias: event.target.value }) })
                            }
                          />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                <FieldDescription render={<span />}>
                  One row per canonical tool. A name the hub has not listed yet is fine — it is reserved for when it
                  appears.
                </FieldDescription>
                <FieldErrors refusal={refusal} field="typescript_aliases.tools" />
              </Field>
              <div className="flex flex-wrap items-center gap-3">
                <Button
                  className="max-md:flex-1"
                  disabled={save.isPending}
                  onClick={() => {
                    save.mutate(
                      { service, rows },
                      {
                        onSuccess: () => {
                          setDraft(null);
                          setRefusal(null);
                        },
                        onError: (error) => setRefusal(refusalOf(error)),
                      },
                    );
                  }}
                >
                  Save aliases
                </Button>
              </div>
            </FieldGroup>
          </Card>

          <Card render={<section />}>
            <div className="text-2xs font-medium tracking-[0.06em] text-muted-foreground uppercase">Reserved names</div>
            <ReservedTable app={app} />
            <Diagnostics lines={diagnostics} />
            <p className="max-w-[72ch] text-xs text-muted-foreground">
              A retired name stays reserved, so a later member can never claim a path code was written against — and
              deleting then recreating an app keeps its old names, so a recreated app needs a new service alias.
            </p>
          </Card>
        </div>
      </ListingScroll>
    </Listing>
  );
}

/**
 * §2's Overview facts, in order. The per-kind rows differ because the two kinds are reached
 * differently: a proxied app is a URL the hub dials, a tunneled one is a socket that dialled
 * in — so one has an endpoint and the other has a last-seen.
 *
 * Body logging names the DEFAULT when it matches it, because the interesting fact about the
 * switch is whether the owner has moved it.
 */
function factRows(app: AppRow, kind: "tunnel" | "proxy", now: number): { key: string; value: string; mono: boolean }[] {
  const rows: { key: string; value: string; mono: boolean }[] = [
    { key: "Slug", value: app.slug, mono: true },
    { key: "Kind", value: kind, mono: true },
    { key: "Created", value: formatStamp(app.createdAt), mono: false },
  ];
  if (kind === "proxy") {
    rows.push({ key: "Endpoint", value: app.endpoint ?? "", mono: true });
    rows.push({ key: "Auth", value: app.auth ?? "", mono: true });
    rows.push({ key: "Forward identity", value: app.forwardIdentity === true ? "On" : "Off", mono: false });
  } else {
    rows.push({ key: "Last seen", value: formatLastSeen(app.lastSeen ?? null, now), mono: false });
  }
  const state = app.logBodies ? "On" : "Off";
  rows.push({
    key: "Body logging",
    value:
      app.logBodies === (kind === "tunnel") ? `${state} — ${kind === "tunnel" ? "tunneled" : "proxied"} default` : state,
    mono: false,
  });
  rows.push({ key: "Description", value: app.description, mono: false });
  return rows;
}

/**
 * §23.6's committed map, in the published order: service before tools, canonical subject
 * within a family — so the owner's map reads the same way the generated API does.
 *
 * A retired row is shown rather than filtered: it is why a name the owner might try to take
 * is unavailable, and hiding it would make the refusal unexplainable.
 */
function ReservedTable({ app }: { app: AppRow }): ReactNode {
  const rows = [...app.typescriptReservations].sort((left, right) =>
    left.family === right.family
      ? left.canonicalName.localeCompare(right.canonicalName)
      : left.family === "service"
        ? -1
        : 1,
  );
  if (rows.length === 0) {
    return (
      <p className="max-w-[72ch] text-xs text-muted-foreground">
        Nothing reserved yet — the hub reserves a name for every canonical member when it first reads this app's
        catalog.
      </p>
    );
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Member</TableHead>
          <TableHead>TypeScript name</TableHead>
          <TableHead>Source</TableHead>
          <TableHead>State</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={`${row.family}/${row.canonicalName}`}>
            <TableCell>
              <Badge variant="muted" size="xs">
                {row.family}
              </Badge>{" "}
              <span className="font-mono text-xs wrap-anywhere">{row.canonicalName}</span>
            </TableCell>
            <TableCell className="font-mono text-xs wrap-anywhere">{row.typescriptName}</TableCell>
            <TableCell className="text-muted-foreground">{row.source}</TableCell>
            <TableCell>
              {row.active ? (
                <Badge variant="success" size="xs">
                  <BadgeDot />
                  active
                </Badge>
              ) : (
                <Badge variant="muted" size="xs">
                  retired
                </Badge>
              )}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/** Why a requested or derived name did not land, where one did not — one sentence each,
 *  naming no contender the owner could not already see.
 *
 *  The sentences are the SERVER's: `hub-types.aliasDiagnosticMessage` is their one author,
 *  and `AppResponse.diagnostics` is where they arrive. `app.typescriptDiagnostics` carries
 *  the same facts as raw objects because it is `app_get`'s own shape, and re-wording those
 *  here would be a second spelling of one explanation. */
function Diagnostics({ lines }: { lines: AliasDiagnostic[] }): ReactNode {
  if (lines.length === 0) return null;
  return (
    <div>
      <div className="text-2xs font-medium tracking-[0.06em] text-muted-foreground uppercase">Diagnostics</div>
      {lines.map((line) => (
        <p className="max-w-[72ch] text-xs text-muted-foreground" key={`${line.family}/${line.canonicalName}/${line.message}`}>
          {line.message}
        </p>
      ))}
    </div>
  );
}

/**
 * A failed save as this editor holds it. Only an `ApiError` carries `violations`; anything
 * else (a transport failure) is one sentence and no fields, which still belongs above the
 * editor rather than thrown away — the draft is intact either way.
 */
function refusalOf(error: Error): Refusal {
  if (!(error instanceof ApiError) || error.violations === undefined) return { reason: error.message };
  return { reason: error.message, violations: error.violations };
}

/** A refusal's sentences for one field, under the control its `field` names (§8/§15). */
function FieldErrors({ refusal, field }: { refusal: Refusal | null; field: string }): ReactNode {
  const violations = (refusal?.violations ?? []).filter((each) => each.field === field);
  if (violations.length === 0) return null;
  return (
    <>
      {violations.map((each) => (
        <FieldError render={<span />} key={each.reason}>
          {each.reason}
        </FieldError>
      ))}
    </>
  );
}

/** The rows one render draws: the given set padded with spares. The padding is measured
 *  against the PREFILLED length, so a redraw of a redraw cannot grow the form. */
function padded(rows: AliasRow[], knownLength: number): AliasRow[] {
  const out = rows.map((row) => ({ canonicalName: row.canonicalName, alias: row.alias }));
  while (out.length < knownLength + SPARE_ROWS) out.push({ canonicalName: "", alias: "" });
  return out;
}

/** One row replaced, the rest untouched — the draft is a value, so an edit produces a new
 *  one rather than mutating the array React is rendering from. */
function replaced(rows: AliasRow[], index: number, row: AliasRow): AliasRow[] {
  return rows.map((each, at) => (at === index ? row : each));
}
