import type { ReactNode } from "react";
import type { PrimitiveState } from "../../seed";
import { NativeSelect } from "@/components/ui/native-select";
import { Bench } from "./Bench";

/**
 * The NativeSelect bench: the app's two `<NativeSelect>`s. One is consent's agent picker (the
 * default size, full width). The other is the credentials pane's expiry filter (the small
 * size, as wide as its longest option).
 */

/** Consent's options: an empty "choose" option first, so a consent is always a choice. */
function Agents(): ReactNode {
  return (
    <>
      <option value="">Choose an agent</option>
      <option value="triage">Triage bot</option>
    </>
  );
}

/** The credentials pane's expiry choices, with its default selected. */
function Expiries(): ReactNode {
  return (
    <>
      <option value="2592000">30d</option>
      <option value="7776000">90d · default</option>
      <option value="never">never</option>
    </>
  );
}

export const nativeSelectStates: Record<string, PrimitiveState> = {
  "native-select": () => (
    <Bench>
      <NativeSelect defaultValue="">
        <Agents />
      </NativeSelect>
      <NativeSelect defaultValue="triage">
        <Agents />
      </NativeSelect>
      <div className="flex items-center gap-1.5">
        <NativeSelect size="sm" className="w-auto" defaultValue="7776000">
          <Expiries />
        </NativeSelect>
      </div>
    </Bench>
  ),
  // `data-focus`: visual-compare focuses the target just before the shot. The
  // `p-1` frame keeps the 3px ring, which is drawn outside the box, inside the crop.
  "native-select-focus": () => (
    <Bench>
      <div className="w-full p-1">
        <NativeSelect data-focus defaultValue="">
          <Agents />
        </NativeSelect>
      </div>
    </Bench>
  ),
  "native-select-invalid": () => (
    <Bench>
      <NativeSelect aria-invalid="true" defaultValue="">
        <Agents />
      </NativeSelect>
    </Bench>
  ),
  "native-select-disabled": () => (
    <Bench>
      <NativeSelect disabled defaultValue="triage">
        <Agents />
      </NativeSelect>
      <div className="flex items-center gap-1.5">
        <NativeSelect size="sm" className="w-auto" disabled defaultValue="7776000">
          <Expiries />
        </NativeSelect>
      </div>
    </Bench>
  ),
};
