import { keepPreviousData, queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import type { QueryClient, UseMutationResult } from "@tanstack/react-query";
import { useApi } from "./api-context";
// The explorer's pure module owns the window read's page URL: the rule that every page after
// the first rides page 0's echoed window is a rule with a test, not a string built inline.
import { windowPagePath } from "@/features/audit/derive";
import type {
  AgentResponse,
  AgentsResponse,
  AppResponse,
  AppsResponse,
  AuditRecordResponse,
  AuditResponse,
  AuditWindowResponse,
  ApprovalDetailRead,
  ApprovalsResponse,
  CapabilitiesResponse,
  CatalogFamily,
  CatalogResponse,
  CreatedApp,
  OpValue,
  RolesResponse,
  TokensResponse,
} from "./types";
import type { ApiClient } from "./http";

/**
 * Every query key this client uses, array-shaped and MOST GENERAL FIRST so a prefix
 * invalidation is a subtree invalidation: `['app', slug]` exact is the row, and
 * `['app', slug, 'catalog']` as a prefix is all four families of one app.
 *
 * One table, because the writes below invalidate by key and a key spelled twice is a cache
 * entry that silently stops being refreshed.
 */
export const keys = {
  apps: () => ["apps"] as const,
  app: (slug: string) => ["app", slug] as const,
  appCapabilities: (slug: string) => ["app", slug, "capabilities"] as const,
  appCatalog: (slug: string) => ["app", slug, "catalog"] as const,
  appCatalogFamily: (slug: string, family: CatalogFamily) => ["app", slug, "catalog", family] as const,
  appRoles: (slug: string) => ["app", slug, "roles"] as const,
  agents: () => ["agents"] as const,
  agent: (slug: string) => ["agent", slug] as const,
  tokens: () => ["tokens"] as const,
  audit: (filters: Record<string, unknown>) => ["audit", filters] as const,
  /** The explorer's window. Keyed on the SEARCH TEXT alone, because that is the only control
   *  that refetches: the window asked for is always the whole retention window, and the brush,
   *  the facets, the views and the merge are computed over the rows already held. */
  auditWindow: (q: string) => ["audit", "window", { q }] as const,
  auditRecord: (id: string) => ["audit", "record", id] as const,
  approvalsPending: () => ["approvals", "pending"] as const,
  approvalsHistory: (limit: number) => ["approvals", "history", { limit }] as const,
  /** Under `["approvals"]`, so `approval_decide`'s prefix invalidation reaches the one row a
   *  detail page holds as well as both lists. */
  approval: (id: string) => ["approvals", "one", id] as const,
} as const;

/**
 * How long each resource stays fresh. The spread is not arbitrary: a capability set changes
 * only when an app reconnects, a catalog is a live upstream read and the most expensive
 * thing here, and the audit ledger is append-only and watched.
 */
const STALE = {
  capabilities: 5 * 60_000,
  catalog: 60_000,
  audit: 10_000,
  other: 30_000,
} as const;

/* --------------------------------- the reads ------------------------------- */

export function appsQuery(api: ApiClient) {
  return queryOptions({
    queryKey: keys.apps(),
    queryFn: () => api.get<AppsResponse>("/apps"),
    staleTime: STALE.other,
  });
}

export function appQuery(api: ApiClient, slug: string) {
  return queryOptions({
    queryKey: keys.app(slug),
    queryFn: () => api.get<AppResponse>(`/apps/${encodeURIComponent(slug)}`),
    staleTime: STALE.other,
  });
}

export function appCapabilitiesQuery(api: ApiClient, slug: string) {
  return queryOptions({
    queryKey: keys.appCapabilities(slug),
    queryFn: () => api.get<CapabilitiesResponse>(`/apps/${encodeURIComponent(slug)}/capabilities`),
    staleTime: STALE.capabilities,
  });
}

export function appCatalogQuery(api: ApiClient, slug: string, family: CatalogFamily) {
  return queryOptions({
    queryKey: keys.appCatalogFamily(slug, family),
    queryFn: () => api.get<CatalogResponse>(`/apps/${encodeURIComponent(slug)}/catalog/${family}`),
    staleTime: STALE.catalog,
    // An unread catalog is an ANSWER, not a transient failure: the upstream said nothing or
    // refused, and retrying three times behind the reader's back only delays the marker
    // that says so.
    retry: false,
  });
}

export function appRolesQuery(api: ApiClient, slug: string) {
  return queryOptions({
    queryKey: keys.appRoles(slug),
    queryFn: () => api.get<RolesResponse>(`/apps/${encodeURIComponent(slug)}/roles`),
    staleTime: STALE.other,
  });
}

export function agentsQuery(api: ApiClient) {
  return queryOptions({
    queryKey: keys.agents(),
    queryFn: () => api.get<AgentsResponse>("/agents"),
    staleTime: STALE.other,
  });
}

export function agentQuery(api: ApiClient, slug: string) {
  return queryOptions({
    queryKey: keys.agent(slug),
    queryFn: () => api.get<AgentResponse>(`/agents/${encodeURIComponent(slug)}`),
    staleTime: STALE.other,
  });
}

export function tokensQuery(api: ApiClient) {
  return queryOptions({
    queryKey: keys.tokens(),
    queryFn: () => api.get<TokensResponse>("/tokens"),
    staleTime: STALE.other,
  });
}

/**
 * The audit ledger under a set of filters, bodies included. Every consumer is a NARROW read of
 * it — an agent's recent calls, an app's, a token's last use; the filters are `audit_query`'s
 * own keys, spelled as a query string.
 *
 * NOT the explorer's read: `/audit` loads thousands of rows and must never ship a body it will
 * throw away, so it has `auditWindowQuery` below. This one stays for the panes that want a
 * handful of rows with everything on them.
 */
export function auditQuery(api: ApiClient, filters: Record<string, string>) {
  return queryOptions({
    queryKey: keys.audit(filters),
    queryFn: () => api.get<AuditResponse>(`/audit?${new URLSearchParams(filters).toString()}`),
    staleTime: STALE.audit,
  });
}

/**
 * The explorer's window: the whole retention window of SLIM rows, up to the ceiling, as one
 * cache entry.
 *
 * Page 0 first, then every remaining page in PARALLEL — the pages are independent offsets into
 * one ordered read, and walking them in series would make the page's time to first paint the
 * sum of five round trips instead of two. The rows come back newest first per page, so the
 * concatenation is already in order.
 *
 * Every page after the first is PINNED to the window page 0 echoed. Left open, each request
 * resolves its own `until = now`, so one row written between two of them shifts every later
 * offset by one and the concatenation carries a duplicate at each page seam. That is what the
 * echoed `since`/`until` are for, and `derive.windowPagePath` is where the rule is written down
 * and tested.
 *
 * The page SIZE is read off page 0's own length rather than written down here: it is
 * `AUDIT_EXPLORER_PAGE`, which the server owns, and a second literal of it in the client is a
 * number that can silently disagree. A short page 0 means the read is exhausted, so there is
 * nothing to walk.
 *
 * `q` is sent as `text` — the read's own name for it — and is debounced by the caller, which is
 * what makes this key change at most four times a second.
 */
export function auditWindowQuery(api: ApiClient, q: string) {
  const text = q.trim();
  return queryOptions({
    queryKey: keys.auditWindow(text),
    queryFn: async (): Promise<AuditWindowResponse> => {
      const first = await api.get<AuditWindowResponse>(windowPagePath({ offset: 0, text }));
      const size = first.rows.length;
      const wanted = Math.min(first.total, first.ceiling);
      if (size === 0 || size >= wanted) return first;
      const offsets: number[] = [];
      for (let offset = size; offset < wanted; offset += size) offsets.push(offset);
      const rest = await Promise.all(
        offsets.map((offset) =>
          api.get<AuditWindowResponse>(
            windowPagePath({ offset, text, since: first.since, until: first.until }),
          ),
        ),
      );
      return { ...first, rows: [...first.rows, ...rest.flatMap((page) => page.rows)] };
    },
    staleTime: STALE.audit,
    /**
     * The previous answer STAYS while a new search loads, and this one line is a bug fix rather
     * than a nicety (postmortem 2026-09-21). `text` belongs in the key — it is the one filter
     * the server applies — but a new key has no data, so without a placeholder the page's
     * `isPending` branch replaced the whole explorer with a skeleton on every settled
     * keystroke: the `<input>` was unmounted and remounted, and focus, caret, "Load more"
     * counts, expanded facet groups and scroll position went with it. Typing past one word was
     * impossible. With it, only the FIRST load has nothing to draw.
     */
    placeholderData: keepPreviousData,
  });
}

/**
 * One full row, by id — the record drawer's own read, made when the drawer opens.
 *
 * It does not need the window: a record id outside the loaded rows still opens, which is what
 * keeps an `?expand=` deep link from a month-old email working. `retry: false` because the one
 * refusal it can make is a 404, and a 404 here is an ANSWER — "that record is gone" — not a
 * transient failure worth three more round trips.
 */
export function auditRecordQuery(api: ApiClient, id: string) {
  return queryOptions({
    queryKey: keys.auditRecord(id),
    queryFn: () => api.get<AuditRecordResponse>(`/audit/${encodeURIComponent(id)}`),
    staleTime: Infinity,
    retry: false,
  });
}

/**
 * The pending set, which is also the nav badge's number. `status=pending` rather than a
 * limited history slice, because `Approvals.list` filters BEFORE it limits: counting pending
 * rows inside a limited response undercounts.
 */
export function pendingApprovalsQuery(api: ApiClient) {
  return queryOptions({
    queryKey: keys.approvalsPending(),
    queryFn: () => api.get<ApprovalsResponse>("/approvals?status=pending"),
    staleTime: STALE.other,
  });
}

export function approvalHistoryQuery(api: ApiClient, limit: number) {
  return queryOptions({
    queryKey: keys.approvalsHistory(limit),
    queryFn: () => api.get<ApprovalsResponse>(`/approvals?limit=${limit}`),
    staleTime: STALE.other,
  });
}

/**
 * One approval, by id — `/approvals/<id>`'s read. `retry: false` for `auditRecordQuery`'s
 * reason: the one refusal it makes is a 404 (unknown ≡ foreign), which is an answer rather
 * than a transient failure.
 */
export function approvalQuery(api: ApiClient, id: string) {
  return queryOptions({
    queryKey: keys.approval(id),
    queryFn: () => api.get<ApprovalDetailRead>(`/approvals/${encodeURIComponent(id)}`),
    staleTime: STALE.other,
    retry: false,
  });
}

/* -------------------------------- the writes ------------------------------ */

/**
 * The nine generic ops, as one hook. `invalidate` is the caller's, because which keys an op
 * touches is knowledge about the op and not about the dispatcher — the table lives in
 * `INVALIDATES` below so it is one place rather than one per button.
 */
export function useOp<TInput extends Record<string, unknown>>(
  op: keyof typeof INVALIDATES,
  subject?: { app?: string; agent?: string },
): UseMutationResult<OpValue, Error, TInput> {
  const api = useApi();
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: TInput) => api.post<OpValue>(`/ops/${op}`, input),
    onSuccess: () => invalidateFor(client, op, subject ?? {}),
  });
}

