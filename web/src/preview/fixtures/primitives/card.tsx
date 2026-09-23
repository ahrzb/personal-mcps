import type { ReactNode } from "react";
import type { PrimitiveState } from "../../seed";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Columns } from "./Columns";

/**
 * The Card bench: `.card` bare and padded, `.card-head/-title/-desc`, `.card--danger`,
 * `.db .card--pad` (`sm`) and `.auth-card` (`auth`), each beside `<Card>` in the same wrappers.
 *
 * Every sample sits in a full-width box on both sides, because a card on a page fills its
 * column, and the bench's cells would otherwise shrink it to its content.
 */
export const cardStates: Record<string, PrimitiveState> = {
  card: () => (
    <Columns
      legacy={
        <>
          <Full>
            <div className="card card--pad">
              <div className="card-head">
                <div>
                  <div className="card-title">Passkeys</div>
                  <div className="card-desc">Sign in with a device you already unlock.</div>
                </div>
                <button type="button" className="btn btn--outline btn--sm">
                  Add
                </button>
              </div>
              <p className="note">No passkeys yet.</p>
            </div>
          </Full>
          <Full>
            <section className="card card--pad card--danger">
              <h2 className="card-title">Delete agent</h2>
              <p className="card-desc">Its keys stop working at once and its grants are removed.</p>
            </section>
          </Full>
          <Full>
            <div className="card">
              <div className="card--pad" style={{ gap: "var(--space-1)" }}>
                <div className="card-title">Connected clients</div>
                <div className="card-desc">Outside software you approved to reach this hub.</div>
              </div>
              <p className="note" style={{ padding: "0 var(--space-10) var(--space-10)" }}>
                A bare card holds a table edge to edge.
              </p>
            </div>
          </Full>
        </>
      }
      next={
        <>
          <Full>
            <Card>
              <CardHeader>
                <div>
                  <CardTitle>Passkeys</CardTitle>
                  <CardDescription>Sign in with a device you already unlock.</CardDescription>
                </div>
                <button type="button" className="btn btn--outline btn--sm">
                  Add
                </button>
              </CardHeader>
              <p className="note">No passkeys yet.</p>
            </Card>
          </Full>
          <Full>
            <Card render={<section />} className="border-danger-border">
              <CardTitle render={<h2 />}>Delete agent</CardTitle>
              <CardDescription render={<p />}>Its keys stop working at once and its grants are removed.</CardDescription>
            </Card>
          </Full>
          <Full>
            <Card size="flush">
              <CardContent style={{ gap: "var(--space-1)" }}>
                <CardTitle>Connected clients</CardTitle>
                <CardDescription>Outside software you approved to reach this hub.</CardDescription>
              </CardContent>
              <p className="note" style={{ padding: "0 var(--space-10) var(--space-10)" }}>
                A bare card holds a table edge to edge.
              </p>
            </Card>
          </Full>
        </>
      }
    />
  ),

  // The details column's small panel: `.db` is its context on both sides, and the panel's
  // key/value lines are the column's own (`.kv`), unchanged.
  "card-sm": () => (
    <Columns
      legacy={
        <Full>
          <div className="db">
            <div className="card card--pad">
              <div className="eyebrow">Upstream</div>
              <div className="kv">
                <div className="kv-row">
                  <div className="kv-key">URL</div>
                  <div className="mono">https://mcp.example.com/sse</div>
                </div>
              </div>
            </div>
          </div>
        </Full>
      }
      next={
        <Full>
          <div className="db">
            <Card size="sm">
              <div className="eyebrow">Upstream</div>
              <div className="kv">
                <div className="kv-row">
                  <div className="kv-key">URL</div>
                  <div className="mono">https://mcp.example.com/sse</div>
                </div>
              </div>
            </Card>
          </div>
        </Full>
      }
    />
  ),

  // The approval page's card, inside the `.auth` frame on both sides (its `min-height: 100vh`
  // lifted, identically, so the bench is not a screen tall). At 390 the card goes chromeless
  // and its heading grows to 20px.
  "card-auth": () => (
    <Columns
      legacy={
        <div className="auth min-h-0 w-full">
          <div className="auth-card">
            <div>
              <h1 className="card-title">Approve this request?</h1>
              <p className="card-desc">An agent wants to run an approval-gated tool.</p>
            </div>
            <button type="button" className="btn btn--primary btn--block">
              Approve
            </button>
          </div>
        </div>
      }
      next={
        <div className="auth min-h-0 w-full">
          <Card size="auth">
            <div>
              <CardTitle render={<h1 />}>Approve this request?</CardTitle>
              <CardDescription render={<p />}>An agent wants to run an approval-gated tool.</CardDescription>
            </div>
            <button type="button" className="btn btn--primary btn--block">
              Approve
            </button>
          </Card>
        </div>
      }
    />
  ),
};

/** The column a card fills on a page. */
function Full({ children }: { children: ReactNode }): ReactNode {
  return <div className="w-full">{children}</div>;
}
