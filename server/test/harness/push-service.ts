// push-service.ts — the suite PLAYING a push service (§13). A fake that merely counted
// requests would bless an unencrypted or misdirected payload, so this one does what
// Mozilla's or Google's endpoint does: it holds the POST, checks the sender's VAPID
// identity against the public key the hub published, and opens the body with the
// subscription keypair the browser half generated. Real WebCrypto on both sides (strategy
// §9) — nothing here is stubbed, and the receiver below is written from the encoding's
// own steps rather than by calling back into the sender's library, so a sender that
// derives the wrong key fails instead of agreeing with itself.
//
// What it deliberately does NOT do: answer per-endpoint statuses or count attempts. That
// is the transport SEAM's fake, which lives in approvals.test.ts, and every case about
// which subscriptions a push reaches or what a 404 prunes belongs to it. This harness
// exists for the one case that needs the bytes.
//
// deps: crypto.subtle (ECDH, ECDSA, HKDF, AES-GCM) · src/approvals (PushSubscriptionJson)
// · src/push (PushFetch — the seam this fake fills)

import type { PushSubscriptionJson } from "../../src/approvals";
import type { PushFetch } from "../../src/push";

/** One POST the push service received, verbatim: the encrypted body and the headers that open it. */
export type PostedPush = {
  endpoint: string;
  headers: Record<string, string>;
  body: ArrayBuffer;
};

/**
 * The push service's front door: a `PushFetch` that accepts everything with a 201 (the
 * status a real app answers a queued push with) and keeps what it was handed.
 */
export function pushService(): { fetch: PushFetch; posted: PostedPush[] } {
  const posted: PostedPush[] = [];
  return {
    posted,
    fetch: async (endpoint, init) => {
      posted.push({ endpoint, headers: init.headers, body: init.body });
      return { status: 201 };
    },
  };
}

/**
 * A throwaway VAPID keypair in the dialect VAPID keys are published in — base64url over
 * the raw P-256 point and the raw private scalar, which is what the `applicationServerKey`
 * a browser subscribes with and every VAPID generator emit. Generated per case: no test in
 * this suite ever holds a real key.
 */
export async function generateVapidPair(): Promise<{ publicKey: string; privateKey: string }> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  if (jwk.d === undefined) throw new Error("push service: generated key exported without its scalar");
  return {
    publicKey: base64Url(await crypto.subtle.exportKey("raw", pair.publicKey)),
    privateKey: jwk.d,
  };
}

/**
 * One subscribed browser: the JSON half `PushSubscription.toJSON()` hands the hub, and the
 * private half only the browser ever holds — which is the whole point, since the body is
 * decryptable with nothing else.
 */
export type FakeBrowser = {
  subscription: PushSubscriptionJson;
  privateKey: CryptoKey;
  publicKeyBytes: Uint8Array<ArrayBuffer>;
  authSecret: Uint8Array<ArrayBuffer>;
};

/** Subscribe a browser: a fresh ECDH keypair plus the 16-byte auth secret RFC 8291 fixes the length of. */
export async function subscribeFakeBrowser(endpoint: string): Promise<FakeBrowser> {
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ]);
  const publicKeyBytes = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const authSecret = crypto.getRandomValues(new Uint8Array(16));
  return {
    subscription: {
      endpoint,
      keys: { p256dh: base64Url(publicKeyBytes), auth: base64Url(authSecret) },
    },
    privateKey: pair.privateKey,
    publicKeyBytes,
    authSecret,
  };
}

/** The VAPID claims a push service reads after checking the signature. */
export type VapidClaims = { aud: string; sub: string; exp: number };

/**
 * Verify the sender's VAPID token the way a push service does — ES256 over
 * `header.payload`, against the public key the hub published — and hand back the claims.
 * REJECTS on a signature that does not verify, on a token signed by another key, and on a
 * header that is not `ES256`: this is the oracle, so it has to be able to say no.
 *
 * Accepts either Authorization dialect a VAPID sender may speak — RFC 8292's
 * `vapid t=<jwt>, k=<key>` and the earlier `WebPush <jwt>` — because which one the
 * transport emits is its library's business, while the signature and the claims are the
 * property under test.
 */