/**
 * Which keys each write touches — targeted, never a bare `invalidateQueries()`, because a
 * blanket invalidation on this app would re-issue four live upstream catalog reads for
 * every archive of an unrelated app.
 *
 * `"apps"`, `"agents"` and `"tokens"` are the three list keys; `"app"` and `"agent"` mean
 * the subject's own keys, and `"appPrefix"` / `"agentPrefix"` mean every app's or agent's
 * — which a delete needs, because a deleted agent's grants were held on apps this client
 * cannot enumerate from the answer.
 */
const INVALIDATES = {
  app_archive: ["apps", "app"],
  app_unarchive: ["apps", "app"],
  app_delete: ["apps", "app", "agents", "agentPrefix", "tokens"],
  app_disconnect: ["app", "appCapabilities", "appCatalog"],
  agent_create: ["agents"],
  agent_delete: ["agents", "agent", "appPrefix", "tokens"],
  token_issue: ["tokens", "app", "agent"],
  token_revoke: ["tokens", "app", "agent"],
  approval_decide: ["approvalsPrefix", "agent"],
} as const satisfies Record<string, readonly Target[]>;

type Target =
  | "apps"
  | "agents"
  | "tokens"
  | "app"
  | "agent"
  | "appCapabilities"
  | "appCatalog"
  | "appPrefix"
  | "agentPrefix"
  | "approvalsPrefix";

