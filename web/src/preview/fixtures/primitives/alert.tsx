import type { ReactNode } from "react";
import type { PrimitiveState } from "../../seed";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Bench } from "./Bench";

/**
 * The Alert bench: `<Alert>` in its four tones and every shape the pages write it in, and
 * /audit's ceiling notice (`size="compact"`).
 *
 * The shapes are the pages' own: `chrome/Notice`'s icon beside a titled or an untitled
 * message (spaced, as /apps draws it, or flush, as /approvals does), a description alone,
 * a bare message, /settings' icon-less wrapper, and `chrome/States`' message with a Retry
 * button beside it.
 */
export const alertStates: Record<string, PrimitiveState> = {
  alert: () => (
    <Bench>
      {TONES.map((tone) => (
        <Full key={tone}>
          <Alert variant={tone}>
            <Icon />
            <div>
              <AlertTitle>Grants full admin access</AlertTitle>
              <AlertDescription>This client can read and change every app on this hub.</AlertDescription>
            </div>
          </Alert>
        </Full>
      ))}
    </Bench>
  ),

  "alert-untitled": () => (
    <Bench>
      <Full>
        <Alert variant="success">
          <Icon />
          <div>
            <AlertDescription>App connected.</AlertDescription>
          </div>
        </Alert>
      </Full>
      <Full>
        <Alert variant="success">
          <Icon />
          <div>
            <div>Request approved.</div>
          </div>
        </Alert>
      </Full>
      <Full>
        <Alert variant="warning">
          <Icon />
          <AlertDescription>This application registered itself — identity unverified.</AlertDescription>
        </Alert>
      </Full>
      <Full>
        <Alert variant="danger">
          <AlertDescription>That name is taken.</AlertDescription>
        </Alert>
      </Full>
      <Full>
        <Alert variant="warning">This token is shown only once. Store it in your bot&apos;s secret store.</Alert>
      </Full>
      <Full>
        <Alert>Tunnelled apps reach the hub over a Cloudflare Tunnel.</Alert>
      </Full>
      <Full>
        <Alert variant="danger">
          <div>
            <div>Password changed.</div>
          </div>
        </Alert>
      </Full>
      <Full>
        <Alert variant="danger">
          The read failed. The rows below are the last answer.{" "}
          <Button variant="outline" size="sm">
            Try again
          </Button>
        </Alert>
      </Full>
    </Bench>
  ),

  // /audit's strip, where the ceiling notice sits: one line, the 14px info glyph.
  "alert-compact": () => (
    <Bench>
      <Full>
        <Alert variant="warning" size="compact">
          <CeilingIcon />
          <span>Showing the newest 5,000 of 12,340 events — narrow the search, or export JSONL for all of them.</span>
        </Alert>
      </Full>
    </Bench>
  ),
};

const TONES = ["default", "success", "warning", "danger"] as const;

/** An alert fills its column on a page. */
function Full({ children }: { children: ReactNode }): ReactNode {
  return <div className="w-full">{children}</div>;
}

/** `chrome/Notice`'s 16px stroke glyph (its warning triangle). */
function Icon(): ReactNode {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m21.73 18-8-14a2 2 0 0 0-3.46 0l-8 14A2 2 0 0 0 4 20h16a2 2 0 0 0 1.73-2Z" />
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
    </svg>
  );
}

/** /audit's `WarnIcon`, 14px. */
function CeilingIcon(): ReactNode {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 8v4M12 16h.01" />
    </svg>
  );
}
