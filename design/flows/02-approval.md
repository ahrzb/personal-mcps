# Tool-call approval

From a gated tool call to an armed retry. Rules: §7 (the `-32003` gate, CAS
claim, MRTR), §13 (`/approvals`, Web Push).

## Wireframe map

| Journey moment | Artboard |
|---|---|
| Pending list + history | `Approvals` / `MobileApprovals` |
| Detail, pending decision | `ApprovalDetail` / `MobileApprovalDetail` |
| Approved, awaiting the retry | `ApprovalStates · APPROVED — AWAITING RETRY` |
| Expired | `ApprovalStates · EXPIRED` |
| Rejected | history rows in `Approvals` (rejected badge) |
| Nothing pending / no history | `EmptyStates · Approvals — no pending`, `· Approvals — no history` |

## The journey

1. A caller whose only path to a tool is an approval-mode grant gets JSON-RPC
   error `-32003` carrying `{approvalId, approvalUrl, expiresAt}`; the URL is in
   the message text too, so it is actionable even in a dumb client (§7).
   Retries while pending return the **same** id and link — the UI can treat the
   detail URL as stable.
2. If this browser enabled notifications (a per-browser "Enable notifications"
   control on `/approvals`), a Web Push arrives naming the app and tool —
   **never arguments** — and opens `/approvals/<id>` on tap. Delivery is
   best-effort; the dashboard is the source of truth (§13).
3. `/approvals` shows pending requests first — agent, app, tool,
   **redacted** arguments, requested time, approve/reject buttons (CSRF-tokened
   POSTs) — with decision history below. `/approvals/<id>` is the detail page
   the error links to; only the namespace owner can open it (§13).
4. The owner approves or rejects. Copy matters here (see `ApprovalDetail`):
   **approving arms a retry, it does not run the call**. The caller must repeat
   the identical call — same canonical post-redaction arguments — and that
   retry executes exactly once (§7's compare-and-set claim).
5. After the fact: an approval is single-use, args-bound, and expires one hour
   after creation. A rejected or expired approval means the caller's next retry
   opens a **fresh** pending request and link. One approval covers a whole
   multi-round-trip exchange — elicitation legs ride the original approval and
   never display or persist the elicited values (§7 MRTR).

## States & edges

- History rows show every transition; expired items decide themselves.
- Empty pending list is the steady state, not an error.
