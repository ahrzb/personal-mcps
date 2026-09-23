import { HISTORY_LIMIT, historyReadLimit } from "@/features/approvals/derive";
import { keys } from "@/lib/queries";
import type { ApprovalRow, DetailApproval } from "@/lib/types";
import type { Seed } from "../seed";

/**
 * `/approvals` and `/approvals/<id>`, reproduced from `server/dev/fixtures.ts`' `approvals`
 * and `approvalDetail` objects one state for one state and one value for one value — the same
 * ids, agents, apps, tools, arguments and instants, rendered against the same frozen `NOW`
 * (`../clock.ts`), because each state is compared against its baseline pixel for pixel.
 *
 * The translation from page props to reads: `pending` is the `['approvals','pending']` entry
 * (which the nav badge counts too, so `shell("approvals", 0)` needs no second value), and
 * `history` is the listing the history read answers — keyed on the limit the page will ask
 * for, `historyReadLimit(20, pending)`, since no state here carries `?limit=`. A `notice` is
 * the flash search keys a decision lands with.
 *
 * `historyLimit: 25` / `hasMoreHistory: true` are the one prop pair with no read behind it:
 * the page derives both from the listing, and six rows under any cap are "Showing 6
 * decisions". So the footnote under History is the live page's, not the fixture's.
 */

/* ------------------------------ the one cast ------------------------------ */

/** Exported: /settings' seeds count the same two for the nav badge. */
export const pendingSetScene: ApprovalRow = {
  id: "apr_8f2k",
  agentSlug: "claude",
  appSlug: "home",
  tool: "set_scene",
  args: { scene: "movie_night" },
  status: "pending",
  createdAt: "2026-08-24T14:29:55.000Z",
  decidedAt: null,
  expiresAt: "2026-08-24T15:29:55.000Z",
};

export const pendingCreatePage: ApprovalRow = {
  id: "apr_3d7m",
  agentSlug: "cron",
  appSlug: "notion",
  tool: "create_page",
  args: {
    title: "Weekly report",
    parent: "Reports",
    // Owner-declared redaction path (§7: create_page → credentials.token).
    credentials: { token: "‹redacted›" },
  },
  status: "pending",
  createdAt: "2026-08-24T14:12:31.000Z",
  decidedAt: null,
  expiresAt: "2026-08-24T15:12:31.000Z",
};

const approvalHistory: ApprovalRow[] = [
  {
    id: "apr_7c1a",
    agentSlug: "claude",
    appSlug: "home",
    tool: "set_scene",
    args: { scene: "reading" },
    status: "approved",
    createdAt: "2026-08-24T14:26:40.000Z",
    decidedAt: "2026-08-24T14:31:02.000Z",
    expiresAt: "2026-08-24T15:26:40.000Z",
  },
  {
    id: "apr_5b9e",
    agentSlug: "claude",
    appSlug: "home",
    tool: "set_scene",
    args: { scene: "away" },
    status: "used",
    createdAt: "2026-08-24T13:18:22.000Z",
    decidedAt: "2026-08-24T13:20:05.000Z",
    expiresAt: "2026-08-24T14:18:22.000Z",
  },
  {
    id: "apr_2f4d",
    agentSlug: "cron",
    appSlug: "notion",
    tool: "create_page",
    args: { title: "Nightly digest", parent: "Inbox" },
    status: "rejected",
    createdAt: "2026-08-24T09:10:02.000Z",
    decidedAt: "2026-08-24T09:12:44.000Z",
    expiresAt: "2026-08-24T10:10:02.000Z",
  },
  {
    id: "apr_9a3b",
    agentSlug: "claude",
    appSlug: "home",
    tool: "unlock_door",
    args: { door: "front", duration_s: 30 },
    status: "rejected",
    createdAt: "2026-08-23T22:38:51.000Z",
    decidedAt: "2026-08-23T22:40:18.000Z",
    expiresAt: "2026-08-23T23:38:51.000Z",
  },
  {
    id: "apr_4e8c",
    agentSlug: "claude",
    appSlug: "home",
    tool: "set_scene",
    args: { scene: "dinner" },
    status: "used",
    createdAt: "2026-08-23T18:03:12.000Z",
    decidedAt: "2026-08-23T18:05:51.000Z",
    expiresAt: "2026-08-23T19:03:12.000Z",
  },
  {
    id: "apr_1d6f",
    agentSlug: "cron",
    appSlug: "news",
    tool: "purge_cache",
    args: { older_than: "24h" },
    status: "expired",
    createdAt: "2026-08-22T11:30:09.000Z",
    decidedAt: null,
    expiresAt: "2026-08-22T12:30:09.000Z",
  },
];

