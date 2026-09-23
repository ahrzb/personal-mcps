import type { ReactNode } from "react";
import type { PrimitiveState } from "../../seed";
import { RadioGroup, RadioGroupCard, RadioGroupSegment } from "@/components/ui/radio-group";
import { Bench } from "./Bench";

/**
 * The RadioGroup bench, in two parts:
 * - `RadioGroupCard`s, app-new's kind and authentication;
 * - `RadioGroupSegment`s, the three-way of a grant row.
 */

const KINDS = [
  { value: "tunnel", title: "Tunneled", description: "A bot that dials in with an app token — shown once after creating." },
  { value: "proxy", title: "Proxied", description: "An existing MCP endpoint the hub forwards to." },
];

function Cards({ chosen }: { chosen: string }): ReactNode {
  return (
    <RadioGroup aria-label="App kind" defaultValue={chosen} className="w-full">
      {KINDS.map((kind) => (
        <RadioGroupCard key={kind.value} value={kind.value} title={kind.title} description={kind.description} />
      ))}
    </RadioGroup>
  );
}

/** GrantRows' three levels, and its rule for what each segment of a row shows. */
const SEGMENTS = [
  { value: "none", label: "none", rank: 0 },
  { value: "approval", label: "ask", rank: 1 },
  { value: "allow", label: "allow", rank: 2 },
] as const;

type Level = (typeof SEGMENTS)[number]["value"];

/** One grant row's control: the level it holds, and the level another entry implies. */
type Control = { value: Level; implied: Level | null };

/** One grant row's segments, drawn by GrantRows' own rules. `focus` names the segment that
 *  carries `data-focus`. */
function Seg({ control, focus }: { control: Control; focus?: Level }): ReactNode {
  const impliedRank = control.implied === null ? -1 : SEGMENTS.find((each) => each.value === control.implied)!.rank;
  const segments = SEGMENTS.map((segment) => {
    const checked = control.value === segment.value;
    const held = checked && control.value !== "none";
    return {
      ...segment,
      disabled: segment.rank < impliedRank && !held,
      implied: segment.rank === impliedRank && !checked,
      warn: segment.value === "approval" && (checked || segment.rank === impliedRank),
      focus: segment.value === focus ? true : undefined,
    };
  });
  return (
    <RadioGroup variant="segment" defaultValue={control.value}>
      {segments.map((segment) => (
        <RadioGroupSegment
          key={segment.value}
          value={segment.value}
          disabled={segment.disabled}
          implied={segment.implied}
          tone={segment.warn ? "warning" : "default"}
          data-focus={segment.focus}
        >
          {segment.label}
        </RadioGroupSegment>
      ))}
    </RadioGroup>
  );
}

/**
 * Every combination a grant row can show: each level held with nothing implied, and each
 * level held under an implied ask or allow.
 */
const CONTROLS: Control[] = [
  { value: "none", implied: null },
  { value: "approval", implied: null },
  { value: "allow", implied: null },
  { value: "none", implied: "approval" },
  { value: "none", implied: "allow" },
  { value: "approval", implied: "allow" },
];

function Segs(): ReactNode {
  return (
    <>
      {CONTROLS.map((control, at) => (
        <Seg key={at} control={control} />
      ))}
    </>
  );
}

export const radioGroupStates: Record<string, PrimitiveState> = {
  "radio-group": () => (
    <Bench>
      <Cards chosen="tunnel" />
      <Cards chosen="proxy" />
    </Bench>
  ),
  // `data-focus`: visual-compare focuses the target just before the shot. The
  // `p-1` frame keeps the ring, which is drawn outside the radio, inside the crop.
  "radio-group-focus": () => (
    <Bench>
      <div className="w-full p-1">
        <RadioGroup aria-label="App kind" defaultValue="tunnel">
          <RadioGroupCard value="tunnel" title="Tunneled" description="A bot that dials in with an app token." data-focus />
        </RadioGroup>
      </div>
    </Bench>
  ),
  "radio-group-segment": () => (
    <Bench><Segs /></Bench>
  ),
  "radio-group-segment-focus": () => (
    <Bench>
      <div className="p-1">
        <Seg control={{ value: "none", implied: null }} focus="approval" />
      </div>
    </Bench>
  ),
  // Focus on the implied segment: today's ring REPLACES its hollow ring.
  "radio-group-segment-focus-implied": () => (
    <Bench>
      <div className="p-1">
        <Seg control={{ value: "approval", implied: "allow" }} focus="allow" />
      </div>
    </Bench>
  ),
};
