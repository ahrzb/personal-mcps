/**
 * The document shell every page renders inside: <!doctype>, head (stylesheet, PWA
 * manifest, service-worker registration), the header bar with the four sections, and a
 * slot for the page's own content.
 *
 * Pure: props in, JSX out. No fetching, no cookies, no auth checks — web.ts decides who
 * may see a page and what the props say; this file only draws them. Every URL comes
 * from `paths`, never from string concatenation here.
 *
 * Desktop and mobile are this one shell plus styles.css: at the narrow breakpoint the
 * nav drops out of the 56px bar onto its own scrollable row (the Mobile* artboards).
 */

import { html } from "hono/html";
import type { Child, FC } from "hono/jsx";
import { paths, type NavSection } from "./model";

export type LayoutProps = {
  /** Browser tab title for this page. */
  title: string;
  /** Which nav item is highlighted; marked aria-current="page". */
  active: NavSection;
  /** Namespace owner's username, shown beside Sign out (hidden at narrow widths). */
  username: string;
  /** Pending approval count — renders the red nav badge when above zero. */
  pendingApprovals?: number;
  /** The page's own content. */
  children?: Child;
};

/**
 * The three asset URLs the shell needs that `paths` does not name: they are served by
 * web.ts, not linked between pages, and their spellings are pinned by §13.
 */
const STYLESHEET = "/styles.css";
const MANIFEST = "/manifest.webmanifest";
const SERVICE_WORKER = "/sw.js";

const NAV: { key: NavSection; label: string; href: string }[] = [
  { key: "services", label: "Services", href: paths.services },
  { key: "audit", label: "Audit", href: paths.audit },
  { key: "approvals", label: "Approvals", href: paths.approvals },
  { key: "account", label: "Account", href: paths.account },
];

/** The hub mark from the artboards — a node with three spokes. */
const BrandMark: FC = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
    <circle cx="12" cy="12" r="3.5" />
    <path d="M12 8.5V3.5" />
    <path d="M14.5 14.5L18.5 18.5" />
    <path d="M9.5 14.5L5.5 18.5" />
  </svg>
);

export const Layout: FC<LayoutProps> = ({ title, active, username, pendingApprovals, children }) => (
  <>
    {html`<!doctype html>`}
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="theme-color" content="#ffffff" />
        <title>{title}</title>
        <link rel="stylesheet" href={STYLESHEET} />
        <link rel="manifest" href={MANIFEST} />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="anonymous" />
        <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&display=swap" />
      </head>
      <body>
        <header class="app-header">
          <div class="app-header-main">
            <a class="brand" href={paths.services}>
              <BrandMark />
              <span>personal-mcps</span>
            </a>
            <div class="app-header-end">
              <span class="header-user">{username}</span>
              <form method="post" action={paths.auth.signOut}>
                <button type="submit" class="btn btn--outline btn--sm">Sign out</button>
              </form>
            </div>
          </div>
          <nav class="nav">
            {NAV.map((item) => (
              <a class="nav-link" href={item.href} aria-current={item.key === active ? "page" : undefined}>
                {item.label}
                {item.key === "approvals" && pendingApprovals ? <span class="nav-badge">{pendingApprovals}</span> : null}
              </a>
            ))}
          </nav>
        </header>
        {children}
        {/* Installability and push only — the worker never intercepts navigation (§13). */}
        <script
          dangerouslySetInnerHTML={{
            __html: `navigator.serviceWorker&&navigator.serviceWorker.register(${JSON.stringify(SERVICE_WORKER)})`,
          }}
        />
      </body>
    </html>
  </>
);
