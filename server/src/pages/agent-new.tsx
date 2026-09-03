/**
 * /agents/new — agent_create's three fields and nothing else (§13, 2026-09-03). Under the
 * shell, unlike /apps/new: there is no once-only reveal on this path (an agent's keys are
 * issued from its page), so nothing here needs the chromeless card. A refused create
 * re-renders this form at 400 with the refusal under the field it names.
 */

import type { FC } from "hono/jsx";
import { Layout } from "./layout";
import { paths, type AgentNewProps } from "./model";

const Field: FC<{ name: string; label: string; hint: string; value: string; error?: string; required?: boolean }> = ({
  name,
  label,
  hint,
  value,
  error,
  required,
}) => (
  <div class="field">
    <label class="label" for={`agent-${name}`}>
      {label}
    </label>
    <input
      class="input"
      id={`agent-${name}`}
      name={name}
      value={value}
      required={required ? true : undefined}
      aria-invalid={error === undefined ? undefined : "true"}
      aria-describedby={`agent-${name}-hint`}
    />
    <div class="field-hint" id={`agent-${name}-hint`}>
      {error === undefined ? hint : <span class="field-error">{error}</span>}
    </div>
  </div>
);

export function AgentNewPage(props: AgentNewProps) {
  const { form, errors, csrfToken } = props;
  return (
    <Layout title="New agent · personal-mcps" active="agents" username={props.username} pendingApprovals={props.pendingApprovals}>
      <main class="page page--narrow">
        <div class="page-head">
          <div>
            <p class="page-subtitle">
              <a href={paths.agents}>Agents</a> / new
            </p>
            <h1 class="page-title">New agent</h1>
            <p class="page-subtitle">An identity for an AI agent or system. It holds no grants until you set some.</p>
          </div>
        </div>
        <form class="card card--pad form" method="post" action={paths.agentCreate}>
          <input type="hidden" name="csrf" value={csrfToken} />
          {errors.form === undefined ? null : <div class="alert alert--danger">{errors.form}</div>}
          <Field
            name="slug"
            label="Slug"
            hint="Lowercase letters, digits and hyphens — the name tokens and grants are bound to."
            value={form.slug}
            error={errors.slug}
            required
          />
          <Field name="name" label="Name" hint="Display name; defaults to the slug." value={form.name} />
          <Field name="description" label="Description" hint="A note shown beside the agent." value={form.description} />
          <div class="actions">
            <a class="btn btn--ghost" href={paths.agents}>
              Cancel
            </a>
            <button type="submit" class="btn btn--primary">
              Create agent
            </button>
          </div>
        </form>
      </main>
    </Layout>
  );
}
