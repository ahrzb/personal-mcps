/**
 * /services/new — the add-service form (ServiceNew.dc.html / MobileServiceNew.dc.html)
 * and its two follow-on renders (ServiceNewStates.dc.html): the once-only token reveal
 * for a tunneled service, and the same receipt one card lighter for a proxied one.
 *
 * Chromeless like /login and /device (model.ts): no nav, no `Layout` shell — `Layout`
 * is built for the four-section signed-in chrome and this page's props carry no
 * `section`/`pendingApprovals` to feed it, so this template renders its own minimal
 * document with the shared `.auth`/`.auth-card` classes those pages are meant for
 * (styles.css: "auth pages ... login, device, two-factor, add-service").
 *
 * Pure `(props) => JSX`: no fetching, no cookies. The one bit of client-side script is
 * progressive enhancement — switching Tunneled/Proxied and Headers/OAuth updates which
 * fields and which note are visible without a round trip — mirroring the inline
 * <script> layout.tsx already uses for service-worker registration. Every fixture
 * renders correctly with the script absent (the server-picked visibility is the
 * script's own starting state), so this is enhancement, not a dependency.
 */

import type { FC } from "hono/jsx";
import { html } from "hono/html";
import { paths, type ServiceNewErrors, type ServiceNewForm, type ServiceNewProps, type ServiceNewStep } from "./model";

/** Not owned by `paths` (display-only asset routes) — same pattern as layout.tsx. */
const STYLESHEET = "/styles.css";
const MANIFEST = "/manifest.webmanifest";

/** The hub mark from the artboards — duplicated from layout.tsx, which doesn't export it. */
const BrandMark: FC = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
    <circle cx="12" cy="12" r="3.5" />
    <path d="M12 8.5V3.5" />
    <path d="M14.5 14.5L18.5 18.5" />
    <path d="M9.5 14.5L5.5 18.5" />
  </svg>
);

/* The three notes under the fields (ServiceNew.dc.html / ServiceNewStates.dc.html).
 * Which one shows is a function of kind + authMode; all three render (`data-note`),
 * and the enhancement script hides the two that don't match — so a fixture with
 * scripting off still shows exactly the right one. */
const NOTE_TUNNEL = "After creating you'll get this service's token — shown once. Your bot uses it to dial in.";
const NOTE_PROXY_OAUTH =
  "After creating you'll be sent to the provider to connect. Tokens are stored encrypted; your config file only records the auth mode.";
const NOTE_PROXY_HEADERS = "Tokens are stored encrypted; your config file only records the auth mode.";

function activeNote(form: ServiceNewForm): "tunnel" | "proxy-headers" | "proxy-oauth" {
  if (form.kind === "tunnel") return "tunnel";
  return form.authMode === "oauth" ? "proxy-oauth" : "proxy-headers";
}

