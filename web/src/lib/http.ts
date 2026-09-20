import type { Bootstrap } from "./bootstrap";

/**
 * Every refusal `/api/hub` can make, as the one thing a query or a form has to render.
 *
 * `status` is load-bearing and not decoration: the client renders a 422 inside the editor
 * that caused it (field-scoped, draft intact), a 503 with `unread` as the blank marker that
 * is NOT an empty set, a 404 as the page's own not-found, and anything else as a query
 * error with a retry. A single "something failed" would collapse four different screens.
 */
export class ApiError extends Error {
  status: number;
  /** §8's field-scoped list, where the op reported one: each sentence belongs under the
   *  control its `field` names. */
  violations?: { field: string; reason: string }[];
  /** The catalog read's own distinction: the family could not be READ, which is not the
   *  same answer as an empty family (gateway's `ownerCatalog` exists to keep them apart). */
  unread: boolean;
  constructor(status: number, reason: string, extra: { violations?: { field: string; reason: string }[]; unread?: boolean } = {}) {
    super(reason);
    this.name = "ApiError";
    this.status = status;
    this.unread = extra.unread === true;
    if (extra.violations !== undefined) this.violations = extra.violations;
  }
}

/** The header the JSON write gate reads the CSRF token from. A custom header cannot be set
 *  cross-origin without a preflight the hub never answers, so the header is itself a
 *  barrier and not merely a re-spelling of the form field the pages used. */
const CSRF_HEADER = "X-Pmcp-Csrf";

/**
 * The one door to `/api/hub`, as its consumers hold it. Three verbs, because three is what
 * the surface has: reads are GETs, the op dispatcher and the create are POSTs, and the five
 * editors are PUTs.
 */
export type ApiClient = {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body: unknown): Promise<T>;
  put<T>(path: string, body: unknown): Promise<T>;
};

/**
 * Every read and every write goes through this, so the four cross-cutting rules are written
 * once: the cookie rides (`same-origin`), a write carries the CSRF header, a 401 sends the
 * browser to /login carrying where it was, and every other refusal becomes an `ApiError`
 * the caller renders.
 *
 * The 401 arm is a navigation rather than a thrown error because there is nothing to
 * render: the session is gone, and `/login?next=…` is the destination the page gate's 302
 * named.
 */
export function apiClient(bootstrap: Bootstrap): ApiClient {
  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(`/api/hub${path}`, {
      method,
      credentials: "same-origin",
      headers: {
        Accept: "application/json",
        ...(method === "GET" ? {} : { [CSRF_HEADER]: bootstrap.csrf, "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (response.status === 401) {
      // Not an error to render: the session is gone, so the only screen left is /login —
      // and it is handed the same `next=` the page gate's own redirect carried.
      location.assign(`/login?next=${encodeURIComponent(location.pathname + location.search)}`);
      throw new ApiError(401, "Sign in again.");
    }
    const parsed: unknown = await response.json().catch(() => null);
    if (!response.ok) throw refusalOf(response.status, parsed);
    return parsed as T;
  }

  return {
    get: <T>(path: string) => call<T>("GET", path),
    post: <T>(path: string, body: unknown) => call<T>("POST", path, body),
    put: <T>(path: string, body: unknown) => call<T>("PUT", path, body),
  };
}


/**
 * A refusal body as an `ApiError`. Read field by field rather than asserted: the body is a
 * network answer, and a 500 from a proxy carries no `reason` at all — which must read as
 * the status's own sentence rather than as `undefined`.
 */
function refusalOf(status: number, body: unknown): ApiError {
  if (typeof body !== "object" || body === null) {
    return new ApiError(status, `The request failed (${status}).`);
  }
  const reason =
    "reason" in body && typeof body.reason === "string" ? body.reason : `The request failed (${status}).`;
  const violations =
    "violations" in body && Array.isArray(body.violations)
      ? body.violations.flatMap((each: unknown) =>
          typeof each === "object" &&
          each !== null &&
          "field" in each &&
          "reason" in each &&
          typeof each.field === "string" &&
          typeof each.reason === "string"
            ? [{ field: each.field, reason: each.reason }]
            : [],
        )
      : undefined;
  return new ApiError(status, reason, {
    ...(violations === undefined || violations.length === 0 ? {} : { violations }),
    unread: "unread" in body && body.unread === true,
  });
}
