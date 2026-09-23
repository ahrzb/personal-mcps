import type { PrimitiveState } from "../../seed";
import { Columns } from "./Columns";

/**
 * The InputGroup bench: the audit search box, `.a-search`.
 *
 * A stub until pass 2's P1b (fields) draws that legacy markup beside `<InputGroup>` in every
 * variant, size and state; its one state compares a placeholder with itself.
 */
export const inputGroupStates: Record<string, PrimitiveState> = {
  "input-group": () => <Columns legacy="stub" next="stub" />,
};
