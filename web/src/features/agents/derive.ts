/**
 * Everything the agent pages compute from what they read: the list's two summary lines, an
 * agent's keys and clients, the rail, and §13's three narrow levels.
 *
 * A port of the derivations in `server/src/pages/model.ts`'s `agentsProps` (`:2492`),
 * `agentListRow`, `accessOf`, `agentTokens`, `agentRail` (`:2875`), `agentConfirm` (`:2944`)
 * and `agentLevel` (`:2838`). They live here rather than in the components for the reason
 * the contract states: a derivation read off the query data is the thing that has to agree
 * between the rail and the pane it marks, and one home is what makes that true.
 *
 * Pure: every function takes the data and the render instant, so a frozen preview clock
 * reaches all of them.
 */

import { AGENT_GROUP, DIMMED, paths } from "@/lib/paths";
import type { AgentPane } from "@/lib/paths";
import { formatLastSeen } from "@/lib/format";
import type { AppRow, ConnectionRow, ListedAgent, TokenInfo } from "@/lib/types";
import type { LevelHeaderModel, PaneEntry } from "@/chrome/Panes";
import { effectiveRolesOf, grantEntryOf } from "./door";

/** Which pane of an agent's page is being drawn. The app pane carries an argument, which is
 *  why it is a route of its own and why this is a union rather than a pane name. */
export type AgentTarget = { pane: "app"; app: string } | { pane: AgentPane };

/**
 * The four counts of one agent's whole holding, as the list's Access line and the agent
 * header's tiles both print them.
 *
 * An entry is `dormant` when nothing it names can run today FOR A REASON A DECLARATION
 * STATES — the app is archived, or the entry is a role the app does not declare — and it is
 * counted as dormant INSTEAD of as allowed or ask-first, so the four numbers partition the
 * set.
 */
export type AgentAccess = { apps: number; allowed: number; askFirst: number; dormant: number };

export function accessOf(grants: Record<string, string[]>, apps: AppRow[]): AgentAccess {
  const byslug = new Map(apps.map((app) => [app.slug, app]));
  const access: AgentAccess = { apps: 0, allowed: 0, askFirst: 0, dormant: 0 };
  for (const [slug, spelled] of Object.entries(grants)) {
    if (spelled.length === 0) continue;
    access.apps += 1;
    const app = byslug.get(slug);
    for (const entry of spelled) {
      const parsed = grantEntryOf(entry);
      const dormant =
        app === undefined ||
        app.archived ||
        (parsed.kind === "role" &&
          parsed.role !== "all" &&
          // The builtin declares no roles at all, and no agent may hold a grant on it (§8) —
          // so an entry naming one is dormant by the same rule.
          !(parsed.role in (app.kind === "builtin" ? {} : effectiveRolesOf(app))));
      if (dormant) access.dormant += 1;
      else if (parsed.mode === "approval") access.askFirst += 1;
      else access.allowed += 1;
    }
  }
  return access;
}

/** The Access cell: one line of totals over every grant set, or the empty arm. */
export function accessText(access: AgentAccess): string {
  if (access.apps === 0) return "no grants";
  return `${access.apps} apps · ${access.allowed} allowed · ${access.askFirst} ask first · ${access.dormant} dormant`;
}

/** The Tokens cell: `N active · used <relative>` / `N active · never used` / `none` (§13). */
export function tokensText(tokens: AgentToken[], now: number): string {
  const live = tokens.filter((token) => !token.expired);
  if (live.length === 0) return "none";
  const lastUsedAt = live.reduce<number | null>(
    (latest, token) =>
      token.lastUsedAt !== null && (latest === null || token.lastUsedAt > latest) ? token.lastUsedAt : latest,
    null,
  );
  return `${live.length} active · ${lastUsedAt === null ? "never used" : `used ${formatLastSeen(lastUsedAt, now)}`}`;
}

/** One of the agent's keys as its pages draw it: `expired` is the row's own state at the
 *  render instant, and it decides the verb — Revoke on a live key, Remove on a dead one. */
export type AgentToken = {
  id: string;
  /** The key's first ~12 characters, the only part of it ever reported. */
  prefix: string;
  createdAt: number;
  /** Epoch ms, or null for a key that never expires. */
  expiresAt: number | null;
  lastUsedAt: number | null;
  expired: boolean;
};

/** The agent's keys as its pages list them: revoked ones are gone, expired ones stay
 *  marked, newest first. */
