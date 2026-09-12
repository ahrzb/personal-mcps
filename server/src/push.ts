// push.ts — the Web Push TRANSPORT (§13), and nothing else: one encrypted POST to one
// subscription, answering the push service's status so approvals can prune dead endpoints.
// It is the concrete side of `ApprovalsConfig.push`, built once by the composition root
// and handed in. Everything ABOUT a push — which subscriptions receive one, what the
// payload may name (§15: never arguments), and that a 404/410 prunes the row — stays in
// approvals.notifyOwner, which is why this module knows nothing of approvals, D1, or the
// hub's vocabulary and takes one subscription and one opaque string.
//
// The crypto is the library's, not ours (§13 names a small Workers-compatible webpush
// library and the approvals header forbids hand-rolling it): @block65/webcrypto-web-push
// encrypts the body under RFC 8291's `aes128gcm` and signs the RFC 8292 `vapid t=…, k=…`
// token with the configured ES256 pair. What this module owns around it is exactly three
// things the library does not decide — reading a VAPID private key in either dialect it is
// published in, the two header values a push service judges the request by (TTL and
// Urgency, both of which mean something specific for an approval), and turning the request
// the library hands back into a fetch.
//
// WHY THIS LIBRARY, AND WHAT APPLE REQUIRES (2026-09-12, closing G23 and superseding the
// 2026-08-26 note that recorded it): Apple's Web Push — Safari and iOS Home Screen web
// apps, which is exactly where an owner's approval notification wants to land — refuses
// both dialects the previous dependency sent. webpush-webcrypto@1.0.5 (still its last
// release) encrypts with the draft-04 `aesgcm` content encoding and authorizes with the
// pre-RFC `Authorization: WebPush <jwt>` scheme; Apple answers those `BadWebPushRequest`
// and `BadAuthorizationHeader`, while Chrome's and Mozilla's services accept them — so the
// loss was Apple-only and silent. The rules Apple's documented `reason` codes spell out,
// and where each one is satisfied now:
//   · `aes128gcm` body, at most 4 KB  — the library (one record, padded to exactly 4096,
//                                      so the ciphertext length leaks no plaintext length)
//   · `vapid t=<jwt>, k=<public key>` — the library, from the pair below; `k` must be the
//                                      key the browser subscribed with (VapidPkHashMismatch)
//   · JWT `sub` a `mailto:` or https  — `sub` is PUBLIC_ORIGIN (wiring.vapidFromEnv), an
//     URL, `aud` the endpoint's         https origin; `aud` and `exp` (+12 h, inside the
//     origin, `exp` under 24 h out      one-day ceiling) are the library's
//   · `TTL`, present and positive      — below, from APPROVAL_WINDOW_MS
//   · `Urgency`, one of four names     — below: `high`
// Push stays best-effort by contract (§7): a refusal costs a notification, never a row.
// This module stays the ONE place a swap touches — nothing outside it names the library,
// the encoding, or a header.

import { buildPushPayload } from "@block65/webcrypto-web-push";
import type { PushSubscriptionJson } from "./approvals";
import { APPROVAL_WINDOW_MS } from "./limits";

/**
 * The one outbound call this module makes, injected so the suite can play the push service
 * and read the bytes. Only the status is ever read back — a push service's body says
 * nothing the hub acts on.
 */
export type PushFetch = (
  endpoint: string,
  init: { method: string; headers: Record<string, string>; body: Uint8Array<ArrayBuffer> },
) => Promise<{ status: number }>;

/** The VAPID identity a hub pushes under: the published keypair and the contact claim (§13). */
export type VapidKeys = { publicKey: string; privateKey: string; subject: string };

/**
 * Build the transport `ApprovalsConfig.push` expects, closed over the VAPID identity —
 * the seam passes only (subscription, payload), so the keys ride here rather than through
 * it.
 */
export function pushSender(
  vapid: VapidKeys,
  send: PushFetch = (endpoint, init) => fetch(endpoint, init),
): (subscription: PushSubscriptionJson, payload: string) => Promise<{ status: number }> {
  // deps: @block65/webcrypto-web-push (buildPushPayload) · crypto.subtle (PKCS#8 import)
  // · src/limits (APPROVAL_WINDOW_MS) · fetch
  return async (subscription, payload) => {
    const { headers, body } = await buildPushPayload(
      {
        data: payload,
        options: {
          // The push is worth exactly as long as the approval it names can still be acted
          // on: a phone that comes back online inside the window still gets the
          // notification, and one that comes back after it would only offer the owner a
          // dead link.
          ttl: Math.floor(APPROVAL_WINDOW_MS / 1000),
          // The one class of push where a battery-saving delay defeats the message: the
          // approval expires while it waits, and Apple delivers `high` immediately.
          urgency: "high",
        },
      },
      // `expirationTime` is part of the browser's subscription JSON and of no interest to
      // a sender, so §5 does not store it; the library's type asks for it explicitly.
      { ...subscription, expirationTime: null },
      { ...vapid, privateKey: await privateScalar(vapid.privateKey) },
    );
    // Every header the library set is one a push service reads — except the length, which
    // the runtime computes from the body it is about to send anyway. Forwarding a
    // Content-Length the hub did not compute would put an arithmetic disagreement between
    // the library and workerd on the one path no test exercises.
    const { "content-length": _length, ...forwarded } = headers;
    const answer = await send(subscription.endpoint, { method: "POST", headers: forwarded, body });
    return { status: answer.status };
  };
}

/** A P-256 private scalar is 32 bytes; anything longer at this position is a PKCS#8 wrapper. */
const RAW_PRIVATE_SCALAR_BYTES = 32;

const ES256 = { name: "ECDSA", namedCurve: "P-256" } as const;

/**
 * The VAPID private half in the one form the library signs with: base64url over the raw
 * 32-byte scalar, which is what every VAPID generator prints and what the deploy guide
 * tells an operator to store. A deployment's secret may instead hold the PKCS#8 wrapper
 * WebCrypto's own `exportKey` produces, and which one it is is not visible from here — so
 * both are read, the wrapper by importing it for its scalar. Throws on a string that is
 * neither, which notifyOwner absorbs (§15: a push never fails the request that created
 * the row) — the same outcome as an unreadable key silently signing nothing, but loud in
 * the logs.
 */
async function privateScalar(privateKey: string): Promise<string> {
  // deps: crypto.subtle (ECDSA import/export)
  const bytes = decodeBase64Url(privateKey);
  if (bytes.byteLength === RAW_PRIVATE_SCALAR_BYTES) return privateKey;
  const wrapped = await crypto.subtle.importKey("pkcs8", bytes, ES256, true, ["sign"]);
  const { d } = await crypto.subtle.exportKey("jwk", wrapped);
  if (d === undefined) throw new Error("VAPID_PRIVATE_KEY: a PKCS#8 key exported without its scalar");
  return d;
}

function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const padded = value
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}
