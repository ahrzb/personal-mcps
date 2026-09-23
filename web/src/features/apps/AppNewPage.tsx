import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { Actions, NarrowActions } from "@/chrome/Actions";
import { AuthFrame } from "@/chrome/AuthFrame";
import { TokenReveal } from "@/chrome/Reveal";
import { useDocumentTitle } from "@/chrome/Shell";
import { Alert } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldError, FieldGroup } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupCard } from "@/components/ui/radio-group";
import { useAppEnv } from "@/lib/api-context";
import { ApiError } from "@/lib/http";
import { paths } from "@/lib/paths";
import { useCreateApp } from "@/lib/queries";
import type { CreatedApp } from "@/lib/types";
import { usePreviewTransient } from "@/preview/transient";
import { AliasRows } from "./AliasRows";
import { ALIAS_SERVICE_FIELD, activeNote, appNewDraft, createErrors, mcpScoped } from "./derive";
import type { AppNewDraft, AppNewErrors, Refusal, SearchBag } from "./derive";

/* The three notes under the fields. Which one shows is a function of kind + auth mode; all
 * three are rendered (`data-note`) and the two that do not match are hidden, exactly as the
 * server-rendered form did it — the difference being that here the visibility follows the
 * draft rather than an enhancement script. */
const NOTE_TUNNEL = "After creating you'll get this app's token — shown once. Your bot uses it to dial in.";
const NOTE_PROXY_OAUTH =
  "After creating you'll be sent to the provider to connect. Tokens are stored encrypted; your config file only records the auth mode.";
const NOTE_PROXY_HEADERS = "Tokens are stored encrypted; your config file only records the auth mode.";

/**
 * `/apps/new` — the add-app form and its three follow-on states.
 *
 * CHROMELESS, like `/login` and `/device`: no header, no nav. The page draws its own
 * `AuthFrame` and one `Card size="auth"` — the auth pages' frame. It, `/approvals/<id>`,
 * `/device` and `/oauth/consent` are the SPA routes that render no `Shell`.
 *
 * The four steps the server rendered as four separate responses — the empty form, the form
 * redrawn with the owner's values and a field-scoped refusal, the created receipt, and §13's
 * connecting card — are the same four here, decided by the create's own answer:
 *
 *   no answer yet, or a refusal  → the form, with the owner's draft untouched
 *   an answer carrying `connect` → the connecting card
 *   an answer carrying anything else → the receipt (with the token where there is one)
 *   an answer carrying `connectError` → the app exists, so this leaves for its Overview pane
 *
 * The draft is component state and the answer is the mutation's; NEITHER is server data in
 * `useState`, and the minted plaintext is never written to the query cache — this render is
 * the only place it will ever exist (§4/§15).
 *
 * Two of those steps and the refusal are the outcome of a submit, so they are also the two
 * the state gallery cannot reach by seeding a cache: both are taken as INITIAL values from
 * the preview transient, which is the empty object in production and therefore the same path
 * a fresh mount already takes.
 */
