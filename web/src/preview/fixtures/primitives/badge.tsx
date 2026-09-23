import type { ReactNode } from "react";
import { Badge, BadgeDot, BadgeRemove } from "@/components/ui/badge";
import type { PrimitiveState } from "../../seed";
import { Columns } from "./Columns";

/**
 * The Badge bench: `.badge` in every tone and size beside `<Badge>`, plus what the pages put in
 * or around one: `.dot`, `.badge-x`, `.badge--dashed`, `.nav-badge`, and the wrapping badge
 * inside a row's detail line.
 *
 * State names read in legacy.css's vocabulary: `badge[-<tone>][-title|-xs]`, where the tone is
 * the `.badge--*` class the state replaces.
 */

type Variant = "default" | "outline" | "muted" | "success" | "warning" | "danger" | "mono";
type Size = "default" | "title" | "xs";

/** Each tone's legacy modifier (the `.badge--` suffix, which also names its states; none for a
 *  bare `.badge`), and a word a page puts in it. */
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

/** The same wrapper on both sides: 4px of room, so a focus ring (3px) is inside the crop. */
function Pad({ children }: { children: ReactNode }): ReactNode {
  return <div className="flex self-stretch p-1">{children}</div>;
}

const states: Record<string, PrimitiveState> = {};

for (const variant of Object.keys(VARIANTS) as Variant[]) {
  const { modifier, label } = VARIANTS[variant];
  for (const size of SIZES) {
    const legacy = ["badge", modifier && `badge--${modifier}`, size !== "default" && `badge--${size}`]
      .filter(Boolean)
      .join(" ");
    const name = ["badge", modifier, size !== "default" && size].filter(Boolean).join("-");
    states[name] = () => (
      <Columns
        legacy={<Pad><span className={legacy}>{label}</span></Pad>}
        next={<Pad><Badge variant={variant} size={size}>{label}</Badge></Pad>}
      />
    );
  }
}

/** The red count beside Approvals in the shell's nav: one digit (at its 18px minimum), and two. */
states["badge-count"] = () => (
  <Columns
    legacy={
      <>
        <Pad><span className="nav-badge">3</span></Pad>
        <Pad><span className="nav-badge">12</span></Pad>
      </>
    }
    next={
      <>
        <Pad><Badge variant="count" size="count">3</Badge></Pad>
        <Pad><Badge variant="count" size="count">12</Badge></Pad>
      </>
    }
  />
);

/** A status dot, lit and idle, as /apps and /settings write them, and in a row's xs badge. */
states["badge-dot"] = () => (
  <Columns
    legacy={
      <>
        <Pad><span className="badge badge--success"><span className="dot" />online</span></Pad>
        <Pad><span className="badge badge--muted"><span className="dot dot--idle" />offline</span></Pad>
        <Pad><span className="badge badge--success badge--xs"><span className="dot" />live</span></Pad>
      </>
    }
    next={
      <>
        <Pad><Badge variant="success"><BadgeDot />online</Badge></Pad>
        <Pad><Badge variant="muted"><BadgeDot idle />offline</Badge></Pad>
        <Pad><Badge variant="success" size="xs"><BadgeDot />live</Badge></Pad>
      </>
    }
  />
);

/** "new", "nothing saved yet": a state that has not landed anywhere, drawn with a dashed edge. */
states["badge-dashed"] = () => (
  <Columns
    legacy={
      <>
        <Pad><span className="badge badge--success badge--dashed">new</span></Pad>
        <Pad><span className="badge badge--warning badge--dashed">new grant · nothing saved yet</span></Pad>
      </>
    }
    next={
      <>
        <Pad><Badge variant="success" className="border-dashed">new</Badge></Pad>
        <Pad><Badge variant="warning" className="border-dashed">new grant · nothing saved yet</Badge></Pad>
      </>
    }
  />
);

/** The grant editor's standing badge with its ×, at rest and with the × focused. */
for (const focus of [false, true]) {
  states[focus ? "badge-remove-focus" : "badge-remove"] = () => (
    <Columns
      legacy={
        <>
          <Pad>
            <span className="badge badge--success">
              in Allowed
              <button type="button" className="badge-x" title="remove this entry" data-focus={focus || undefined}>
                ×
              </button>
            </span>
          </Pad>
          <Pad>
            <span className="badge badge--warning">
              in Ask first
              <button type="button" className="badge-x" title="remove this entry">
                ×
              </button>
            </span>
          </Pad>
        </>
      }
      next={
        <>
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
        </>
      }
    />
  );
}

/** A declared pattern is one unbreakable token, so inside a row's detail line the badge wraps
 *  rather than pushing the row past the listing (`.cr-detail .badge`). */
const PATTERN = `files:read:${"projects/personal-mcps/".repeat(12)}**`;
states["badge-wrap"] = () => (
  <Columns
    legacy={
      <div className="cr-detail">
        <div>
          <span className="muted">allowed</span> <span className="badge badge--mono">{PATTERN}</span>
        </div>
        <div>
          <span className="muted">ask first</span> <span className="badge badge--warning">{PATTERN}</span>
        </div>
      </div>
    }
    next={
      <div className="cr-detail">
        <div>
          <span className="muted">allowed</span> <Badge variant="mono" size="wrap">{PATTERN}</Badge>
        </div>
        <div>
          <span className="muted">ask first</span> <Badge variant="warning" size="wrap">{PATTERN}</Badge>
        </div>
      </div>
    }
  />
);

export const badgeStates: Record<string, PrimitiveState> = states;
