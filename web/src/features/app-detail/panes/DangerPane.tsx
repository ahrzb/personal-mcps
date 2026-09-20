/**
 * The Danger zone — archive, unarchive and delete, with the counts that say what each one
 * costs.
 *
 * A port of `pages/app-detail.tsx`'s `DangerPane` and `model.ts:appPane`'s danger arm. Two
 * of the three controls are LINKS to a `?confirm=` URL rather than buttons, which is the
 * page's rule and not decoration: the confirmation rides this pane's own URL, so it is
 * shareable and survives a reload, and `AppDetailPage` renders the dialog. Unarchive is the
 * one control here that destroys nothing, so it acts immediately and asks nothing.
 *
 * A WIDE pane: the listing is all of it, so there is no details column and no level 3.
 */

import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { ApiError } from "@/lib/http";
import { paths } from "@/lib/paths";
import { useOp } from "@/lib/queries";
import { grantsOn, plural } from "../derive";
import type { AppPaneProps } from "../derive";

export function DangerPane(props: AppPaneProps): ReactNode {
  const { slug, app, agents, tokens } = props;
  const unarchive = useOp<{ slug: string }>("app_unarchive", { app: slug });
  const granted = grantsOn(slug, agents);
  const base = paths.appPane(slug, "danger");
  const refusal = unarchive.error instanceof ApiError ? unarchive.error : null;

  return (
    <div className="listing listing--wide">
      <div className="lh">
        <span className="listing-title">Danger zone</span>
      </div>
      <div className="scroll">
        {refusal === null ? null : (
          <div className="alert alert--danger" role="alert">
            <div className="alert-text">{refusal.message}</div>
          </div>
        )}
        <div className="db">
          <section className="card card--pad">
            <h2 className="card-title">{app.archived ? "Unarchive" : `Archive ${slug}`}</h2>
            <p className="card-desc">
              {app.archived
                ? "It accepts connections again, with everything it kept while archived."
                : "It refuses connections and leaves the list — tokens, grants and history are kept."}
            </p>
            <div className="actions actions--start">
              {app.archived ? (
                <button
                  type="button"
                  className="btn btn--outline btn--sm"
                  disabled={unarchive.isPending}
                  onClick={() => unarchive.mutate({ slug })}
                >
                  Unarchive
                </button>
              ) : (
                <Link className="btn btn--outline btn--sm" to={base} search={{ confirm: "archive" }}>
                  Archive {slug}
                </Link>
              )}
            </div>
          </section>
          <section className="card card--pad card--danger">
            <h2 className="card-title">Delete {slug}</h2>
            <p className="card-desc">
              Revokes its {plural(tokens.length, "token")}, closes the live connection and removes every grant (
              {plural(granted.agents.length, "agent")}). This cannot be undone.
            </p>
            <div className="actions actions--start">
              <Link className="btn btn--danger-outline btn--sm" to={base} search={{ confirm: "delete" }}>
                Delete {slug}
              </Link>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
