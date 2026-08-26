/**
 * /oauth/connections — §19.6/§8's list of the OAuth clients connected to this namespace,
 * with Revoke. Chromeless, like /oauth/consent: a settings page reached from a link, not
 * part of the four-section shell (§13 names no nav slot for it).
 *
 * Pure: (props) => JSX. Every URL comes from `paths`; `now` is the only clock read, for the
 * relative "last used" line.
 */

import type { FC } from "hono/jsx";
import { html } from "hono/html";
import type { ConnectionRow, ConnectionsProps } from "./model";
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

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "Never" / "just now" / "12m ago" / "3h ago" / an ISO date — the same relative-time shape
 *  services.tsx already draws, spelled again here rather than imported (a template concern,
 *  never a shared runtime dependency between two pages). */
function relative(at: number | null, nowIso: string): string {
  if (at === null) return "Never";
  const diff = Date.parse(nowIso) - at;
  if (diff < MINUTE) return "just now";
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)}m ago`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)}h ago`;
  return new Date(at).toISOString().slice(0, 10);
}

const ConnectionRowView: FC<{ row: ConnectionRow; csrfToken: string; now: string }> = ({ row, csrfToken, now }) => (
  <tr>
    <td>
      <div class="cell-name">{row.clientName ?? row.clientId}</div>
      <div class="cell-slug wide-only">{row.clientId}</div>
    </td>
    <td class="wide-only">{row.accountSlug}</td>
    <td class="wide-only muted">{relative(row.createdAt, now)}</td>
    <td class="wide-only muted">{relative(row.lastUsedAt, now)}</td>
    <td class="cell-actions">
      <form method="post" action={paths.connectionRevoke(row.id)}>
        <input type="hidden" name="csrf" value={csrfToken} />
        <button type="submit" class="btn btn--danger-outline btn--sm">
          Revoke
        </button>
      </form>
    </td>
  </tr>
);

const EmptyConnections: FC = () => (
  <div class="empty">
    <div class="empty-title">No connections yet</div>
    <div class="empty-text">A client that completes /oauth/consent appears here.</div>
  </div>
);

export const ConnectionsPage: FC<ConnectionsProps> = ({ now, csrfToken, connections }) => (
  <>
    {html`<!doctype html>`}
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="theme-color" content="#ffffff" />
        <title>Connections</title>
        <link rel="stylesheet" href={STYLESHEET} />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="anonymous" />
        <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&display=swap" />
      </head>
      <body>
        <div class="page">
          <div class="page-head">
            <div>
              <div class="brand">
                <BrandMark />
                <span>personal-mcps</span>
              </div>
              <h1 class="page-title">Connections</h1>
              <p class="page-subtitle">OAuth clients connected to your namespace.</p>
            </div>
          </div>
          {connections.length === 0 ? (
            <EmptyConnections />
          ) : (
            <div class="card">
              <table class="table">
                <thead>
                  <tr>
                    <th>Client</th>
                    <th class="wide-only">Account</th>
                    <th class="wide-only">Created</th>
                    <th class="wide-only">Last used</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {connections.map((row) => (
                    <ConnectionRowView row={row} csrfToken={csrfToken} now={now} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p class="note">
            <a href={paths.services}>Back to services</a>
          </p>
        </div>
      </body>
    </html>
  </>
);
