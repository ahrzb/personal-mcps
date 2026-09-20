/**
 * Everything `/apps` and `/apps/new` compute rather than render — the derivations that
 * lived in `pages/model.ts`'s `appsProps`/`appRow`/`liveTokenCounts`/`appNewForm` and in
 * `web.ts`'s `createErrors`, moved to where the data now arrives.
 *
 * They are here rather than inside the components for the reason the contract gives: the
 * server-rendered page's props builder was the specification for what a row MEANS (which
 * status field belongs to which kind, what an empty role list reads as, which tokens count
 * toward "its N tokens are revoked"), and a reader comparing the two renderings should find
 * one place holding those readings rather than them scattered through JSX.
 *
 * Nothing here touches the query cache or the router: every function is a pure function of
 * a wire row, a search bag, or a refusal.
 */

import { formatLastSeen } from "@/lib/format";
import type { AppKind, AppRow, TokenInfo, Violation } from "@/lib/types";

/**
 * A route's search as this client's router hands it over: a string per key, an array where
 * the key repeated, and `undefined` for a key the URL does not carry.
 *
 * Spelled here rather than imported from `@/router` so a page never imports the module that
 * imports it — the values are read through the two helpers below, which are the only place
 * the union is narrowed.
 */
export type SearchBag = Record<string, string | string[] | undefined>;

/** One search value as `URLSearchParams.get` would answer it: the first of a repeated key,
 *  `null` where the URL carries none. Every `?confirm=`/`?slug=` read goes through this, so
 *  a hand-written `?slug=a&slug=b` reads as one value rather than as an array in a `<td>`. */
export function searchOne(search: SearchBag, key: string): string | null {
  const value = search[key];
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value[0] ?? null;
  return null;
}

/* ------------------------------------------------------------------ *
 * /apps — the table's readings of one `app_list` row
 * ------------------------------------------------------------------ */

/**
 * The rows the table draws: every real app, in `app_list`'s order.
 *
 * The virtual `pmcp` row is dropped here exactly as the props builder dropped it — it has
 * no actions, no page and no slug an owner may touch, so a table of things you can archive
 * and delete is not where it belongs.
 */
export function listedApps(apps: readonly AppRow[]): AppRow[] {
  return apps.filter((row) => row.kind !== "builtin");
}

/** A row's DECLARED role names. Empty for an app that has never declared any: the built-in
 *  `all` is resolved at request time and never stored, which is why the table renders "all"
 *  for an empty list rather than this ever carrying it. */
export function roleNamesOf(app: AppRow): string[] {
  return Object.keys(app.roles);
}

/** The Roles column: the declared names, or "all" for the empty list. */
export function rolesText(roleNames: readonly string[]): string {
  return roleNames.length === 0 ? "all" : roleNames.join(", ");
}

/**
 * The instant the Last seen column formats — epoch ms, or null for never.
 *
 * Null on every PROXIED row, and that is the derivation and not an omission: a proxied app
 * never dials in, so it has no last-connected instant of its own and the column reads "—"
 * rather than borrowing another meaning.
 */
export function lastConnectedAt(app: AppRow): number | null {
  return app.kind === "tunnel" ? (app.lastSeen ?? null) : null;
}

/** The mobile card's one meta line: "slug · roles · seen …", with "seen" omitted where the
 *  app has never connected. `now` is the render instant in epoch ms. */
export function metaLine(app: AppRow, now: number): string {
  const parts = [app.slug, rolesText(roleNamesOf(app))];
  const at = lastConnectedAt(app);
  if (at !== null) parts.push(`seen ${formatLastSeen(at, now)}`);
  return parts.join(" · ");
}

/**
 * The delete dialog's second line — grammatical whether or not there are tokens to name.
 * `tokenCount` is the LIVE count (see `liveTokenCounts`), which is what "its N tokens are
 * revoked" promises to be about.
 */
export function deleteConfirmText(tokenCount: number): string {
  if (tokenCount > 0) {
    const plural = tokenCount === 1 ? "" : "s";
    const verb = tokenCount === 1 ? "is" : "are";
    return `Its ${tokenCount} token${plural} ${verb} revoked, its grants removed, and its live connection closed. This cannot be undone.`;
  }
  return "Its grants are removed and its live connection closed. This cannot be undone.";
}

