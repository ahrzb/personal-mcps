import type { ReactNode } from "react";
import type { PrimitiveState } from "../../seed";
import { Tabs, TabsList, TabsTrigger, tabsListVariants, tabsTriggerVariants } from "@/components/ui/tabs";
import { Bench } from "./Bench";

/**
 * The Tabs bench: the segmented strip twice. As /audit's view switch, `<Tabs>`, and as
 * /settings' token-kind row, links (which stay links) wearing `tabsListVariants` /
 * `tabsTriggerVariants`.
 *
 * Focus is staged on an arm that is not current and on the current one, whose ring replaces its
 * raised shadow. Hover has no state: nothing draws one.
 *
 * At 390 an arm is 44px of 14px text, and either strip is wider than the cell, so `Clip` cuts it
 * at the cell's edge, as the baselines were shot.
 */

const VIEWS = ["Summary", "Sessions", "Events"] as const;
const KINDS = ["All", "Agents", "Apps"] as const;

/** Clips a strip to its cell, 4px in, so a focus ring on its first arm still shows whole. */
function Clip({ children }: { children: ReactNode }): ReactNode {
  return <div className="w-full overflow-hidden p-1">{children}</div>;
}

/** `focus` names the arm the compare focuses. */
function Views({ focus }: { focus?: string }): ReactNode {
  const current = "Sessions";
  return (
    <Bench>
      <Clip>
        <Tabs defaultValue={current}>
          <TabsList aria-label="View">
            {VIEWS.map((view) => (
              <TabsTrigger key={view} value={view} data-focus={view === focus ? "" : undefined}>
                {view}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </Clip>
    </Bench>
  );
}

function Kinds({ focus }: { focus?: string }): ReactNode {
  const current = "All";
  const links = (className?: string): ReactNode =>
    KINDS.map((kind) => (
      <a
        key={kind}
        href={`#${kind}`}
        className={className}
        aria-current={kind === current ? "page" : undefined}
        data-focus={kind === focus ? "" : undefined}
      >
        {kind}
      </a>
    ));
  return (
    <Bench>
      <Clip>
        <div className={tabsListVariants()}>{links(tabsTriggerVariants())}</div>
      </Clip>
    </Bench>
  );
}

export const tabsStates: Record<string, PrimitiveState> = {
  tabs: () => <Views />,
  "tabs-focus": () => <Views focus="Summary" />,
  "tabs-focus-current": () => <Views focus="Sessions" />,
  "tabs-links": () => <Kinds />,
  "tabs-links-focus": () => <Kinds focus="Agents" />,
  "tabs-links-focus-current": () => <Kinds focus="All" />,
};
