import type { PrimitiveState } from "../../seed";
import { buttonStates } from "./button";
import { badgeStates } from "./badge";
import { inputStates } from "./input";
import { inputGroupStates } from "./input-group";
import { labelStates } from "./label";
import { fieldStates } from "./field";
import { nativeSelectStates } from "./native-select";
import { checkboxStates } from "./checkbox";
import { switchStates } from "./switch";
import { radioGroupStates } from "./radio-group";
import { cardStates } from "./card";
import { alertStates } from "./alert";
import { emptyStates } from "./empty";
import { tableStates } from "./table";
import { skeletonStates } from "./skeleton";
import { dialogStates } from "./dialog";
import { sheetStates } from "./sheet";
import { tabsStates } from "./tabs";
import { pageStates } from "./page";
import { listingStates } from "./listing";
import { kvStates } from "./kv";
import { authFrameStates } from "./auth-frame";

/**
 * Every state of the `primitives` bench, one file per component so each of pass 2's P1b
 * agents owns exactly the files of its components. State names are prefixed with the
 * component's (`button`, `button-focus`, …) because the spread below keeps only the last of
 * two equal keys.
 */
export const primitivesStates: Record<string, PrimitiveState> = {
  ...buttonStates,
  ...badgeStates,
  ...inputStates,
  ...inputGroupStates,
  ...labelStates,
  ...fieldStates,
  ...nativeSelectStates,
  ...checkboxStates,
  ...switchStates,
  ...radioGroupStates,
  ...cardStates,
  ...alertStates,
  ...emptyStates,
  ...tableStates,
  ...skeletonStates,
  ...dialogStates,
  ...sheetStates,
  ...tabsStates,
  ...pageStates,
  ...listingStates,
  ...kvStates,
  ...authFrameStates,
};
