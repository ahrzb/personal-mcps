import type { ReactNode } from "react";
import type { PrimitiveState } from "../../seed";
import { RadioGroup, RadioGroupCard, RadioGroupSegment } from "@/components/ui/radio-group";
import { Columns } from "./Columns";

/**
 * The RadioGroup bench, in two parts:
 * - `.choice` cards (app-new's kind and authentication), beside `RadioGroupCard`;
 * - the `.seg` three-way of a grant row, beside `RadioGroupSegment`.
 *
 * Each legacy group has its own `name`, since native radios group by name across the whole
 * document.
 */

const KINDS = [
  { value: "tunnel", title: "Tunneled", description: "A bot that dials in with an app token — shown once after creating." },
  { value: "proxy", title: "Proxied", description: "An existing MCP endpoint the hub forwards to." },
];

function Cards({ next, chosen, name }: { next: boolean; chosen: string; name: string }): ReactNode {
  if (next)
    return (
      <RadioGroup aria-label="App kind" defaultValue={chosen} className="w-full">
        {KINDS.map((kind) => (
          <RadioGroupCard key={kind.value} value={kind.value} title={kind.title} description={kind.description} />
        ))}
      </RadioGroup>
    );
  return (
    <div className="choice-list w-full" role="radiogroup" aria-label="App kind">
      {KINDS.map((kind) => (
        <label className="choice" key={kind.value}>
          <input type="radio" name={name} value={kind.value} defaultChecked={kind.value === chosen} />
          <div>
            <div className="choice-title">{kind.title}</div>
            <div className="choice-desc">{kind.description}</div>
          </div>
        </label>
      ))}
    </div>
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

/**
 * A `.seg` or its component, drawn by GrantRows' own rules. `focus` names the segment that
 * carries `data-focus`.
 */
function Seg({ next, control, name, focus }: { next: boolean; control: Control; name: string; focus?: Level }): ReactNode {
  const impliedRank = control.implied === null ? -1 : SEGMENTS.find((each) => each.value === control.implied)!.rank;
  const segments = SEGMENTS.map((segment) => {
    const checked = control.value === segment.value;
    const held = checked && control.value !== "none";
    return {
      ...segment,
      checked,
      disabled: segment.rank < impliedRank && !held,
      implied: segment.rank === impliedRank && !checked,
      warn: segment.value === "approval" && (checked || segment.rank === impliedRank),
      focus: segment.value === focus ? true : undefined,
    };
  });
  if (next)
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
  return (
    <span className="seg">
      {segments.map((segment) => (
        <label
          key={segment.value}
          className={`seg-opt${segment.implied ? " impl" : ""}${segment.warn ? " seg-opt--warn" : ""}`}
        >
          <input
            type="radio"
            name={name}
            value={segment.value}
            defaultChecked={segment.checked}
            disabled={segment.disabled}
            data-focus={segment.focus}
          />
          <span>{segment.label}</span>
        </label>
      ))}
    </span>
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

function Segs({ next }: { next: boolean }): ReactNode {
  return (
    <>
      {CONTROLS.map((control, at) => (
        <Seg key={at} next={next} control={control} name={`bench-seg-${at}`} />
      ))}
    </>
  );
}

export const radioGroupStates: Record<string, PrimitiveState> = {
  "radio-group": () => (
    <Columns
      legacy={
        <>
          <Cards next={false} chosen="tunnel" name="bench-kind-a" />
          <Cards next={false} chosen="proxy" name="bench-kind-b" />
        </>
      }
      next={
        <>
          <Cards next chosen="tunnel" name="" />
          <Cards next chosen="proxy" name="" />
        </>
      }
    />
  ),
  // `data-focus`: visual-compare focuses each column's target just before shooting it. The
  // `p-1` frame keeps the ring, which is drawn outside the radio, inside the cropped column.
  "radio-group-focus": () => (
    <Columns
      legacy={
        <div className="w-full p-1">
          <div className="choice-list" role="radiogroup" aria-label="App kind">
            <label className="choice">
              <input type="radio" name="bench-kind-focus" value="tunnel" defaultChecked data-focus />
              <div>
                <div className="choice-title">Tunneled</div>
                <div className="choice-desc">A bot that dials in with an app token.</div>
              </div>
            </label>
          </div>
        </div>
      }
      next={
        <div className="w-full p-1">
          <RadioGroup aria-label="App kind" defaultValue="tunnel">
            <RadioGroupCard value="tunnel" title="Tunneled" description="A bot that dials in with an app token." data-focus />
          </RadioGroup>
        </div>
      }
    />
  ),
  "radio-group-segment": () => (
    <Columns legacy={<Segs next={false} />} next={<Segs next />} />
  ),
  "radio-group-segment-focus": () => (
    <Columns
      legacy={
        <div className="p-1">
          <Seg next={false} control={{ value: "none", implied: null }} name="bench-seg-focus" focus="approval" />
        </div>
      }
      next={
        <div className="p-1">
          <Seg next control={{ value: "none", implied: null }} name="" focus="approval" />
        </div>
      }
    />
  ),
  // Focus on the implied segment: today's ring REPLACES its hollow ring.
  "radio-group-segment-focus-implied": () => (
    <Columns
      legacy={
        <div className="p-1">
          <Seg next={false} control={{ value: "approval", implied: "allow" }} name="bench-seg-focus-implied" focus="allow" />
        </div>
      }
      next={
        <div className="p-1">
          <Seg next control={{ value: "approval", implied: "allow" }} name="" focus="allow" />
        </div>
      }
    />
  ),
};
