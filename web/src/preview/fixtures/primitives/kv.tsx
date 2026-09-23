import type { PrimitiveState } from "../../seed";
import { Kv, KvList } from "@/chrome/Kv";
import { DetailsBody } from "@/chrome/Listing";
import { Columns } from "./Columns";

/**
 * The key/value bench (`chrome/Kv`): the grey block (`.kv` on its own, as the approval page and
 * the app page's panes draw it) and the details column's lines (`.db .kv`), whose pairs stack
 * key over value below 1024px on a page with levels — both sides sit in the same
 * `data-level` box for that. The block inside an auth card is `auth-frame.tsx`'s.
 */
export const kvStates: Record<string, PrimitiveState> = {
  kv: () => (
    <Columns
      legacy={
        <div className="flex w-full flex-col gap-3" data-level="3">
          <div className="kv">
            <div className="kv-row">
              <span className="kv-key">Principal</span>
              <span className="mono">agent:triage-bot</span>
            </div>
            <div className="kv-row">
              <span className="kv-key">Requested</span>
              <span>Aug 24, 14:02</span>
            </div>
          </div>
          <div className="db">
            <div className="kv">
              <div className="kv-row">
                <div className="kv-key">Standing</div>
                <div>in Allowed</div>
              </div>
              <div className="kv-row">
                <div className="kv-key">Scoped MCP identity</div>
                <div>https://hub.example.com/owner/mcp/github_with_a_long_unbroken_tail</div>
              </div>
            </div>
          </div>
        </div>
      }
      next={
        <div className="flex w-full flex-col gap-3" data-level="3">
          <KvList variant="block">
            <Kv k="Principal">
              <span className="mono">agent:triage-bot</span>
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
      }
    />
  ),
};