export function agentTokensOf(tokens: TokenInfo[], slug: string, now: number): AgentToken[] {
  return tokens
    .filter((token) => token.kind === "agent" && token.refSlug === slug && token.revokedAt === null)
    .map((token) => ({
      id: token.id,
      prefix: token.prefix,
      createdAt: token.createdAt,
      expiresAt: token.expiresAt,
      lastUsedAt: token.lastUsedAt,
      expired: token.expiresAt !== null && token.expiresAt <= now,
    }))
    .sort((a, b) => b.createdAt - a.createdAt);
}

/** One OAuth client signed in as this agent. A revoked binding stays listed — re-consent
 *  revives it, so dropping the row would read as the client having never been there. */
export type AgentClient = {
  id: string;
  /** The provider's display name, or the client id where it registered without one. */
  name: string;
  /** The ORIGIN of the registered redirect URI, never the whole URI (§13). */
  origin: string;
  revoked: boolean;
  createdAt: number;
  lastUsedAt: number | null;
  /** §19.3's DCR marker: nobody was signed in to vouch for this client. */
  selfRegistered: boolean;
};

export function agentClientsOf(connections: ConnectionRow[], slug: string): AgentClient[] {
  return connections
    .filter((row) => row.agentSlug === slug)
    .map((row) => ({
      id: row.id,
      name: row.clientName ?? row.clientId,
      origin: row.redirectOrigin,
      revoked: row.revokedAt !== null,
      createdAt: row.createdAt,
      lastUsedAt: row.lastUsedAt,
      selfRegistered: row.selfRegistered,
    }));
}

/** The apps the agent holds at least one entry on, in slug order — the rail's head, and the
 *  landing's choice of pane. */
export function heldAppsOf(agent: ListedAgent): string[] {
  return Object.entries(agent.grants)
    .filter(([, spelled]) => spelled.length > 0)
    .map(([app]) => app)
    .sort((a, b) => a.localeCompare(b));
}

/** The apps the grant step offers: every ACTIVE app of this owner's the agent holds nothing
 *  on. Archived ones are not offered — unarchive one to grant it. */
export function grantableAppsOf(agent: ListedAgent, apps: AppRow[]): AppRow[] {
  return apps.filter(
    (row) => row.kind !== "builtin" && !row.archived && (agent.grants[row.slug] ?? []).length === 0,
  );
}

/** Each single-segment pane's own name, as the level header and the rail both say it. */
export const AGENT_PANE_TITLE: Record<AgentPane, string> = {
  grant: "Grant another app",
  credentials: "Credentials",
  activity: "Activity",
  danger: "Danger zone",
};

/**
 * The rail, drawn from the same reads every pane is. An app's entry recedes with the `—`
 * marker when the app is ARCHIVED and for no other reason: the rail is on every pane and
 * reads no catalog, so "matches nothing today" is not a question it can answer. The amber
 * dot is the one marker that is a status — at least one entry on that app asks first.
 *
 * The OPEN app is listed whether or not the agent holds anything on it: the new-grant state
 * is an app pane like any other, and a rail that left out the very app being edited would
 * say the page is somewhere it is not. The heading's count is still the GRANTED apps,
 * because that is what `Apps · N` counts.
 */
export function agentRailOf(args: {
  slug: string;
  held: string[];
  apps: Map<string, AppRow>;
  grants: Record<string, string[]>;
  at: AgentTarget;
  counts: { grantable: number; tokens: number; clients: number; pending: number };
}): PaneEntry[] {
  const { slug, held, apps, grants, at, counts } = args;
  const group = `Apps · ${held.length}`;
  const listed =
    at.pane === "app" && !held.includes(at.app) ? [...held, at.app].sort((a, b) => a.localeCompare(b)) : held;
  const appEntries = listed.map((app) => {
    const archived = apps.get(app)?.archived === true;
    const asksFirst = (grants[app] ?? []).some((entry) => grantEntryOf(entry).mode === "approval");
    return entryOf({
      href: paths.agentApp(slug, app),
      label: app,
      group,
      current: at.pane === "app" && at.app === app,
      marker: archived ? DIMMED : "",
      warn: asksFirst,
      dim: archived,
    });
  });
  return [
    ...appEntries,
    entryOf({
      href: paths.agentPane(slug, "grant"),
      label: "+ Grant another app…",
      group,
      current: at.pane === "grant",
      marker: String(counts.grantable),
    }),
    entryOf({
      href: paths.agentPane(slug, "credentials"),
      label: "Credentials",
      group: AGENT_GROUP,
      current: at.pane === "credentials",
      marker: `${counts.tokens} · ${counts.clients}`,
    }),
    entryOf({
      href: paths.agentPane(slug, "activity"),
      label: "Activity",
      group: AGENT_GROUP,
      current: at.pane === "activity",
      marker: counts.pending === 0 ? "" : String(counts.pending),
      warn: counts.pending > 0,
    }),
    entryOf({
      href: paths.agentPane(slug, "danger"),
      label: "Danger zone",
      group: null,
      current: at.pane === "danger",
      marker: "",
    }),
  ];
}

