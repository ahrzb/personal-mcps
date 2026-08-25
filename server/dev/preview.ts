// preview.ts — DEV-ONLY, THROWAWAY. Exists solely so `wrangler dev -c
// wrangler.preview.jsonc` can render every page × fixture combination while the UI
// template layer (server/src/pages) is being built against fixtures.ts. It is not
// part of the shipped worker (server/src/index.ts), is not mounted by wrangler.jsonc,
// is never deployed, and can be deleted the moment the real page routes in web.ts
// render for real. No auth, no bindings, no router dependency — a plain fetch handler
// is all two GET routes need.
//
//   GET /                          — an index linking every page × fixture pair.
//   GET /preview/<page>/<fixture>  — that page rendered with that fixture's exact props.
//
// Each page component already renders its complete document — the chromeless pages
// (login, device, service-new, approval-detail) draw their own <html>, the shelled
// pages (account, services, approvals, audit) wrap themselves in ./layout's Layout
// internally — so rendering here is just the component's own JSX stringified. Nothing
// here re-wraps a page in a second layout.

import type { PageName, PagePropsByName } from "../src/pages/model";
import type { FC } from "hono/jsx";
import { fixtures } from "./fixtures";
import { Login } from "../src/pages/login";
import { Device } from "../src/pages/device";
import { AccountPage } from "../src/pages/account";
import { ServicesPage } from "../src/pages/services";
import { ServiceNewPage } from "../src/pages/service-new";
import { ApprovalsPage } from "../src/pages/approvals";
import { ApprovalDetail } from "../src/pages/approval-detail";
import { AuditPage } from "../src/pages/audit";

/** page key (fixtures.ts / model.ts's PageName) → the component that renders it. */
const PAGES: Record<PageName, FC<any>> = {
  login: Login,
  device: Device,
  account: AccountPage,
  services: ServicesPage,
  "service-new": ServiceNewPage,
  approvals: ApprovalsPage,
  "approval-detail": ApprovalDetail,
  audit: AuditPage,
};

/** Structural, not `hono/jsx`'s own `JSX.Element` — the type hono/jsx exports under
 * that name from a plain .ts file is a different (attributes-only) namespace. Every
 * FC's real return value has this shape; `.toString()` is typed `string |
 * Promise<string>` for Suspense support none of these pure, sync templates use —
 * awaiting covers both without caring which one actually comes back. */
async function renderToHtml(node: { toString(): string | Promise<string> }): Promise<string> {
  const result = node.toString();
  return typeof result === "string" ? result : await result;
}

function htmlResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}

function renderIndex(): string {
  const sections = (Object.keys(fixtures) as PageName[])
    .map((page) => {
      const links = Object.keys(fixtures[page])
        .map((name) => `<li><a href="/preview/${page}/${name}">${name}</a></li>`)
        .join("");
      return `<section><h2>${page}</h2><ul>${links}</ul></section>`;
    })
    .join("");
  return `<!doctype html><html><head><meta charset="utf-8"><title>personal-mcps — page preview</title>
<style>body{font-family:system-ui,sans-serif;max-width:640px;margin:40px auto;padding:0 20px}
h2{margin-top:2em} ul{padding-left:1.2em} a{color:#2563eb}</style></head>
<body><h1>personal-mcps — page preview</h1>${sections}</body></html>`;
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/") return htmlResponse(renderIndex());

    const match = url.pathname.match(/^\/preview\/([^/]+)\/([^/]+)$/);
    if (!match) return htmlResponse("Not found", 404);

    const page = match[1] as PageName;
    const fixtureName = match[2] as string;
    const pageFixtures = fixtures[page] as Record<string, PagePropsByName[PageName]> | undefined;
    if (!pageFixtures || !(fixtureName in pageFixtures)) {
      return htmlResponse(`Not found: ${match[1]}/${fixtureName}`, 404);
    }

    const Component = PAGES[page];
    // FC's generic return type also allows `null`/`Child[]` (Suspense/fragment
    // escape hatches); every real page component here always returns one element.
    const rendered = Component(pageFixtures[fixtureName]) as { toString(): string | Promise<string> };
    const html = await renderToHtml(rendered);
    return htmlResponse(html);
  },
};
