import type { PrimitiveState } from "../../seed";
import { AuthFrame, BrandMark } from "@/chrome/AuthFrame";
import { Kv, KvList } from "@/chrome/Kv";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { Columns } from "./Columns";

/**
 * The auth frame's bench (`chrome/AuthFrame`): the brand, one auth card with its title,
 * description, a key/value block and a button, and the foot with a link — beside legacy.css's
 * `.auth`, `.brand`, `.auth-card`, `.auth-title`, `.auth-desc`, `.kv` and `.auth-foot`. The
 * frame is a screen tall on both sides, as it is on its pages.
 */
export const authFrameStates: Record<string, PrimitiveState> = {
  "auth-frame": () => (
    <Columns
      legacy={
        <div className="auth w-full">
          <div className="brand">
            <BrandMark />
            <span>personal-mcps</span>
          </div>
          <div className="auth-card">
            <div>
              <div className="auth-title">Connect Claude</div>
              <div className="auth-desc">This client will act as the agent you choose.</div>
            </div>
            <div className="kv">
              <div className="kv-row">
                <div className="kv-key">Redirects to</div>
                <div className="mono">https://claude.ai/api/mcp/auth_callback</div>
              </div>
            </div>
            <button type="button" className="btn btn--primary btn--block">
              Allow
            </button>
          </div>
          <div className="auth-foot">
            All requests: <a href="#approvals">Approvals dashboard</a>
          </div>
        </div>
      }
      next={
        <div className="w-full">
          <AuthFrame
            foot={
              <>
                All requests: <a href="#approvals">Approvals dashboard</a>
              </>
            }
          >
            <Card size="auth">
              <div>
                <CardTitle>Connect Claude</CardTitle>
                <CardDescription>This client will act as the agent you choose.</CardDescription>
              </div>
              <KvList variant="block">
                <Kv k="Redirects to">
                  <span className="mono">https://claude.ai/api/mcp/auth_callback</span>
                </Kv>
              </KvList>
              <button type="button" className="btn btn--primary btn--block">
                Allow
              </button>
            </Card>
          </AuthFrame>
        </div>
      }
    />
  ),
};
