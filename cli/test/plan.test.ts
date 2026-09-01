/**
 * cli/test/plan.test.ts — the YAML config language stated precisely: what a file
 * MEANS (parseDesired's defaults and grammar, §9/§15) and what a file COSTS
 * (planChanges' create/update/delete/archive steps, their order, their
 * destructive flags, and the severity of a bad file, §8/§9).
 *
 * Project: `unit` — plain Node, parallel, no fixtures. Both functions' deps
 * lines read `none`, which is that project's entire admission rule (strategy
 * §2). (Strategy §3 files this suite under `unit` while §2's project table files
 * "the CLI planner" under `scripts` + clients; both are the same Node-parallel
 * semantics, so the eventual config picks one — nothing here depends on which.)
 * No isolation or ordering constraints exist: the planner is pure, so cases are
 * order-independent and share nothing.
 *
 * This is the one suite strategy §6 calls classic fail-first TDD — the planner
 * is pure, independent of every other vertical slice, and writing the assertion
 * first is cheap. It is therefore deliberately NOT table-shaped: the cases below
 * are individually interesting, not rows of one matrix. The churn protection
 * lives in the last block instead, in the law.
 *
 * Durable vs incidental (§7): durable are which steps a difference produces, in
 * what order, with which `destructive` flag, and which severity a bad file gets.
 * Incidental — never asserted as text — are warning and error PROSE (assert the
 * severity and the offending slug), step `summary` wording (assert that one
 * exists), and any ordering among steps of the same phase.
 *
 * Refusal cases carry their allow-twin in the same block (strategy §9 rule 2):
 * every hard error below sits beside the near-identical file that plans cleanly.
 */

// deps: none (no harness — desired/current are plain literals) · cli/src/plan.ts (parseDesired,
//   planChanges) · yaml (the package §9's file is parsed by, for the last block only)

import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";
import { parseDesired, planChanges } from "../src/plan";
import type { CurrentAgent, CurrentApp, CurrentState, DesiredConfig, Plan } from "../src/plan";

/** One YAML document as `YAML.parse` would hand it over — the planner's only input shape. */
function doc(apps: unknown, agents?: unknown): unknown {
  return agents === undefined ? { apps } : { apps, agents: agents };
}

/** A server-side app row with the fields no row can be missing. */
function currentApp(over: Partial<CurrentApp> & { slug: string }): CurrentApp {
  return {
    kind: "tunnel",
    name: over.slug,
    description: "",
    archived: false,
    builtin: false,
    roles: {},
    redact: {},
    redactResults: {},
    logBodies: over.kind === "proxy" ? false : true,
    ...over,
  };
}

function currentAgent(over: Partial<CurrentAgent> & { slug: string }): CurrentAgent {
  return { name: over.slug, description: "", grants: {}, ...over };
}

/**
 * §20.3's role declaration, both spellings: a bare pattern list means tools and nothing
 * else, forever, while the per-family object names any of the three keyspaces and may sit
 * beside a bare list in the same declaration. Spelled here rather than imported because it
 * is what `DesiredApp.roles` and `CurrentApp.roles` BECOME with this dispatch — the
 * two rows that use it are what widens them.
 */
type RoleDeclaration = Record<string, string[] | Record<string, string[]>>;

/**
 * A proxied server row carrying such a declaration. The cast is a seam bridge and not a
 * claim: `CurrentApp.roles` is still spelled tools-only, so it is deletable the day the
 * type widens, and no assertion below reads through it.
 *
 * That day is this dispatch. §20.3's canonical read shape means `app_list` returns the
 * per-family object whenever a role is not tools-only, so `CurrentApp.roles`,
 * `DesiredApp.roles` and main.ts's `AppRow.roles` all become active misstatements
 * of the wire until they are widened to this type — and main.ts documents those declarations
 * as the lock that makes a server-side shape change "fail to compile here rather than
 * emptying a column". Deleting this cast is part of implementing the two rows below.
 */
function proxyRow(slug: string, roles: RoleDeclaration): CurrentApp {
  return currentApp({
    slug,
    kind: "proxy",
    endpoint: "https://x/mcp",
    auth: "headers",
    forwardIdentity: false,
    roles: roles as Record<string, string[]>,
  });
}

function state(apps: CurrentApp[] = [], agents: CurrentAgent[] = []): CurrentState {
  return { apps, agents };
}

/**
 * §20.2's owner-declared advertisement on each side of the diff, with ABSENT spelled as a
 * missing key rather than as an empty list — which is the distinction the two capabilities
 * cases are about: `undefined` means "never configured", and §9 makes that identical in
 * MEANING to `[tools]` without making it identical in shape. One pair of builders so the two
 * cases cannot drift into diffing different proxied apps.
 */
function capabilityFile(capabilities?: string[]): DesiredConfig {
  return parseDesired(
    doc({
      linear: {
        kind: "proxy",
        endpoint: "https://x/mcp",
        ...(capabilities === undefined ? {} : { capabilities }),
      },
    }),
  );
}

function capabilityServer(capabilities?: string[]): CurrentState {
  return state([
    currentApp({
      slug: "linear",
      kind: "proxy",
      endpoint: "https://x/mcp",
      auth: "headers",
      forwardIdentity: false,
      ...(capabilities === undefined ? {} : { capabilities }),
    }),
  ]);
}

/** The steps of one tool, in plan order — the shape most cases assert against. */
function stepsOf(plan: Plan, tool: string): Record<string, unknown>[] {
  return plan.steps.filter((step) => step.tool === tool).map((step) => step.args);
}

/** Every step's tool name in plan order — the order and vocabulary cases' subject. */
function tools(plan: Plan): string[] {
  return plan.steps.map((step) => step.tool);
}

