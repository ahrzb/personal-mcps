// push.ts — the Web Push TRANSPORT (§13), and nothing else: one encrypted POST to one
// subscription, answering the push service's status so approvals can prune dead endpoints.
// It is the concrete side of `ApprovalsConfig.push`, built once by the composition root
// and handed in. Everything ABOUT a push — which subscriptions receive one, what the
// payload may name (§15: never arguments), and that a 404/410 prunes the row — stays in
// approvals.notifyOwner, which is why this module knows nothing of approvals, D1, or the
// hub's vocabulary and takes one subscription and one opaque string.
//
// The crypto is the library's, not ours (§13 names webpush-webcrypto, and the approvals
// header forbids hand-rolling it): a VAPID ES256 token over the endpoint's origin plus the
// configured subject, and a body only the subscription's own keypair can open. What this
// module owns around it is exactly two things the library does not do — reading a VAPID
// private key in either dialect it is published in, and turning the request the library
// hands back into a fetch.
//
// IMPLEMENTATION NOTE (2026-08-26), stated because §13 asks for something narrower than
// what the sanctioned dependency delivers: webpush-webcrypto@1.0.5 (its latest) encrypts
// with the older `aesgcm` content encoding and sends VAPID as `Authorization: WebPush
// <jwt>` — NOT RFC 8291's `aes128gcm` nor RFC 8292's `vapid t=…,k=…`. The two are
// interoperable with Chrome's and Mozilla's push services and were the deployed standard
// before them, but Apple's Web Push (Safari/iOS, which is exactly where a PWA's approval
// notification wants to land) accepts aes128gcm only. Closing that is a dependency
// decision, not a code one: either another Workers-compatible library or a hand-rolled
// RFC 8291 the approvals header forbids. Push is best-effort by contract (§7), so the
// failure mode is a notification that never arrives and a dashboard that still holds the
// truth. This module stays the ONE place a swap touches: nothing outside it names the
// library, the encoding, or a header.

import { ApplicationServerKeys, generatePushHTTPRequest } from "webpush-webcrypto";
import type { PushSubscriptionJson } from "./approvals";
import { APPROVAL_WINDOW_MS } from "./limits";

/**
 * The one outbound call this module makes, injected so the suite can play the push service
 * and read the bytes. Only the status is ever read back — a push service's body says
 * nothing the hub acts on.
 */
export type PushFetch = (
  endpoint: string,
  init: { method: string; headers: Record<string, string>; body: ArrayBuffer },
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
  // deps: webpush-webcrypto (generatePushHTTPRequest) · src/limits (APPROVAL_WINDOW_MS) · fetch
  return async (subscription, payload) => {
    const { headers, body, endpoint } = await generatePushHTTPRequest({
      applicationServerKeys: await applicationServerKeys(vapid),
      payload,
      target: subscription,
      adminContact: vapid.subject,
      // The push is worth exactly as long as the approval it names can still be acted on:
      // a phone that comes back online inside the window still gets the notification, and
      // one that comes back after it would only offer the owner a dead link.
      ttl: Math.floor(APPROVAL_WINDOW_MS / 1000),
    });
    return { status: (await send(endpoint, { method: "POST", headers, body })).status };
  };
}

/** A P-256 private scalar is 32 bytes; anything longer at this position is a PKCS#8 wrapper. */
const RAW_PRIVATE_SCALAR_BYTES = 32;

const ES256 = { name: "ECDSA", namedCurve: "P-256" } as const;

/**
 * Read the configured VAPID pair into the CryptoKeys the library signs with. The public
 * half has one form — base64url over the raw P-256 point, the same bytes the browser
 * subscribes with as `applicationServerKey` (§13) — but the private half is published in
 * two: the raw 32-byte scalar every VAPID generator prints, and the PKCS#8 wrapper
 * WebCrypto's own `exportKey` (and this library's `toJSON`) produces. Both are accepted
 * because which one a deployment's secret holds is not visible from here, and a push that
 * silently never sends is the worst way to find out.
 */
async function applicationServerKeys(vapid: VapidKeys): Promise<ApplicationServerKeys> {
  // deps: crypto.subtle (ECDSA import) · webpush-webcrypto (ApplicationServerKeys)
  const publicBytes = decodeBase64Url(vapid.publicKey);
  const privateBytes = decodeBase64Url(vapid.privateKey);
  // Extractable: the library exports it again for the `p256ecdsa` key the push service
  // checks the signature with.
  const publicKey = await crypto.subtle.importKey("raw", publicBytes, ES256, true, []);
  const privateKey =
    privateBytes.byteLength === RAW_PRIVATE_SCALAR_BYTES
      ? await crypto.subtle.importKey("jwk", privateJwk(publicBytes, privateBytes), ES256, false, [
          "sign",
        ])
      : await crypto.subtle.importKey("pkcs8", privateBytes, ES256, false, ["sign"]);
  return new ApplicationServerKeys(publicKey, privateKey);
}

/** The scalar plus the point it belongs to, as the one private-key form WebCrypto imports whole. */
function privateJwk(publicBytes: Uint8Array, scalar: Uint8Array): JsonWebKey {
  // An uncompressed P-256 point is 0x04 ‖ x(32) ‖ y(32); JWK wants the halves apart.
  return {
    kty: "EC",
    crv: "P-256",
    x: encodeBase64Url(publicBytes.subarray(1, 33)),
    y: encodeBase64Url(publicBytes.subarray(33, 65)),
    d: encodeBase64Url(scalar),
  };
}

function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const padded = value
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

function encodeBase64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}
