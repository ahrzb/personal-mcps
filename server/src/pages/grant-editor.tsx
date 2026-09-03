/**
 * /agents/<slug>/grants/<app> — §13's (agent × app) grant editor (2026-09-03, roadmap
 * step 9; the `GrantEditorStates` board). Its own page rather than a dialog, so the pair
 * is linkable and the whole thing needs no script.
 *
 * One row per role the app declares, then any role the pair holds that it does not, then
 * the built-in `all` last — each row carrying §13's one three-way choice. The form's
 * fields are the only ones on this surface that are not the fronted op's keys: `grant_set`
 * takes `roles` as a list, so the route composes it out of these controls
 * (model.ts's `roleField` / `composeRoles` own both halves of that translation).
 */

import type { FC } from "hono/jsx";
import { Layout } from "./layout";
import { alertClass } from "./format";
import { paths, roleField } from "./model";
import type { GrantChoice, GrantEditorProps, GrantEditorRow } from "./model";
import type { FamilyPatterns } from "../registry";

/** §13's three-way choice, in its own order — `none` first, because it is the state a
 *  role the agent does not hold is in. */
const CHOICES: readonly GrantChoice[] = ["none", "allow", "approval"];

/** §20.3's two spellings on one line: a bare list IS the tools list, and the per-family
 *  object names the family each list belongs to. The page relays what `app_list` reported
 *  — canonicalizing here would be a second normalizer beside registry's. */
function patternText(patterns: string[] | FamilyPatterns): string {
  return Array.isArray(patterns)
    ? patterns.join(", ")
    : Object.entries(patterns)
        .map(([family, list]) => `${family}: ${(list ?? []).join(", ")}`)
        .join(" · ");
}

const RoleRow: FC<{ row: GrantEditorRow }> = ({ row }) => (
  <tr>
    <td>
      <div class="cell-name">
        <span class="mono">{row.role}</span>{" "}
        {row.builtin ? <span class="badge badge--muted">built-in</span> : null}
        {row.undeclared ? <span class="badge badge--warning">undeclared</span> : null}
      </div>
      {row.builtin ? (
        <div class="list-meta">every tool, present and future — the app can widen what its roles match.</div>
      ) : row.patterns === null ? null : (
        <div class="list-meta mono">{patternText(row.patterns)}</div>
      )}
    </td>
    <td class="cell-actions">
      <select name={roleField(row.role)} aria-label={`${row.role} access`}>
        {CHOICES.map((choice) => (
          <option value={choice} selected={row.choice === choice ? true : undefined}>
            {choice}
          </option>
        ))}
      </select>
    </td>
  </tr>
);

/**
 * §9's kind rule in §13's words. The same shape — a granted role the app does not declare
 * — is a warning on a tunneled app, whose declaration arrives at its first connect and may
 * legitimately be behind the file, and an error on a proxied one, whose declaration is
 * complete by construction; the proxied sentence is what `grant_set` refuses the save
 * with, so it names no role.
 */
const UndeclaredNotice: FC<GrantEditorProps> = (props) => {
  const undeclared = props.rows.filter((row) => row.undeclared);
  if (undeclared.length === 0) return null;
  if (props.kind === "proxy") {
    return (
      <div class={alertClass("danger")}>
        <span class="mono">{props.app}</span> is proxied — its roles are fixed in config, so an undeclared role is
        an error.
      </div>
    );
  }
  return (
    <div class={alertClass("warning")}>
      {undeclared.map((row) => (
        <div>
          <span class="mono">{props.app}</span> hasn't declared <span class="mono">{row.role}</span>. Tunneled apps
          declare roles when they connect — this grant stays dormant until then.
        </div>
      ))}
    </div>
  );
};

export function GrantEditorPage(props: GrantEditorProps) {
  const { agent, app, appName, csrfToken, error, notice } = props;
  return (
    <Layout
      title={`Grants · ${agent} on ${app} · personal-mcps`}
      active="agents"
      username={props.username}
      pendingApprovals={props.pendingApprovals}
    >
      <main class="page page--narrow">
        {notice ? (
          <div class={alertClass(notice.tone)}>
            {notice.title ? <div class="alert-title">{notice.title}</div> : null}
            <div>{notice.message}</div>
          </div>
        ) : null}
        <div class="page-head">
          <div>
            <p class="page-subtitle">
              <a href={paths.agents}>Agents</a> / <a href={paths.agentDetail(agent)}>{agent}</a> / grants
            </p>
            <h1 class="page-title">
              Grants — <span class="mono">{agent}</span> on {appName}
            </h1>
            <p class="page-subtitle">What this agent may call on this app.</p>
          </div>
        </div>

        <form class="card card--pad" method="post" action={paths.agentGrantSet(agent, app)}>
          <input type="hidden" name="csrf" value={csrfToken} />
          {/* The refused save, redrawn on the choices that caused it (§13) — never a
              redirect, so nothing the owner picked is lost to the refusal. */}
          {error === null ? null : <div class={alertClass("danger")}>{error}</div>}
          {props.declaresNothing ? (
            <div class="empty empty--inline">
              <div class="empty-text">
                <span class="mono">{app}</span> hasn't declared any roles yet.
              </div>
            </div>
          ) : null}
          <table class="table">
            <thead>
              <tr>
                <th>Role</th>
                <th>Access</th>
              </tr>
            </thead>
            <tbody>
              {props.rows.map((row) => (
                <RoleRow row={row} />
              ))}
            </tbody>
          </table>
          <UndeclaredNotice {...props} />
          <p class="note">
            Saving replaces every grant <span class="mono">{agent}</span> holds on <span class="mono">{app}</span> —
            unchecked roles are removed.
          </p>
          <div class="actions">
            <a class="btn btn--ghost" href={paths.agentDetail(agent)}>
              Cancel
            </a>
            <button type="submit" class="btn btn--primary">
              Save
            </button>
          </div>
        </form>
      </main>
    </Layout>
  );
}
