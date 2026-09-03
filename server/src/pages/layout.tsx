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
  /** Pending approval count — renders the red nav badge when above zero. Required, like
   *  `active`: every caller reads it off ShellProps, where it is a required number. */
  pendingApprovals: number;
  /** The page's own content. */
  children?: Child;
};

/**
 * The four asset URLs the shell LINKS rather than navigates to (`paths` names them too,
 * because web.ts serves them): spelled here as the document head's own contract, pinned
 * by §13. The icon is the 192 — iOS's `apple-touch-icon` wants a raster and prefers this
 * link over any manifest entry, and a tab favicon needs no more.
 */
const STYLESHEET = "/styles.css";
const MANIFEST = "/manifest.webmanifest";
const SERVICE_WORKER = "/sw.js";
const ICON = "/icon-192.png";

const NAV: { key: NavSection; label: string; href: string }[] = [
  { key: "apps", label: "Apps", href: paths.apps },
  // §13's fifth slot (2026-09-03): the narrow nav is already a horizontal scroller with
  // its scrollbar hidden, so five fit without an overflow menu.
  { key: "agents", label: "Agents", href: paths.agents },
  { key: "audit", label: "Audit", href: paths.audit },
  { key: "approvals", label: "Approvals", href: paths.approvals },
  { key: "settings", label: "Settings", href: paths.settings },
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

/**
 * One entry of a paned page's navigation — the rail's and the pill row's, because §13
 * makes them the same routes in the same order and only the label and the marker differ.
 * `short` is what the pill draws (Settings shortens exactly one label, to `Clients`).
 */
export type PaneEntry = {
  href: string;
  label: string;
  short: string;
  marker: PaneMarker;
  current: boolean;
  /** The rail heading this entry sits under — `null` is §13's ungrouped tail. It rides
   *  the entry rather than a parallel table because the shell owns the grouping rule and
   *  a page that kept the heading elsewhere would have to be indexed in lockstep. */
  group: string | null;
};

/**
 * An entry's at-a-glance marker (§13's rail table). `null` is the table's `none` cell —
 * no marker element at all, which is what makes its absence readable. `dot` is the one
 * marker that is a STATUS rather than a count: the coloured dot is decoration, and `text`
 * is the state said in words, because a colour alone is a state only a sighted reader has.
 * `dim` is §13's "renders dimmed" — the whole entry recedes, label included
 * (AppDetail.dc.html), and it stays a link.
 */
export type PaneMarker = { text: string; dot?: "on" | "off"; dim?: boolean } | null;

/** A rail group: a heading (§13's `Sign-in` / `Access` / `App`) and its entries, or a
 *  headless run for the ungrouped tail the app page's Danger zone sits in. */
export type PaneGroup = { heading: string | null; entries: PaneEntry[] };

/**
 * The rail's grouping, once, for both paned pages: entries fall under their own `group`,
 * and the headings come out in the order the entries first name them — which is §13's
 * table order, so neither page states an order of its own that could drift from the order
 * its panes are actually listed in.
 */
export function paneGroups(entries: PaneEntry[]): PaneGroup[] {
  const groups: PaneGroup[] = [];
  for (const entry of entries) {
    const group = groups.find((made) => made.heading === entry.group);
    if (group === undefined) groups.push({ heading: entry.group, entries: [entry] });
    else group.entries.push(entry);
  }
  return groups;
}

/**
 * §13's "Panes behind a rail", as the one shell both paned pages render. TWO navigations
 * on every response at every width — the rail and the pill row, the second hidden by CSS
 * above the breakpoint rather than left out of the document — each with its own accessible
 * name, because two navigations on one page that share their destinations are otherwise
 * indistinguishable to anyone listing the page's landmarks.
 *
 * The active entry stays an ANCHOR carrying `aria-current="page"`: a page that dropped it
 * to a <div> would leave the rail with one fewer thing to tab to and no way to say which
 * pane you are on.
 */
export const PaneRail: FC<{ label: string; groups: PaneGroup[] }> = ({ label, groups }) => (
  <nav class="rail" aria-label={label}>
    {groups.map((group) => (
      /* The headless run is the app page's Danger zone: no heading, but a rule above it,
         which is how the board separates it from the groups without a third heading. */
      <div class={group.heading === null ? "rail-group rail-group--tail" : "rail-group"}>
        {group.heading === null ? null : <div class="rail-heading">{group.heading}</div>}
        {group.entries.map((entry) => (
          <a
            class={entry.marker?.dim === true ? "rail-link rail-link--dim" : "rail-link"}
            href={entry.href}
            aria-current={entry.current ? "page" : undefined}
          >
            <span>{entry.label}</span>
            {entry.marker === null ? null : (
              <span class="rail-marker">
                {entry.marker.dot === undefined ? (
                  entry.marker.text
                ) : (
                  <>
                    <span class={`rail-dot rail-dot--${entry.marker.dot}`} aria-hidden="true"></span>
                    <span class="sr-only">{entry.marker.text}</span>
                  </>
                )}
              </span>
            )}
          </a>
        ))}
      </div>
    ))}
  </nav>
);

/** The same panes below the breakpoint: a horizontally scrolling pill row under the page
 *  title — label only, no markers (§13's Mobile rule). */
export const PanePills: FC<{ label: string; entries: PaneEntry[] }> = ({ label, entries }) => (
  <nav class="pill-row" aria-label={label}>
    {entries.map((entry) => (
      <a class="pill" href={entry.href} aria-current={entry.current ? "page" : undefined}>
        <span>{entry.short}</span>
      </a>
    ))}
  </nav>
);

/**
 * §13's confirm step, as the one shell both paned pages render: a server-rendered
 * `<dialog open>` reached by a URL, so every confirmation works with scripting off and is
 * reachable from a fixture and a bookmark alike. The caller supplies only what differs —
 * the title, the sentence and the form that acts — because everything else about a
 * confirmation is the same question asked about a different row.
 *
 * `id` is the caller's, so a page can carry its own (`confirm-settings` / `confirm-app`)
 * and the script below re-opens THAT dialog and no other.
 */
export const ConfirmShell: FC<{ id: string; title: string; text: string; children?: Child }> = ({
  id,
  title,
  text,
  children,
}) => (
  <>
    <dialog id={id} open aria-labelledby={`${id}-title`}>
      <div class="dialog-body">
        <div>
          <div class="dialog-title" id={`${id}-title`}>
            {title}
          </div>
          <div class="dialog-text">{text}</div>
        </div>
        {children}
      </div>
    </dialog>
    {/* Progressive enhancement only: the `open` attribute above is the whole story with
        scripting off. Where JS runs, re-open as a real modal so it gets centered and
        styles.css's `dialog::backdrop` — otherwise unreachable from a plain `open`
        attribute, which never produces a backdrop — actually applies. */}
    <script
      dangerouslySetInnerHTML={{
        __html: `var d=document.getElementById(${JSON.stringify(id)});if(d&&d.open){d.removeAttribute("open");d.showModal();}`,
      }}
    />
  </>
);

/**
 * A freshly minted key, in the one response that will ever hold it (§4/§15) — the add-app
 * flow's reveal and the app page's rotation reveal, which §13 makes the same one. The Copy
 * button is enhancement: the value is selectable text without it, and the script only
 * saves a drag.
 *
 * `children` is where a caller adds what is true of ITS reveal alone (the rotation
 * sentence), under the warning both share.
 */
export const TokenReveal: FC<{ token: string; children?: Child }> = ({ token, children }) => (
  <>
    <div class="token-reveal">
      <div class="token-value" id="token-value">
        {token}
      </div>
      <button type="button" class="btn btn--outline" id="copy-token">
        Copy
      </button>
    </div>
    <div class="alert alert--warning">This token is shown only once. Store it in your bot's secret store.</div>
    {children}
    <script
      dangerouslySetInnerHTML={{
        __html: `(function(){var b=document.getElementById("copy-token");var v=document.getElementById("token-value");if(!b||!v)return;b.addEventListener("click",function(){navigator.clipboard.writeText(v.textContent||"");});})();`,
      }}
    />
  </>
);

/**
 * The stitching behind `OtpBoxes` below: static text, no interpolated data, moved
 * verbatim off /login (G30 — the settings card had six named boxes and none of this, so a
 * correctly typed code posted `code=""` and could never verify). Auto-advance,
 * backspace-back and paste all funnel into the one hidden field better-auth's `code`
 * reads, because the form posts straight past web.ts to better-auth — no stitching
 * happens server-side.
 */
const OTP_SCRIPT = `(function(){
  var form = document.querySelector('[data-otp-form]');
  if (!form) return;
  var boxes = Array.prototype.slice.call(form.querySelectorAll('[data-otp] input'));
  var hidden = form.querySelector('[data-otp-value]');
  function sync() { hidden.value = boxes.map(function (b) { return b.value; }).join(''); }
  boxes.forEach(function (box, i) {
    box.addEventListener('input', function () {
      box.value = box.value.replace(/[^0-9]/g, '').slice(-1);
      sync();
      if (box.value && boxes[i + 1]) boxes[i + 1].focus();
    });
    box.addEventListener('keydown', function (e) {
      if (e.key === 'Backspace' && !box.value && boxes[i - 1]) boxes[i - 1].focus();
    });
    box.addEventListener('paste', function (e) {
      var text = (e.clipboardData || window.clipboardData).getData('text').replace(/[^0-9]/g, '');
      if (!text) return;
      e.preventDefault();
      for (var j = 0; j < boxes.length; j++) boxes[j].value = text[j] || '';
      sync();
      (boxes[Math.min(text.length, boxes.length) - 1] || boxes[0]).focus();
    });
  });
})();`;

/**
 * The six-box TOTP code entry both credential targets that check one render — /login's
 * challenge card and /settings's enrolment card (§13). One definition rather than two
 * copies: a second copy is exactly how G30 happened. Owns the hidden `[data-otp-value]`
 * input better-auth's `code` field reads, the six unnamed `[data-otp]` boxes (only the
 * hidden field is ever submitted) and the one stitching script above. `data-otp-form`
 * stays on each caller's own `<form>` — the script looks for it first, and the two forms
 * differ in `action` and hidden fields, which is the caller's business.
 *
 * `invalid` sets `aria-invalid` on the boxes; each caller reads its own refusal source
 * (`step.error` at /login, `enrollment.error` at /settings) and passes the one bit this
 * component needs.
 */
export const OtpBoxes: FC<{ invalid: boolean }> = ({ invalid }) => (
  <>
    <input type="hidden" name="code" data-otp-value />
    <div class="otp" data-otp>
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <input
          key={i}
          type="text"
          inputmode="numeric"
          pattern="[0-9]*"
          maxlength={1}
          autocomplete="one-time-code"
          aria-label={`Digit ${i + 1}`}
          aria-invalid={invalid ? "true" : undefined}
          autofocus={i === 0 ? true : undefined}
        />
      ))}
    </div>
    <script dangerouslySetInnerHTML={{ __html: OTP_SCRIPT }} />
  </>
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
        <link rel="icon" href={ICON} />
        <link rel="apple-touch-icon" href={ICON} />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="anonymous" />
        <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&display=swap" />
      </head>
      <body>
        <header class="app-header">
          <div class="app-header-main">
            <a class="brand" href={paths.apps}>
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
