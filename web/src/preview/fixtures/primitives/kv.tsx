import type { PrimitiveState } from "../../seed";
import { Kv, KvList } from "@/chrome/Kv";
import { DetailsBody } from "@/chrome/Listing";
import { Bench } from "./Bench";

/**
 * The key/value bench (`chrome/Kv`): the grey block (as the approval page and the app page's
 * panes draw it) and the details column's lines, whose pairs stack key over value below
 * 1024px on a page with levels — hence the `data-level` box. The block inside an auth card is
 * `auth-frame.tsx`'s.
 */
export const kvStates: Record<string, PrimitiveState> = {
  kv: () => (
    <Bench>
      <div className="flex w-full flex-col gap-3" data-level="3">
        <KvList variant="block">
          <Kv k="Principal">
            <span className="font-mono">agent:triage-bot</span>
          </Kv>
          <Kv k="Requested">
            <span>Aug 24, 14:02</span>
          </Kv>
        </KvList>
        <DetailsBody>
          <KvList>
            <Kv k="Standing">in Allowed</Kv>
            <Kv k="Scoped MCP identity">https://hub.example.com/owner/mcp/github_with_a_long_unbroken_tail</Kv>
          </KvList>
        </DetailsBody>
      </div>
    </Bench>
  ),
};
