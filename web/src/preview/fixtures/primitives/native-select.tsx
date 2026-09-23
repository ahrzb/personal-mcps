import type { ReactNode } from "react";
import type { PrimitiveState } from "../../seed";
import { NativeSelect } from "@/components/ui/native-select";
import { Columns } from "./Columns";

/**
 * The NativeSelect bench: the app's two `select`s beside `<NativeSelect>`. One is consent's
 * agent picker (the default size, full width). The other is the credentials pane's expiry
 * filter (`.gh-form select`: the small size, as wide as its longest option).
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
    <Columns
      legacy={
        <>
          <select defaultValue="">
            <Agents />
          </select>
          <select defaultValue="triage">
            <Agents />
          </select>
          <div className="gh-form">
            <select defaultValue="7776000">
              <Expiries />
            </select>
          </div>
        </>
      }
      next={
        <>
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
        </>
      }
    />
  ),
  // `data-focus`: visual-compare focuses each column's target just before shooting it. The
  // `p-1` frame keeps the 3px ring, which is drawn outside the box, inside the cropped column.
  "native-select-focus": () => (
    <Columns
      legacy={
        <div className="w-full p-1">
          <select data-focus defaultValue="">
            <Agents />
          </select>
        </div>
      }
      next={
        <div className="w-full p-1">
          <NativeSelect data-focus defaultValue="">
            <Agents />
          </NativeSelect>
        </div>
      }
    />
  ),
  "native-select-invalid": () => (
    <Columns
      legacy={
        <select aria-invalid="true" defaultValue="">
          <Agents />
        </select>
      }
      next={
        <NativeSelect aria-invalid="true" defaultValue="">
          <Agents />
        </NativeSelect>
      }
    />
  ),
  "native-select-disabled": () => (
    <Columns
      legacy={
        <>
          <select disabled defaultValue="triage">
            <Agents />
          </select>
          <div className="gh-form">
            <select disabled defaultValue="7776000">
              <Expiries />
            </select>
          </div>
        </>
      }
      next={
        <>
          <NativeSelect disabled defaultValue="triage">
            <Agents />
          </NativeSelect>
          <div className="flex items-center gap-1.5">
            <NativeSelect size="sm" className="w-auto" disabled defaultValue="7776000">
              <Expiries />
            </NativeSelect>
          </div>
        </>
      }
    />
  ),
};
