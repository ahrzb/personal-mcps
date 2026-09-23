import type { PrimitiveState } from "../../seed";
import { Columns } from "./Columns";

/**
 * The Field bench: `.form`, `.field`, `.field-hint`, `.field-error`.
 *
 * A stub until pass 2's P1b (fields) draws that legacy markup beside `<Field>` in every
 * variant, size and state; its one state compares a placeholder with itself.
 */
export const fieldStates: Record<string, PrimitiveState> = {
  field: () => <Columns legacy="stub" next="stub" />,
};
