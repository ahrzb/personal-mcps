// push-service.ts — the suite PLAYING a push service (§13). A fake that merely counted
// requests would bless an unencrypted or misdirected payload, so this one does what
// Apple's, Mozilla's or Google's endpoint does: it holds the POST, checks the sender's
// VAPID identity against the public key the hub published, and opens the body with the
// subscription keypair the browser half generated. Real WebCrypto on both sides (strategy
// §9) — nothing here is stubbed, and the receiver below is written from RFC 8291's and
// RFC 8188's own steps rather than by calling back into the sender's library, so a sender
// that derives the wrong key fails instead of agreeing with itself.
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

/** One POST the push service received, verbatim: the encrypted body and the headers that carry it. */
export type PostedPush = {
  endpoint: string;
  headers: Record<string, string>;
  body: Uint8Array<ArrayBuffer>;
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
 * Verify the sender's VAPID identity the way a push service does — ES256 over
 * `header.payload`, against the public key the hub published — and hand back the claims.
 * REJECTS on a signature that does not verify, on a token signed by another key, on a
 * header that is not `ES256`, and on an Authorization that is not RFC 8292's: this is the
 * oracle, so it has to be able to say no.
 *
 * ONE dialect, and deliberately: `vapid t=<jwt>, k=<public key>` (RFC 8292 §3.1), with `k`
 * the very key the subscription was made with. Apple answers the earlier `WebPush <jwt>`
 * scheme `BadAuthorizationHeader` and a mismatched `k` `VapidPkHashMismatch`, so a
 * receiver that accepted either would bless a push Apple silently drops.
 */
export async function verifyVapidJwt(
  posted: PostedPush,
  vapidPublicKey: string,
): Promise<VapidClaims> {
  const authorization = pushHeader(posted, "authorization");
  if (!authorization) throw new Error("push service: no Authorization header on the push");
  const token = /^vapid\s+t=([^,\s]+)/i.exec(authorization)?.[1];
  const advertisedKey = /[,\s]k=([^,\s]+)/i.exec(authorization)?.[1];
  if (!token || !advertisedKey) {
    throw new Error(`push service: Authorization is not RFC 8292's "vapid t=…, k=…": ${authorization}`);
  }
  const [jwtHeader, jwtClaims, jwtSignature] = token.split(".");
  if (!jwtHeader || !jwtClaims || !jwtSignature) throw new Error("push service: malformed JWT");
  const declared = JSON.parse(new TextDecoder().decode(decodeBase64Url(jwtHeader))) as {
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
    decodeBase64Url(jwtSignature),
    new TextEncoder().encode(`${jwtHeader}.${jwtClaims}`),
  );
  if (!verified) throw new Error("push service: VAPID signature does not verify against this key");
  // Checked after the signature so the refusal above stays the one a foreign key earns: a
  // token can verify under a key the request never advertised, and that is still refused.
  if (advertisedKey !== vapidPublicKey) {
    throw new Error("push service: the k= public key is not the one this subscription was made with");
  }
  return JSON.parse(new TextDecoder().decode(decodeBase64Url(jwtClaims))) as VapidClaims;
}

/** An uncompressed P-256 point — 0x04 ‖ x(32) ‖ y(32) — which is what a record's key id is. */
const P256_POINT_BYTES = 65;

/** RFC 8188 §2: salt(16) ‖ record size(4) ‖ key id length(1), and then the key id. */
const RECORD_HEADER_PREFIX_BYTES = 21;

/** RFC 8188 §2: the byte that ends the LAST record's plaintext, before its zero padding. */
const LAST_RECORD_DELIMITER = 0x02;

/**
 * Open the encrypted body with the subscription's own keys — the browser half of RFC
 * 8291, derived here from its steps: ECDH against the sender's ephemeral key, HKDF over
 * the auth secret for the input keying material, then a content-encryption key and a
 * nonce over the record's salt, and AES-GCM under them.
 *
 * Throws if anything about the request contradicts the encoding — a decrypt that cannot
 * happen is the failure this case exists to produce.
 */
export async function decryptPushBody(posted: PostedPush, browser: FakeBrowser): Promise<string> {
  // ONE encoding, named (G23, closed 2026-09-12): this receiver implements RFC 8291's
  // `aes128gcm` and nothing else, so it says so before deriving anything. The draft-04
  // `aesgcm` the hub sent until the library swap put the salt and the sender's key in
  // HEADERS and mixed a context block into the key derivation; both moved into the body
  // here, so the two encodings cannot be opened by one reader — and a regression to the
  // dialect Apple refuses reddens on this line rather than passing quietly.
  const encoding = pushHeader(posted, "content-encoding");
  if (encoding !== "aes128gcm") {
    throw new Error(
      `push service: body is not aes128gcm (Content-Encoding: ${encoding ?? "absent"}) — this receiver opens aes128gcm only`,
    );
  }

  // RFC 8188 §2.1 header, then the single record.
  const body = posted.body;
  const keyIdLength = body[RECORD_HEADER_PREFIX_BYTES - 1];
  if (keyIdLength !== P256_POINT_BYTES) {
    throw new Error(`push service: the record's key id is ${keyIdLength} bytes, not a P-256 point`);
  }
  const headerBytes = RECORD_HEADER_PREFIX_BYTES + keyIdLength;
  if (body.byteLength <= headerBytes) throw new Error("push service: the body is shorter than its own header");
  const salt = body.subarray(0, 16);
  const recordSize = new DataView(body.buffer, body.byteOffset + 16, 4).getUint32(0);
  if (body.byteLength - headerBytes > recordSize) {
    throw new Error("push service: the record is longer than the size its header declares");
  }
  const senderPublicBytes = body.subarray(RECORD_HEADER_PREFIX_BYTES, headerBytes);
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
  // RFC 8291 §3.3: the input keying material is what binds the key to BOTH public keys,
  // salted by the subscription's own auth secret — so a body encrypted for another
  // subscription cannot be opened here even if the ECDH somehow agreed. (Draft-04 bound
  // the two keys in a context block per derivation instead; this is the same property,
  // moved.)
  const ikmBits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: browser.authSecret,
      info: concat([
        new TextEncoder().encode("WebPush: info\0"),
        browser.publicKeyBytes,
        senderPublicBytes,
      ]),
    },
    shared,
    256,
  );
  const ikm = await crypto.subtle.importKey("raw", ikmBits, "HKDF", false, ["deriveBits"]);

  // RFC 8188 §2.2/2.3: key and nonce are salted the same and differ only in their label.
  const contentKeyBits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt, info: label("aes128gcm") },
    ikm,
    128,
  );
  const nonce = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt, info: label("nonce") },
    ikm,
    96,
  );
  const contentKey = await crypto.subtle.importKey("raw", contentKeyBits, "AES-GCM", false, [
    "decrypt",
  ]);

  const padded = new Uint8Array(
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: nonce },
      contentKey,
      body.subarray(headerBytes),
    ),
  );
  // The plaintext ends at the delimiter, and everything after it is the zero padding the
  // sender disguised the payload's LENGTH with (RFC 8291 §4 asks for a constant one).
  let end = padded.byteLength;
  while (end > 0 && padded[end - 1] === 0x00) end -= 1;
  if (end === 0 || padded[end - 1] !== LAST_RECORD_DELIMITER) {
    throw new Error("push service: the record carries no 0x02 delimiter — its padding is not RFC 8188's");
  }
  return new TextDecoder().decode(padded.subarray(0, end - 1));
}

/** `Content-Encoding: <name>\0` — the info string each derivation is separated by. */
function label(name: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(`Content-Encoding: ${name}\0`);
}

/**
 * One header off the recorded POST, by LOWER-CASE name. The seam hands headers as a plain
 * record, so their casing is the sender's choice while a push service's reading of them is
 * not — every case that judges a header (here and in approvals.test.ts, which asserts the
 * three Apple validates) goes through this rather than pinning the library's spelling.
 */
export function pushHeader(posted: PostedPush, name: string): string | undefined {
  return Object.entries(posted.headers).find(([key]) => key.toLowerCase() === name)?.[1];
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