export function AppNewPage(): ReactNode {
  useDocumentTitle("Add app");
  const { bootstrap } = useAppEnv();
  const search = useSearch({ strict: false }) as SearchBag;
  const navigate = useNavigate();
  const create = useCreateApp();
  const transient = usePreviewTransient();
  // Prefilled from the URL once. A refusal does not navigate, so there is no second read to
  // take the owner's values back from — they never left.
  const [draft, setDraft] = useState<AppNewDraft>(() => appNewDraft(search));
  // The seeded answer and refusal are initial values only: `useState`'s initialiser runs
  // once, so a later render can never have one of these overwrite the real mutation's.
  const [seededAnswer] = useState<CreatedApp | null>(() =>
    transient.connecting !== undefined
      ? {
          slug: transient.connecting.slug,
          name: transient.connecting.name,
          connect: { authorizeUrl: transient.connecting.authorizeUrl },
        }
      : transient.created !== undefined
        ? {
            slug: transient.created.slug,
            name: transient.created.name,
            token: transient.created.token ?? null,
          }
        : null,
  );
  const [seededRefusal] = useState<Refusal | null>(() => transient.refusal ?? null);

  const created = create.data ?? seededAnswer;
  const connectFailed = created !== null && created.connectError !== undefined;
  const refused: Refusal | null =
    create.error === null
      ? seededRefusal
      : {
          reason: create.error.message,
          violations: create.error instanceof ApiError ? create.error.violations : undefined,
        };

  // §18 decision 30's refusal arm: the create SUCCEEDED and only the upstream handshake did
  // not, so the owner belongs on the app that now exists, carrying the reason as the same
  // two flash keys the server's redirect wrote.
  useEffect(() => {
    if (created === null || created.connectError === undefined) return;
    void navigate({
      to: paths.appPane(created.slug, "overview"),
      search: { failed: "connect", reason: created.connectError },
      replace: true,
    });
  }, [created, navigate]);

  return (
    <AuthFrame>
      {created === null || connectFailed ? (
        <FormCard
          username={bootstrap.username}
          draft={draft}
          onDraft={setDraft}
          errors={refused === null ? {} : createErrors(refused)}
          pending={create.isPending}
          onSubmit={(event) => {
            event.preventDefault();
            create.mutate(createBody(draft));
          }}
        />
      ) : created.connect !== undefined ? (
        <ConnectingCard slug={created.slug} name={created.name} authorizeUrl={created.connect.authorizeUrl} />
      ) : (
        <CreatedCard slug={created.slug} token={created.token ?? null} />
      )}
    </AuthFrame>
  );
}

/**
 * The draft as `POST /api/hub/apps` takes it.
 *
 * A blank Name is NOT sent, so the op defaults it to the slug (§8/§13) and the form has no
 * Name error to draw. The proxy-only pair is sent only where it means something, because a
 * tunneled create rejects both. The alias section is sent whole — including its untouched
 * spare rows, which the route's own composer drops — so the request is the editor's own
 * account of what it drew.
 */
function createBody(draft: AppNewDraft): Record<string, unknown> {
  return {
    slug: draft.slug,
    kind: draft.kind,
    ...(draft.name.trim() === "" ? {} : { name: draft.name }),
    ...(draft.kind === "proxy" ? { endpoint: draft.endpoint, authMode: draft.authMode } : {}),
    aliases: { service: draft.aliases.service, rows: draft.aliases.rows },
  };
}

/**
 * The form itself — every control of AppNew.dc.html, in its order.
 *
 * `onDraft` replaces the whole draft rather than patching a field, so the controls stay
 * uncontrolled-looking and there is one state transition per keystroke; `errors` is the
 * refusal's own field scoping, drawn beside the control it names and never navigated to.
 */
