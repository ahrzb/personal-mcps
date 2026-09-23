/**
 * `/device` as pure functions: which of its moments the URL asks for, and the one relative
 * time it prints. `pages/model.ts`'s `deviceStep` split in two — the URL half is here (routes
 * design §3: `?decided=`, `?error=` and a missing `?user_code` are the client's display
 * state), and the verify half is `GET /api/hub/device`. No React, no DOM, no `@/` runtime
 * import, so `server/test/unit/device-derive.test.ts` pins it from plain Node.
 */

import { searchOne } from "../apps/derive";
import type { SearchBag } from "../apps/derive";

/**
 * What the page draws before any read: the verdict already in, the empty enter-code card, or
 * a code to verify. Precedence is `deviceStep`'s — a `decided` URL wins over everything and
 * reads nothing, and only a present, non-empty `user_code` is ever sent to be verified.
 */
export type DeviceView =
  | { kind: "decided"; decision: "approved" | "denied" }
  /** `error` is `?error=` as the link supplied it — display text, never markup. */
  | { kind: "enter-code"; error: string | null }
  | { kind: "verify"; userCode: string };

export function deviceViewOf(search: SearchBag): DeviceView {
  const decided = searchOne(search, "decided");
  if (decided === "approved" || decided === "denied") return { kind: "decided", decision: decided };
  const userCode = searchOne(search, "user_code");
  if (userCode === null || userCode === "") return { kind: "enter-code", error: searchOne(search, "error") };
  return { kind: "verify", userCode };
}

/** "Just now" / "N mins ago" / "N hours ago" — the confirm card's Requested row. */
export function relativeTime(fromIso: string, now: number): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(fromIso)) / 1000));
  if (seconds < 45) return "Just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  return `${hours} hour${hours === 1 ? "" : "s"} ago`;
}