function invalidateFor(
  client: QueryClient,
  op: keyof typeof INVALIDATES,
  subject: { app?: string; agent?: string },
): void {
  for (const target of INVALIDATES[op]) {
    switch (target) {
      case "apps":
        void client.invalidateQueries({ queryKey: keys.apps() });
        break;
      case "agents":
        void client.invalidateQueries({ queryKey: keys.agents() });
        break;
      case "tokens":
        void client.invalidateQueries({ queryKey: keys.tokens() });
        break;
      case "app":
        if (subject.app !== undefined) void client.invalidateQueries({ queryKey: keys.app(subject.app) });
        break;
      case "agent":
        if (subject.agent !== undefined) void client.invalidateQueries({ queryKey: keys.agent(subject.agent) });
        break;
      case "appCapabilities":
        if (subject.app !== undefined) {
          void client.invalidateQueries({ queryKey: keys.appCapabilities(subject.app) });
        }
        break;
      case "appCatalog":
        if (subject.app !== undefined) void client.invalidateQueries({ queryKey: keys.appCatalog(subject.app) });
        break;
      case "appPrefix":
        void client.invalidateQueries({ queryKey: ["app"] });
        break;
      case "agentPrefix":
        void client.invalidateQueries({ queryKey: ["agent"] });
        break;
      case "approvalsPrefix":
        void client.invalidateQueries({ queryKey: ["approvals"] });
        break;
    }
  }
}

