import type { PrimitiveState } from "../../seed";
import { Field, FieldDescription, FieldError, FieldGroup } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Bench } from "./Bench";

/**
 * The Field bench: a form's group of fields, each with its label, control, hint or error, in
 * the shapes the pages write them, and a checkbox row with its hint under it.
 *
 * The checkbox row keeps a NATIVE box, because this bench is about the row's layout. The box
 * itself is the Checkbox bench's.
 */
export const fieldStates: Record<string, PrimitiveState> = {
  field: () => (
    <Bench>
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
    </Bench>
  ),
};
