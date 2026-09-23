import type { PrimitiveState } from "../../seed";
import { Columns } from "./Columns";

/**
 * The Input bench: the typed `input`s, `.input--mono`, `.otp input`.
 *
 * A stub until pass 2's P1b (fields) draws that legacy markup beside `<Input>` in every
 * variant, size and state; its one state compares a placeholder with itself.
 */
export const inputStates: Record<string, PrimitiveState> = {
  input: () => <Columns legacy="stub" next="stub" />,
};
