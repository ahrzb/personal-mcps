/**
 * `/agents/<slug>/danger` — the delete card and what deletion removes.
 *
 * A port of `pages/agent-detail.tsx`'s `DangerPane` plus the `delete-agent` arm of its
 * dialog. The three counts are the same ones the rail and the header were built from, so the
 * card cannot claim a different cascade from the page around it.
 */

import { useNavigate } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { paths } from "@/lib/paths";
import { useOp } from "@/lib/queries";
import { ConfirmDialog, useDropSearchKeys } from "@/chrome/Confirm";
import { DELETE_AGENT_TEXT } from "../AgentsPage";
import type { AgentPageData } from "../AgentFrame";
import { Kv, KvList } from "@/chrome/Kv";
import { Details, DetailsBody, DetailsHead, Listing, ListingHead, ListingScroll, ListingTitle } from "@/chrome/Listing";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { DialogFooter } from "@/components/ui/dialog";

/** The danger zone's own sentence — longer than the list's, because this card is where the
 *  cascade into clients is stated. */
const DELETE_AGENT_FULL =
  "Deleting an agent deletes its tokens, revokes its clients and removes its grants everywhere. This cannot be undone.";

export function DangerPane({ data, confirming }: { data: AgentPageData; confirming: boolean }): ReactNode {
  const agent = data.agent.slug;
  const navigate = useNavigate();
  const dropKeys = useDropSearchKeys();
  const remove = useOp<{ slug: string }>("agent_delete", { agent });
  return (
    <>
      <Listing>
        <ListingHead>
          <ListingTitle render={<span />}>Danger zone</ListingTitle>
        </ListingHead>
        <ListingScroll>
          {remove.isError ? (
            <Alert variant="danger" role="alert">
              <AlertDescription>{remove.error.message}</AlertDescription>
            </Alert>
          ) : null}
          <Card render={<section />} className="border-danger-border">
            <CardTitle render={<h2 />}>Delete agent</CardTitle>
            <CardDescription render={<p />}>{DELETE_AGENT_FULL}</CardDescription>
            {/* The action row: wrapping, its button the row's full width on a phone. */}
            <div className="flex flex-wrap items-center gap-3 max-md:*:flex-1">
              <Button
                variant="danger-outline"
                onClick={() => void navigate({ to: paths.agentPane(agent, "danger"), search: { confirm: "delete-agent" } })}
              >
                Delete {agent}
              </Button>
            </div>
          </Card>
        </ListingScroll>
      </Listing>
      <Details>
        <DetailsHead>
          <div className="text-lg font-semibold">What deletion removes</div>
        </DetailsHead>
        <DetailsBody>
          <Card size="sm" render={<section />}>
            <KvList>
              <Kv k="Grants">{data.held.length} apps</Kv>
              <Kv k="Tokens">{data.tokens.length}</Kv>
              <Kv k="Clients">{data.clients.length} — the binding cascades</Kv>
              <Kv k="History">kept — audit rows name the principal, not the row</Kv>
            </KvList>
          </Card>
        </DetailsBody>
      </Details>
      {confirming ? (
        <ConfirmDialog
          title={`Delete agent “${agent}”?`}
          text={DELETE_AGENT_TEXT}
          onClose={() => dropKeys(["confirm"])}
        >
          <DialogFooter>
            <Button variant="ghost" onClick={() => dropKeys(["confirm"])}>
              Cancel
            </Button>
            <Button
              variant="danger"
              disabled={remove.isPending}
              onClick={() =>
                remove.mutate(
                  { slug: agent },
                  // The agent this page is about no longer exists, so there is no pane to
                  // return to: the list is the only place left to be.
                  { onSuccess: () => void navigate({ to: paths.agents }) },
                )
              }
            >
              Delete
            </Button>
          </DialogFooter>
        </ConfirmDialog>
      ) : null}
    </>
  );
}
