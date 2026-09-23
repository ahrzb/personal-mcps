/**
 * `/agents` — the list: one row per agent, the whole row a link to the agent page, and
 * Delete as the only row control. Granting lives on the agent page, so nothing here opens an
 * editor and nothing here reads a catalog.
 *
 * A port of `server/src/pages/agents.tsx` with its props builder's derivations
 * (`model.ts`'s `agentsProps` / `agentListRow` / `accessOf`) moved into `derive.ts` and
 * computed from the three reads the builder made: `agent_list`, `app_list` and `token_list`.
 *
 * The stretched anchor is kept: the row's link covers the row through its `after:` overlay,
 * and the Delete cell sits above it (`z-1`) so it still deletes. Delete stays behind
 * the list's own `?confirm=delete-agent&slug=` state — addressable exactly as /apps's is, so
 * a shared URL opens the same dialog and the state gallery can render it.
 */

import { Link, useSearch } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useApi } from "@/lib/api-context";
import { agentsQuery, appsQuery, keys, tokensQuery, useOp } from "@/lib/queries";
import { paths } from "@/lib/paths";
import { NoticeBanner, useFlash } from "@/chrome/Notice";
import { formatStamp } from "@/lib/format";
import { Shell, useDocumentTitle } from "@/chrome/Shell";
import { ConfirmDialog, useDropSearchKeys } from "@/chrome/Confirm";
import { Page, PageHead, PageSubtitle, PageTitle } from "@/chrome/Page";
import { RowLink } from "@/chrome/Listing";
import { QueryState, Skeleton } from "@/chrome/States";
import { Note, RowMeta, RowTitle } from "@/chrome/Text";
import { Alert } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { DialogFooter } from "@/components/ui/dialog";
import { Empty, EmptyDescription, EmptyTitle } from "@/components/ui/empty";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow, TableRowChevron } from "@/components/ui/table";
import type { AgentsResponse, ListedAgent } from "@/lib/types";
import { accessOf, accessText, agentTokensOf, oneOf, tokensText } from "./derive";
import type { AgentAccess, AgentToken } from "./derive";

/** §13's Delete copy — the same sentence the list's footer and the danger zone carry. */
export const DELETE_AGENT_TEXT = "Deleting an agent deletes its tokens and removes its grants everywhere.";

/** The search keys the delete dialog is addressed by, dropped together when it closes. */
const CONFIRM_KEYS = ["confirm", "slug"];

/** One row of the list, with the two summary cells already read off the three reads. */
type AgentRow = {
  agent: ListedAgent;
  access: AgentAccess;
  tokens: AgentToken[];
};

