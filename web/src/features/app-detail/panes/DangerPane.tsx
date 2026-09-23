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
import { Actions } from "@/chrome/Actions";
import { DetailsBody, Listing, ListingHead, ListingScroll, ListingTitle } from "@/chrome/Listing";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
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
    <Listing wide>
      <ListingHead>
        <ListingTitle render={<span />}>Danger zone</ListingTitle>
      </ListingHead>
      <ListingScroll>
        {refusal === null ? null : (
          <Alert variant="danger" role="alert">
            <AlertDescription>{refusal.message}</AlertDescription>
          </Alert>
        )}
        <DetailsBody>
          <Card size="sm" render={<section />}>
            <CardTitle render={<h2 />}>{app.archived ? "Unarchive" : `Archive ${slug}`}</CardTitle>
            <CardDescription render={<p />}>
              {app.archived
                ? "It accepts connections again, with everything it kept while archived."
                : "It refuses connections and leaves the list — tokens, grants and history are kept."}
            </CardDescription>
            <Actions start grow>
              {app.archived ? (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={unarchive.isPending}
                  onClick={() => unarchive.mutate({ slug })}
                >
                  Unarchive
                </Button>
              ) : (
                <Link
                  className={buttonVariants({ variant: "outline", size: "sm" })}
                  to={base}
                  search={{ confirm: "archive" }}
                >
                  Archive {slug}
                </Link>
              )}
            </Actions>
          </Card>
          <Card size="sm" render={<section />} className="border-danger-border">
            <CardTitle render={<h2 />}>Delete {slug}</CardTitle>
            <CardDescription render={<p />}>
              Revokes its {plural(tokens.length, "token")}, closes the live connection and removes every grant (
              {plural(granted.agents.length, "agent")}). This cannot be undone.
            </CardDescription>
            <Actions start grow>
              <Link
                className={buttonVariants({ variant: "danger-outline", size: "sm" })}
                to={base}
                search={{ confirm: "delete" }}
              >
                Delete {slug}
              </Link>
            </Actions>
          </Card>
        </DetailsBody>
      </ListingScroll>
    </Listing>
  );
}

