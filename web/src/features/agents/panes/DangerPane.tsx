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
import { Kv } from "./Kv";

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
      <div className="listing">
        <div className="lh">
          <span className="listing-title">Danger zone</span>
        </div>
        <div className="scroll">
          {remove.isError ? (
            <div className="alert alert--danger" role="alert">
              <div className="alert-text">{remove.error.message}</div>
            </div>
          ) : null}
          <section className="card card--pad card--danger">
            <h2 className="card-title">Delete agent</h2>
            <p className="card-desc">{DELETE_AGENT_FULL}</p>
            <div className="actions actions--start">
              <button
                type="button"
                className="btn btn--danger-outline"
                onClick={() => void navigate({ to: paths.agentPane(agent, "danger"), search: { confirm: "delete-agent" } })}
              >
                Delete {agent}
              </button>
            </div>
          </section>
        </div>
      </div>
      <div className="details">
        <div className="dh">
          <div className="listing-title">What deletion removes</div>
        </div>
        <div className="db">
          <section className="card card--pad">
            <div className="kv">
              <Kv k="Grants">{data.held.length} apps</Kv>
              <Kv k="Tokens">{data.tokens.length}</Kv>
              <Kv k="Clients">{data.clients.length} — the binding cascades</Kv>
              <Kv k="History">kept — audit rows name the principal, not the row</Kv>
            </div>
          </section>
        </div>
      </div>
      {confirming ? (
        <ConfirmDialog
          title={`Delete agent “${agent}”?`}
          text={DELETE_AGENT_TEXT}
          onClose={() => dropKeys(["confirm"])}
        >
          <div className="actions">
            <button type="button" className="btn btn--ghost" onClick={() => dropKeys(["confirm"])}>
              Cancel
            </button>
            <button
              type="button"
              className="btn btn--danger"
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
            </button>
          </div>
        </ConfirmDialog>
      ) : null}
    </>
  );
}
