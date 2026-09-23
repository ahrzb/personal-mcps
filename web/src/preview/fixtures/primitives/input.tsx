import type { PrimitiveState } from "../../seed";
import { Input } from "@/components/ui/input";
import { Bench } from "./Bench";

/**
 * The Input bench: `<Input>` in every `type` the pages write, the small size (the role editor's
 * name field) and the one-time-code boxes. Every state is shot at both widths, and the narrow
 * one is where the default size grows to its 44px touch target.
 */

/** The typed fields, one per `type` the pages write, holding a value or showing a placeholder. */
function Fields() {
  return (
    <>
      <Input type="text" defaultValue="Linear" />
      <Input type="password" defaultValue="hunter22" />
      <Input type="number" defaultValue="30000" />
      <Input type="url" placeholder="https://mcp.example.com/mcp" />
      <Input type="search" placeholder="filter paths…" />
    </>
  );
}

export const inputStates: Record<string, PrimitiveState> = {
  input: () => (
    <Bench>
      <Fields />
      {/* Two fields that wore `.input--mono`, which never applied, drawn sans as the slug field
          still is. The device and backup codes say `font-mono` at their call sites. */}
      <Input type="text" defaultValue="linear" />
      <Input type="text" placeholder="XXXX-XXXX" />
      <Input type="text" size="sm" className="w-50 max-w-full font-mono" placeholder="role name" />
      <Input type="text" size="sm" className="w-50 max-w-full font-mono" defaultValue="triage_bot" />
    </Bench>
  ),
  "input-invalid": () => (
    <Bench>
      <Input type="password" aria-invalid="true" defaultValue="hunter22" />
      <Input type="url" aria-invalid="true" placeholder="https://mcp.example.com/mcp" />
    </Bench>
  ),
  "input-disabled": () => (
    <Bench>
      <Input type="text" disabled defaultValue="Linear" />
      <Input type="search" disabled placeholder="filter paths…" />
    </Bench>
  ),
  // `data-focus`: visual-compare focuses the target just before the shot. The
  // `p-1` frame keeps the 3px ring, which is drawn outside the box, inside the crop.
  "input-focus": () => (
    <Bench>
      <div className="flex w-full flex-col gap-3 p-1">
        <Input type="text" data-focus defaultValue="ahrzb" />
        <Input type="password" aria-invalid="true" defaultValue="hunter22" />
      </div>
    </Bench>
  ),
  // OtpBoxes' digit boxes: each box is Input plus sizing classes at the call site. Three of the
  // six are drawn, because six overflow the 390px cell. The first box is focused, as OtpBoxes'
  // `autoFocus` leaves it.
  "input-otp": () => (
    <Bench>
      {[false, true].map((invalid) => (
        <div key={String(invalid)} className="flex justify-center gap-2">
          {(invalid ? ["4", "2", "0"] : ["4", "2", ""]).map((digit, at) => (
            <Input
              key={at}
              type="text"
              maxLength={1}
              className="h-otp-h w-otp-w p-0 text-center text-xl font-semibold shadow-none max-md:h-otp-h-touch max-md:w-otp-w-touch"
              aria-invalid={invalid ? "true" : undefined}
              data-focus={!invalid && at === 0 ? true : undefined}
              defaultValue={digit}
            />
          ))}
        </div>
      ))}
    </Bench>
  ),
};