/** Edge: an argument object nobody sized a block for, secrets already masked. */
const bulkyArgs: Record<string, unknown> = {
  operation: "bulk_update",
  dry_run: false,
  filter: {
    workspace: "engineering",
    updated_after: "2026-08-01T00:00:00.000Z",
    labels: ["incident", "postmortem", "follow-up", "sev2", "customer-visible"],
  },
  updates: Array.from({ length: 12 }, (_, i) => ({
    page_id: `page_${(i + 1).toString().padStart(4, "0")}`,
    title: `Postmortem ${i + 1}: sustained upstream latency in the eu-west region`,
    properties: { status: "published", owner: "agent:cron", reviewed: i % 2 === 0 },
  })),
  credentials: { token: "‹redacted›", refresh_token: "‹redacted›" },
  notify: { channel: "#eng-incidents", mention: ["@oncall"], webhook_secret: "‹redacted›" },
};

/** `bulkyArgs`' pending card, on both pages. */
const pendingBulky: ApprovalRow = { ...pendingCreatePage, id: "apr_6h4p", tool: "bulk_update_pages", args: bulkyArgs };

/* --------------------------------- /approvals ------------------------------- */

/** The two reads the page makes: the pending set, and the listing the history read answers
 *  under the limit the page will ask for. The listing holds the pending rows too, as
 *  `approval_list` would; the page drops them. */
const reads = (pending: ApprovalRow[], history: ApprovalRow[]): Seed["queries"] => [
  { key: keys.approvalsPending(), data: { approvals: pending } },
  {
    key: keys.approvalsHistory(historyReadLimit(HISTORY_LIMIT, pending.length)),
    data: { approvals: [...pending, ...history] },
  },
];

export const approvalsSeeds: Record<string, Seed> = {
  /** Two waiting decisions and a week of history — the artboard's state. */
  default: {
    path: "/approvals",
    queries: reads([pendingSetScene, pendingCreatePage], approvalHistory),
  },

  /** EmptyStates "Approvals — no pending": history only, badge at zero. */
  noPending: {
    path: "/approvals",
    queries: reads([], approvalHistory),
  },

  /** EmptyStates, both halves: nothing has ever been gated here. */
  empty: {
    path: "/approvals",
    queries: reads([], []),
  },

  /**
   * A decision that raced the agent's retry and lost: the landing the op's one refusal
   * makes. The SSR fixture typed its own banner (a title and an expiry sentence); the live
   * page says `lib/notice.ts`'s one sentence for every lost race, which is what renders here.
   */
  decideFailed: {
    path: "/approvals",
    search: { failed: "approval_decide", reason: "no decidable approval request" },
    queries: reads([pendingSetScene], [{ ...pendingCreatePage, status: "expired", decidedAt: null }, ...approvalHistory]),
  },

  /** Edge: a pending card carrying a very large argument object. */
  bulkyArgs: {
    path: "/approvals",
    queries: reads([pendingBulky], approvalHistory),
  },
};

/* ------------------------------ /approvals/<id> ----------------------------- */

/** One row's page: its URL and the one read it makes. */
const detail = (approval: DetailApproval): Seed => ({
  path: `/approvals/${approval.id}`,
  queries: [{ key: keys.approval(approval.id), data: { approval } }],
});

export const approvalDetailSeeds: Record<string, Seed> = {
  /** The link a -32003 hands the owner: decidable, 43 minutes left. */
  default: detail({ ...pendingSetScene, status: "pending" }),

  /** ApprovalStates "APPROVED — AWAITING RETRY": a pass nobody has spent yet. */
  approved: detail({ ...pendingSetScene, status: "approved", decidedAt: "2026-08-24T14:44:10.000Z" }),

  /** Spent by the agent's identical retry — terminal (§7). */
  used: detail({ ...pendingSetScene, status: "used", decidedAt: "2026-08-24T14:45:37.000Z" }),

  /** Refused: the next attempt opens a fresh request. */
  rejected: detail({
    ...pendingSetScene,
    id: "apr_9a3b",
    tool: "unlock_door",
    args: { door: "front", duration_s: 30 },
    status: "rejected",
    decidedAt: "2026-08-24T14:40:12.000Z",
  }),

  /** ApprovalStates "EXPIRED": undecided for an hour, reported expired on read. */
  expired: detail({
    ...pendingSetScene,
    status: "expired",
    createdAt: "2026-08-24T13:29:55.000Z",
    expiresAt: "2026-08-24T14:29:55.000Z",
    decidedAt: null,
  }),

  /** Edge: the arguments block dwarfs the decision it belongs to. */
  bulkyArgs: detail({ ...pendingBulky, status: "pending" }),
};
