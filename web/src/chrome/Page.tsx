import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * The page frames every signed-in page draws inside `Shell` (legacy.css's `.page--*`,
 * `.page-head`, `.title-row`, `.crumb`, `.section`, `.paned.paned--framed`, `.pane`): the
 * `<main>` in one of three shapes, the head over it, its titled sections, and the workspace's
 * one framed box.
 *
 * NARROW LEVELS. A workspace page with levels passes `level`, which `Page` writes as
 * `data-level` on the `<main>`. Below 1024px that attribute is the whole switch: every frame
 * here, in `chrome/Panes`, `chrome/Listing` and `chrome/Kv` reads it through an arbitrary
 * variant on the attribute (`[[data-level='2']_&]:max-lg:…`), showing one level at a time —
 * the rail at 1, the listing at 2, the details at 3 — and dropping the title line the level
 * header now carries. An attribute rather than a React context, so a level survives into
 * markup a frame never rendered (`.md` prose, a family's own rows).
 *
 * `--gutter` and `--pad-top` are declared on the `<main>` for anything that must bleed through
 * the page's padding — the phone's level header negates both (`chrome/Panes`).
 */
export function Page({
  shape,
  level,
  className,
  ...props
}: ComponentProps<"main"> & {
  /** What the page holds decides its cap: `document` 760px (prose, forms, one column of
   *  cards), `table` 1280px (a list the eye scans row by row), `workspace` none (a rail and
   *  panes, whose panes are capped instead). */
  shape: "document" | "table" | "workspace";
  /** The narrow level this render is (1 rail, 2 listing, 3 details); omitted on a page that
   *  has none. Read by CSS alone. */
  level?: 1 | 2 | 3;
}): ReactNode {
  return (
    <main
      data-shape={shape}
      data-level={level}
      className={cn(
        "mx-auto flex w-full flex-col gap-6 px-(--gutter) pt-(--pad-top) pb-12 [--gutter:--spacing(4)] [--pad-top:--spacing(8)] lg:[--gutter:--spacing(6)] max-md:gap-4 max-md:pb-4 max-md:[--pad-top:--spacing(4)]",
        SHAPE[shape],
        className,
      )}
      {...props}
    />
  );
}

const SHAPE = {
  document: "max-w-page-narrow",
  table: "max-w-page",
  workspace: "max-w-none",
} as const;

/**
 * The title block on the left and one thing on the right (actions, totals), top-aligned; on a
 * phone the right-hand thing wraps under the title. A primary action there spans the phone's
 * width: give it `max-md:flex-[1_1_100%]`. Gone below 1024px at levels 2 and 3, whose level
 * header says everything the head would.
 */
export function PageHead({ className, ...props }: ComponentProps<"div">): ReactNode {
  return (
    <div
      data-slot="page-head"
      className={cn(
        "flex items-start justify-between gap-4 max-md:flex-wrap max-md:gap-3 [[data-level='2']_&]:max-lg:hidden [[data-level='3']_&]:max-lg:hidden",
        className,
      )}
      {...props}
    />
  );
}

/** The page's `<h1>`: 24px, 20px on a phone, and gone below 1024px on a page with levels. */
export function PageTitle({ className, render, ...props }: useRender.ComponentProps<"h1">): ReactNode {
  return useRender({
    defaultTagName: "h1",
    render,
    props: mergeProps<"h1">(
      {
        className: cn(
          "text-2xl leading-[1.2] font-semibold max-md:text-title-narrow [[data-level]_&]:max-lg:hidden",
          className,
        ),
      },
      props,
    ),
    state: { slot: "page-title" },
  });
}

/** The muted line under (or beside) the title. A `<p>`; `render={<span />}` inside a
 *  `TitleRow`. */
export function PageSubtitle({ className, render, ...props }: useRender.ComponentProps<"p">): ReactNode {
  return useRender({
    defaultTagName: "p",
    render,
    props: mergeProps<"p">({ className: cn("mt-1 text-base text-muted-foreground", className) }, props),
    state: { slot: "page-subtitle" },
  });
}

/**
 * A title with what belongs to it on the same line — a crumb before it, badges or a subtitle
 * after — wrapping when it runs out of room. `split` makes it the head's full width, so a
 * `TitleRowEnd` inside it goes to the far edge.
 */
export function TitleRow({ split = false, className, ...props }: ComponentProps<"div"> & { split?: boolean }): ReactNode {
  return <div data-slot="title-row" className={cn("flex flex-wrap items-center gap-2.5", split && "w-full", className)} {...props} />;
}

/**
 * The control at the end of a `split` title row; below 1024px on a page with levels, a line
 * of its own under the rest. A `<div>` around the control, or the control itself with
 * `render` (`render={<Link … />}`, `render={<Label … />}`), where a box around it would add a
 * line box of its own.
 */
export function TitleRowEnd({ className, render, ...props }: useRender.ComponentProps<"div">): ReactNode {
  return useRender({
    defaultTagName: "div",
    render,
    props: mergeProps<"div">(
      { className: cn("ml-auto [[data-level]_&]:max-lg:ml-0 [[data-level]_&]:max-lg:basis-full", className) },
      props,
    ),
    state: { slot: "title-row-end" },
  });
}

/**
 * The way up, folded into the title line: small and receded, darkening and underlining under
 * the pointer like every link. An `<a>`; `render={<Link to={…} />}` for a client route.
 * Gone below 1024px on a page with levels.
 */
export function Crumb({ className, render, ...props }: useRender.ComponentProps<"a">): ReactNode {
  return useRender({
    defaultTagName: "a",
    render,
    props: mergeProps<"a">(
      {
        className: cn(
          "text-sm text-muted-foreground no-underline hover:text-foreground hover:underline [[data-level]_&]:max-lg:hidden",
          className,
        ),
      },
      props,
    ),
    state: { slot: "crumb" },
  });
}

/** The `›` after a crumb. */
export function CrumbSep(): ReactNode {
  return (
    <span data-slot="crumb-sep" className="text-ring [[data-level]_&]:max-lg:hidden" aria-hidden="true">
      ›
    </span>
  );
}

/** `.section`: a titled run of a page's content — a `SectionTitle` over its cards or table,
 *  12px apart. A `<section>`. */
export function Section({ className, ...props }: ComponentProps<"section">): ReactNode {
  return <section data-slot="section" className={cn("flex flex-col gap-3", className)} {...props} />;
}

/** `.section-title`: a `Section`'s `<h2>`, 16px semibold. */
export function SectionTitle({ className, ...props }: ComponentProps<"h2">): ReactNode {
  return <h2 data-slot="section-title" className={cn("text-lg font-semibold", className)} {...props} />;
}

/**
 * The workspace's one framed box: the rail (`chrome/Panes`' `PaneRail`) and one `Pane` side by
 * side, at a fixed height so the pane's own regions scroll inside it rather than growing the
 * page. Below 1024px the box goes — the screen is the frame — and on a page with levels its
 * children stop laying out side by side, since only one of them shows.
 */
export function Workspace({ className, ...props }: ComponentProps<"div">): ReactNode {
  return (
    <div
      data-slot="workspace"
      className={cn(
        "flex h-[max(560px,calc(100vh-220px))] items-stretch overflow-hidden rounded-lg border bg-background shadow-xs max-lg:h-auto max-lg:overflow-visible max-lg:rounded-none max-lg:border-0 max-lg:bg-transparent max-lg:shadow-none [[data-level]_&]:max-lg:block",
        className,
      )}
      {...props}
    />
  );
}

/**
 * The region beside the rail. A STACK of cards by default (/settings, and the app page's
 * panes before they split): the frame's scrolling region, padded as the page was. `split`
 * is the one pane that is two columns side by side — a `Listing` and its `Details`
 * (`chrome/Listing`) — which go back to one column below 1024px. `narrow` caps a form's pane
 * at 640px, above 768px only.
 */
export function Pane({
  split = false,
  narrow = false,
  className,
  ...props
}: ComponentProps<"div"> & { split?: boolean; narrow?: boolean }): ReactNode {
  return (
    <div
      data-slot="pane"
      className={cn(
        "flex min-h-0 min-w-0 flex-auto flex-col gap-4",
        split
          ? "flex-row items-stretch gap-0 overflow-hidden p-0 max-lg:flex-col max-lg:overflow-visible"
          : "overflow-auto p-6 max-lg:overflow-visible max-lg:p-0 [[data-level='1']_&]:max-lg:hidden [[data-level='3']_&]:max-lg:hidden [[data-level='2']_&]:max-lg:block",
        narrow && "max-w-pane max-md:max-w-none",
        className,
      )}
      {...props}
    />
  );
}
