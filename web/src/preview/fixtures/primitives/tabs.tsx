import type { ReactNode } from "react";
import type { PrimitiveState } from "../../seed";
import { Tabs, TabsList, TabsTrigger, tabsListVariants, tabsTriggerVariants } from "@/components/ui/tabs";
import { Columns } from "./Columns";

/**
 * The Tabs bench: `.segmented` twice. As /audit's view switch (buttons with `aria-current`)
 * beside `<Tabs>`, and as /settings' token-kind row (links, which stay links) beside the same
 * links wearing `tabsListVariants` / `tabsTriggerVariants`.
 *
 * Focus is staged on an arm that is not current and on the current one, which today shows no
 * ring. Hover has no state: neither side draws one.
 *
 * At 390 an arm is 44px of 14px text, and either strip is wider than the cell: each side is
 * clipped to its cell by `Clip`, since a strip spilling out of the legacy cell would paint under
 * the component's and show in its crop.
 */

const VIEWS = ["Summary", "Sessions", "Events"] as const;
const KINDS = ["All", "Agents", "Apps"] as const;

/** Clips a strip to its cell, 4px in, so a focus ring on its first arm still shows whole. */
function Clip({ children }: { children: ReactNode }): ReactNode {
  return <div className="w-full overflow-hidden p-1">{children}</div>;
}

/** `focus` names the arm the compare focuses, on both sides. */
function Views({ focus }: { focus?: string }): ReactNode {
  const current = "Sessions";
  return (
    <Columns
      legacy={
        <Clip>
          <div className="segmented" role="group" aria-label="View">
            {VIEWS.map((view) => (
              <button
                key={view}
                type="button"
                aria-current={view === current ? "page" : undefined}
                data-focus={view === focus ? "" : undefined}
              >
                {view}
              </button>
            ))}
          </div>
        </Clip>
      }
      next={
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
      }
    />
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
    <Columns
      legacy={
        <Clip>
          <div className="segmented">{links()}</div>
        </Clip>
      }
      next={
        <Clip>
          <div className={tabsListVariants()}>{links(tabsTriggerVariants())}</div>
        </Clip>
      }
    />
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
