import type { ReactNode } from "react";

/** One key-value row of a details card, as `styles.css`'s `.kv` draws it — the shape every
 *  details column on the agent page is built from (`pages/agent-detail.tsx`'s `Kv`). */
export function Kv({ k, children }: { k: string; children?: ReactNode }): ReactNode {
  return (
    <div className="kv-row">
      <div className="kv-key">{k}</div>
      <div>{children}</div>
    </div>
  );
}
