import { useState } from "react";
import type { ReactNode } from "react";

/**
 * A freshly minted key, in the one render that will ever hold it (§4/§15) — the add-app
 * flow's reveal and the app and agent pages' rotation reveal, which §13 makes the same one.
 *
 * NEVER written to the query cache: this is component state, so a navigation away or a
 * reload loses it, which is exactly the contract. The Copy button is enhancement — the value
 * is selectable text without it.
 */
export function TokenReveal({ token, children }: { token: string; children?: ReactNode }): ReactNode {
  const [copied, setCopied] = useState(false);
  return (
    <>
      <div className="token-reveal">
        <div className="token-value">{token}</div>
        <button
          type="button"
          className="btn btn--outline"
          onClick={() => {
            void navigator.clipboard.writeText(token).then(() => setCopied(true));
          }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <div className="alert alert--warning">
        This token is shown only once. Store it in your bot's secret store.
      </div>
      {children}
    </>
  );
}

/**
 * A value the reader is meant to take away rather than read — the scoped endpoint a resource
 * is served on (§3), and anything else a page hands over intact. The Copy button is
 * enhancement, exactly as the token reveal's is.
 */
export function Copyable({ value }: { value: string }): ReactNode {
  const [copied, setCopied] = useState(false);
  return (
    <span className="copyable">
      <span className="mono copy-value">{value}</span>
      <button
        type="button"
        className="btn btn--ghost btn--sm"
        aria-label="Copy"
        onClick={() => {
          void navigator.clipboard.writeText(value).then(() => setCopied(true));
        }}
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </span>
  );
}
