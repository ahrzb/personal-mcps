import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Sheet, SheetClose, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import { useApi, useAppEnv } from "@/lib/api-context";
import { paths } from "@/lib/paths";
import { pendingApprovalsQuery } from "@/lib/queries";
import { usePreviewTransient } from "@/preview/transient";
import { BrandMark } from "./AuthFrame";

/**
 * The shell every signed-in SPA page renders inside: the 56px header with the brand, the
 * five nav destinations and the user block, plus the narrow drawer.
 *
 * ONE header markup, two shapes. Wide, the inner row is `display: contents`, so the brand, the
 * nav and the user block lay out in the header's own row, ordered brand · nav · user. Narrow,
 * that inner row becomes the 56px bar (brand and hamburger), the nav and the user block are
 * hidden, and the same five entries and the sign-out live in the drawer, a `Sheet`.
 *
 * The wide nav and the narrow drawer are the same five entries: the one behavioural change
 * from the server-rendered layout, whose drawer was a `:target` panel with no script.
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
      <header className="flex h-header items-center gap-6 border-b px-8 max-md:block max-md:h-auto max-md:border-b-0 max-md:px-0">
        <div className="contents max-md:flex max-md:h-header max-md:items-center max-md:justify-between max-md:border-b max-md:px-5">
          <Link className={`${BRAND} ${FOCUS_RING}`} to={paths.apps}>
            <BrandMark />
            <span>personal-mcps</span>
          </Link>
          <Drawer active={active} username={bootstrap.username} />
          <div className="order-2 ml-auto flex items-center gap-3 max-md:hidden">
            <span className={USER}>{bootstrap.username}</span>
            <SignOutForm className="flex" />
          </div>
        </div>
        <nav className="order-1 flex items-center gap-1 max-md:hidden">
          {NAV.map((item) => (
            <NavEntry key={item.key} item={item} active={active} className={NAV_LINK} />
          ))}
        </nav>
      </header>
      {/* The flash banner is NOT here: it is the first line of a page's own `<main>`, above its
          title and inside its gutters, so `chrome/Notice`'s `NoticeBanner` is the page's to
          render. */}
      {children}
    </>
  );
}

/** Focus shows the ring every control shows, where a link or a bare button would otherwise
 *  show the browser's outline. */
const FOCUS_RING = "focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/35";

/** The mark and the name, 15px semibold, never squeezed: the bar's home link, and the
 *  drawer's heading. It keeps the text colour when hovered, unlike a plain link. */
const BRAND = "flex shrink-0 items-center gap-2 text-md font-semibold text-foreground no-underline";

/** Who is signed in, beside the sign-out. */
const USER = "text-base text-muted-foreground";

/** An entry in the bar: a 32px pill, filled when hovered and while it is the current page. */
const NAV_LINK = `flex h-control-sm items-center gap-1.5 whitespace-nowrap rounded-md px-3 text-base font-medium text-muted-foreground no-underline hover:bg-muted hover:text-foreground aria-[current=page]:bg-muted aria-[current=page]:text-foreground ${FOCUS_RING}`;

/** An entry in the drawer: a 44px row, its count pushed to the far end, filled only while it
 *  is the current page. A hover greys the others' text, as a link's does. */
const MENU_LINK = `flex h-control-touch items-center justify-between rounded-lg px-3 text-md font-medium text-muted-foreground no-underline hover:text-fg-subtle aria-[current=page]:bg-muted aria-[current=page]:text-foreground ${FOCUS_RING}`;

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
  return count === 0 ? null : (
    <Badge variant="count" size="count">
      {count}
    </Badge>
  );
}

/**
 * Sign out — a real form POST to the Worker's `/login/sign-out` (`paths.signOut` says why
 * not better-auth's own route), which answers with Set-Cookie and a 303 to /login. A `fetch`
 * could not apply the navigation, so this is one of the places the SPA still submits a form
 * rather than calling the API.
 *
 * `className` is the form's: the bar lays it out as a flex item, the drawer as a block.
 * `buttonClassName` adjusts the button, which the drawer keeps at 36px and 13px where every
 * other small button grows to the phone's 44px.
 */
function SignOutForm({ className, buttonClassName }: { className?: string; buttonClassName?: string }): ReactNode {
  return (
    <form method="post" action={paths.signOut} className={className}>
      <Button type="submit" variant="outline" size="sm" className={buttonClassName}>
        Sign out
      </Button>
    </form>
  );
}

/**
 * The narrow navigation: the same five entries as the bar's nav, in the `menu` Sheet, which
 * exists below the narrow breakpoint only. A Base UI Dialog underneath, so it traps focus and
 * closes on Escape — which the `:target` drawer of the server-rendered pages could not.
 *
 * The open flag starts from the gallery's `drawerOpen` transient, which is how the
 * `apps/drawerOpen` state draws it open; outside the gallery that is always false.
 *
 * The open flag is held here rather than left to the Dialog because a tapped entry has to
 * shut the drawer, and nothing else would do it: a drawer link to the route already shown
 * navigates nowhere, so the panel would sit over the page the owner just asked for. Across
 * routes it closes anyway — each page renders its own `Shell`, so the Dialog unmounts —
 * but that is the router's doing and not a promise this component should rest on.
 */
function Drawer({ active, username }: { active: string; username: string }): ReactNode {
  const [open, setOpen] = useState(usePreviewTransient().drawerOpen === true);
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      {/* The hamburger: absent above the narrow breakpoint, a 44px target at the bar's right
          edge below it, pulled 10px into the bar's gutter so its glyph lines up with the
          content beneath. */}
      <SheetTrigger
        aria-label="Menu"
        className={`hidden cursor-pointer bg-transparent p-0 text-foreground max-md:-mr-2.5 max-md:inline-flex max-md:size-control-touch max-md:items-center max-md:justify-center max-md:rounded-md ${FOCUS_RING}`}
      >
        <MenuIcon />
      </SheetTrigger>
      <SheetContent variant="menu">
        <div className="mb-1.5 flex h-header items-center justify-between border-b border-row-border pl-3">
          <span className={BRAND}>
            <BrandMark />
            <span>personal-mcps</span>
          </span>
          <SheetClose
            aria-label="Close menu"
            className={`inline-flex size-control-touch cursor-pointer items-center justify-center rounded-md bg-transparent p-0 text-foreground ${FOCUS_RING}`}
          >
            <CloseIcon />
          </SheetClose>
        </div>
        {NAV.map((item) => (
          <NavEntry
            key={item.key}
            item={item}
            active={active}
            className={MENU_LINK}
            onNavigate={() => setOpen(false)}
          />
        ))}
        {/* Pushed to the drawer's foot by the auto margin, under the rule that separates who
            you are from where you can go. */}
        <div className="mt-auto flex items-center justify-between gap-2.5 border-t border-row-border px-3 pt-2.5 pb-1">
          <span className={USER}>{username}</span>
          <SignOutForm buttonClassName="max-md:h-control max-md:text-sm" />
        </div>
      </SheetContent>
    </Sheet>
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