function FormCard({
  username,
  draft,
  onDraft,
  errors,
  pending,
  onSubmit,
}: {
  username: string;
  draft: AppNewDraft;
  onDraft: (draft: AppNewDraft) => void;
  /** A refused create's sentences, per control. Empty before the first submit. */
  errors: AppNewErrors;
  /** Whether a create is in flight — the one thing that disables the submit. */
  pending: boolean;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}): ReactNode {
  const proxy = draft.kind === "proxy";
  const note = activeNote(draft);
  const slugPath = mcpScoped(username, draft.slug || "…");
  const submitLabel = proxy ? "Create and connect" : "Create";

  return (
    <Card size="auth" render={<form id="app-form" onSubmit={onSubmit} />}>
      <div>
        <CardTitle>Add app</CardTitle>
        <CardDescription>Register an MCP app in your namespace.</CardDescription>
      </div>

      {errors.form ? <Alert variant="danger">{errors.form}</Alert> : null}

      <RadioGroup
        aria-label="App kind"
        name="kind"
        value={draft.kind}
        onValueChange={(kind: AppNewDraft["kind"]) => onDraft({ ...draft, kind })}
      >
        <RadioGroupCard
          value="tunnel"
          title="Tunneled"
          description="A bot that dials in with an app token — shown once after creating."
        />
        <RadioGroupCard value="proxy" title="Proxied" description="An existing MCP endpoint the hub forwards to." />
      </RadioGroup>

      <FieldGroup>
        {/* No `required` and no error slot: §8 defaults a blank Name to the slug, so the form
            neither demands one nor can be refused over one (§13). */}
        <Field>
          <Label htmlFor="app-name">Name</Label>
          <Input
            id="app-name"
            type="text"
            name="name"
            value={draft.name}
            onChange={(event) => onDraft({ ...draft, name: event.target.value })}
          />
        </Field>

        <Field>
          <Label htmlFor="app-slug">Slug</Label>
          {/* The `-` in `pattern` is ESCAPED. A `pattern` attribute is compiled with the `v`
              flag, under which a bare trailing `-` in a character class is a syntax error —
              the browser then refuses the whole expression and validates nothing. The
              server-rendered page carried the unescaped form and therefore had no
              client-side slug validation at all; `app_create` was the only judge. */}
          <Input
            id="app-slug"
            type="text"
            className="font-mono"
            name="slug"
            value={draft.slug}
            pattern="[a-z0-9\-]+"
            required
            aria-invalid={errors.slug ? "true" : undefined}
            onChange={(event) => onDraft({ ...draft, slug: event.target.value })}
          />
          {errors.slug ? (
            <FieldError>{errors.slug}</FieldError>
          ) : (
            <FieldDescription>
              Lowercase letters, digits, dashes — served at {slugPath}. pmcp is reserved.
            </FieldDescription>
          )}
        </Field>

        <Field data-proxy-only hidden={!proxy}>
          <Label htmlFor="app-endpoint">Endpoint</Label>
          <Input
            id="app-endpoint"
            type="url"
            className="font-mono"
            name="endpoint"
            value={draft.endpoint}
            placeholder="https://mcp.example.com/mcp"
            required={proxy}
            aria-invalid={errors.endpoint ? "true" : undefined}
            onChange={(event) => onDraft({ ...draft, endpoint: event.target.value })}
          />
          {errors.endpoint ? <FieldError>{errors.endpoint}</FieldError> : null}
        </Field>

        <Field data-proxy-only hidden={!proxy}>
          <Label render={<div />}>Authentication</Label>
          <RadioGroup
            aria-label="Authentication"
            name="authMode"
            value={draft.authMode}
            onValueChange={(authMode: AppNewDraft["authMode"]) => onDraft({ ...draft, authMode })}
          >
            <RadioGroupCard
              value="headers"
              title="Headers"
              description="Static headers — an API key or bearer token, stored encrypted."
            />
            <RadioGroupCard
              value="oauth"
              title="OAuth"
              description="Sign in at the provider — Linear, GitHub, and similar."
            />
          </RadioGroup>
        </Field>

        {/* §23.6's optional hub-local TypeScript naming: the names generated programs call
            this app's tools under. The upstream keeps its canonical names — an alias never
            renames it — and a blank control keeps whatever name the hub establishes, so an
            untouched section is not a statement about anything. */}
        <Field>
          <Label htmlFor="app-typescript-service">TypeScript service name</Label>
          <Input
            id="app-typescript-service"
            type="text"
            className="font-mono"
            name={ALIAS_SERVICE_FIELD}
            value={draft.aliases.service}
            onChange={(event) =>
              onDraft({ ...draft, aliases: { ...draft.aliases, service: event.target.value } })
            }
          />
          <FieldDescription>
            Optional. Names this app in generated programs, e.g. mcp.<span className="font-mono">linear</span>.…;
            blank derives one from the slug.
          </FieldDescription>
        </Field>

        <Field>
          <Label render={<span />}>Tool aliases</Label>
          <AliasRows
            rows={draft.aliases.rows}
            onRows={(rows) => onDraft({ ...draft, aliases: { ...draft.aliases, rows } })}
          />
          <FieldDescription>
            Optional. Canonical upstream tool names keep working unchanged; an alias only changes what generated
            programs call. Blank keeps the name already established.
          </FieldDescription>
          {/* The op names `typescript_aliases` — the whole section — for a syntax refusal and
              for a collision alike, so the sentence lands here rather than under one control
              (no single input is the wrong one; the SET is). */}
          {errors.aliases ? <FieldError>{errors.aliases}</FieldError> : null}
        </Field>
      </FieldGroup>

      <Alert data-note="tunnel" hidden={note !== "tunnel"}>
        {NOTE_TUNNEL}
      </Alert>
      <Alert data-note="proxy-headers" hidden={note !== "proxy-headers"}>
        {NOTE_PROXY_HEADERS}
      </Alert>
      <Alert data-note="proxy-oauth" hidden={note !== "proxy-oauth"}>
        {NOTE_PROXY_OAUTH}
      </Alert>

      {/* The same two actions in each artboard's order: Cancel first beside the row wide,
          the submit first and full width on a phone. */}
      <Actions grow className="max-md:hidden">
        <Link className={buttonVariants({ variant: "ghost" })} to={paths.apps}>
          Cancel
        </Link>
        <Button type="submit" disabled={pending}>
          <span data-submit-label>{submitLabel}</span>
        </Button>
      </Actions>
      <NarrowActions>
        <Button type="submit" className="w-full" disabled={pending}>
          <span data-submit-label>{submitLabel}</span>
        </Button>
        <Link className={buttonVariants({ variant: "outline", className: "w-full" })} to={paths.apps}>
          Cancel
        </Link>
      </NarrowActions>
    </Card>
  );
}

