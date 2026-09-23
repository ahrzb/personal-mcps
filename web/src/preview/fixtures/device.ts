import { deviceApi } from "@/lib/paths";
import { keys } from "@/lib/queries";
import type { Seed } from "../seed";

/**
 * `/device`, reproduced from the server fixtures' (`../seed.ts`) `device` object one state for one state
 * and one value for one value. The page's moment is its URL (`?decided=`, `?user_code=`), and
 * the one read — the confirm card's facts, or the 404 that sends the owner back to the field —
 * is the seeded answer to `GET /api/hub/device?user_code=`.
 *
 * Two values here are the SSR fixture's rather than anything the live read produces, kept
 * because each state is compared against its baseline pixel for pixel: the IP (the read always
 * answers "unknown" — better-auth records none) and the expired-code sentence (the live 404
 * says "That code is not valid. Check it and try again."). The page prints whatever the read
 * says, so the states are still the page's own.
 */

const CODE = "BDWJ-KTQP";

export const deviceSeeds: Record<string, Seed> = {
  /** The verdict screen: a live request from the CLI, 4 seconds old. Approve and Deny answer
   *  as `POST /api/hub/device/decide` does — a landing on the verdict — so a walk through the
   *  gallery reaches both decided states from this one. */
  default: {
    path: "/device",
    search: { user_code: CODE },
    respond: (path, body) =>
      path === deviceApi.decide
        ? {
            delayMs: 0,
            data: {
              next: `/device?decided=${(body as { decision?: string } | undefined)?.decision === "approve" ? "approved" : "denied"}`,
              reload: false,
            },
          }
        : null,
    queries: [
      {
        key: keys.device(CODE),
        data: {
          request: {
            userCode: CODE,
            ip: "203.0.113.42",
            client: "pmcp CLI on Windows",
            requestedAt: "2026-08-24T14:46:56.000Z",
            expiresAt: "2026-08-24T14:56:56.000Z",
          },
        },
      },
    ],
  },

  /** AuthStates "DEVICE — ENTER CODE": arrived at /device without a code, so nothing is read. */
  enterCode: { path: "/device", queries: [] },

  /** AuthStates "DEVICE — EXPIRED CODE": the code is not live, so the field comes back with the
   *  code kept in it and the read's sentence under it. */
  expiredCode: {
    path: "/device",
    search: { user_code: CODE },
    queries: [
      {
        key: keys.device(CODE),
        error: { status: 404, body: { reason: "That code has expired — run pmcp login again for a new one." } },
      },
    ],
  },

  /** AuthStates "DEVICE — APPROVED": the decision's landing, which reads nothing. */
  approved: { path: "/device", search: { decided: "approved" }, queries: [] },

  /** The same landing with the opposite verdict. */
  denied: { path: "/device", search: { decided: "denied" }, queries: [] },
};