/**
 * The four editors, as one hook: a PUT whose body is the editor's own draft, invalidating
 * the app's row, its roles and the list. `catalog` is deliberately NOT invalidated — a role
 * or mask save changes no declaration, and re-reading four live upstream families after a
 * checkbox would be the expensive habit this table exists to avoid.
 */
export function useAppEditor<TDraft>(
  slug: string,
  editor: "roles" | "recording" | "aliases",
): UseMutationResult<unknown, Error, TDraft> {
  const api = useApi();
  const client = useQueryClient();
  return useMutation({
    mutationFn: (draft: TDraft) => api.put<unknown>(`/apps/${encodeURIComponent(slug)}/${editor}`, draft),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: keys.app(slug) });
      void client.invalidateQueries({ queryKey: keys.appRoles(slug) });
      void client.invalidateQueries({ queryKey: keys.apps() });
    },
  });
}

/**
 * Either grant editor's Save. Both PUTs invalidate the same five keys, because a grant is
 * one fact held between an app and an agent and both pages draw it: the app's effective
 * roles, its catalog reach badges (which are a function of the grant, not of the
 * declaration), the agent's own page, and both lists.
 */
export function useGrantEditor<TDraft>(
  target: { app: string; agent: string; from: "app" | "agent" },
): UseMutationResult<unknown, Error, TDraft> {
  const api = useApi();
  const client = useQueryClient();
  const path =
    target.from === "app"
      ? `/apps/${encodeURIComponent(target.app)}/grants`
      : `/agents/${encodeURIComponent(target.agent)}/apps/${encodeURIComponent(target.app)}/grants`;
  return useMutation({
    mutationFn: (draft: TDraft) => api.put<unknown>(path, draft),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: keys.appRoles(target.app) });
      void client.invalidateQueries({ queryKey: keys.appCatalog(target.app) });
      void client.invalidateQueries({ queryKey: keys.agent(target.agent) });
      void client.invalidateQueries({ queryKey: keys.agents() });
      void client.invalidateQueries({ queryKey: keys.apps() });
    },
  });
}

/** The create, whose answer the caller renders rather than the cache: two of its arms carry
 *  something that cannot be asked for twice. */
export function useCreateApp(): UseMutationResult<CreatedApp, Error, unknown> {
  const api = useApi();
  const client = useQueryClient();
  return useMutation({
    mutationFn: (draft: unknown) => api.post<CreatedApp>("/apps", draft),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: keys.apps() });
    },
  });
}
