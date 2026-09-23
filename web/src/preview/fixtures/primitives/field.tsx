import type { PrimitiveState } from "../../seed";
import { Field, FieldDescription, FieldError, FieldGroup } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Columns } from "./Columns";

/**
 * The Field bench: `.form`, `.field`, `.field-hint`, `.field-error` and the `.checkbox` row
 * with its `.checkbox-hint`. The legacy side writes each in the shapes the pages use, and the
 * component side writes the composition that replaces it.
 *
 * The checkbox row keeps a NATIVE box on both sides, because this bench is about the row's
 * layout. The box itself is the Checkbox bench's.
 */
export const fieldStates: Record<string, PrimitiveState> = {
  field: () => (
    <Columns
      legacy={
        <div className="form w-full">
          <div className="field">
            <label htmlFor="bench-field-a">Device code</label>
            <input id="bench-field-a" type="text" placeholder="XXXX-XXXX" />
            <div className="field-hint">Enter the code the pmcp CLI printed.</div>
          </div>
          <label className="field">
            <span className="label">New password</span>
            <input type="password" defaultValue="hunter22" />
            <span className="field-hint">At least 12 characters.</span>
          </label>
          <div className="field" hidden>
            <label htmlFor="bench-field-c">Endpoint</label>
            <input id="bench-field-c" type="url" />
          </div>
          <div className="field">
            <label className="label" htmlFor="bench-field-d">
              Name
            </label>
            <input id="bench-field-d" type="text" aria-invalid="true" defaultValue="Triage" />
            <div className="field-hint">
              <span className="field-error">Letters, digits and dashes only.</span>
            </div>
          </div>
          <div className="field">
            <label htmlFor="bench-field-e">Password</label>
            <input id="bench-field-e" type="password" aria-invalid="true" />
            <p className="field-error">The username or password is wrong.</p>
          </div>
          <label className="checkbox">
            <input type="checkbox" defaultChecked />
            <span>Sign out my other sessions</span>
          </label>
          <span className="field-hint checkbox-hint">CLI sessions included. This browser stays signed in.</span>
        </div>
      }
      next={
        <FieldGroup className="w-full">
          <Field>
            <Label htmlFor="bench-field-a-next">Device code</Label>
            <Input id="bench-field-a-next" type="text" placeholder="XXXX-XXXX" />
            <FieldDescription>Enter the code the pmcp CLI printed.</FieldDescription>
          </Field>
          <Field render={<label />}>
            <Label render={<span />}>New password</Label>
            <Input type="password" defaultValue="hunter22" />
            <FieldDescription render={<span />}>At least 12 characters.</FieldDescription>
          </Field>
          <Field hidden>
            <Label htmlFor="bench-field-c-next">Endpoint</Label>
            <Input id="bench-field-c-next" type="url" />
          </Field>
          <Field>
            <Label htmlFor="bench-field-d-next">Name</Label>
            <Input id="bench-field-d-next" type="text" aria-invalid="true" defaultValue="Triage" />
            <FieldDescription>
              <FieldError render={<span />}>Letters, digits and dashes only.</FieldError>
            </FieldDescription>
          </Field>
          <Field>
            <Label htmlFor="bench-field-e-next">Password</Label>
            <Input id="bench-field-e-next" type="password" aria-invalid="true" />
            <FieldError render={<p />}>The username or password is wrong.</FieldError>
          </Field>
          <Field orientation="horizontal" render={<label />}>
            <input type="checkbox" className="m-0 size-4 accent-primary" defaultChecked />
            <span>Sign out my other sessions</span>
          </Field>
          <FieldDescription render={<span />} className="-mt-3 pl-6.5">
            CLI sessions included. This browser stays signed in.
          </FieldDescription>
        </FieldGroup>
      }
    />
  ),
};
