import type { ReactNode } from "react";
import type { PrimitiveState } from "../../seed";
import { Kv, KvList } from "@/chrome/Kv";
import { DetailsBody } from "@/chrome/Listing";
import { Eyebrow, Note } from "@/chrome/Text";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Bench } from "./Bench";

/**
 * The Card bench: `<Card>` padded, with a header, in danger, and bare (`flush`); the details
 * column's panel (`sm`); and the auth card (`auth`), each in the wrapper its page gives it.
 *
 * Every sample sits in a full-width box, because a card on a page fills its column, and the
 * bench's cell would otherwise shrink it to its content.
 */
export const cardStates: Record<string, PrimitiveState> = {
  card: () => (
    <Bench>
      <Full>
        <Card>
          <CardHeader>
            <div>
              <CardTitle>Passkeys</CardTitle>
              <CardDescription>Sign in with a device you already unlock.</CardDescription>
            </div>
            <Button variant="outline" size="sm">
              Add
            </Button>
          </CardHeader>
          <Note>No passkeys yet.</Note>
        </Card>
      </Full>
      <Full>
        <Card render={<section />} className="border-danger-border">
          <CardTitle render={<h2 />}>Delete agent</CardTitle>
          <CardDescription render={<p />}>Its keys stop working at once and its grants are removed.</CardDescription>
        </Card>
      </Full>
      <Full>
        <Card size="flush">
          <CardContent className="gap-0.5">
            <CardTitle>Connected clients</CardTitle>
            <CardDescription>Outside software you approved to reach this hub.</CardDescription>
          </CardContent>
          <Note className="px-6 pb-6">A bare card holds a table edge to edge.</Note>
        </Card>
      </Full>
    </Bench>
  ),

  // The details column's small panel, in the column's body, holding the column's key/value
  // lines.
  "card-sm": () => (
    <Bench>
      <Full>
        <DetailsBody>
          <Card size="sm">
            <Eyebrow>Upstream</Eyebrow>
            <KvList>
              <Kv k="URL">
                <span className="font-mono">https://mcp.example.com/sse</span>
              </Kv>
            </KvList>
          </Card>
        </DetailsBody>
      </Full>
    </Bench>
  ),

  // The approval page's card, on the auth frame's ground and layout (`chrome/AuthFrame` less
  // its brand and its screen-tall minimum). At 390 the card goes chromeless and its heading
  // grows to 20px.
  "card-auth": () => (
    <Bench>
      <div className="flex w-full flex-col items-center justify-center gap-6 bg-sunken px-5 py-8 max-md:bg-background">
        <Card size="auth">
          <div>
            <CardTitle render={<h1 />}>Approve this request?</CardTitle>
            <CardDescription render={<p />}>An agent wants to run an approval-gated tool.</CardDescription>
          </div>
          <Button className="w-full">Approve</Button>
        </Card>
      </div>
    </Bench>
  ),
};

/** The column a card fills on a page. */
function Full({ children }: { children: ReactNode }): ReactNode {
  return <div className="w-full">{children}</div>;
}
