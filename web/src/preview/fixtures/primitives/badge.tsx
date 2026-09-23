import type { ReactNode } from "react";
import { ListRowDetail } from "@/chrome/Listing";
import { Muted } from "@/chrome/Text";
import { Badge, BadgeDot, BadgeRemove } from "@/components/ui/badge";
import type { PrimitiveState } from "../../seed";
import { Bench } from "./Bench";

/**
 * The Badge bench: `<Badge>` in every tone and size, plus what the pages put in or around one:
 * the status dot, the remove button, the dashed edge, the nav count, and the wrapping badge
 * inside a row's detail line.
 *
 * State names keep the vocabulary of the legacy `.badge` classes the bench was first matched
 * against, because each name keys a baseline: `badge[-<tone>][-title|-xs]`.
 */

type Variant = "default" | "outline" | "muted" | "success" | "warning" | "danger" | "mono";
type Size = "default" | "title" | "xs";

/** Each tone's state-name modifier (the old `.badge--` suffix; none for the default), and a
 *  word a page puts in it. */
const VARIANTS: Record<Variant, { modifier: string | null; label: string }> = {
  default: { modifier: null, label: "3 on" },
  outline: { modifier: "outline", label: "current" },
  muted: { modifier: "muted", label: "offline" },
  success: { modifier: "success", label: "connected" },
  warning: { modifier: "warning", label: "pending" },
  danger: { modifier: "danger", label: "denied" },
  mono: { modifier: "mono", label: "tunnel" },
};

const SIZES: Size[] = ["default", "title", "xs"];

/** 4px of room, so a focus ring (3px) is inside the crop. */
function Pad({ children }: { children: ReactNode }): ReactNode {
  return <div className="flex self-stretch p-1">{children}</div>;
}

const states: Record<string, PrimitiveState> = {};

for (const variant of Object.keys(VARIANTS) as Variant[]) {
  const { modifier, label } = VARIANTS[variant];
  for (const size of SIZES) {
    const name = ["badge", modifier, size !== "default" && size].filter(Boolean).join("-");
    states[name] = () => (
      <Bench><Pad><Badge variant={variant} size={size}>{label}</Badge></Pad></Bench>
    );
  }
}

/** The red count beside Approvals in the shell's nav: one digit (at its 18px minimum), and two. */
states["badge-count"] = () => (
  <Bench>
    <Pad><Badge variant="count" size="count">3</Badge></Pad>
    <Pad><Badge variant="count" size="count">12</Badge></Pad>
  </Bench>
);

/** A status dot, lit and idle, as /apps and /settings write them, and in a row's xs badge. */
states["badge-dot"] = () => (
  <Bench>
    <Pad><Badge variant="success"><BadgeDot />online</Badge></Pad>
    <Pad><Badge variant="muted"><BadgeDot idle />offline</Badge></Pad>
    <Pad><Badge variant="success" size="xs"><BadgeDot />live</Badge></Pad>
  </Bench>
);

/** "new", "nothing saved yet": a state that has not landed anywhere, drawn with a dashed edge. */
states["badge-dashed"] = () => (
  <Bench>
    <Pad><Badge variant="success" className="border-dashed">new</Badge></Pad>
    <Pad><Badge variant="warning" className="border-dashed">new grant · nothing saved yet</Badge></Pad>
  </Bench>
);

/** The grant editor's standing badge with its ×, at rest and with the × focused. */
for (const focus of [false, true]) {
  states[focus ? "badge-remove-focus" : "badge-remove"] = () => (
    <Bench>
      <Pad>
        <Badge variant="success">
          in Allowed
          <BadgeRemove title="remove this entry" data-focus={focus || undefined}>
            ×
          </BadgeRemove>
        </Badge>
      </Pad>
      <Pad>
        <Badge variant="warning">
          in Ask first
          <BadgeRemove title="remove this entry">×</BadgeRemove>
        </Badge>
      </Pad>
    </Bench>
  );
}

/** A declared pattern is one unbreakable token, so inside a row's detail line the badge wraps
 *  rather than pushing the row past the listing (`size="wrap"`). */
const PATTERN = `files:read:${"projects/personal-mcps/".repeat(12)}**`;
states["badge-wrap"] = () => (
  <Bench>
    <ListRowDetail>
      <div>
        <Muted>allowed</Muted> <Badge variant="mono" size="wrap">{PATTERN}</Badge>
      </div>
      <div>
        <Muted>ask first</Muted> <Badge variant="warning" size="wrap">{PATTERN}</Badge>
      </div>
    </ListRowDetail>
  </Bench>
);

export const badgeStates: Record<string, PrimitiveState> = states;
