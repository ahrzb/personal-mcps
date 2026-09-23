import type { Seed } from "../seed";

/**
 * `/login`, reproduced from the server's `login` fixtures one state for one state and one value
 * for one value. The page reads nothing but its `#pmcp-login` island, so each state IS an
 * island — the card, its error, the kept username, and the landing — and makes no read at all.
 */
export const loginSeeds: Record<string, Seed> = {
  /** First visit: an empty credentials form with the passkey alternative. */
  default: {
    path: "/login",
    queries: [],
    loginIsland: { step: { kind: "credentials", username: "", error: null }, redirectTo: null },
  },

  /** AuthStates "LOGIN — ERROR": the username survives, the password does not. */
  credentialsError: {
    path: "/login",
    queries: [],
    loginIsland: {
      step: { kind: "credentials", username: "ahrzb", error: "Wrong username or password." },
      redirectTo: null,
    },
  },

  /** Password accepted, second factor demanded; bounced here from a push link. */
  totp: {
    path: "/login",
    queries: [],
    loginIsland: { step: { kind: "totp", error: null }, redirectTo: "/approvals/apr_8f2k" },
  },

  /** AuthStates "TWO-FACTOR — ERROR". */
  totpError: {
    path: "/login",
    queries: [],
    loginIsland: {
      step: { kind: "totp", error: "That code didn't work. Codes rotate every 30 seconds." },
      redirectTo: null,
    },
  },

  /** AuthStates "BACKUP CODE": the same challenge, spelled the other way. */
  backupCode: {
    path: "/login",
    queries: [],
    loginIsland: { step: { kind: "backup-code", error: null }, redirectTo: null },
  },

  /** A spent or mistyped backup code. */
  backupCodeError: {
    path: "/login",
    queries: [],
    loginIsland: { step: { kind: "backup-code", error: "That backup code has already been used." }, redirectTo: null },
  },
};