/**
 * Live app credentials per app slug — neither revoked nor past expiry, keyed on `refSlug`.
 * `now` is epoch ms, compared against `expiresAt` because expiry is evaluated at read time
 * (§7) and a row the ledger still holds may already be past its own deadline.
 */
export function liveTokenCounts(tokens: readonly TokenInfo[], now: number): Map<string, number> {
  const counts = new Map<string, number>();
  for (const token of tokens) {
    if (token.kind !== "app" || token.revokedAt !== null) continue;
    if (token.expiresAt !== null && token.expiresAt <= now) continue;
    counts.set(token.refSlug, (counts.get(token.refSlug) ?? 0) + 1);
  }
  return counts;
}

/**
 * The row's upstream control, or null where the row has nothing to connect — a tunneled app
 * or a headers-auth proxy.
 *
 * `action` rather than a URL, because the two arms are no longer one form: Connect and
 * Reconnect are a real cross-origin POST to `/apps/connect` (a `fetch` cannot follow a
 * redirect into the address bar), while Disconnect is an ordinary op call.
 */
export function connectAction(app: AppRow): { label: string; action: "connect" | "disconnect" } | null {
  if (app.kind !== "proxy" || app.auth !== "oauth") return null;
  if (app.connection === "connected") return { label: "Disconnect", action: "disconnect" };
  if (app.connection === "needs_reconnect") return { label: "Reconnect", action: "connect" };
  return { label: "Connect", action: "connect" };
}

/** The scoped MCP endpoint of one app — shown, never linked: `/apps/new` spells it out under
 *  the slug field so the owner sees what they are naming. `pages/model.ts`'s `mcpScoped`,
 *  which the client's `paths` does not carry because nothing navigates to it. */
export function mcpScoped(username: string, slug: string): string {
  return `/${encodeURIComponent(username)}/mcp/${encodeURIComponent(slug)}`;
}

/* ------------------------------------------------------------------ *
 * /apps/new — the draft, its prefill, and a refusal's field scoping
 * ------------------------------------------------------------------ */

/**
 * §23.6's alias field names, as the `/apps/new` link spells them in a query string. The
 * CREATE body carries rows as objects, so these are read-only here: they exist because a
 * prefilled link (`?canonical.0=…&alias.0=…`) is a URL an owner or a doc can hand over.
 */
export const ALIAS_SERVICE_FIELD = "typescript_service";
export const ALIAS_CANONICAL_PREFIX = "canonical.";
export const ALIAS_ALIAS_PREFIX = "alias.";

/** How many empty rows the editor draws past the prefilled ones. A blank row composes to
 *  nothing, so drawing them is free, and they are how the owner names a tool the hub has
 *  not seen yet. */
export const ALIAS_SPARE_ROWS = 3;

/** One alias row: an upstream tool's canonical name and the name generated programs call it
 *  by. Both blank is a spare row, which composes to nothing. */
export type AliasRow = { canonicalName: string; alias: string };

/**
 * The add-app form's whole state. Every field is a CONTROL VALUE — a string even where the
 * op takes something else — because this is what the owner typed, and a refusal redraws it
 * rather than a normalisation of it.
 */
export type AppNewDraft = {
  kind: AppKind;
  name: string;
  slug: string;
  /** Proxy only in effect; kept across a kind switch so toggling back does not lose it. */
  endpoint: string;
  authMode: "headers" | "oauth";
  aliases: { service: string; rows: AliasRow[] };
};

/**
 * The draft a `/apps/new` URL carries — `pages/model.ts`'s `appNewForm`, reading the same
 * keys, so a link written against the server-rendered page still prefills the same controls.
 * Unknown or absent keys fall back to the empty form, which is what a first visit is.
 */
export function appNewDraft(search: SearchBag): AppNewDraft {
  const prefilled = aliasRowsOf(search);
  return {
    kind: searchOne(search, "kind") === "proxy" ? "proxy" : "tunnel",
    name: searchOne(search, "name") ?? "",
    slug: searchOne(search, "slug") ?? "",
    endpoint: searchOne(search, "endpoint") ?? "",
    authMode: searchOne(search, "authMode") === "oauth" ? "oauth" : "headers",
    aliases: {
      service: searchOne(search, ALIAS_SERVICE_FIELD) ?? "",
      rows: withSpareRows(prefilled, prefilled.length),
    },
  };
}