export function AgentsPage(): ReactNode {
  useDocumentTitle("Agents · personal-mcps");
  const api = useApi();
  const search = useSearch({ strict: false }) as Record<string, string | string[] | undefined>;
  const dropKeys = useDropSearchKeys();
  const client = useQueryClient();
  // The op's subject is the row the dialog names, so a delete invalidates that agent's own
  // key beside the three lists.
  const remove = useOp<{ slug: string }>("agent_delete", { agent: oneOf(search.slug) });

  const agents = useQuery(agentsQuery(api));
  const apps = useQuery(appsQuery(api));
  const tokens = useQuery(tokensQuery(api));
  const notice = useFlash(search);
  const now = Date.now();

  const rowsOf = (data: AgentsResponse): AgentRow[] =>
    data.agents.map((agent) => ({
      agent,
      access: accessOf(agent.grants, apps.data?.apps ?? []),
      tokens: agentTokensOf(tokens.data?.tokens ?? [], agent.slug, now),
    }));

  // A `?confirm=` naming no row opens nothing: the dialog is about a row, and a guessed slug
  // names none — the same validation the loader did.
  const confirmed =
    oneOf(search.confirm) === "delete-agent"
      ? agents.data?.agents.find((agent) => agent.slug === oneOf(search.slug))
      : undefined;

  /**
   * Delete is OPTIMISTIC: the next state is fully known here — the row leaves the list — and
   * a rollback is meaningful, so the row goes at the click and comes back if the op refuses.
   * The refetch is what settles it either way.
   */
  const deleteAgent = (slug: string): void => {
    client.setQueryData<AgentsResponse>(keys.agents(), (held) =>
      held === undefined ? held : { agents: held.agents.filter((agent) => agent.slug !== slug) },
    );
    dropKeys(CONFIRM_KEYS);
    remove.mutate(
      { slug },
      {
        onError: () => {
          void client.invalidateQueries({ queryKey: keys.agents() });
        },
      },
    );
  };

  return (
    <Shell active="agents">
      <Page shape="table">
        {notice === null ? null : <NoticeBanner notice={notice} />}
        <PageHead>
          <div>
            <PageTitle>Agents</PageTitle>
            <PageSubtitle>Identities that call your apps — each holds grants and keys.</PageSubtitle>
          </div>
          <Link className={buttonVariants({ className: "max-md:flex-[1_1_100%]" })} to={paths.agentNew}>
            New agent
          </Link>
        </PageHead>

        {remove.isError ? (
          <Alert variant="danger" role="alert">
            {remove.error.message}
          </Alert>
        ) : null}

        <QueryState
          query={agents}
          skeleton={<Skeleton rows={4} />}
          empty={{
            when: (data) => data.agents.length === 0,
            render: (
              <Empty>
                <EmptyTitle>No agents yet.</EmptyTitle>
                <EmptyDescription>Create one to give an AI agent its own grants and keys.</EmptyDescription>
                <Link className={buttonVariants({ className: "mt-4" })} to={paths.agentNew}>
                  New agent
                </Link>
              </Empty>
            ),
          }}
        >
          {(data) =>
            // The two summary cells are functions of the other two reads, so the table waits
            // for them rather than printing `no grants` for an agent whose apps have simply
            // not arrived yet.
            apps.isPending || tokens.isPending ? (
              <Skeleton rows={4} />
            ) : (
              <Card size="flush">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Agent</TableHead>
                      <TableHead>Access</TableHead>
                      <TableHead>Tokens</TableHead>
                      <TableHead>Created</TableHead>
                      <TableHead />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rowsOf(data).map((row) => (
                      <AgentRowView key={row.agent.slug} row={row} now={now} />
                    ))}
                  </TableBody>
                </Table>
              </Card>
            )
          }
        </QueryState>
        <Note>{DELETE_AGENT_TEXT}</Note>
      </Page>
      {confirmed === undefined ? null : (
        <ConfirmDialog
          title={`Delete agent “${confirmed.slug}”?`}
          text={DELETE_AGENT_TEXT}
          onClose={() => dropKeys(CONFIRM_KEYS)}
        >
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => dropKeys(CONFIRM_KEYS)}>
              Cancel
            </Button>
            <Button type="button" variant="danger" onClick={() => deleteAgent(confirmed.slug)}>
              Delete
            </Button>
          </DialogFooter>
        </ConfirmDialog>
      )}
    </Shell>
  );
}

function AgentRowView({ row, now }: { row: AgentRow; now: number }): ReactNode {
  const { agent } = row;
  return (
    <TableRow link>
      <TableCell>
        <RowTitle className="font-mono">
          <RowLink render={<Link to={paths.agentDetail(agent.slug)} />}>{agent.slug}</RowLink>
        </RowTitle>
        {agent.description === "" ? null : <RowMeta>{agent.description}</RowMeta>}
      </TableCell>
      <TableCell className="text-muted-foreground">{accessText(row.access)}</TableCell>
      <TableCell className="text-muted-foreground">{tokensText(row.tokens, now)}</TableCell>
      <TableCell className="text-muted-foreground">{formatStamp(agent.createdAt)}</TableCell>
      {/* Right-aligned beside the row wide; its own row under the card on a phone, the
          button a 44px share of it beside the chevron. */}
      <TableCell variant="actions">
        {/* Delete never mutates directly — it opens this page with the confirm dialog. */}
        <Link
          className={buttonVariants({ variant: "danger-outline", size: "cell" })}
          to={paths.agents}
          search={{ confirm: "delete-agent", slug: agent.slug }}
        >
          Delete
        </Link>
        <TableRowChevron />
      </TableCell>
    </TableRow>
  );
}
