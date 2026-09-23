import type { PrimitiveState } from "../../seed";
import { Columns } from "./Columns";

/**
 * The NativeSelect bench: the two `select`s.
 *
 * A stub until pass 2's P1b (fields) draws that legacy markup beside `<NativeSelect>` in every
 * variant, size and state; its one state compares a placeholder with itself.
 */
export const nativeSelectStates: Record<string, PrimitiveState> = {
  "native-select": () => <Columns legacy="stub" next="stub" />,
};
