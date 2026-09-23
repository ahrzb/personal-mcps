import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { TokenReveal } from "@/chrome/Reveal";
import { useDocumentTitle } from "@/chrome/Shell";
import { useAppEnv } from "@/lib/api-context";
import { ApiError } from "@/lib/http";
import { paths } from "@/lib/paths";
import { useCreateApp } from "@/lib/queries";
import type { CreatedApp } from "@/lib/types";
import { usePreviewTransient } from "@/preview/transient";
import { ALIAS_SERVICE_FIELD, activeNote, appNewDraft, createErrors, mcpScoped } from "./derive";
import type { AliasRow, AppNewDraft, AppNewErrors, Refusal, SearchBag } from "./derive";

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
 * `.auth`/`.auth-card` wrapper, which is what `styles.css` calls "auth pages … login,
 * device, two-factor, add-app". It, `/approvals/<id>` and `/device` are the SPA routes that
 * render no `Shell`.
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
    <div className="auth">
      <div className="brand">
        <BrandMark />
        <span>personal-mcps</span>
      </div>
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
    </div>
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
 * The form itself — every control of AppNew.dc.html, in its order and with its classes.
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
    <form id="app-form" className="auth-card" onSubmit={onSubmit}>
      <div>
        <div className="auth-title">Add app</div>
        <div className="auth-desc">Register an MCP app in your namespace.</div>
      </div>

      {errors.form ? <div className="alert alert--danger">{errors.form}</div> : null}

      <div className="choice-list" role="radiogroup" aria-label="App kind">
        <label className="choice">
          <input
            type="radio"
            name="kind"
            value="tunnel"
            checked={draft.kind === "tunnel"}
            onChange={() => onDraft({ ...draft, kind: "tunnel" })}
          />
          <div>
            <div className="choice-title">Tunneled</div>
            <div className="choice-desc">A bot that dials in with an app token — shown once after creating.</div>
          </div>
        </label>
        <label className="choice">
          <input
            type="radio"
            name="kind"
            value="proxy"
            checked={proxy}
            onChange={() => onDraft({ ...draft, kind: "proxy" })}
          />
          <div>
            <div className="choice-title">Proxied</div>
            <div className="choice-desc">An existing MCP endpoint the hub forwards to.</div>
          </div>
        </label>
      </div>

      <div className="form">
        {/* No `required` and no error slot: §8 defaults a blank Name to the slug, so the form
            neither demands one nor can be refused over one (§13). */}
        <div className="field">
          <label htmlFor="app-name">Name</label>
          <input
            id="app-name"
            type="text"
            name="name"
            value={draft.name}
            onChange={(event) => onDraft({ ...draft, name: event.target.value })}
          />
        </div>

        <div className="field">
          <label htmlFor="app-slug">Slug</label>
          {/* The `-` in `pattern` is ESCAPED. A `pattern` attribute is compiled with the `v`
              flag, under which a bare trailing `-` in a character class is a syntax error —
              the browser then refuses the whole expression and validates nothing. The
              server-rendered page carried the unescaped form and therefore had no
              client-side slug validation at all; `app_create` was the only judge. */}
          <input
            id="app-slug"
            className="input--mono"
            type="text"
            name="slug"
            value={draft.slug}
            pattern="[a-z0-9\-]+"
            required
            aria-invalid={errors.slug ? "true" : undefined}
            onChange={(event) => onDraft({ ...draft, slug: event.target.value })}
          />
          {errors.slug ? (
            <div className="field-error">{errors.slug}</div>
          ) : (
            <div className="field-hint">
              Lowercase letters, digits, dashes — served at {slugPath}. pmcp is reserved.
            </div>
          )}
        </div>

        <div className="field" data-proxy-only hidden={!proxy}>
          <label htmlFor="app-endpoint">Endpoint</label>
          <input
            id="app-endpoint"
            className="input--mono"
            type="url"
            name="endpoint"
            value={draft.endpoint}
            placeholder="https://mcp.example.com/mcp"
            required={proxy}
            aria-invalid={errors.endpoint ? "true" : undefined}
            onChange={(event) => onDraft({ ...draft, endpoint: event.target.value })}
          />
          {errors.endpoint ? <div className="field-error">{errors.endpoint}</div> : null}
        </div>

        <div className="field" data-proxy-only hidden={!proxy}>
          <div className="label">Authentication</div>
          <div className="choice-list" role="radiogroup" aria-label="Authentication">
            <label className="choice">
              <input
                type="radio"
                name="authMode"
                value="headers"
                checked={draft.authMode === "headers"}
                onChange={() => onDraft({ ...draft, authMode: "headers" })}
              />
              <div>
                <div className="choice-title">Headers</div>
                <div className="choice-desc">Static headers — an API key or bearer token, stored encrypted.</div>
              </div>
            </label>
            <label className="choice">
              <input
                type="radio"
                name="authMode"
                value="oauth"
                checked={draft.authMode === "oauth"}
                onChange={() => onDraft({ ...draft, authMode: "oauth" })}
              />
              <div>
                <div className="choice-title">OAuth</div>
                <div className="choice-desc">Sign in at the provider — Linear, GitHub, and similar.</div>
              </div>
            </label>
          </div>
        </div>

        {/* §23.6's optional hub-local TypeScript naming: the names generated programs call
            this app's tools under. The upstream keeps its canonical names — an alias never
            renames it — and a blank control keeps whatever name the hub establishes, so an
            untouched section is not a statement about anything. */}
        <div className="field">
          <label htmlFor="app-typescript-service">TypeScript service name</label>
          <input
            id="app-typescript-service"
            className="input--mono"
            type="text"
            name={ALIAS_SERVICE_FIELD}
            value={draft.aliases.service}
            onChange={(event) =>
              onDraft({ ...draft, aliases: { ...draft.aliases, service: event.target.value } })
            }
          />
          <div className="field-hint">
            Optional. Names this app in generated programs, e.g. mcp.<span className="mono">linear</span>.…; blank
            derives one from the slug.
          </div>
        </div>

        <div className="field">
          <span className="label">Tool aliases</span>
          <AliasRows
            rows={draft.aliases.rows}
            onRows={(rows) => onDraft({ ...draft, aliases: { ...draft.aliases, rows } })}
          />
          <div className="field-hint">
            Optional. Canonical upstream tool names keep working unchanged; an alias only changes what generated
            programs call. Blank keeps the name already established.
          </div>
          {/* The op names `typescript_aliases` — the whole section — for a syntax refusal and
              for a collision alike, so the sentence lands here rather than under one control
              (no single input is the wrong one; the SET is). */}
          {errors.aliases ? <div className="field-error">{errors.aliases}</div> : null}
        </div>
      </div>

      <div className="alert" data-note="tunnel" hidden={note !== "tunnel"}>
        {NOTE_TUNNEL}
      </div>
      <div className="alert" data-note="proxy-headers" hidden={note !== "proxy-headers"}>
        {NOTE_PROXY_HEADERS}
      </div>
      <div className="alert" data-note="proxy-oauth" hidden={note !== "proxy-oauth"}>
        {NOTE_PROXY_OAUTH}
      </div>

      <div className="actions wide-only">
        <Link className="btn" to={paths.apps}>
          Cancel
        </Link>
        <button type="submit" className="btn btn--primary" disabled={pending}>
          <span data-submit-label>{submitLabel}</span>
        </button>
      </div>
      <div className="narrow-only">
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-5)" }}>
          <button type="submit" className="btn btn--primary btn--block" disabled={pending}>
            <span data-submit-label>{submitLabel}</span>
          </button>
          <Link className="btn btn--outline btn--block" to={paths.apps}>
            Cancel
          </Link>
        </div>
      </div>
    </form>
  );
}