describe("parseDesired · defaults and grammar (§9, §15)", () => {
  it("§9 · every default applied — absent kind → tunnel, absent name → slug, description \"\", archived false, redact/redact_results {} — so two files that mean the same thing normalize equal", () => {
    const bare = parseDesired(doc({ news: null }));
    expect(bare.apps).toEqual([
      {
        slug: "news",
        kind: "tunnel",
        name: "news",
        description: "",
        archived: false,
        redact: {},
        redactResults: {},
        logBodies: true,
      },
    ]);
    // The same meaning spelled out in full normalizes to the identical value.
    const spelled = parseDesired(
      doc({
        news: {
          kind: "tunnel",
          name: "news",
          description: "",
          archived: false,
          redact: {},
          redact_results: {},
          log_bodies: true,
        },
      }),
    );
    expect(spelled).toEqual(bare);
    expect(bare.agents).toEqual([]);
  });

  it("§15 · log_bodies defaults by kind (tunnel true, proxy false), and an explicit value overrides the kind default in both directions", () => {
    const defaults = parseDesired(
      doc({ news: {}, notion: { kind: "proxy", endpoint: "https://mcp.notion.com/mcp" } }),
    );
    expect(defaults.apps.map((app) => app.logBodies)).toEqual([true, false]);
    const explicit = parseDesired(
      doc({
        news: { log_bodies: false },
        notion: { kind: "proxy", endpoint: "https://mcp.notion.com/mcp", log_bodies: true },
      }),
    );
    expect(explicit.apps.map((app) => app.logBodies)).toEqual([false, true]);
  });

  it("§9 · proxy defaults: auth \"headers\", forward_identity false", () => {
    const [proxy] = parseDesired(doc({ notion: { kind: "proxy", endpoint: "https://mcp.notion.com/mcp" } })).apps;
    expect(proxy.auth).toBe("headers");
    expect(proxy.forwardIdentity).toBe(false);
    expect(proxy.roles).toEqual({});
    // §20.2's `capabilities` is the one proxy key with NO normalized default: absent means
    // the handshake advertises tools only, which is the hub's rule to apply, so inventing
    // `["tools"]` here would make every pre-amendment file diff against the server on the
    // first `pmcp diff` after this lands.
    expect(Object.keys(proxy)).not.toContain("capabilities");
  });

  it("§9 · `reader:approval` splits into approval mode; bare `reader` is allow — role names carry no colon, so the split is unambiguous", () => {
    const parsed = parseDesired(doc({ news: {} }, { claude: { grants: { news: ["reader", "writer:approval"] } } }));
    expect(parsed.agents).toEqual([
      {
        slug: "claude",
        name: "claude",
        description: "",
        grants: {
          news: [
            { role: "reader", mode: "allow" },
            { role: "writer", mode: "approval" },
          ],
        },
      },
    ]);
  });

  it("§9 · a colon suffix that is not exactly `approval` (`reader:aproval`, `reader:Approval`, `reader:allow`, `reader:approval:x`) throws naming the offending grant — the natural split (`mode = suffix === \"approval\" ? \"approval\" : \"allow\"`) turns a one-character typo into a silent privilege escalation, planning an approval-gated grant as an outright allow grant that reads like an ordinary grant_set; twin: the correctly spelled `reader:approval` parses as approval mode (the value-side of the row above's key-side rule)", () => {
    for (const grant of ["reader:aproval", "reader:Approval", "reader:allow", "reader:approval:x"]) {
      expect(() => parseDesired(doc({ news: {} }, { claude: { grants: { news: [grant] } } })), grant).toThrow(
        new RegExp(grant.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      );
    }
    const twin = parseDesired(doc({ news: {} }, { claude: { grants: { news: ["reader:approval"] } } }));
    expect(twin.agents[0].grants.news).toEqual([{ role: "reader", mode: "approval" }]);
  });

  it("§9 · an unrecognized key (`rols:`) and a wrong-typed field (redact values not string arrays) each throw naming the offending path — a typo never silently plans a role wipe; twin: the correctly spelled file parses", () => {
    expect(() => parseDesired(doc({ notion: { kind: "proxy", endpoint: "https://x/mcp", rols: {} } }))).toThrow(/rols/);
    expect(() => parseDesired(doc({ news: { redact: { search: "query" } } }))).toThrow(/redact/);
    expect(() => parseDesired(doc({ news: { redact: { search: [1] } } }))).toThrow(/redact/);
    const twin = parseDesired(
      doc({ notion: { kind: "proxy", endpoint: "https://x/mcp", roles: { reader: ["search"] } } }),
    );
    expect(twin.apps[0].roles).toEqual({ reader: ["search"] });
  });

  it("§9/§18 d3 · keys that are RECOGNIZED but misplaced throw too, naming the offending path: the proxy-only fields (`roles`, `endpoint`, `auth`, `forward_identity`) on a `kind: tunnel` app, and a `kind: proxy` app carrying no `endpoint`. The `rols:` case cannot catch either — both keys exist in the grammar — and dropping them silently would make the file lie about a tunneled app's role surface while the hub keeps whatever the bot self-declared, or claim a forwarding target the hub does not have; twin: the same keys on a proxy app parse", () => {
    const misplaced: Record<string, unknown>[] = [
      { roles: { reader: ["search"] } },
      { endpoint: "https://x/mcp" },
      { auth: "oauth" },
      { forward_identity: true },
      // §20.2's owner-declared advertisement is the fifth member of that set, and misplaced
      // for the same reason: a TUNNELED app's capability set is the one it answered
      // `server/discover` with (§6), so a `capabilities:` line here would be a claim about
      // the hub's surface that the hub ignores — the file lying, silently.
      { capabilities: ["tools", "resources"] },
    ];
    for (const fields of misplaced) {
      const key = Object.keys(fields)[0];
      expect(() => parseDesired(doc({ news: fields })), key).toThrow(new RegExp(key));
    }
    expect(() => parseDesired(doc({ notion: { kind: "proxy" } }))).toThrow(/endpoint/);
    const twin = parseDesired(
      doc({
        notion: {
          kind: "proxy",
          endpoint: "https://x/mcp",
          auth: "oauth",
          forward_identity: true,
          capabilities: ["tools", "resources"],
          roles: { reader: ["search"] },
        },
      }),
    );
    expect(twin.apps[0]).toMatchObject({
      endpoint: "https://x/mcp",
      auth: "oauth",
      forwardIdentity: true,
      capabilities: ["tools", "resources"],
      roles: { reader: ["search"] },
    });
  });

  it("§9 · semantic problems (reserved slug, undeclared role, dual-mode grant) do NOT throw here — they are planChanges' errors, so diff reports every problem in one pass", () => {
    expect(() =>
      parseDesired(
        doc({ pmcp: {}, news: {} }, { claude: { grants: { news: ["reader", "reader:approval", "ghost"] } } }),
      ),
    ).not.toThrow();
  });
});

describe("planChanges · the steps a difference produces (§8, §9)", () => {
  it("§9 · file-only app and file-only agent → app_create / agent_create carrying the normalized fields", () => {
    const plan = planChanges(
      parseDesired(doc({ news: { name: "News MCP" } }, { claude: { name: "Claude" } })),
      state(),
    );
    expect(plan.errors).toEqual([]);
    expect(stepsOf(plan, "app_create")).toEqual([
      {
        slug: "news",
        kind: "tunnel",
        name: "News MCP",
        description: "",
        redact: {},
        redact_results: {},
        log_bodies: true,
      },
    ]);
    expect(stepsOf(plan, "agent_create")).toEqual([{ slug: "claude", name: "Claude", description: "" }]);
    expect(plan.steps.every((step) => step.summary.length > 0)).toBe(true);
    expect(plan.steps.some((step) => step.destructive)).toBe(false);
  });

  it("§9 · server-only app and server-only agent → app_delete /agent_delete, both flagged destructive (grants cascade, tokens deleted)", () => {
    const plan = planChanges(
      parseDesired(doc({})),
      state([currentApp({ slug: "news" })], [currentAgent({ slug: "claude" })]),
    );
    expect(stepsOf(plan, "app_delete")).toEqual([{ slug: "news" }]);
    expect(stepsOf(plan, "agent_delete")).toEqual([{ slug: "claude" }]);
    expect(plan.steps.every((step) => step.destructive)).toBe(true);
  });

  it("§8 · the builtin `pmcp` row is excluded from the delete computation", () => {
    const plan = planChanges(
      parseDesired(doc({})),
      state([currentApp({ slug: "pmcp", builtin: true })]),
    );
    expect(plan.steps).toEqual([]);
    expect(plan.errors).toEqual([]);
  });

  it("§9 · a (agent, app) pair the SERVER grants and the file's `grants:` block omits plans grant_set with an empty role list — absence in the file is desired state, not silence. Scoped to pairs the server actually holds, deliberately: §9's \"any pair not listed\" read as a quantifier over every (agent × app) product would emit a clearing step for pairs nobody grants, and a state derived from itself would plan |agents|×|apps| steps — contradicting the empty-plan law below, which is the one contradiction this file could not detect from inside", () => {
    const plan = planChanges(
      parseDesired(doc({ news: {}, home: {} }, { claude: { grants: { news: ["reader"] } } })),
      state(
        [currentApp({ slug: "news", roles: { reader: ["get_.*"] } }), currentApp({ slug: "home" })],
        [
          currentAgent({
            slug: "claude",
            grants: { news: [{ role: "reader", mode: "allow" }], home: [{ role: "all", mode: "allow" }] },
          }),
        ],
      ),
    );
    // `news` is unchanged, so only the omitted `home` pair is planned — and it is planned
    // as a clearing replacement, not skipped.
    expect(stepsOf(plan, "grant_set")).toEqual([{ agent: "claude", app: "home", roles: [] }]);
  });

  it("§9/§15 · a change in redact, redact_results, or log_bodies alone plans an app_update — either kind", () => {
    const tunnel = planChanges(
      parseDesired(doc({ news: { redact: { search: ["query"] } } })),
      state([currentApp({ slug: "news" })]),
    );
    expect(stepsOf(tunnel, "app_update")).toEqual([{ slug: "news", redact: { search: ["query"] } }]);
    const proxy = planChanges(
      parseDesired(doc({ notion: { kind: "proxy", endpoint: "https://x/mcp", log_bodies: true } })),
      state([currentApp({ slug: "notion", kind: "proxy", endpoint: "https://x/mcp", auth: "headers", forwardIdentity: false })]),
    );
    expect(stepsOf(proxy, "app_update")).toEqual([{ slug: "notion", log_bodies: true }]);
    const results = planChanges(
      parseDesired(doc({ news: { redact_results: { search: ["page.token"] } } })),
      state([currentApp({ slug: "news" })]),
    );
    expect(stepsOf(results, "app_update")).toEqual([
      { slug: "news", redact_results: { search: ["page.token"] } },
    ]);
  });

  it("§9 · proxy-only fields (endpoint, auth, forward_identity, roles) are diffed like any other field", () => {
    const plan = planChanges(
      parseDesired(
        doc({
          notion: {
            kind: "proxy",
            endpoint: "https://new/mcp",
            forward_identity: true,
            roles: { reader: ["search"] },
          },
        }),
      ),
      state([
        currentApp({
          slug: "notion",
          kind: "proxy",
          endpoint: "https://old/mcp",
          auth: "headers",
          forwardIdentity: false,
          roles: {},
        }),
      ]),
    );
    expect(stepsOf(plan, "app_update")).toEqual([
      { slug: "notion", endpoint: "https://new/mcp", forward_identity: true, roles: { reader: ["search"] } },
    ]);
  });

  it("§9/§20.3 · the YAML planner accepts a per-family roles block for a proxied app and diffs it field-by-field", () => {
    const file = (roles: RoleDeclaration): DesiredConfig =>
      parseDesired(doc({ notion: { kind: "proxy", endpoint: "https://x/mcp", roles } }));
    // §20.3's own shape: the two spellings mixed across roles in one declaration, and a
    // resource pattern where `*` still aliases `.*`.
    const declared: RoleDeclaration = {
      reader: ["list_.*"],
      docs: { prompts: ["summarize_.*"], resources: ["linear://docs/*"] },
    };
    // The planner normalizes nothing away — both spellings survive the parse verbatim, so
    // the canonical read shape §20.3 pins is what the diff compares against. It does NOT
    // follow that it refuses nothing: §20.3's Validation bullet applies to every family
    // list, and the severities block below walks those refusals.
    expect(file(declared).apps[0].roles).toEqual(declared);
    expect(planChanges(file(declared), state()).errors).toEqual([]);

    const current = state([proxyRow("notion", declared)]);
    // Field-by-field, so the same declaration on both sides differs in no field and plans
    // nothing — a planner that re-rendered the block would plan an update that changes it
    // to itself, on every run, for every proxied app that has one.
    expect(planChanges(file(declared), current).steps).toEqual([]);
    // One family widened is one changed field, carried whole in the op's wire spelling and
    // beside no other field.
    const widened: RoleDeclaration = {
      ...declared,
      docs: { prompts: ["summarize_.*"], resources: ["linear://docs/*", "linear://specs/*"] },
    };
    const plan = planChanges(file(widened), current);
    expect(plan.errors).toEqual([]);
    expect(stepsOf(plan, "app_update")).toEqual([{ slug: "notion", roles: widened }]);
  });

  it("§9/§20.3 · a bare list in YAML plans identically to {tools: [...]} — no spurious diff on a file written before this change", () => {
    const file = (roles: RoleDeclaration): DesiredConfig =>
      parseDesired(doc({ notion: { kind: "proxy", endpoint: "https://x/mcp", roles } }));
    const bare: RoleDeclaration = { reader: ["list_.*", "get_.*"] };
    const spelled: RoleDeclaration = { reader: { tools: ["list_.*", "get_.*"] } };
    /**
     * The same patterns under a DIFFERENT family — identical spelling, opposite meaning
     * (§20.3: "a role that grants tools grants *nothing* in another family"). It sits here
     * because it is what "identically to {tools: [...]}" excludes: a comparison that
     * flattened the object away would call this pair equal too, and a file that moved a
     * pattern from `tools:` to `prompts:` would plan nothing while the hub kept granting
     * the tool of that name.
     */
    const elsewhere: RoleDeclaration = { reader: { prompts: ["list_.*", "get_.*"] } };
    // §20.3's canonical read renders a tools-only role as a bare list, which is exactly
    // what every file written before this change already spells: the first `pmcp diff`
    // after it lands must be empty, or the widening announces itself as a namespace-wide
    // update nobody asked for.
    const server = state([proxyRow("notion", bare)]);
    expect(planChanges(file(bare), server)).toEqual({ steps: [], warnings: [], errors: [] });
    // The other spelling is the same MEANING, so it is the same plan — the diff is a
    // function of what a role grants, never of which spelling happened to be written down.
    expect(planChanges(file(spelled), server)).toEqual(planChanges(file(bare), server));
    // …and a different keyspace is a different meaning, so it is a real change.
    const moved = planChanges(file(elsewhere), server);
    expect(moved.errors).toEqual([]);
    expect(stepsOf(moved, "app_update")).toEqual([{ slug: "notion", roles: elsewhere }]);
  });

  it("§9/§20.2 · a capabilities change on a proxied app plans an app_update naming the field", () => {
    // The widening: the file names a family the server was never told about. Carried whole
    // in the op's wire spelling — `app_update` replaces the list, it does not merge one.
    const widened = planChanges(capabilityFile(["tools", "resources"]), capabilityServer(["tools"]));
    expect(widened.errors).toEqual([]);
    expect(stepsOf(widened, "app_update")).toEqual([
      { slug: "linear", capabilities: ["tools", "resources"] },
    ]);
    // …and the narrowing, because a field that can only grow is a field that never
    // converges: an owner who deletes `resources` from the file must see it planned away.
    expect(
      stepsOf(planChanges(capabilityFile(["tools"]), capabilityServer(["tools", "prompts"])), "app_update"),
    ).toEqual([{ slug: "linear", capabilities: ["tools"] }]);
    // Declaring the key against an app that has none is a change too — absent ≡ [tools]
    // (below), so naming a second family really is a widening of what the handshake says.
    expect(
      stepsOf(planChanges(capabilityFile(["tools", "prompts"]), capabilityServer()), "app_update"),
    ).toEqual([{ slug: "linear", capabilities: ["tools", "prompts"] }]);
    // Nothing else moves with it: `capabilities` is one field among the proxied ones, not a
    // trigger that re-sends the whole row.
    expect(Object.keys(stepsOf(widened, "app_update")[0]).sort()).toEqual(["capabilities", "slug"]);
  });

  it("§9/§20.2 · capabilities compares as a set with absent ≡ [tools] — spelling the default, or reordering the list, plans nothing", () => {
    const clean = { steps: [], warnings: [], errors: [] };
    // The two spellings of the default, in both directions. Either one planning an update
    // would make `pmcp apply` never converge: the file says one thing, the server stores the
    // other, and every run plans the same step again.
    expect(planChanges(capabilityFile(), capabilityServer(["tools"]))).toEqual(clean);
    expect(planChanges(capabilityFile(["tools"]), capabilityServer())).toEqual(clean);
    expect(planChanges(capabilityFile(), capabilityServer())).toEqual(clean);
    // A set, not a list: the declaration is an advertisement of WHICH families exist, so the
    // order an owner happened to type them in carries no meaning to diff on.
    expect(
      planChanges(capabilityFile(["resources", "tools"]), capabilityServer(["tools", "resources"])),
    ).toEqual(clean);
    // The twin every silencing rule owes: a genuinely different SET is still a change, so
    // the set comparison narrows the diff without blinding it.
    const real = planChanges(capabilityFile(["tools", "prompts"]), capabilityServer(["tools", "resources"]));
    expect(real.errors).toEqual([]);
    expect(stepsOf(real, "app_update")).toEqual([
      { slug: "linear", capabilities: ["tools", "prompts"] },
    ]);
  });

  it("§8 · an `auth` mode flip plans an app_update flagged destructive — it wipes the stored upstream credentials; twin: any other update is not", () => {
    const current = state([
      currentApp({
        slug: "notion",
        kind: "proxy",
        endpoint: "https://x/mcp",
        auth: "headers",
        forwardIdentity: false,
      }),
    ]);
    const flip = planChanges(
      parseDesired(doc({ notion: { kind: "proxy", endpoint: "https://x/mcp", auth: "oauth" } })),
      current,
    );
    expect(flip.steps.map((step) => [step.tool, step.destructive])).toEqual([["app_update", true]]);
    const twin = planChanges(
      parseDesired(doc({ notion: { kind: "proxy", endpoint: "https://x/mcp", name: "Notion" } })),
      current,
    );
    expect(twin.steps.map((step) => [step.tool, step.destructive])).toEqual([["app_update", false]]);
  });

  it("§6/§9 · an `archived` difference plans app_archive / app_unarchive, never an update carrying an archived field", () => {
    const park = planChanges(
      parseDesired(doc({ home: { archived: true } })),
      state([currentApp({ slug: "home" })]),
    );
    expect(tools(park)).toEqual(["app_archive"]);
    expect(stepsOf(park, "app_archive")).toEqual([{ slug: "home" }]);
    const revive = planChanges(
      parseDesired(doc({ home: {} })),
      state([currentApp({ slug: "home", archived: true })]),
    );
    expect(tools(revive)).toEqual(["app_unarchive"]);
    expect(JSON.stringify(park.steps)).not.toMatch(/archived/);
  });

  it("§8/§9 · a file-only app declared `archived: true` plans TWO steps — app_create then app_archive — and `archived` never appears in app_create's arguments: the op has no such property and rejects additionalProperties, so \"carrying the normalized fields\" verbatim would be refused by the real tools/call; twin: `archived: false` plans the create alone", () => {
    const parked = planChanges(parseDesired(doc({ home: { archived: true } })), state());
    expect(tools(parked)).toEqual(["app_create", "app_archive"]);
    expect(Object.keys(stepsOf(parked, "app_create")[0])).not.toContain("archived");
    const twin = planChanges(parseDesired(doc({ home: { archived: false } })), state());
    expect(tools(twin)).toEqual(["app_create"]);
  });

  it("§8 · every step's `args` is the OP's wire spelling, not the planner's normalized shape: snake_case keys (`redact_results`, `forward_identity`, `log_bodies`) and grant_set's `roles` as a flat string array with the `:approval` suffix re-joined — not DesiredGrant's split {role, mode}. `args` is documented as ready to forward verbatim, so a planner that forwarded the camelCase/split shape would satisfy every other case here and be rejected by every real tools/call (contracts/README direction C)", () => {
    const plan = planChanges(
      parseDesired(
        doc(
          {
            notion: {
              kind: "proxy",
              endpoint: "https://x/mcp",
              forward_identity: true,
              log_bodies: true,
              redact_results: { search: ["page.token"] },
              roles: { reader: ["search"], writer: ["create_.*"] },
            },
          },
          { claude: { grants: { notion: ["reader", "writer:approval"] } } },
        ),
      ),
      state(),
    );
    const created = stepsOf(plan, "app_create")[0];
    expect(Object.keys(created)).toEqual(
      expect.arrayContaining(["redact_results", "forward_identity", "log_bodies"]),
    );
    expect(JSON.stringify(plan.steps)).not.toMatch(/redactResults|forwardIdentity|logBodies/);
    expect(stepsOf(plan, "grant_set")).toEqual([
      { agent: "claude", app: "notion", roles: ["reader", "writer:approval"] },
    ]);
  });

  it("§9 · a `grants:` block naming an app that exists neither in the file nor on the server is a hard error, not a grant_set against an unreferenceable slug: apply stops at the first failure with no rollback, so a typo that plans a doomed step AFTER the destructive delete phase leaves the namespace half-applied; twin: a slug the same file creates is fine, and the order row below pins the grant_set sorting after that create", () => {
    const ghost = planChanges(
      parseDesired(doc({ news: {} }, { claude: { grants: { newz: ["reader"] } } })),
      state(),
    );
    expect(ghost.errors.some((error) => error.includes("newz"))).toBe(true);
    const twin = planChanges(
      parseDesired(doc({ news: {} }, { claude: { grants: { news: ["reader"] } } })),
      state(),
    );
    expect(twin.errors).toEqual([]);
    expect(tools(twin)).toEqual(["app_create", "agent_create", "grant_set"]);
  });
});

describe("planChanges · severities, every refusal beside its allow-twin (§9)", () => {
  it("§9 · a grant naming a role a TUNNELED app has not declared warns and still plans the grant_set (the file may be ahead of the first connection); twin: a declared role plans with no warning", () => {
    const current = state([currentApp({ slug: "news", roles: { reader: ["get_.*"] } })]);
    const ahead = planChanges(
      parseDesired(doc({ news: {} }, { claude: { grants: { news: ["writer"] } } })),
      { ...current, agents: [currentAgent({ slug: "claude" })] },
    );
    expect(ahead.errors).toEqual([]);
    expect(ahead.warnings.some((warning) => warning.includes("writer"))).toBe(true);
    expect(stepsOf(ahead, "grant_set")).toEqual([{ agent: "claude", app: "news", roles: ["writer"] }]);
    const twin = planChanges(
      parseDesired(doc({ news: {} }, { claude: { grants: { news: ["reader"] } } })),
      { ...current, agents: [currentAgent({ slug: "claude" })] },
    );
    expect(twin.warnings).toEqual([]);
  });

  it("§9 · the same undeclared role on a PROXIED app is a hard error — its roles live in this very file; twin: a role the file declares is accepted", () => {
    const file = (roles: string[]): DesiredConfig =>
      parseDesired(
        doc(
          { notion: { kind: "proxy", endpoint: "https://x/mcp", roles: { reader: ["search"] } } },
          { claude: { grants: { notion: roles } } },
        ),
      );
    const undeclared = planChanges(file(["writer"]), state());
    expect(undeclared.errors.some((error) => error.includes("writer"))).toBe(true);
    expect(planChanges(file(["reader"]), state()).errors).toEqual([]);
  });

  it("§9 · the built-in `all` is never \"undeclared\": granted on either kind it neither warns nor errors", () => {
    const plan = planChanges(
      parseDesired(
        doc(
          { news: {}, notion: { kind: "proxy", endpoint: "https://x/mcp" } },
          { claude: { grants: { news: ["all"], notion: ["all:approval"] } } },
        ),
      ),
      state(),
    );
    expect(plan.errors).toEqual([]);
    expect(plan.warnings).toEqual([]);
  });

  it("§18 d10 · a grant of a role literally named `*` is NOT the built-in wildcard — `*` is only a PATTERN alias for `.*` and was retired as a role name, so it is treated as any other undeclared role (warning on tunnel, hard error on proxy, per the two rows above). An implementer who adds a `*`→`all` alias turns a typo into a full-namespace grant on an app; twin: `all` in the same position stays exempt. (Reported, not bent: §9's own YAML example still spells the wildcard grant `home: [\"*:approval\"]`, which §2 and decision 10 retired — that line needs a `spec:` fix, and this row is what it should read as)", () => {
    const onTunnel = planChanges(
      parseDesired(doc({ home: {} }, { claude: { grants: { home: ["*:approval"] } } })),
      state(),
    );
    expect(onTunnel.errors).toEqual([]);
    expect(onTunnel.warnings.some((warning) => warning.includes("*"))).toBe(true);
    const onProxy = planChanges(
      parseDesired(
        doc({ notion: { kind: "proxy", endpoint: "https://x/mcp" } }, { claude: { grants: { notion: ["*"] } } }),
      ),
      state(),
    );
    expect(onProxy.errors.some((error) => error.includes("*"))).toBe(true);
    const twin = planChanges(
      parseDesired(
        doc({ notion: { kind: "proxy", endpoint: "https://x/mcp" } }, { claude: { grants: { notion: ["all"] } } }),
      ),
      state(),
    );
    expect(twin.errors).toEqual([]);
    expect(twin.warnings).toEqual([]);
  });

  it("§9 · one role granted in both modes for one (agent, app) is a hard error; twin: the same role in a single mode is accepted", () => {
    const dual = planChanges(
      parseDesired(doc({ news: {} }, { claude: { grants: { news: ["reader", "reader:approval"] } } })),
      state(),
    );
    expect(dual.errors.some((error) => error.includes("reader"))).toBe(true);
    const twin = planChanges(
      parseDesired(doc({ news: {} }, { claude: { grants: { news: ["reader:approval"] } } })),
      state(),
    );
    expect(twin.errors).toEqual([]);
  });

  it("§8 · a proxy `roles:` block DECLARING a role named `all` is a hard error — `all` is the resolver's built-in, never declarable and only grantable, and the exemption row above covers the grant side only; twin: the same block declaring `reader` is accepted", () => {
    const declared = planChanges(
      parseDesired(doc({ notion: { kind: "proxy", endpoint: "https://x/mcp", roles: { all: ["search"] } } })),
      state(),
    );
    expect(declared.errors.some((error) => error.includes("all"))).toBe(true);
    const twin = planChanges(
      parseDesired(doc({ notion: { kind: "proxy", endpoint: "https://x/mcp", roles: { reader: ["search"] } } })),
      state(),
    );
    expect(twin.errors).toEqual([]);
  });

  it("§8 · a proxy `roles:` block gets `hub/register`'s validation (§6): a pattern that does not compile, a pattern over 128 chars, more than 64 patterns in one role, or a role name outside `[a-z0-9_-]{1,64}` are each a hard error; twin: a role at the caps with a compiling pattern is accepted", () => {
    const proxy = (roles: RoleDeclaration): DesiredConfig =>
      parseDesired(doc({ notion: { kind: "proxy", endpoint: "https://x/mcp", roles } }));
    const capped = (length: number): string[] => Array.from({ length }, () => "a".repeat(128));
    const refusals: RoleDeclaration[] = [
      { reader: ["get_(.*"] },
      { reader: ["a".repeat(129)] },
      { reader: Array.from({ length: 65 }, (_unused, index) => `tool_${index}`) },
      { ["Reader"]: ["search"] },
      { ["r".repeat(65)]: ["search"] },
      // §20.3 applies those same rules to EVERY family list and adds one of its own: a key
      // outside the three families is a violation. Without these rows the whole per-family
      // spelling is unwitnessed on the refusal side, and the one-line wrong implementation
      // — skip anything that is not an Array — passes every case in this file while
      // `pmcp apply` dies server-side, AFTER the destructive delete phase has run. That is
      // verbatim the failure plan.ts's second copy of validateRoles exists to prevent.
      { docs: { tolls: ["x"] } },
      { docs: { resources: ["news://[["] } },
      { docs: { prompts: ["a".repeat(129)] } },
      { docs: { resources: Array.from({ length: 65 }, (_unused, index) => `news://feed/${index}`) } },
      // `all` is the built-in in either spelling — the object form is not a way in.
      { all: { tools: ["search"] } },
    ];
    for (const roles of refusals) {
      const plan = planChanges(proxy(roles), state());
      expect(plan.errors.length, JSON.stringify(roles).slice(0, 40)).toBeGreaterThan(0);
    }
    const twin = planChanges(
      proxy({
        ["r".repeat(64)]: capped(64),
      }),
      state(),
    );
    expect(twin.errors).toEqual([]);
    // The twin's other half: the cap is per FAMILY LIST, not per role (§20.3 — "the same
    // two limits.ts constants, applied three times"), so a role at the caps in all three
    // families is legal and a planner that summed them would refuse a valid file.
    const perFamily = planChanges(
      proxy({ docs: { tools: capped(64), prompts: capped(64), resources: capped(64) } }),
      state(),
    );
    expect(perFamily.errors).toEqual([]);
  });

  it("§7/§9 · a `redact` or `redact_results` KEY that does not compile is a hard error on EITHER kind — the same rule the proxy `roles:` block gets, because both are the one pattern language over tool names. A key that compiles nowhere matches no tool, so the file reads as masking a password that the hub then persists in full; `pmcp apply` refusing locally is what keeps that from being discovered in an audit row. The message names the app and the key and never the declared paths — a diff runs on shared terminals; twin: the same key with its group closed plans cleanly", () => {
    const typo = "get_(.*"; // one unclosed group
    const kinds: Record<string, unknown>[] = [{}, { kind: "proxy", endpoint: "https://x/mcp" }];
    for (const kind of kinds) {
      for (const key of ["redact", "redact_results"]) {
        const plan = planChanges(
          parseDesired(doc({ news: { ...kind, [key]: { [typo]: ["credentials.token"] } } })),
          state(),
        );
        expect(plan.errors.some((error) => error.includes("news")), `${key} on ${JSON.stringify(kind)}`).toBe(true);
        expect(plan.errors.join(" ")).not.toContain("credentials.token");
      }
    }
    const twin = planChanges(
      parseDesired(doc({ news: { redact: { "get_(.*)": ["credentials.token"] } } })),
      state(),
    );
    expect(twin.errors).toEqual([]);
  });

  it("§7/§8 · a `apps:` key outside the slug grammar `[a-z0-9-]` is a hard error, an underscore especially: §7's aggregated `<slug>_<tool>` split depends on slugs having no `_`, so an app slugged `news_x` makes `news_x_get` ambiguous with app `news`'s tool `x_get` — tool-name confusion across two apps in one namespace; twin: the same slug hyphenated (`news-x`) is accepted", () => {
    const underscored = planChanges(parseDesired(doc({ news_x: {} })), state());
    expect(underscored.errors.some((error) => error.includes("news_x"))).toBe(true);
    expect(planChanges(parseDesired(doc({ "news-x": {} })), state()).errors).toEqual([]);
  });

  it("§8/§9 · the reserved `pmcp` slug is a hard error as a `apps:` key and inside a `grants:` block alike — the reservation is uniform; twin: a slug that merely contains or is prefixed by it (`pmcp-admin`, `pmcpx`) is an ordinary app, because the reservation is the exact slug and the ops schemas' `^[a-z0-9-]+$` admits those neighbours", () => {
    const asApp = planChanges(parseDesired(doc({ pmcp: {} })), state());
    expect(asApp.errors.some((error) => error.includes("pmcp"))).toBe(true);
    const inGrants = planChanges(
      parseDesired(doc({ news: {} }, { claude: { grants: { pmcp: ["all"] } } })),
      state(),
    );
    expect(inGrants.errors.some((error) => error.includes("pmcp"))).toBe(true);
    const twin = planChanges(parseDesired(doc({ "pmcp-admin": {}, pmcpx: {} })), state());
    expect(twin.errors).toEqual([]);
    expect(tools(twin)).toEqual(["app_create", "app_create"]);
  });

  it("§8 · a kind change on an existing slug is a hard error: kind is immutable and the planner never invents a delete-and-recreate the file did not ask for; twin: the same slug with an unchanged kind plans an ordinary app_update, so a planner that errored on every update cannot pass", () => {
    const current = state([currentApp({ slug: "news" })]);
    const converted = planChanges(
      parseDesired(doc({ news: { kind: "proxy", endpoint: "https://x/mcp" } })),
      current,
    );
    expect(converted.errors.some((error) => error.includes("news"))).toBe(true);
    expect(tools(converted)).not.toContain("app_delete");
    const twin = planChanges(parseDesired(doc({ news: { name: "News MCP" } })), current);
    expect(twin.errors).toEqual([]);
    expect(stepsOf(twin, "app_update")).toEqual([{ slug: "news", name: "News MCP" }]);
  });
});

describe("planChanges · order and laws (§9)", () => {
  it("§9 · one fixture exercising all four phases pins the order deletes → creates → updates and archive transitions → grant_set, and a grant_set naming an app created in the same plan sorts after that create", () => {
    const plan = planChanges(
      parseDesired(
        doc(
          { news: { name: "News MCP" }, home: { archived: true } },
          { claude: { grants: { news: ["all"], home: ["all"] } } },
        ),
      ),
      state(
        [currentApp({ slug: "gone" }), currentApp({ slug: "news" })],
        [currentAgent({ slug: "old" })],
      ),
    );
    expect(plan.errors).toEqual([]);
    expect([...tools(plan)].sort()).toEqual(
      [
        "app_delete",
        "agent_delete",
        "app_create",
        "agent_create",
        "app_update",
        "app_archive",
        "grant_set",
        "grant_set",
      ].sort(),
    );
    // The four phases, in order. Ordering WITHIN a phase is incidental (file header), so
    // the assertion is that the phase index never decreases.
    const phase: Record<string, number> = {
      app_delete: 0,
      agent_delete: 0,
      app_create: 1,
      agent_create: 1,
      app_update: 2,
      app_archive: 2,
      app_unarchive: 2,
      grant_set: 3,
    };
    const phases = tools(plan).map((tool) => phase[tool]);
    expect(phases).toEqual([...phases].sort((left, right) => left - right));
    const createdAt = tools(plan).indexOf("app_create");
    const granted = plan.steps.findIndex(
      (step) => step.tool === "grant_set" && step.args.app === "home",
    );
    expect(granted).toBeGreaterThan(createdAt);
  });

  it("§9 · planChanges is total: every semantic problem lands in `errors`, no input throws, and a plan carrying hard errors still returns best-effort steps so diff can show everything at once", () => {
    const plan = planChanges(
      parseDesired(
        doc(
          { pmcp: {}, news: { name: "News MCP" }, bad_slug: {} },
          { claude: { grants: { news: ["reader", "reader:approval"], ghost: ["all"] } } },
        ),
      ),
      state([currentApp({ slug: "news" })]),
    );
    expect(plan.errors.length).toBeGreaterThan(2);
    // Best-effort: the legitimate half of the file is still planned.
    expect(stepsOf(plan, "app_update")).toEqual([{ slug: "news", name: "News MCP" }]);
    expect(() => planChanges({ apps: [], agents: [] }, state())).not.toThrow();
  });

  it("§8/§9 · the plan's tool vocabulary is CLOSED to the non-secret admin ops — app_create/update/delete/archive/unarchive, agent_create/delete, grant_set — and no plan over any input emits `token_issue` or `app_set_upstream_auth`. `PlanStep.tool` is a free string and renderPlan prints every step's summary while apply executes each verbatim, so a planner that reached for §6's \"create then mint a token\" pairing would make `pmcp diff` and `pmcp apply` print credentials to stdout: secrets and humans are imperative-only and never in this file", () => {
    const vocabulary = new Set([
      "app_create",
      "app_update",
      "app_delete",
      "app_archive",
      "app_unarchive",
      "agent_create",
      "agent_delete",
      "grant_set",
    ]);
    const plans = [
      planChanges(
        parseDesired(
          doc(
            {
              news: {},
              home: { archived: true },
              notion: { kind: "proxy", endpoint: "https://x/mcp", auth: "oauth" },
            },
            { claude: { grants: { news: ["reader"] } }, cron: { grants: {} } },
          ),
        ),
        state(
          [
            currentApp({ slug: "gone" }),
            currentApp({ slug: "home" }),
            currentApp({ slug: "notion", kind: "proxy", endpoint: "https://x/mcp", auth: "headers", forwardIdentity: false }),
          ],
          [currentAgent({ slug: "cron", grants: { gone: [{ role: "all", mode: "allow" }] } })],
        ),
      ),
      planChanges(parseDesired(doc({})), state()),
    ];
    for (const plan of plans) {
      for (const step of plan.steps) expect(vocabulary.has(step.tool), step.tool).toBe(true);
    }
  });

  it("§9 · the planner is pure in the sense plan.ts claims: parseDesired and planChanges mutate neither argument at any depth, and a second call on the same inputs returns a deep-equal Plan — `pmcp diff` and `pmcp apply` run in one process, so a planner that sorted or normalized `current.apps` in place would corrupt the second pass with every other case still green (the twin of api.test.ts's non-mutation case)", () => {
    const source = doc(
      { news: { redact: { search: ["q"] } }, home: { archived: true } },
      { claude: { grants: { news: ["reader", "writer:approval"] } } },
    );
    const sourceCopy = structuredClone(source);
    const desired = parseDesired(source);
    expect(source).toEqual(sourceCopy);
    const current = state(
      [currentApp({ slug: "news" }), currentApp({ slug: "gone" })],
      [currentAgent({ slug: "claude", grants: { news: [{ role: "reader", mode: "allow" }] } })],
    );
    const desiredCopy = structuredClone(desired);
    const currentCopy = structuredClone(current);
    const first = planChanges(desired, current);
    expect(desired).toEqual(desiredCopy);
    expect(current).toEqual(currentCopy);
    expect(planChanges(desired, current)).toEqual(first);
  });

  it("§9 · the empty-plan law — desired derived from an arbitrary current state plans nothing: no steps, no warnings, no errors. This is the file's churn insurance: it holds across every future field, so adding one to the config language costs one case above, not a rewrite here", () => {
    const current = state(
      [
        currentApp({ slug: "pmcp", builtin: true }),
        currentApp({
          slug: "news",
          name: "News MCP",
          description: "RSS",
          roles: { reader: ["get_.*"] },
          redact: { search: ["q"] },
          logBodies: true,
        }),
        currentApp({ slug: "home", archived: true }),
        currentApp({
          slug: "notion",
          kind: "proxy",
          endpoint: "https://mcp.notion.com/mcp",
          auth: "oauth",
          forwardIdentity: true,
          roles: { editor: ["create_page"] },
          redactResults: { create_page: ["page.share_token"] },
          logBodies: true,
        }),
      ],
      [
        currentAgent({
          slug: "claude",
          name: "Claude",
          grants: {
            news: [{ role: "reader", mode: "allow" }],
            notion: [{ role: "editor", mode: "approval" }],
          },
        }),
        currentAgent({ slug: "cron" }),
      ],
    );
    expect(planChanges(desiredFromCurrent(current), current)).toEqual({ steps: [], warnings: [], errors: [] });
  });
});

/**
 * The empty-plan law's other half: project a server state back into the file
 * that would have produced it. Writing this is itself a design check (strategy
 * §6) — if a CurrentApp cannot be projected onto a DesiredApp without
 * inventing or discarding a field, then desired and current have drifted and the
 * law is unstateable, which is the finding, not a test bug. Runtime facts the
 * planner must never see (online/offline, OAuth connection state, last seen) are
 * absent from CurrentApp by construction, so they cannot leak in here; the
 * `builtin` pmcp row is dropped, since no file may name it (§8).
 *
 * THE PROJECTION IS KIND-DEPENDENT, and that carve-out is stated here so the guard
 * above does not fire on correct behavior (resolved 2026-08-26). `CurrentApp.roles`
 * is required on BOTH kinds — from registration for tunnel, from config for proxy —
 * while `DesiredApp.roles` is proxy-only. Projecting a tunneled app therefore
 * DISCARDS `roles`, by design: tunneled roles arrive at connect time and are
 * deliberately not desired state (§18 decision 3), which is the whole reason the file
 * only references them. Carrying them for proxy kind and dropping them for tunnel kind
 * is the correct projection, not the drift the guard hunts for.
 */
export function desiredFromCurrent(current: CurrentState): DesiredConfig {
  // deps: none
  return {
    apps: current.apps
      .filter((app) => !app.builtin)
      .map((app) => ({
        slug: app.slug,
        kind: app.kind,
        name: app.name,
        description: app.description,
        archived: app.archived,
        redact: app.redact,
        redactResults: app.redactResults,
        logBodies: app.logBodies,
        ...(app.kind === "proxy"
          ? {
              endpoint: app.endpoint,
              auth: app.auth,
              forwardIdentity: app.forwardIdentity,
              roles: app.roles,
              // Optional on BOTH sides (§20.2's absent-is-absent), so the projection carries
              // the absence too rather than inventing the default the planner applies.
              ...(app.capabilities === undefined ? {} : { capabilities: app.capabilities }),
            }
          : {}),
      })),
    agents: current.agents.map((agent) => ({
      slug: agent.slug,
      name: agent.name,
      description: agent.description,
      grants: agent.grants,
    })),
  };
}

/**
 * The file's FORMAT, on the way in (added 2026-09-01, replacing the deleted
 * `cli/test/yaml.test.ts`): §9's `mcps.yaml` is parsed by the `yaml` package now, not by
 * the hand-rolled subset that used to live in `cli/src/yaml.ts`. `parseDesired` is
 * unchanged and still takes `unknown`, so the only thing that can have moved underneath it
 * is what a document DESERIALIZES to — which is exactly what this block pins, with the
 * spec's own example as the specimen. Losing it with the subset parser would have left
 * §9's real file shape unexercised end to end.
 */
describe("§9 · the YAML package feeding parseDesired", () => {
  /** §9's example file, verbatim from the spec — the format's only real specimen. */
  const SPEC_EXAMPLE = `apps:
  news:                     # kind: tunnel is the default; roles come from registration
    name: News MCP
    description: RSS digester on the home server
  notion:
    kind: proxy
    endpoint: https://mcp.notion.com/mcp
    log_bodies: true        # opt-in: proxied bodies are not audited by default (§15)
    roles:                  # virtual roles — defined here because the upstream can't
      editor: ["create_page", "update_.*"]   # anchored regexes over tool names
      reader: ["search", "fetch_.*"]
    redact:
      create_page: ["credentials.token"]
    redact_results:
      create_page: ["page.share_token"]
  linear:
    kind: proxy
    endpoint: https://mcp.linear.app/mcp
    auth: oauth             # connected interactively from /apps (§7)
    capabilities: [tools, resources]  # §20.2: what the scoped handshake advertises
    roles:
      reader: ["list_.*", "get_.*"]        # bare list = tools, unchanged (§20)
      docs:                                # per-family form (§20)
        prompts: ["summarize_.*"]
        resources: ["linear://docs/*"]
  home:
    name: Home automation
    archived: true          # parked: connections refused, hidden from consumers

agents:
  claude:
    name: Claude
    grants:
      news: [reader]
      notion: [editor]
      home: ["control:approval"]  # ':approval' suffix = approval mode (§2)
  cron:
    name: Nightly jobs
    grants:
      news: [reader]
`;

  it("§9 · the spec's own example parses into a plannable config: four apps with their kinds, two agents with their grants, and a plan that creates every one of them without a hard error", () => {
    const desired = parseDesired(parseYaml(SPEC_EXAMPLE));
    expect(desired.apps.map((app) => `${app.slug}:${app.kind}`)).toEqual([
      "news:tunnel",
      "notion:proxy",
      "linear:proxy",
      "home:tunnel",
    ]);
    expect(desired.apps[1].roles).toEqual({ editor: ["create_page", "update_.*"], reader: ["search", "fetch_.*"] });
    // §20.3's two spellings, mixed in one declaration exactly as the spec prints them.
    expect(desired.apps[2].roles).toEqual({
      reader: ["list_.*", "get_.*"],
      docs: { prompts: ["summarize_.*"], resources: ["linear://docs/*"] },
    });
    const plan = planChanges(desired, { apps: [], agents: [] });
    expect(plan.errors).toEqual([]);
    const created = plan.steps.filter((step) => step.tool === "app_create");
    expect(created).toHaveLength(4);
    expect(plan.steps.filter((step) => step.tool === "grant_set")).toHaveLength(4);
    const args = (slug: string): Record<string, unknown> => created.find((step) => step.args.slug === slug)?.args ?? {};
    expect(args("linear").capabilities).toEqual(["tools", "resources"]);
    expect(Object.keys(args("notion"))).not.toContain("capabilities");
  });

  it("§9 · the coercions parseDesired relies on survive the swap: booleans stay booleans, a bare word stays a string, and a key with nothing under it is null — `news:` still means \"all defaults\"", () => {
    const doc = parseYaml(
      ["a:", "  archived: true", "  log_bodies: false", "  name: 'Quoted Name'", "  endpoint: https://x/mcp", "b:"].join("\n"),
    ) as Record<string, any>;
    expect(doc.a).toEqual({ archived: true, log_bodies: false, name: "Quoted Name", endpoint: "https://x/mcp" });
    expect(doc.b).toBeNull();
    // …and the shape the planner is handed for a defaults-only entry is unchanged.
    expect(parseDesired(parseYaml("apps:\n  news:\n")).apps[0]).toMatchObject({ slug: "news", kind: "tunnel" });
  });

  it("§9 · the package is STRICTER than the subset it replaces: a duplicate key and a tab-indented line are now parse errors rather than a silently-kept last value", () => {
    expect(() => parseYaml("apps:\n  news:\n  news:\n")).toThrow();
    expect(() => parseYaml("apps:\n\tnews:\n")).toThrow();
  });

  it("§9 · and it is more CAPABLE: an anchor, a multi-line scalar and a flow mapping — none of which the subset understood — reach the planner as ordinary values", () => {
    const doc = parseYaml(
      [
        "defaults: &roles",
        "  reader: [get_.*]",
        "apps:",
        "  a:",
        "    roles: *roles",
        "  b:",
        "    description: |",
        "      two",
        "      lines",
        "    roles: { reader: [get_.*] }",
      ].join("\n"),
    ) as Record<string, any>;
    expect(doc.apps.a.roles).toEqual({ reader: ["get_.*"] });
    expect(doc.apps.b.description).toBe("two\nlines\n");
    expect(doc.apps.b.roles).toEqual({ reader: ["get_.*"] });
  });
});
