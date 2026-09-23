import type { NoticeTone } from "./format";

/**
 * The redirect-back flash, still read by the client.
 *
 * The SPA mostly does not redirect after its own writes — a mutation's answer is in hand, so
 * it renders the outcome directly — but these keys still arrive two ways: three retained
 * server redirects land on SPA routes carrying them (`POST /apps/connect`'s refusal arm, the
 * upstream OAuth callback, and `/login`'s `signedOut`), and the JSON writes that replaced a
 * 303 land with them exactly where it did — an approval decision on `/approvals`
 * (`features/approvals/derive.decisionLanding`), every /settings write on its pane through the
 * server's own `next`. So the keys are read on every search change rather than only at first
 * mount, and stripped with a replacing navigation once shown.
 *
 * A COPY of `pages/model.ts`'s `NOTICE_KEYS`, spelled here for `web/src/lib/types.ts`'s
 * reason, and the one READER of them — `web.ts`'s `noticeOf` went with the server pages. The
 * server still WRITES them (`noticeUrl`), so the two spellings must agree: a renamed key would
 * quietly stop rendering rather than fail to compile.
 */
export const NOTICE_KEYS = {
  done: "done",
  failed: "failed",
  reason: "reason",
  /** The Password pane's extra: which control a refused change named (§13). */
  field: "field",
  /** The Password pane's extra: how many other sessions a password change ended. */
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
  if (done !== null) {
    return done === CHANGE_PASSWORD ? passwordDone(search) : { tone: "success", message: `${humanize(done)} done.` };
  }
  const failed = search.get(NOTICE_KEYS.failed);
  if (failed === null) return null;
  // §13 (G52): a decision that lost its race — decided or expired between the render and
  // the click — is not a failure of the owner's, so the tone is keyed on the op rather
  // than on prose. Both approvals pages land here after a decision, so this is the copy a
  // lost race reads (pinned in `server/test/unit/approvals-derive.test.ts`).
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

/** The Password pane's op key — the one flash with copy of its own. */
const CHANGE_PASSWORD = "change_password";

/**
 * §13's Password-pane success copy (`web.ts`'s `passwordDone`) — the one outcome spelled out
 * rather than named by its op, because three things are worth saying: what changed, what it
 * cost in sessions (only when the box was ticked, which is when `signedOut` is present), and
 * what it did NOT touch — true by construction, since no key derives from the password.
 */
function passwordDone(search: URLSearchParams): Notice {
  const signedOut = search.get(NOTICE_KEYS.signedOut);
  return {
    tone: "success",
    title: "Password updated.",
    message: [
      signedOut === null ? null : `${signedOut} other session(s) were signed out — this one stays.`,
      "App and agent tokens keep working: they do not derive from the password.",
    ]
      .filter((line): line is string => line !== null)
      .join(" "),
  };
}

/** `app_archive` → "App archive" — an op key as a sentence's first words. */
function humanize(op: string): string {
  const words = op.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}
