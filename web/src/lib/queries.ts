import { queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import type { QueryClient, UseMutationResult } from "@tanstack/react-query";
import { useApi } from "./api-context";
import type {
  AgentResponse,
  AgentsResponse,
  AppResponse,
  AppsResponse,
  AuditResponse,
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
  approvalsPending: () => ["approvals", "pending"] as const,
  approvalsHistory: (limit: number) => ["approvals", "history", { limit }] as const,
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

/* ------------------------------ the ten reads ----------------------------- */

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
 * The audit ledger under a set of filters. Every consumer is a NARROW read of it — an
 * agent's recent calls, an app's, a token's last use — because `/audit` itself is still
 * server-rendered; the filters are `audit_query`'s own keys, spelled as a query string.
 */
export function auditQuery(api: ApiClient, filters: Record<string, string>) {
  return queryOptions({
    queryKey: keys.audit(filters),
    queryFn: () => api.get<AuditResponse>(`/audit?${new URLSearchParams(filters).toString()}`),
    staleTime: STALE.audit,
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
