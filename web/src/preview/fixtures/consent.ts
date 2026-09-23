import { keys } from "@/lib/queries";
import type { ConsentRead } from "@/lib/types";
import type { Seed } from "../seed";

/**
 * `/oauth/consent`, reproduced from `server/dev/fixtures.ts`' `oauthConsent` object one state
 * for one state and one value for one value. The page's URL carries the signed query, and its
 * one read is the seeded answer to `GET /api/hub/oauth/consent?<that query>`.
 */

/** The signed query the provider redirected here with — obviously fake, and never rebuilt
 *  from the fields below. The gallery writes it through `URLSearchParams`, which reproduces
 *  these bytes exactly, so the page's raw search IS this string and the seeded key matches. */
const OAUTH_QUERY =
  "client_id=cli_FAKE0000a3f1&response_type=code&redirect_uri=https%3A%2F%2Fclaude.ai%2Fapi%2Fmcp%2Fcallback" +
  "&scope=mcp&resource=https%3A%2F%2Fmcp.example%2Fahrzb%2Fmcp&state=st_FAKE0000b7&code_challenge_method=S256";

/** One state: the consent URL, and the read's answer — the default client with this state's
 *  differences. */
const state = (read: Partial<ConsentRead>): Seed => ({
  path: "/oauth/consent",
  search: Object.fromEntries(new URLSearchParams(OAUTH_QUERY)),
  queries: [
    {
      key: keys.consent(`?${OAUTH_QUERY}`),
      data: {
        oauthQuery: OAUTH_QUERY,
        clientName: "Claude",
        clientSelfRegistered: false,
        redirectOrigin: "https://claude.ai",
        scopes: ["mcp"],
        namespace: "ahrzb",
        agents: [
          { slug: "claude", name: "claude" },
          { slug: "pi", name: "pi" },
        ],
        ...read,
      } satisfies ConsentRead,
    },
  ],
});

export const consentSeeds: Record<string, Seed> = {
  /** OauthConsent.dc.html: a known client, one scope, the full agent picker. */
  default: state({}),

  /** OauthConsentStates "SELF-REGISTERED CLIENT": §19.3's marker beside a name nobody vouched
   *  for, and the refresh scope asked for alongside `mcp`. */
  selfRegistered: state({
    clientName: "Acme Agent",
    clientSelfRegistered: true,
    redirectOrigin: "https://agent.acme.dev",
    scopes: ["mcp", "offline_access"],
    agents: [{ slug: "claude", name: "claude" }],
  }),

  /** OauthConsentStates "NO AGENTS": consent is impossible until an agent exists, so Allow is
   *  disabled and only Deny works. */
  noAgents: state({ agents: [] }),

  /** The client that registered without a name: the page's fallback, not an empty line. */
  anonymousClient: state({
    clientName: null,
    clientSelfRegistered: true,
    redirectOrigin: "https://agent.acme.dev",
    agents: [{ slug: "claude", name: "claude" }],
  }),
};
