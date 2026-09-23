import { useState } from "react";
import type { ReactNode } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

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
      <div className="flex items-center gap-2">
        {/* A control-high mono well that takes the row's free width and clips what does not
            fit: the token is one unbreakable string. */}
        <div className="flex h-control grow items-center overflow-hidden rounded-md bg-muted px-3 font-mono text-sm text-foreground">
          {token}
        </div>
        <Button
          variant="outline"
          onClick={() => {
            void navigator.clipboard.writeText(token).then(() => setCopied(true));
          }}
        >
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <Alert variant="warning">This token is shown only once. Store it in your bot's secret store.</Alert>
      {children}
    </>
  );
}

/**
 * A value the reader is meant to take away rather than read — the scoped endpoint a resource
 * is served on (§3), and anything else a page hands over intact. The Copy button is
 * enhancement, exactly as the token reveal's is.
 *
 * The value wraps anywhere, because an endpoint is one long token in a narrow column, and the
 * button sits on the first line's baseline.
 */
export function Copyable({ value }: { value: string }): ReactNode {
  const [copied, setCopied] = useState(false);
  return (
    <span className="inline-flex min-w-0 items-baseline gap-2">
      <span className="min-w-0 font-mono wrap-anywhere">{value}</span>
      <Button
        variant="ghost"
        size="sm"
        aria-label="Copy"
        onClick={() => {
          void navigator.clipboard.writeText(value).then(() => setCopied(true));
        }}
      >
        {copied ? "Copied" : "Copy"}
      </Button>
    </span>
  );
}