export async function verifyVapidJwt(
  authorization: string | undefined,
  vapidPublicKey: string,
): Promise<VapidClaims> {
  if (!authorization) throw new Error("push service: no Authorization header on the push");
  const token = /^vapid\s+t=([^,\s]+)/i.exec(authorization)?.[1] ?? /^WebPush\s+(\S+)$/i.exec(authorization)?.[1];
  if (!token) throw new Error(`push service: unreadable VAPID Authorization header`);
  const [header, claims, signature] = token.split(".");
  if (!header || !claims || !signature) throw new Error("push service: malformed JWT");
  const declared = JSON.parse(new TextDecoder().decode(decodeBase64Url(header))) as {
    typ?: string;
    alg?: string;
  };
  if (declared.alg !== "ES256") throw new Error(`push service: JWT alg is ${declared.alg}, not ES256`);
  const key = await crypto.subtle.importKey(
    "raw",
    decodeBase64Url(vapidPublicKey),
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["verify"],
  );
  const verified = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    decodeBase64Url(signature),
    new TextEncoder().encode(`${header}.${claims}`),
  );
  if (!verified) throw new Error("push service: VAPID signature does not verify against this key");
  return JSON.parse(new TextDecoder().decode(decodeBase64Url(claims))) as VapidClaims;
}

/**
 * Open the encrypted body with the subscription's own keys — the browser half of the push
 * content encoding, derived here from the encoding's steps: ECDH against the sender's
 * ephemeral key, HKDF over the auth secret for the pseudo-random key, then a nonce and a
 * content-encryption key over the salt, and AES-GCM under them. The leading two bytes of
 * the plaintext are the padding length the sender disguised the payload's size with.
 *
 * Throws if anything about the request contradicts the encoding — a decrypt that cannot
 * happen is the failure this case exists to produce.
 */
export async function decryptPushBody(posted: PostedPush, browser: FakeBrowser): Promise<string> {
  const salt = decodeBase64Url(headerParam(posted.headers, "Encryption", "salt"));
  const senderPublicBytes = decodeBase64Url(headerParam(posted.headers, "Crypto-Key", "dh"));
  const senderPublicKey = await crypto.subtle.importKey(
    "raw",
    senderPublicBytes,
    { name: "ECDH", namedCurve: "P-256" },
    true,
    [],
  );

  const sharedBits = await crypto.subtle.deriveBits(
    { name: "ECDH", public: senderPublicKey },
    browser.privateKey,
    256,
  );
  const shared = await crypto.subtle.importKey("raw", sharedBits, "HKDF", false, ["deriveBits"]);
  const pseudoRandomBits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: browser.authSecret, info: label("auth") },
    shared,
    256,
  );
  const pseudoRandom = await crypto.subtle.importKey("raw", pseudoRandomBits, "HKDF", false, [
    "deriveBits",
  ]);

  // Both derivations are salted the same and differ only in this context block, which
  // binds the keys to BOTH public keys — a payload encrypted for another subscription
  // cannot be opened here even if the ECDH somehow agreed.
  const context = concat([
    new TextEncoder().encode("P-256\0"),
    length16(browser.publicKeyBytes),
    browser.publicKeyBytes,
    length16(senderPublicBytes),
    senderPublicBytes,
  ]);
  const nonce = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt, info: concat([label("nonce"), context]) },
    pseudoRandom,
    96,
  );
  const contentKeyBits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt, info: concat([label("aesgcm"), context]) },
    pseudoRandom,
    128,
  );
  const contentKey = await crypto.subtle.importKey("raw", contentKeyBits, "AES-GCM", false, [
    "decrypt",
  ]);

  const padded = new Uint8Array(
    await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, contentKey, posted.body),
  );
  const padding = new DataView(padded.buffer, padded.byteOffset).getUint16(0);
  return new TextDecoder().decode(padded.subarray(2 + padding));
}

/** `Content-Encoding: <name>\0` — the info string each derivation is separated by. */
function label(name: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(`Content-Encoding: ${name}\0`);
}

/** A P-256 point's length as the context block spells it: two bytes, big-endian. */
function length16(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array([bytes.byteLength >> 8, bytes.byteLength & 0xff]);
}

function concat(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const total = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let at = 0;
  for (const part of parts) {
    total.set(part, at);
    at += part.byteLength;
  }
  return total;
}

/** One `name=value` out of a `salt=…` / `dh=…;p256ecdsa=…` push header. */
function headerParam(headers: Record<string, string>, header: string, name: string): string {
  const raw = headers[header] ?? headers[header.toLowerCase()];
  const value = raw === undefined ? undefined : new RegExp(`(?:^|[;,\\s])${name}=([^;,\\s]+)`).exec(raw)?.[1];
  if (!value) throw new Error(`push service: no ${name} in the ${header} header`);
  return value;
}

function base64Url(bytes: ArrayBuffer | Uint8Array): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}
