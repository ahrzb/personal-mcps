// webpush-webcrypto.d.ts — the types for §13's one dependency, which ships none (it is JS
// with JSDoc, and this repo does not typecheck node_modules). Hand-rolled for the same
// reason workers-env.d.ts is: the alternative is `any` at the one call site whose whole job
// is getting a crypto library's arguments right.
//
// Narrowed to what src/push actually calls — `generatePushHTTPRequest` and the key pair it
// takes. `setWebCrypto` is declared but unused: workerd and Node 20+ both expose the
// global `crypto` the library finds on its own, and a module-scope call would be a global
// mutation for nothing.

declare module "webpush-webcrypto" {
  /** The VAPID identity, as CryptoKeys. The library signs with the private half and exports
   *  the public one into the `Crypto-Key` header, so the public key must be extractable. */
  export class ApplicationServerKeys {
    constructor(publicKey: CryptoKey, privateKey: CryptoKey);
    readonly publicKey: CryptoKey;
    readonly privateKey: CryptoKey;
    /** base64url over the raw public point and the PKCS#8 private key. */
    toJSON(): Promise<{ publicKey: string; privateKey: string }>;
    static fromJSON(keys: { publicKey: string; privateKey: string }): Promise<ApplicationServerKeys>;
    static generate(): Promise<ApplicationServerKeys>;
  }

  /** Encrypt one payload for one subscription and return the POST that carries it — headers
   *  (VAPID authorization, salt, the sender's ephemeral key, TTL) plus the ciphertext. */
  export function generatePushHTTPRequest(options: {
    applicationServerKeys: ApplicationServerKeys;
    payload: string | Uint8Array;
    target: { endpoint: string; keys: { p256dh: string; auth: string } };
    /** The VAPID `sub` claim: a `mailto:` or `https:` URI the push service can reach the sender at. */
    adminContact: string;
    /** Seconds the push service may hold an undelivered message. */
    ttl: number;
    topic?: string;
    urgency?: "very-low" | "low" | "normal" | "high";
  }): Promise<{ headers: Record<string, string>; body: ArrayBuffer; endpoint: string }>;

  /** For runtimes with no global `crypto`; neither workerd nor Node 20+ needs it. */
  export function setWebCrypto(crypto: Crypto): void;
}