const FormCard: FC<{ username: string; csrfToken: string; form: ServiceNewForm; errors: ServiceNewErrors }> = ({
  username,
  csrfToken,
  form,
  errors,
}) => {
  const proxy = form.kind === "proxy";
  const note = activeNote(form);
  const slugPath = paths.mcpScoped(username, form.slug || "…");

  return (
    <form id="service-form" class="auth-card" method="post" action={paths.serviceCreate}>
      <input type="hidden" name="csrf" value={csrfToken} />

      <div>
        <div class="auth-title">Add service</div>
        <div class="auth-desc">Register an MCP service in your namespace.</div>
      </div>

      {errors.form ? <div class="alert alert--danger">{errors.form}</div> : null}

      <div class="choice-list" role="radiogroup" aria-label="Service kind">
        <label class="choice">
          <input type="radio" name="kind" value="tunnel" checked={form.kind === "tunnel"} />
          <div>
            <div class="choice-title">Tunneled</div>
            <div class="choice-desc">A bot that dials in with a service token — shown once after creating.</div>
          </div>
        </label>
        <label class="choice">
          <input type="radio" name="kind" value="proxy" checked={proxy} />
          <div>
            <div class="choice-title">Proxied</div>
            <div class="choice-desc">An existing MCP endpoint the hub forwards to.</div>
          </div>
        </label>
      </div>

      <div class="form">
        <div class="field">
          <label for="svc-name">Name</label>
          <input id="svc-name" type="text" name="name" value={form.name} required aria-invalid={errors.name ? "true" : undefined} />
          {errors.name ? <div class="field-error">{errors.name}</div> : null}
        </div>

        <div class="field">
          <label for="svc-slug">Slug</label>
          <input
            id="svc-slug"
            class="input--mono"
            type="text"
            name="slug"
            value={form.slug}
            pattern="[a-z0-9-]+"
            required
            aria-invalid={errors.slug ? "true" : undefined}
          />
          {errors.slug ? (
            <div class="field-error">{errors.slug}</div>
          ) : (
            <div class="field-hint">Lowercase letters, digits, dashes — served at {slugPath}. pmcp is reserved.</div>
          )}
        </div>

        <div class="field" data-proxy-only hidden={!proxy}>
          <label for="svc-endpoint">Endpoint</label>
          <input
            id="svc-endpoint"
            class="input--mono"
            type="url"
            name="endpoint"
            value={form.endpoint}
            placeholder="https://mcp.example.com/mcp"
            required={proxy}
            aria-invalid={errors.endpoint ? "true" : undefined}
          />
          {errors.endpoint ? <div class="field-error">{errors.endpoint}</div> : null}
        </div>

        <div class="field" data-proxy-only hidden={!proxy}>
          <div class="label">Authentication</div>
          <div class="choice-list" role="radiogroup" aria-label="Authentication">
            <label class="choice">
              <input type="radio" name="authMode" value="headers" checked={form.authMode === "headers"} />
              <div>
                <div class="choice-title">Headers</div>
                <div class="choice-desc">Static headers — an API key or bearer token, stored encrypted.</div>
              </div>
            </label>
            <label class="choice">
              <input type="radio" name="authMode" value="oauth" checked={form.authMode === "oauth"} />
              <div>
                <div class="choice-title">OAuth</div>
                <div class="choice-desc">Sign in at the provider — Linear, GitHub, and similar.</div>
              </div>
            </label>
          </div>
        </div>
      </div>

      <div class="alert" data-note="tunnel" hidden={note !== "tunnel"}>
        {NOTE_TUNNEL}
      </div>
      <div class="alert" data-note="proxy-headers" hidden={note !== "proxy-headers"}>
        {NOTE_PROXY_HEADERS}
      </div>
      <div class="alert" data-note="proxy-oauth" hidden={note !== "proxy-oauth"}>
        {NOTE_PROXY_OAUTH}
      </div>

      <div class="actions wide-only">
        <a class="btn" href={paths.services}>
          Cancel
        </a>
        <button type="submit" class="btn btn--primary">
          <span data-submit-label>{proxy ? "Create and connect" : "Create"}</span>
        </button>
      </div>
      <div class="narrow-only">
        <div style={{ display: "flex", "flex-direction": "column", gap: "var(--space-5)" }}>
          <button type="submit" class="btn btn--primary btn--block">
            <span data-submit-label>{proxy ? "Create and connect" : "Create"}</span>
          </button>
          <a class="btn btn--outline btn--block" href={paths.services}>
            Cancel
          </a>
        </div>
      </div>

      {html`
        <script>
          (function () {
            var form = document.getElementById("service-form");
            if (!form) return;
            function sync() {
              var proxy = form.kind.value === "proxy";
              var authMode = form.authMode.value;
              form.querySelectorAll("[data-proxy-only]").forEach(function (el) {
                el.hidden = !proxy;
              });
              form.endpoint.required = proxy;
              var note = proxy ? "proxy-" + authMode : "tunnel";
              form.querySelectorAll("[data-note]").forEach(function (el) {
                el.hidden = el.dataset.note !== note;
              });
              var label = form.querySelector("[data-submit-label]");
              if (label) label.textContent = proxy ? "Create and connect" : "Create";
            }
            form.addEventListener("change", sync);
          })();
        </script>
      `}
    </form>
  );
};

const CreatedCard: FC<{ step: Extract<ServiceNewStep, { kind: "created" }> }> = ({ step }) => (
  <div class="auth-card">
    <div>
      <div class="auth-title">Service created</div>
      <div class="auth-desc">
        <span class="mono">{step.slug}</span> is ready for its first connection.
      </div>
    </div>

    {step.token ? (
      <>
        <div class="token-reveal">
          <div class="token-value" id="token-value">
            {step.token}
          </div>
          <button type="button" class="btn btn--outline" id="copy-token">
            Copy
          </button>
        </div>
        <div class="alert alert--warning">This token is shown only once. Store it in your bot's secret store.</div>
        {html`
          <script>
            (function () {
              var btn = document.getElementById("copy-token");
              var value = document.getElementById("token-value");
              if (!btn || !value) return;
              btn.addEventListener("click", function () {
                navigator.clipboard.writeText(value.textContent || "");
              });
            })();
          </script>
        `}
      </>
    ) : null}

    <div class="actions">
      <a class="btn btn--primary" href={paths.services}>
        Done
      </a>
    </div>
  </div>
);

export const ServiceNewPage: FC<ServiceNewProps> = ({ username, csrfToken, step }) => (
  <>
    {html`<!doctype html>`}
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="theme-color" content="#ffffff" />
        <title>Add service</title>
        <link rel="stylesheet" href={STYLESHEET} />
        <link rel="manifest" href={MANIFEST} />
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
          {step.kind === "form" ? (
            <FormCard username={username} csrfToken={csrfToken} form={step.form} errors={step.errors} />
          ) : (
            <CreatedCard step={step} />
          )}
        </div>
      </body>
    </html>
  </>
);
