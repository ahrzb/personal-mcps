import type { PrimitiveState } from "../../seed";
import { AuthFrame, BrandMark } from "@/chrome/AuthFrame";
import { Kv, KvList } from "@/chrome/Kv";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { Bench } from "./Bench";

/**
 * The auth frame's bench (`chrome/AuthFrame`): the brand, one auth card with its title,
 * description, a key/value block and a button, and the foot with a link. The frame is a
 * screen tall, as it is on its pages.
 */
export const authFrameStates: Record<string, PrimitiveState> = {
  "auth-frame": () => (
    <Bench>
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
                <span className="font-mono">https://claude.ai/api/mcp/auth_callback</span>
              </Kv>
            </KvList>
            <Button className="w-full">Allow</Button>
          </Card>
        </AuthFrame>
      </div>
    </Bench>
  ),
};
