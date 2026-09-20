import type { NoticeTone } from "./format";

/**
 * The redirect-back flash, still read by the client.
 *
 * The SPA does not redirect after its own writes — a mutation's answer is in hand, so it
 * renders the outcome directly — but three retained server redirects still land on SPA
 * routes carrying these keys: `POST /apps/connect`'s refusal arm, the upstream OAuth
 * callback, and `/login`'s `signedOut`. So the keys are read on every search change rather
 * than only at first mount, and stripped with a replacing navigation once shown.
 *
 * A COPY of `pages/model.ts`'s `NOTICE_KEYS` and `web.ts`'s `noticeOf`, spelled here for
 * `web/src/lib/types.ts`'s reason. The server still WRITES them, so the two spellings must
 * agree: a renamed key would quietly stop rendering rather than fail to compile.
 */
export const NOTICE_KEYS = {
  done: "done",
  failed: "failed",
  reason: "reason",
  /** /settings's Password pane extra — never written to an SPA route, kept so the stripper
   *  removes it if a stale link carries it here. */
  field: "field",
  /** The same, for how many sessions a password change ended. */
  signedOut: "signedOut",
} as const;

/** One flash line, as the shell draws it. */
export type Notice = { tone: NoticeTone; title?: string; message: string };

/**
 * The flash a retained server redirect left, read off the current search. `null` when there
 * is none, which is the ordinary case.
 */
export function noticeOf(search: URLSearchParams): Notice | null {
  const done = search.get(NOTICE_KEYS.done);
  if (done !== null) return { tone: "success", message: `${humanize(done)} done.` };
  const failed = search.get(NOTICE_KEYS.failed);
  if (failed === null) return null;
  // §13 (G52): a decision that lost its race — decided or expired between the render and
  // the click — is not a failure of the owner's, so the tone is keyed on the op rather
  // than on prose. Retained here because `/approvals` can redirect into an agent's
  // Activity pane.
  if (failed === "approval_decide") return { tone: "warning", message: "That request is no longer pending." };
  return {
    tone: "danger",
    title: `${humanize(failed)} failed`,
    message: search.get(NOTICE_KEYS.reason) ?? "The change was refused.",
  };
}

/** Whether a search carries a flash at all — what the stripper tests before navigating,
 *  so a route change with no flash does not push a redundant history entry. */
export function hasNotice(search: URLSearchParams): boolean {
  return Object.values(NOTICE_KEYS).some((key) => search.has(key));
}

/** `app_archive` → "App archive" — an op key as a sentence's first words. */
function humanize(op: string): string {
  const words = op.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}