/** The receipt (AppNewStates). `token` is the tunneled create's one-time plaintext, or null
 *  — a proxied app has nothing that connects, so it has no token to reveal, and the same
 *  card renders one section lighter. */
function CreatedCard({ slug, token }: { slug: string; token: string | null }): ReactNode {
  return (
    <Card size="auth">
      <div>
        <CardTitle>App created</CardTitle>
        <CardDescription>
          <span className="font-mono">{slug}</span> is ready for its first connection.
        </CardDescription>
      </div>

      {/* The same reveal the app page's Token pane draws for a rotation (§13) — one
          definition, so the two renders of one warning cannot drift apart. */}
      {token === null ? null : <TokenReveal token={token} />}

      <Actions grow>
        <Link className={buttonVariants()} to={paths.apps}>
          Done
        </Link>
      </Actions>
    </Card>
  );
}

/**
 * The `auth: oauth` receipt (AppNewProxiedStates · CONNECTING). A LINK, not a redirect and
 * not a script: §18 decision 30 settled that a create must not depend on a tab a page cannot
 * open, so the owner clicks "Continue to <name>" and the same-tab flow §7 already runs takes
 * over. "Not now" leaves the app in place — it exists, and its own page carries Connect for
 * later.
 *
 * The continue control is a plain `<a>` and not a `Link`: the authorize URL is the provider's.
 */
function ConnectingCard({
  slug,
  name,
  authorizeUrl,
}: {
  slug: string;
  /** The DISPLAY name, which the server defaulted to the slug where the owner left Name
   *  blank — this card says it twice, and a slug is not always the name. */
  name: string;
  authorizeUrl: string;
}): ReactNode {
  return (
    <Card size="auth">
      <div>
        <CardTitle>Connecting to {name}…</CardTitle>
        <CardDescription>Finish signing in at {name} — this link expires in about 10 minutes.</CardDescription>
      </div>

      <Actions grow>
        <Link className={buttonVariants({ variant: "ghost" })} to={paths.appPane(slug, "overview")}>
          Not now
        </Link>
        <a className={buttonVariants()} href={authorizeUrl}>
          Continue to {name}
        </a>
      </Actions>
    </Card>
  );
}
