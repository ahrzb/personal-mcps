import { Dialog } from "@base-ui/react/dialog";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { useApi, useAppEnv } from "@/lib/api-context";
import { paths } from "@/lib/paths";
import { pendingApprovalsQuery } from "@/lib/queries";

/**
 * The shell every signed-in SPA page renders inside: the 56px header with the brand, the
 * five nav destinations and the user block, plus the narrow drawer.
 *
 * ONE behavioural change from `pages/layout.tsx`, and it is the one this rewrite exists to
 * make: the wide nav and the narrow drawer are the same five entries, and the drawer is a
 * Base UI Dialog rather than the `:target` mechanism the server-rendered pages needed (they
 * shipped no script). `styles.css`'s `.menu`, `.scrim` and `.menu-open` rules are untouched
 * and this component reuses them by class; `app.css` adds the open state they key elsewhere.
 *
 * Everything else is the same markup and the same classes: the page chrome is
 * `styles.css`'s, not Tailwind's, because the design language is the shared sheet's and a
 * second rendering of the header is a second chance for the two to disagree.
 */
export function Shell({
  active,
  children,
}: {
  active: "apps" | "agents" | "audit" | "approvals" | "settings";
  children: ReactNode;
}): ReactNode {
  const { bootstrap } = useAppEnv();
  return (
    <>
      <header className="app-header">
        <div className="app-header-main">
          <Link className="brand" to={paths.apps}>
            <BrandMark />
            <span>personal-mcps</span>
          </Link>
          <Drawer active={active} username={bootstrap.username} />
          <div className="app-header-end">
            <span className="header-user">{bootstrap.username}</span>
            <SignOutForm />
          </div>
        </div>
        <nav className="nav">
          {NAV.map((item) => (
            <NavEntry key={item.key} item={item} active={active} className="nav-link" />
          ))}
        </nav>
      </header>
      {/* The flash banner is NOT here. `styles.css` positions `.alert` as the first child
          of a page's own `<main>`, above `.page-head`, which is where every server-rendered
          page drew it — hoisting it into the chrome would put it outside the page's gutters
          and above its title. `chrome/Notice`'s `NoticeBanner` is the page's to render. */}
      {children}
    </>
  );
}

/** The five nav destinations, in the order §13 renders them — every one a route of this
 *  client's since /settings moved (decision 38), so every one is a `Link`. */
const NAV: {
  key: "apps" | "agents" | "audit" | "approvals" | "settings";
  label: string;
  href: string;
}[] = [
  { key: "apps", label: "Apps", href: paths.apps },
  { key: "agents", label: "Agents", href: paths.agents },
  { key: "audit", label: "Audit", href: paths.audit() },
  { key: "approvals", label: "Approvals", href: paths.approvals },
  { key: "settings", label: "Settings", href: paths.settings },
];

/**
 * One nav entry, as a client-side link.
 *
 * `onNavigate` fires on activation, before the navigation: the drawer passes its own close
 * so a tapped entry dismisses it. The header's nav bar passes nothing, having nothing to
 * dismiss.
 */
function NavEntry({
  item,
  active,
  className,
  onNavigate,
}: {
  item: (typeof NAV)[number];
  active: string;
  className: string;
  onNavigate?: () => void;
}): ReactNode {
  const badge =
    item.key === "approvals" ? <PendingBadge /> : null;
  const current = item.key === active ? "page" : undefined;
  return (
    <Link className={className} to={item.href} aria-current={current} onClick={onNavigate}>
      {item.label}
      {badge}
    </Link>
  );
}

/**
 * The red count beside Approvals.
 *
 * It POLLS, deliberately. The behaviour it replaces was `shell()` reading `pendingOf()` on
 * every server-rendered navigation, which client navigation no longer does — so without a
 * poll the badge would freeze at whatever the first page load saw. A minute is the interval,
 * and a window focus refetches immediately, because the case that matters is coming back to
 * a tab after approving something on a phone.
 */
function PendingBadge(): ReactNode {
  const api = useApi();
  const pending = useQuery({
    ...pendingApprovalsQuery(api),
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });
  const count = pending.data?.approvals.length ?? 0;
  return count === 0 ? null : <span className="nav-badge">{count}</span>;
}

/**
 * Sign out — a real form POST to the Worker's `/login/sign-out` (`paths.signOut` says why
 * not better-auth's own route), which answers with Set-Cookie and a 303 to /login. A `fetch`
 * could not apply the navigation, so this is one of the places the SPA still submits a form
 * rather than calling the API.
 */
function SignOutForm(): ReactNode {
  return (
    <form method="post" action={paths.signOut}>
      <button type="submit" className="btn btn--outline btn--sm">
        Sign out
      </button>
    </form>
  );
}

/**
 * The narrow navigation: the same five entries as the bar's nav, in the drawer
 * `styles.css`'s narrow breakpoint reveals. A Base UI Dialog, so it traps focus and closes
 * on Escape — which the `:target` drawer of the server-rendered pages could not.
 *
 * `.menu-open`, `.menu`, `.menu-head` and `.menu-foot` are the sheet's existing classes,
 * and so is `.scrim` on the Dialog's own backdrop. What the sheet does NOT carry is an
 * open state this component can reach — it keys open on `#menu:target` — so `app.css`
 * adds the `[data-open]` counter-rules Base UI's switch needs.
 *
 * The open flag is held here rather than left to the Dialog because a tapped entry has to
 * shut the drawer, and nothing else would do it: a drawer link to the route already shown
 * navigates nowhere, so the panel would sit over the page the owner just asked for. Across
 * routes it closes anyway — each page renders its own `Shell`, so the Dialog unmounts —
 * but that is the router's doing and not a promise this component should rest on.
 */
function Drawer({ active, username }: { active: string; username: string }): ReactNode {
  const [open, setOpen] = useState(false);
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger className="menu-open" aria-label="Menu" render={<button type="button" />}>
        <MenuIcon />
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Backdrop className="scrim" />
        <Dialog.Popup className="menu" data-slot="dialog-content">
          <div className="menu-head">
            <span className="brand">
              <BrandMark />
              <span>personal-mcps</span>
            </span>
            <Dialog.Close className="menu-close" aria-label="Close menu" render={<button type="button" />}>
              <CloseIcon />
            </Dialog.Close>
          </div>
          {NAV.map((item) => (
            <NavEntry
              key={item.key}
              item={item}
              active={active}
              className="menu-link"
              onNavigate={() => setOpen(false)}
            />
          ))}
          <div className="menu-foot">
            <span className="header-user">{username}</span>
            <SignOutForm />
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** The three bars, and the cross that closes what they opened. Decoration beside a label
 *  that already says what the control does, so neither is read out. */
function MenuIcon(): ReactNode {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M4 7h16M4 12h16M4 17h16" />
    </svg>
  );
}

function CloseIcon(): ReactNode {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

/** The hub mark from the artboards — a node with three spokes. */
function BrandMark(): ReactNode {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <circle cx="12" cy="12" r="3.5" />
      <path d="M12 8.5V3.5" />
      <path d="M14.5 14.5L18.5 18.5" />
      <path d="M9.5 14.5L5.5 18.5" />
    </svg>
  );
}

/**
 * The document title, which the client must now set itself: a server-rendered page carried
 * `<title>` in its own head, and a client-side navigation changes no head at all. An effect
 * rather than a render-time write, because the title is a side effect on a document the
 * component does not own.
 */
export function useDocumentTitle(title: string): void {
  useEffect(() => {
    document.title = title;
  }, [title]);
}
