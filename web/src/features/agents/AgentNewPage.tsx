/**
 * `/agents/new` — `agent_create`'s three fields and nothing else (§13).
 *
 * A port of `server/src/pages/agent-new.tsx`, including its place: under the shell, unlike
 * /apps/new, for the reason that page's own header states — there is no once-only reveal on
 * this path (an agent's keys are issued from its page), so nothing here needs the chromeless
 * card.
 *
 * A refusal renders under the field it names, with the draft intact and NO navigation. The
 * server re-rendered this form at 400 to carry the submitted values back across a redirect;
 * the draft never leaves the browser here, so the refusal is just something drawn beside it.
 */

import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useState } from "react";
import type { ReactNode } from "react";
import { ApiError } from "@/lib/http";
import { paths } from "@/lib/paths";
import { Actions } from "@/chrome/Actions";
import { NoticeBanner, useFlash } from "@/chrome/Notice";
import { useOp } from "@/lib/queries";
import { Shell, useDocumentTitle } from "@/chrome/Shell";
import { Page, PageHead, PageSubtitle, PageTitle } from "@/chrome/Page";
import { Alert } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Field, FieldDescription, FieldError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { usePreviewTransient } from "@/preview/transient";
import { oneOf } from "./derive";

/** The refusal, as the form draws it: one sentence per field it named, and one for the form
 *  where the refusal named no field of this form's. */
type AgentNewErrors = { slug?: string; name?: string; description?: string; form?: string };

/** The three fields `agent_create` takes. `name` and `description` are optional to the op and
 *  are sent only when the owner typed one, exactly as the form route did. */
type AgentNewForm = { slug: string; name: string; description: string };

export function AgentNewPage(): ReactNode {
  useDocumentTitle("New agent · personal-mcps");
  const search = useSearch({ strict: false }) as Record<string, string | string[] | undefined>;
  const navigate = useNavigate();
  const transient = usePreviewTransient();
  const create = useOp<{ slug: string; name?: string; description?: string }>("agent_create");
  const notice = useFlash(search);

  // The draft starts at whatever the URL carried — `agentNewForm`'s three keys, so a link
  // that pre-fills the form still does.
  const [form, setForm] = useState<AgentNewForm>(() => ({
    slug: oneOf(search.slug),
    name: oneOf(search.name),
    description: oneOf(search.description),
  }));
  const [errors, setErrors] = useState<AgentNewErrors>(() =>
    transient.refusal === undefined ? {} : errorsOf(transient.refusal),
  );

  const submit = (): void => {
    setErrors({});
    create.mutate(
      {
        slug: form.slug,
        ...(form.name === "" ? {} : { name: form.name }),
        ...(form.description === "" ? {} : { description: form.description }),
      },
      {
        onSuccess: () => void navigate({ to: paths.agentDetail(form.slug) }),
        onError: (error) =>
          setErrors(
            error instanceof ApiError
              ? errorsOf({ reason: error.message, violations: error.violations })
              : { form: error.message },
          ),
      },
    );
  };

  return (
    <Shell active="agents">
      <Page shape="document">
        {notice === null ? null : <NoticeBanner notice={notice} />}
        <PageHead>
          <div>
            <PageSubtitle>
              <Link to={paths.agents}>Agents</Link> / new
            </PageSubtitle>
            <PageTitle>New agent</PageTitle>
            <PageSubtitle>An identity for an AI agent or system. It holds no grants until you set some.</PageSubtitle>
          </div>
        </PageHead>
        <Card
          render={
            <form
              onSubmit={(event) => {
                event.preventDefault();
                submit();
              }}
            />
          }
        >
          {errors.form === undefined ? null : <Alert variant="danger">{errors.form}</Alert>}
          <TextField
            name="slug"
            label="Slug"
            hint="Lowercase letters, digits and hyphens — the name tokens and grants are bound to."
            value={form.slug}
            error={errors.slug}
            required
            onChange={(slug) => setForm({ ...form, slug })}
          />
          <TextField
            name="name"
            label="Name"
            hint="Display name; defaults to the slug."
            value={form.name}
            error={errors.name}
            onChange={(name) => setForm({ ...form, name })}
          />
          <TextField
            name="description"
            label="Description"
            hint="A note shown beside the agent."
            value={form.description}
            error={errors.description}
            onChange={(description) => setForm({ ...form, description })}
          />
          <Actions grow>
            <Link className={buttonVariants({ variant: "ghost" })} to={paths.agents}>
              Cancel
            </Link>
            <Button type="submit" disabled={create.isPending}>
              {create.isPending ? "Creating…" : "Create agent"}
            </Button>
          </Actions>
        </Card>
      </Page>
    </Shell>
  );
}

/**
 * A refusal, filed under the field it belongs to. `violations` is §8's field-scoped list and
 * is used as it stands where the op reported one; a bare reason is filed by the rule the form
 * route applied (`web.ts:1047`) — one that names the slug goes under Slug, anything else
 * under the whole form, because a sentence about the shape of the request is not about a
 * field the owner can point at.
 */
function errorsOf(refusal: { reason: string; violations?: { field: string; reason: string }[] }): AgentNewErrors {
  const named = refusal.violations ?? [];
  if (named.length > 0) {
    const errors: AgentNewErrors = {};
    for (const violation of named) {
      if (violation.field === "slug" || violation.field === "name" || violation.field === "description") {
        errors[violation.field] = violation.reason;
      } else {
        errors.form = errors.form === undefined ? violation.reason : `${errors.form} ${violation.reason}`;
      }
    }
    return errors;
  }
  return /"slug"|slug/i.test(refusal.reason) ? { slug: refusal.reason } : { form: refusal.reason };
}

/** One of the form's three text fields: its name, the field, and under it the standing hint,
 *  which the refusal naming this field replaces. */
function TextField({
  name,
  label,
  hint,
  value,
  error,
  required,
  onChange,
}: {
  name: string;
  label: string;
  hint: string;
  value: string;
  error?: string;
  required?: boolean;
  onChange: (value: string) => void;
}): ReactNode {
  return (
    <Field>
      <Label htmlFor={`agent-${name}`}>{label}</Label>
      <Input
        id={`agent-${name}`}
        name={name}
        value={value}
        required={required}
        aria-invalid={error === undefined ? undefined : "true"}
        aria-describedby={`agent-${name}-hint`}
        onChange={(event) => onChange(event.target.value)}
      />
      <FieldDescription id={`agent-${name}-hint`}>
        {error === undefined ? hint : <FieldError render={<span />}>{error}</FieldError>}
      </FieldDescription>
    </Field>
  );
}
