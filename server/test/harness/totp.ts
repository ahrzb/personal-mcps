// totp.ts — the authenticator's side of RFC 6238, and nothing else.
//
// WHY IT EXISTS: /settings/two-factor's verify step wants the six digits an authenticator
// app would show for the secret the enrolment card just rendered. Nothing in the tree can
// produce them — the hub only ever CHECKS a code, through better-auth's own verifier — so
// a test that walks the enrolment journey has to play the authenticator, exactly as
// `formPost` plays the browser. The hub's half stays real: a divergence in parameters
// (better-auth's `createOTP` defaults are the same 6 digits / 30 s / SHA-1) reddens the
// verify row rather than passing by construction.
//
// NOT A FAKE (strategy §9): the primitive is WebCrypto's own HMAC-SHA1 through
// `crypto.subtle`, never a stand-in. What is written here is the arithmetic around it —
// base32 decode, the 30-second counter, RFC 6238 dynamic truncation — which is the
// authenticator's business and no module of ours.
//
// Rejected: `@better-auth/utils` as a devDependency at better-auth's pinned version — a
// transitive package promoted for one call, plus a lockfile entry, a vitest optimizer
// allowlist entry and a lockstep-bump rule to keep for good.
//
// deps: crypto.subtle (WebCrypto — the real primitive)

/** RFC 4648 base32, the alphabet better-auth writes the `secret` parameter in
 *  (`base32.encode(secret, { padding: false })`) — so the decode below takes no padding
 *  and tolerates the spaces the card's grouped display form puts in. */
const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Decode(secret: string): Uint8Array {
  const symbols = secret.replace(/[\s=]/g, "").toUpperCase();
  const bytes: number[] = [];
  let bits = 0;
  let value = 0;
  for (const symbol of symbols) {
    const index = BASE32.indexOf(symbol);
    if (index < 0) throw new Error(`totpCode: "${symbol}" is not base32`);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >>> bits) & 0xff);
    }
  }
  return new Uint8Array(bytes);
}

/**
 * The six digits an authenticator shows for `secret` at `at` (default now) — RFC 6238's
 * default parameters, which are also better-auth's: SHA-1, a 30-second step counted from
 * the Unix epoch, and RFC 4226's dynamic truncation to 6 digits.
 */
export async function totpCode(secret: string, at: number = Date.now()): Promise<string> {
  const counter = Math.floor(at / 1000 / 30);
  // The counter is eight big-endian bytes; `setBigUint64` is what makes that exact rather
  // than a 32-bit shift that would break in 2038's neighbourhood.
  const message = new DataView(new ArrayBuffer(8));
  message.setBigUint64(0, BigInt(counter));
  const key = await crypto.subtle.importKey(
    "raw",
    base32Decode(secret) as unknown as ArrayBuffer,
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, message.buffer));
  // RFC 4226 §5.3: the low nibble of the last byte picks the four-byte window, whose high
  // bit is masked off so the number is positive on every platform.
  const offset = mac[mac.length - 1] & 0x0f;
  const truncated =
    ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(truncated % 1_000_000).padStart(6, "0");
}
