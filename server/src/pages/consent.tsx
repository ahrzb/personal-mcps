/**
 * /oauth/consent — §19.5's consent screen: the provider redirected the browser here with a
 * signed authorization request, and this page is the whole security boundary of §19 (§18
 * decision 24). Every string it shows about the client came out of a body anyone could POST
 * to an unauthenticated registration endpoint, so it is drawn as untrusted text — never
 * markup, never a live link — and the one thing that actually decides where the code goes
 * (the redirect_uri's ORIGIN) is shown beside the client's self-chosen name, not instead of
 * it.
 *
 * Chromeless, like /login and /device: reached from the provider's own redirect, not from
 * inside the signed-in app.
 *
 * Pure: (props) => JSX. The hidden `oauth_query` field is the SAME signed string the page
 * was rendered from — this component only echoes it, never rebuilds or edits it (model.ts's
 * consentProps is where it is read, once).
 */

import type { FC } from "hono/jsx";
import { html } from "hono/html";
import type { ConsentAgentOption, ConsentProps } from "./model";
import { paths } from "./model";

const STYLESHEET = "/styles.css";

/** Not exported by ./layout — the same mark, redrawn here for this chromeless page. */
const BrandMark: FC = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
    <circle cx="12" cy="12" r="3.5" />
    <path d="M12 8.5V3.5" />
    <path d="M14.5 14.5L18.5 18.5" />
    <path d="M9.5 14.5L5.5 18.5" />
  </svg>
);

const WarningIcon: FC = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--warning)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="m21.73 18-8-14a2 2 0 0 0-3.46 0l-8 14A2 2 0 0 0 4 20h16a2 2 0 0 0 1.73-2Z" />
    <path d="M12 9v4" />
    <path d="M12 17h.01" />
  </svg>
);

/** The empty state (§19.5): consent is impossible until an agent exists, so submit is
 *  disabled rather than left to fail server-side, and Deny still works. */
const NoAgents: FC = () => (
  <div class="empty">
    <div class="empty-title">No agents yet</div>
    <div class="empty-text">
      Create one at <a href={paths.apps}>{paths.apps}</a> before connecting a client — the agent it is
      given decides everything the client can do.
    </div>
  </div>
);

const AgentPicker: FC<{ agents: ConsentAgentOption[] }> = ({ agents }) => (
  <div class="field">
    <label for="agent">Agent</label>
    <select id="agent" name="agent" required>
      <option value="">Choose an agent</option>
      {agents.map((agent) => (
        <option value={agent.slug}>{agent.name}</option>
      ))}
    </select>
    <div class="field-hint">The client will be able to do exactly what this agent can.</div>
  </div>
);

export const ConsentPage: FC<ConsentProps> = ({
  csrfToken,
  oauthQuery,
  clientName,
  clientSelfRegistered,
  redirectOrigin,
  scopes,
  namespace,
  agents,
}) => {
  const displayName = clientName ?? "An application";
  return (
    <>
      {html`<!doctype html>`}
      <html lang="en">
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <meta name="theme-color" content="#fafafa" />
          <title>Connect {displayName}</title>
          <link rel="stylesheet" href={STYLESHEET} />
          <link rel="preconnect" href="https://fonts.googleapis.com" />
          <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="anonymous" />
          <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&display=swap" />
        </head>
        <body>
          <div class="auth">
            <div class="brand">
              <BrandMark />
              <span>personal-mcps</span>
            </div>
            <div class="auth-card">
              <div>
                <div class="auth-title">Connect {displayName}</div>
                <div class="auth-desc">
                  {displayName} wants to connect to your {namespace} namespace.
                </div>
              </div>

              {clientSelfRegistered && (
                <div class="alert alert--warning">
                  <WarningIcon />
                  <div class="alert-text">This application registered itself — identity unverified.</div>
                </div>
              )}

              <div class="kv">
                <div class="kv-row">
                  <div class="kv-key">Redirects to</div>
                  <div class="mono">{redirectOrigin}</div>
                </div>
                <div class="kv-row">
                  <div class="kv-key">Namespace</div>
                  <div>{namespace}</div>
                </div>
                <div class="kv-row">
                  <div class="kv-key">Scopes</div>
                  <div class="mono">{scopes.join(", ")}</div>
                </div>
              </div>

              <form method="post" action={paths.oauthConsent} class="form">
                <input type="hidden" name="csrf" value={csrfToken} />
                <input type="hidden" name="oauth_query" value={oauthQuery} />
                {agents.length === 0 ? <NoAgents /> : <AgentPicker agents={agents} />}
                <div class="confirm-actions">
                  <button type="submit" name="decision" value="deny" class="btn btn--danger-outline">
                    Deny
                  </button>
                  <button
                    type="submit"
                    name="decision"
                    value="accept"
                    class="btn btn--primary"
                    disabled={agents.length === 0 ? true : undefined}
                  >
                    Allow
                  </button>
                </div>
              </form>
            </div>
          </div>
        </body>
      </html>
    </>
  );
};