/**
 * §23.6's alias rows: one `<tr>` per row, the canonical name beside its alias, paired by
 * index exactly as the composer reads them.
 *
 * A row's canonical name is an editable input, not a label: a spare row is how the owner
 * names a tool the hub has not seen, and retargeting a prefilled row is the same statement.
 * Each input carries its own `aria-label` because the narrow treatment hides the header row,
 * and a stacked pair of bare inputs with only a placeholder would have no name at all.
 */
function AliasRows({
  rows,
  onRows,
}: {
  rows: readonly AliasRow[];
  /** The whole row list, because a row is two controls and the pair is the unit. */
  onRows: (rows: AliasRow[]) => void;
}): ReactNode {
  return (
    <table className="table alias-table">
      <thead>
        <tr>
          <th>Canonical tool name</th>
          <th>TypeScript alias</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row, index) => (
          <tr key={index}>
            <td>
              <input
                className="input--mono"
                type="text"
                value={row.canonicalName}
                placeholder="canonical tool name"
                aria-label={`Canonical tool name, row ${index + 1}`}
                onChange={(event) =>
                  onRows(
                    rows.map((held, at) =>
                      at === index ? { ...held, canonicalName: event.target.value } : held,
                    ),
                  )
                }
              />
            </td>
            <td>
              <input
                className="input--mono"
                type="text"
                value={row.alias}
                placeholder="alias"
                aria-label={`TypeScript alias, row ${index + 1}`}
                onChange={(event) =>
                  onRows(rows.map((held, at) => (at === index ? { ...held, alias: event.target.value } : held)))
                }
              />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** The receipt (AppNewStates). `token` is the tunneled create's one-time plaintext, or null
 *  — a proxied app has nothing that connects, so it has no token to reveal, and the same
 *  card renders one section lighter. */
function CreatedCard({ slug, token }: { slug: string; token: string | null }): ReactNode {
  return (
    <div className="auth-card">
      <div>
        <div className="auth-title">App created</div>
        <div className="auth-desc">
          <span className="mono">{slug}</span> is ready for its first connection.
        </div>
      </div>

      {/* The same reveal the app page's Token pane draws for a rotation (§13) — one
          definition, so the two renders of one warning cannot drift apart. */}
      {token === null ? null : <TokenReveal token={token} />}

      <div className="actions">
        <Link className="btn btn--primary" to={paths.apps}>
          Done
        </Link>
      </div>
    </div>
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
    <div className="auth-card">
      <div>
        <div className="auth-title">Connecting to {name}…</div>
        <div className="auth-desc">Finish signing in at {name} — this link expires in about 10 minutes.</div>
      </div>

      <div className="actions">
        <Link className="btn" to={paths.appPane(slug, "overview")}>
          Not now
        </Link>
        <a className="btn btn--primary" href={authorizeUrl}>
          Continue to {name}
        </a>
      </div>
    </div>
  );
}

/** The hub mark from the artboards. Duplicated from the Shell, which does not export it and
 *  whose header this page deliberately does not render. */
const BrandMark = (): ReactNode => (
  <svg
    width="20"
    height="20"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    aria-hidden="true"
  >
    <circle cx="12" cy="12" r="3.5" />
    <path d="M12 8.5V3.5" />
    <path d="M14.5 14.5L18.5 18.5" />
    <path d="M9.5 14.5L5.5 18.5" />
  </svg>
);
