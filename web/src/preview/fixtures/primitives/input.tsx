import type { PrimitiveState } from "../../seed";
import { Input } from "@/components/ui/input";
import { Columns } from "./Columns";

/**
 * The Input bench: legacy.css's typed `input`s, `.input--mono`, `input.role-name` (the small
 * size) and `.otp input`, each beside `<Input>`. Every state is shot at both widths, and the
 * narrow one is where the default size grows to its 44px touch target.
 */

/** The typed fields, one per `type` the pages write, holding a value or showing a placeholder. */
function Fields({ next }: { next: boolean }) {
  const Field = next ? Input : "input";
  return (
    <>
      <Field type="text" defaultValue="Linear" />
      <Field type="password" defaultValue="hunter22" />
      <Field type="number" defaultValue="30000" />
      <Field type="url" placeholder="https://mcp.example.com/mcp" />
      <Field type="search" placeholder="filter paths…" />
    </>
  );
}

export const inputStates: Record<string, PrimitiveState> = {
  input: () => (
    <Columns
      legacy={
        <>
          <Fields next={false} />
          <input type="text" className="input--mono" defaultValue="linear" />
          <input type="text" className="input--mono" placeholder="XXXX-XXXX" />
          <input type="text" className="input role-name" placeholder="role name" />
          <input type="text" className="input role-name" defaultValue="triage_bot" />
        </>
      }
      next={
        <>
          <Fields next />
          {/* `.input--mono` never applied (see Input's comment): these draw in sans */}
          <Input type="text" defaultValue="linear" />
          <Input type="text" placeholder="XXXX-XXXX" />
          <Input type="text" size="sm" className="w-50 max-w-full font-mono" placeholder="role name" />
          <Input type="text" size="sm" className="w-50 max-w-full font-mono" defaultValue="triage_bot" />
        </>
      }
    />
  ),
  "input-invalid": () => (
    <Columns
      legacy={
        <>
          <input type="password" aria-invalid="true" defaultValue="hunter22" />
          <input type="url" className="input--mono" aria-invalid="true" placeholder="https://mcp.example.com/mcp" />
        </>
      }
      next={
        <>
          <Input type="password" aria-invalid="true" defaultValue="hunter22" />
          <Input type="url" aria-invalid="true" placeholder="https://mcp.example.com/mcp" />
        </>
      }
    />
  ),
  "input-disabled": () => (
    <Columns
      legacy={
        <>
          <input type="text" disabled defaultValue="Linear" />
          <input type="search" disabled placeholder="filter paths…" />
        </>
      }
      next={
        <>
          <Input type="text" disabled defaultValue="Linear" />
          <Input type="search" disabled placeholder="filter paths…" />
        </>
      }
    />
  ),
  // `data-focus`: visual-compare focuses each column's target just before shooting it. The
  // `p-1` frame would keep a ring inside the cropped column. Today's field draws none, and
  // this state is the proof.
  "input-focus": () => (
    <Columns
      legacy={
        <div className="flex w-full flex-col gap-3 p-1">
          <input type="text" data-focus defaultValue="ahrzb" />
          <input type="password" aria-invalid="true" defaultValue="hunter22" />
        </div>
      }
      next={
        <div className="flex w-full flex-col gap-3 p-1">
          <Input type="text" data-focus defaultValue="ahrzb" />
          <Input type="password" aria-invalid="true" defaultValue="hunter22" />
        </div>
      }
    />
  ),
  // OtpBoxes' digit boxes: each box is Input plus sizing classes at the call site, and the
  // row is `.otp`'s layout. Three of the six are drawn, because six overflow a 390px column
  // into its neighbour. The first box is focused, as OtpBoxes' `autoFocus` leaves it.
  "input-otp": () => (
    <Columns
      legacy={
        <>
          <div className="otp">
            {["4", "2", ""].map((digit, at) => (
              <input key={at} type="text" maxLength={1} data-focus={at === 0 ? true : undefined} defaultValue={digit} />
            ))}
          </div>
          <div className="otp">
            {["4", "2", "0"].map((digit, at) => (
              <input key={at} type="text" maxLength={1} aria-invalid="true" defaultValue={digit} />
            ))}
          </div>
        </>
      }
      next={
        <>
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
        </>
      }
    />
  ),
};