/**
 * One rail entry in the shell's own shape. The amber dot is a STATUS, not a count, so it is
 * drawn where there is no count to draw — an app entry. An entry carrying a number
 * (Activity's pending, Credentials' pair) prints it, because the number says more than the
 * dot would.
 */
function entryOf(entry: {
  href: string;
  label: string;
  group: string | null;
  current: boolean;
  marker: string;
  warn?: boolean;
  dim?: boolean;
}): PaneEntry {
  return {
    href: entry.href,
    label: entry.label,
    short: entry.label,
    marker:
      entry.marker === ""
        ? entry.warn === true
          ? { text: "asks first", dot: "warn" }
          : null
        : { text: entry.marker, dim: entry.dim === true || entry.marker === DIMMED },
    current: entry.current,
    group: entry.group,
  };
}

/**
 * §13's three narrow levels, from the URL alone: the landing is 1, a pane 2, a pane with
 * `sel` 3. The level is the URL's, never the viewport's — CSS decides whether it matters, so
 * one render serves both widths and a bookmark keeps its level.
 *
 * `paneTitle` is the pane's own name (an app pane's is the APP's name) and `selectedName` is
 * the row the pane actually drew for the `sel` it was given — read off the drawn details
 * rather than off `sel`, so a `sel` naming nothing falls back to the pane's own name exactly
 * as the pane falls back to its own summary.
 */
export function agentLevelOf(args: {
  slug: string;
  landing: boolean;
  paneTitle: string;
  /** The pane's own URL with the reading state it carries but without `sel` — level 3's way
   *  up, which drops the row and keeps the filter. */
  paneHref: { to: string; search: Record<string, string> };
  selectedName: string | null;
  hasSel: boolean;
}): { level: 1 | 2 | 3; levelHeader: LevelHeaderModel } {
  if (args.landing) {
    return { level: 1, levelHeader: { backHref: paths.agents, backLabel: "Agents", title: args.slug } };
  }
  if (!args.hasSel) {
    return {
      level: 2,
      levelHeader: { backHref: paths.agentDetail(args.slug), backLabel: args.slug, title: args.paneTitle },
    };
  }
  const query = new URLSearchParams(args.paneHref.search).toString();
  return {
    level: 3,
    levelHeader: {
      backHref: query === "" ? args.paneHref.to : `${args.paneHref.to}?${query}`,
      backLabel: args.paneTitle,
      title: args.selectedName ?? args.paneTitle,
    },
  };
}

/** The reading state a pane keeps when the row it showed is dropped — `?q=`, `?show=` and
 *  `?calls=`, exactly the keys `agentPaneHref` kept. */
export function readingState(search: Record<string, string | string[] | undefined>): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const key of ["q", "show", "calls"]) {
    const value = search[key];
    if (typeof value === "string" && value !== "") kept[key] = value;
  }
  return kept;
}

/** One search value as a page reads it: the first spelling of a repeated key, and `""` for
 *  a key the URL does not carry — so every reader gets a string and none gets an array it
 *  did not ask for. */
export function oneOf(value: string | string[] | undefined): string {
  if (typeof value === "string") return value;
  return Array.isArray(value) ? value[0] ?? "" : "";
}

/**
 * §2's status word for one app row — the one §8's row already reports, said in words rather
 * than in the op's snake case, so no page names a state of its own (`model.ts`'s
 * `appHeader`). `null` is an app with no status to print: a proxied app that is not on
 * OAuth has no connection to be in a state.
 */
export function statusOf(app: AppRow): string | null {
  if (app.archived) return "archived";
  if (app.kind === "tunnel") return app.status ?? null;
  return app.auth === "oauth" ? (app.connection ?? "not_connected").replace(/_/g, " ") : null;
}
