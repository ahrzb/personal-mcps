import { useQuery } from "@tanstack/react-query";
import { Link, useRouter } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { AuthFrame } from "@/chrome/AuthFrame";
import { Kv, KvList } from "@/chrome/Kv";
import { useDocumentTitle } from "@/chrome/Shell";
import { Failure, Skeleton } from "@/chrome/States";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldDescription, FieldGroup } from "@/components/ui/field";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { useApi, useAppEnv } from "@/lib/api-context";
import { ApiError } from "@/lib/http";
import { paths } from "@/lib/paths";
import { consentQuery } from "@/lib/queries";
import type { ConsentRead } from "@/lib/types";

/**
 * `/oauth/consent` — §19.5's consent screen, and the whole security boundary of §19 (§18
 * decision 24). Chromeless, as the server page was: reached from the provider's own redirect.
 *
 * The port of `server/src/pages/consent.tsx`, element for element. Three rules hold it to the
 * server's binding (routes design §4):
 *
 *   - the read carries the document's RAW search — the router HISTORY's `location.search`,
 *     which is `window.location.search` as the provider's redirect wrote it — and never the
 *     router's own `searchStr`, which is parsed and re-serialized: a re-encoded byte is a
 *     broken signature;
 *   - the form's `oauth_query` is the read's `oauthQuery`, the bytes the provider just
 *     verified, never something assembled here;
 *   - every client string (name, redirect origin, namespace, scopes) is untrusted and drawn as
 *     a text node — never markup, never a link — with the redirect ORIGIN beside the
 *     self-chosen name, never instead of it.
 *
 * The decision stays a real `<form method="post">`: its answer is a 303 to the client's own
 * redirect_uri, which a `fetch` cannot carry into the address bar.
 */
export function ConsentPage(): ReactNode {
  const api = useApi();
  const rawSearch = useRouter().history.location.search;
  const read = useQuery(consentQuery(api, rawSearch));

  let body: ReactNode;
  if (read.isPending) {
    body = (
      <Card size="auth">
        <Skeleton rows={6} />
      </Card>
    );
  } else if (read.isError) {
    // A 400 is the provider refusing the signature — what the document-level 400 said for an
    // edited or expired query. Retrying cannot mend a signature, so it offers none.
    body =
      read.error instanceof ApiError && read.error.status === 400 ? (
        <Alert variant="danger" role="alert">
          {read.error.message}
        </Alert>
      ) : (
        <Failure message={read.error.message} onRetry={() => void read.refetch()} />
      );
  } else body = <ConsentCard read={read.data} />;

  return <AuthFrame>{body}</AuthFrame>;
}

/** The card: who is asking, where the code goes, what it may reach, the agent it acts as. */
function ConsentCard({ read }: { read: ConsentRead }): ReactNode {
  const { bootstrap } = useAppEnv();
  const displayName = read.clientName ?? "An application";
  useDocumentTitle(`Connect ${displayName}`);

  return (
    <Card size="auth">
      <div>
        <CardTitle>Connect {displayName}</CardTitle>
        <CardDescription>
          {displayName} wants to connect to your {read.namespace} namespace.
        </CardDescription>
      </div>

      {read.clientSelfRegistered && (
        <Alert variant="warning">
          <WarningIcon />
          <AlertDescription>This application registered itself — identity unverified.</AlertDescription>
        </Alert>
      )}

      <KvList variant="block">
        <Kv k="Redirects to">
          <span className="font-mono">{read.redirectOrigin}</span>
        </Kv>
        <Kv k="Namespace">{read.namespace}</Kv>
        <Kv k="Scopes">
          <span className="font-mono">{read.scopes.join(", ")}</span>
        </Kv>
      </KvList>

      <FieldGroup render={<form method="post" action={paths.oauthConsent} />}>
        <input type="hidden" name="csrf" value={bootstrap.csrf} />
        <input type="hidden" name="oauth_query" value={read.oauthQuery} />
        {read.agents.length === 0 ? <NoAgents /> : <AgentPicker agents={read.agents} />}
        <div className="flex gap-3 max-md:flex-col-reverse max-md:gap-2.5">
          {/* `formNoValidate`: the picker is `required`, and on the server page that blocked
              Deny until an agent was chosen — refusing needs no agent. */}
          <Button
            type="submit"
            name="decision"
            value="deny"
            variant="danger-outline"
            className="flex-[1_1_auto]"
            formNoValidate
          >
            Deny
          </Button>
          <Button
            type="submit"
            name="decision"
            value="accept"
            className="flex-[1_1_auto]"
            disabled={read.agents.length === 0}
          >
            Allow
          </Button>
        </div>
      </FieldGroup>
    </Card>
  );
}

/** The empty state (§19.5): consent is impossible until an agent exists, so Allow is disabled
 *  rather than left to fail server-side, and Deny still works. */
function NoAgents(): ReactNode {
  return (
    <Empty>
      <EmptyTitle>No agents yet</EmptyTitle>
      <EmptyDescription>
        Create one under <Link to={paths.agentNew}>Agents</Link> before connecting a client — the agent it is given
        decides everything the client can do.
      </EmptyDescription>
    </Empty>
  );
}

/** The agent the client will act as — defaulted to NOTHING, so a consent is always a choice. */
function AgentPicker({ agents }: { agents: ConsentRead["agents"] }): ReactNode {
  return (
    <Field>
      <Label htmlFor="agent">Agent</Label>
      <NativeSelect id="agent" name="agent" required defaultValue="">
        <option value="">Choose an agent</option>
        {agents.map((agent) => (
          <option key={agent.slug} value={agent.slug}>
            {agent.name}
          </option>
        ))}
      </NativeSelect>
      <FieldDescription>The client will be able to do exactly what this agent can.</FieldDescription>
    </Field>
  );
}

function WarningIcon(): ReactNode {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--warning)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m21.73 18-8-14a2 2 0 0 0-3.46 0l-8 14A2 2 0 0 0 4 20h16a2 2 0 0 0 1.73-2Z" />
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
    </svg>
  );
}
