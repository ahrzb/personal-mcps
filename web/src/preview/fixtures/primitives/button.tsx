import type { ReactNode } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import type { PrimitiveState } from "../../seed";
import { Bench } from "./Bench";

/**
 * The Button bench: `<Button>` in every variant, size and state, plus the two shapes a page
 * gives it that are not a variant: an `<a>` wearing `buttonVariants()`, and a full-width
 * button.
 *
 * State names keep the vocabulary of the legacy `.btn` classes the bench was first matched
 * against, because each name keys a baseline: `button-<modifier>[-sm|-mini|-cell][-focus|-disabled]`.
 */

type Variant = "default" | "outline" | "ghost" | "danger" | "danger-outline" | "danger-ghost";
type Size = "default" | "sm" | "xs" | "cell";

/** Each variant's state-name modifier (the old `.btn--` suffix), and a label. */
const VARIANTS: Record<Variant, { modifier: string; label: string }> = {
  default: { modifier: "primary", label: "Save" },
  outline: { modifier: "outline", label: "Cancel" },
  ghost: { modifier: "ghost", label: "Back" },
  danger: { modifier: "danger", label: "Delete" },
  "danger-outline": { modifier: "danger-outline", label: "Revoke" },
  "danger-ghost": { modifier: "danger-ghost", label: "Remove" },
};

/** Each size's state-name suffix. */
const SIZES: Record<Size, { suffix: string }> = {
  default: { suffix: "" },
  sm: { suffix: "-sm" },
  xs: { suffix: "-mini" },
  cell: { suffix: "-cell" },
};

/** 4px of room, so a focus ring (3px) is inside the crop. */
function Pad({ children }: { children: ReactNode }): ReactNode {
  return <div className="flex self-stretch p-1">{children}</div>;
}

const states: Record<string, PrimitiveState> = {};

for (const variant of Object.keys(VARIANTS) as Variant[]) {
  const { modifier, label } = VARIANTS[variant];
  for (const size of Object.keys(SIZES) as Size[]) {
    const name = `button-${modifier}${SIZES[size].suffix}`;
    states[name] = () => (
      <Bench><Pad><Button variant={variant} size={size}>{label}</Button></Pad></Bench>
    );
    states[`${name}-focus`] = () => (
      <Bench><Pad><Button data-focus variant={variant} size={size}>{label}</Button></Pad></Bench>
    );
    states[`${name}-disabled`] = () => (
      <Bench><Pad><Button disabled variant={variant} size={size}>{label}</Button></Pad></Bench>
    );
  }

  // An <a> or <Link> takes the classes rather than rendering <Button>: 25-odd sites do this.
  states[`button-${modifier}-link`] = () => (
    <Bench><Pad><a href="#" className={buttonVariants({ variant })}>{label}</a></Pad></Bench>
  );
  states[`button-${modifier}-link-focus`] = () => (
    <Bench><Pad><a href="#" data-focus className={buttonVariants({ variant })}>{label}</a></Pad></Bench>
  );
}

/** A bare `.btn` (two Links on /apps/new) became the ghost variant. */
states["button-bare-link"] = () => (
  <Bench><Pad><a href="#" className={buttonVariants({ variant: "ghost" })}>Back</a></Pad></Bench>
);

/** The full-width buttons the auth cards stack: a `w-full` className, not a variant. */
states["button-block"] = () => (
  <Bench>
    <Pad><Button className="w-full">Sign in</Button></Pad>
    <Pad><Button variant="outline" className="w-full">Use a passkey</Button></Pad>
    <Pad><Button variant="danger-outline" className="w-full">Disable</Button></Pad>
  </Bench>
);

export const buttonStates: Record<string, PrimitiveState> = states;
