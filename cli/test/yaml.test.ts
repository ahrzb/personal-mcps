/**
 * cli/test/yaml.test.ts — the one check behind `yaml.parseYaml`, the §9 config file's
 * FORMAT. It exists because the repo may add no dependency (§4) and the CLI
 * therefore carries a subset parser of its own: a parser with no test is a silent
 * mis-read of the one file `pmcp apply` acts on.
 *
 * Scope, deliberately narrow: text → JSON values. Every rule about what the shape MEANS
 * — defaults, the grant suffix, which keys exist — is plan.parseDesired's, pinned in
 * plan.test.ts, and is not restated here. The load-bearing case is the last one: §9's own
 * example file, parsed and planned, so the format and the language are checked against
 * the document they both come from.
 *
 * Project: `cli` — plain Node, parallel, pure. deps: none.
 */

// deps: none · cli/src/yaml.ts (parseYaml — a module with no imports, so this suite's
//   "deps: none" stays true; main.ts's node:fs/node:os config reading is not dragged in)
//   · cli/src/plan.ts (parseDesired, planChanges)

import { describe, expect, it } from "vitest";
import { parseDesired, planChanges } from "../src/plan";
import { parseYaml } from "../src/yaml";

/**
 * §9's example file, verbatim from the spec — the format's only real specimen, and the
 * reason the last case below is this file's load-bearing one. Re-copied 2026-08-26 with
 * §20's amendment to §9 (the `linear:` entry's `capabilities:` list and its per-family
 * `docs:` role): a stale copy would keep grounding the parser in a document the spec no
 * longer contains, which is the one failure a verbatim fixture exists to make impossible.
 */
const SPEC_EXAMPLE = `services:
  news:                     # kind: tunnel is the default; roles come from registration
    name: News MCP
    description: RSS digester on the home server
  notion:
    kind: proxy
    endpoint: https://mcp.notion.com/mcp
    log_bodies: true        # opt-in: proxied bodies are not audited by default (§15);
                            #   tunneled services default to true — either flips
    roles:                  # virtual roles — defined here because the upstream can't
      editor: ["create_page", "update_.*"]   # anchored regexes over tool names
      reader: ["search", "fetch_.*"]
    redact:                 # sensitive argument paths per tool (§7) — config-declared
      create_page: ["credentials.token"]     #   because upstream schemas rarely mark writeOnly
    redact_results:         # identical shape, applied to result structuredContent (§7)
      create_page: ["page.share_token"]
    # upstream auth is imperative (service_set_upstream_auth) — never in this file
  linear:
    kind: proxy
    endpoint: https://mcp.linear.app/mcp
    auth: oauth             # connected interactively from /services (§7); tokens never here
    capabilities: [tools, resources]  # §20.2: what a proxied service's scoped handshake
                            #   advertises (subset of tools/prompts/resources/completions);
                            #   absent means tools only — advertisement, never access
    roles:
      reader: ["list_.*", "get_.*"]        # bare list = tools, unchanged (§20)
      docs:                                # per-family form (§20, added 2026-08-26)
        prompts: ["summarize_.*"]
        resources: ["linear://docs/*"]     # anchored, \`*\` still aliases \`.*\`
  home:
    name: Home automation
    archived: true          # parked: connections refused, hidden from consumers,
                            # roles/grants/tokens retained (§6, "Service lifecycle")

service_accounts:
  claude:
    name: Claude
    grants:
      news: [reader]        # exact role names; warned (not rejected) if the service
                            # hasn't declared them yet
      notion: [editor]
      home: ["control:approval"]  # ':approval' suffix = approval mode (§2) — role names
                            # have no colon, so the suffix is unambiguous; bare = allow
  cron:
    name: Nightly jobs
    grants:
      news: [reader]
`;

describe("parseYaml · §9's file format", () => {
  it("§9 · block mappings nest by indentation, flow lists and block lists mean the same thing, and `#` comments never reach a value", () => {
    const doc = parseYaml(SPEC_EXAMPLE) as Record<string, any>;
    expect(doc.services.news).toEqual({ name: "News MCP", description: "RSS digester on the home server" });
    expect(doc.services.notion.roles.editor).toEqual(["create_page", "update_.*"]);
    // A block list under a key is the same value as the flow list beside it.
    const block = parseYaml(["grants:", "  news:", "    - reader"].join("\n")) as Record<string, any>;
    expect(block.grants.news).toEqual(["reader"]);
    expect(doc.service_accounts.claude.grants.news).toEqual(["reader"]);
    // `# kind: tunnel is the default` is a comment, not a second mapping entry.
    expect(Object.keys(doc.services.news)).toEqual(["name", "description"]);
  });

  it("§9 · scalars keep their types: `true`/`false` are booleans, a bare word is a string, quotes are stripped, and a key with nothing under it is null (\"all defaults\")", () => {
    const doc = parseYaml(
      ["a:", "  archived: true", "  log_bodies: false", "  name: 'Quoted Name'", "  endpoint: https://x/mcp", "b:"].join(
        "\n",
      ),
    ) as Record<string, any>;
    expect(doc.a).toEqual({
      archived: true,
      log_bodies: false,
      name: "Quoted Name",
      endpoint: "https://x/mcp",
    });
    expect(doc.b).toBeNull();
  });

  it("§9 · the spec's own example parses into a plannable config: four services with their kinds, two accounts with their grants, and a plan that creates every one of them without a hard error", () => {
    const desired = parseDesired(parseYaml(SPEC_EXAMPLE));
    expect(desired.services.map((service) => `${service.slug}:${service.kind}`)).toEqual([
      "news:tunnel",
      "notion:proxy",
      "linear:proxy",
      "home:tunnel",
    ]);
    expect(desired.services[1].roles).toEqual({ editor: ["create_page", "update_.*"], reader: ["search", "fetch_.*"] });
    // §20.3's two spellings, mixed in one declaration exactly as the spec prints them: a
    // bare list beside the per-family object. Nothing is normalized away on the way in.
    expect(desired.services[2].roles).toEqual({
      reader: ["list_.*", "get_.*"],
      docs: { prompts: ["summarize_.*"], resources: ["linear://docs/*"] },
    });
    const plan = planChanges(desired, { services: [], accounts: [] });
    expect(plan.errors).toEqual([]);
    const created = plan.steps.filter((step) => step.tool === "service_create");
    expect(created).toHaveLength(4);
    expect(plan.steps.filter((step) => step.tool === "grant_set")).toHaveLength(4);
    // §20.2's owner-declared list rides `service_create`'s wire — a grammar that parsed the
    // key and dropped it would leave `linear`'s scoped handshake advertising tools only,
    // with `pmcp diff` reporting the namespace in sync forever.
    const args = (slug: string): Record<string, unknown> =>
      created.find((step) => step.args.slug === slug)?.args ?? {};
    expect(args("linear").capabilities).toEqual(["tools", "resources"]);
    // …and the key is optional: `notion` declares none, so its create carries none rather
    // than an invented default (§20.2 — absent means tools only, decided by the hub).
    expect(Object.keys(args("notion"))).not.toContain("capabilities");
  });
});