/**
 * The `canonical.<i>` / `alias.<i>` pairs a URL carries, in index order, with a pair whose
 * two values are both EXACTLY empty dropped. Every value passes through byte for byte: a
 * whitespace-only entry is not a blank one, and rewriting it here would hide it from the op
 * that refuses it.
 */
function aliasRowsOf(search: SearchBag): AliasRow[] {
  const found: { index: number; row: AliasRow }[] = [];
  for (const key of Object.keys(search)) {
    if (!key.startsWith(ALIAS_CANONICAL_PREFIX)) continue;
    const index = key.slice(ALIAS_CANONICAL_PREFIX.length);
    if (!/^\d+$/.test(index)) continue;
    const canonicalName = searchOne(search, key) ?? "";
    const alias = searchOne(search, `${ALIAS_ALIAS_PREFIX}${index}`) ?? "";
    if (canonicalName === "" && alias === "") continue;
    found.push({ index: Number(index), row: { canonicalName, alias } });
  }
  found.sort((left, right) => left.index - right.index);
  return found.map((entry) => entry.row);
}

/** `rows` padded with spares, measured against `known` so a redraw cannot grow the form —
 *  `pages/model.ts`'s `aliasRowsFor`. */
function withSpareRows(rows: readonly AliasRow[], known: number): AliasRow[] {
  const padded = rows.map((row) => ({ canonicalName: row.canonicalName, alias: row.alias }));
  while (padded.length < known + ALIAS_SPARE_ROWS) padded.push({ canonicalName: "", alias: "" });
  return padded;
}

/** Which of the three notes under the fields applies — a function of kind and auth mode,
 *  exactly as the server-rendered form computed it. */
export function activeNote(draft: AppNewDraft): "tunnel" | "proxy-headers" | "proxy-oauth" {
  if (draft.kind === "tunnel") return "tunnel";
  return draft.authMode === "oauth" ? "proxy-oauth" : "proxy-headers";
}

/**
 * A refused write as both of its sources spell it: a mutation's `ApiError` (`message` is the
 * op's `reason`, `violations` its field-scoped list) and the state gallery's seeded refusal.
 * One shape, so the form has one arm rather than two.
 */
export type Refusal = { reason: string; violations?: Violation[] };

/** Where a refused create draws its sentences: under a control of the form, or as the
 *  whole-form message. */
export type AppNewErrors = Partial<Record<"slug" | "endpoint" | "aliases" | "form", string>>;

/**
 * A refused create split into the messages the form draws in red — `web.ts`'s `createErrors`,
 * unchanged in behaviour: read off the refusal's OWN violation list (§8), never off a
 * substring of its message, because the two reservation sentences name no field in quotes at
 * all and a scan would file them under a control.
 *
 * A violation naming a control sits under it; `typescript_aliases` is the whole alias
 * section (no single input is the wrong one — the SET is); anything else is the whole-form
 * message. Two violations on one field join with a space, because the control has one place
 * to say things. A refusal carrying no list at all — a 500, an offline browser — is still one
 * sentence about this form.
 */
export function createErrors(refused: Refusal): AppNewErrors {
  const listed = refused.violations;
  const violations: Violation[] =
    listed !== undefined && listed.length > 0 ? listed : [{ field: "", reason: refused.reason }];
  const errors: AppNewErrors = {};
  for (const violation of violations) {
    const key =
      violation.field === "slug" || violation.field === "endpoint"
        ? violation.field
        : violation.field === "typescript_aliases"
          ? "aliases"
          : "form";
    const sentence = shownSentence(violation);
    errors[key] = errors[key] === undefined ? sentence : `${errors[key]} ${sentence}`;
  }
  return errors;
}

/** One violation as the PAGE says it: the op's own sentence with the `"<field>" ` quote
 *  prefix dropped where it has one (the control's label already says which field this is),
 *  capitalised, and ended with exactly one period. The op's words, not the page's. */
function shownSentence({ field, reason }: Violation): string {
  const prefix = `"${field}" `;
  const said = reason.startsWith(prefix) ? reason.slice(prefix.length) : reason;
  const ended = said.endsWith(".") ? said : `${said}.`;
  return ended.charAt(0).toUpperCase() + ended.slice(1);
}
