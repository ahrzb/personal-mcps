import type { ReactNode } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import type { PrimitiveState } from "../../seed";
import { Columns } from "./Columns";

/**
 * The Button bench: `.btn` in every variant, size and state beside `<Button>`, plus the two
 * shapes a page gives it that are not a variant: an `<a>` wearing `buttonVariants()`, and
 * `.btn--block`.
 *
 * State names read in legacy.css's vocabulary: `button-<modifier>[-sm|-mini][-focus|-disabled]`,
 * where the modifier is the `.btn--*` class the state replaces.
 */

type Variant = "default" | "outline" | "ghost" | "danger" | "danger-outline" | "danger-ghost";
type Size = "default" | "sm" | "xs";

/** Each variant's legacy modifier (the `.btn--` suffix, which also names its states), and a label. */
const VARIANTS: Record<Variant, { modifier: string; label: string }> = {
  default: { modifier: "primary", label: "Save" },
  outline: { modifier: "outline", label: "Cancel" },
  ghost: { modifier: "ghost", label: "Back" },
  danger: { modifier: "danger", label: "Delete" },
  "danger-outline": { modifier: "danger-outline", label: "Revoke" },
  "danger-ghost": { modifier: "danger-ghost", label: "Remove" },
};

/** Each size's legacy classes, and its state-name suffix. */
const SIZES: Record<Size, { classes: string; suffix: string }> = {
  default: { classes: "", suffix: "" },
  sm: { classes: "btn--sm", suffix: "-sm" },
  xs: { classes: "btn--sm btn--mini", suffix: "-mini" },
};

/** The same wrapper on both sides: 4px of room, so a focus ring (3px) is inside the crop. */
function Pad({ children }: { children: ReactNode }): ReactNode {
  return <div className="flex self-stretch p-1">{children}</div>;
}

function legacyClass(variant: Variant, size: Size): string {
  return ["btn", `btn--${VARIANTS[variant].modifier}`, SIZES[size].classes].filter(Boolean).join(" ");
}

const states: Record<string, PrimitiveState> = {};

for (const variant of Object.keys(VARIANTS) as Variant[]) {
  const { modifier, label } = VARIANTS[variant];
  for (const size of Object.keys(SIZES) as Size[]) {
    const name = `button-${modifier}${SIZES[size].suffix}`;
    states[name] = () => (
      <Columns
        legacy={<Pad><button type="button" className={legacyClass(variant, size)}>{label}</button></Pad>}
        next={<Pad><Button variant={variant} size={size}>{label}</Button></Pad>}
      />
    );
    states[`${name}-focus`] = () => (
      <Columns
        legacy={<Pad><button type="button" data-focus className={legacyClass(variant, size)}>{label}</button></Pad>}
        next={<Pad><Button data-focus variant={variant} size={size}>{label}</Button></Pad>}
      />
    );
    states[`${name}-disabled`] = () => (
      <Columns
        legacy={<Pad><button type="button" disabled className={legacyClass(variant, size)}>{label}</button></Pad>}
        next={<Pad><Button disabled variant={variant} size={size}>{label}</Button></Pad>}
      />
    );
  }

  // An <a> or <Link> takes the classes rather than rendering <Button>: 25-odd sites do this.
  states[`button-${modifier}-link`] = () => (
    <Columns
      legacy={<Pad><a href="#" className={legacyClass(variant, "default")}>{label}</a></Pad>}
      next={<Pad><a href="#" className={buttonVariants({ variant })}>{label}</a></Pad>}
    />
  );
  states[`button-${modifier}-link-focus`] = () => (
    <Columns
      legacy={<Pad><a href="#" data-focus className={legacyClass(variant, "default")}>{label}</a></Pad>}
      next={<Pad><a href="#" data-focus className={buttonVariants({ variant })}>{label}</a></Pad>}
    />
  );
}

/** A bare `.btn` (two Links on /apps/new) is the ghost variant: they differ only on hover. */
states["button-bare-link"] = () => (
  <Columns
    legacy={<Pad><a href="#" className="btn">Back</a></Pad>}
    next={<Pad><a href="#" className={buttonVariants({ variant: "ghost" })}>Back</a></Pad>}
  />
);

/** `.btn--block` is a className, `w-full`, on the variants the auth cards stack. */
states["button-block"] = () => (
  <Columns
    legacy={
      <>
        <Pad><button type="button" className="btn btn--primary btn--block">Sign in</button></Pad>
        <Pad><button type="button" className="btn btn--outline btn--block">Use a passkey</button></Pad>
        <Pad><button type="button" className="btn btn--danger-outline btn--block">Disable</button></Pad>
      </>
    }
    next={
      <>
        <Pad><Button className="w-full">Sign in</Button></Pad>
        <Pad><Button variant="outline" className="w-full">Use a passkey</Button></Pad>
        <Pad><Button variant="danger-outline" className="w-full">Disable</Button></Pad>
      </>
    }
  />
);

export const buttonStates: Record<string, PrimitiveState> = states;
