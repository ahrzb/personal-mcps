# Typing in the audit search box tears the whole page down

- **Found:** 2026-09-21, by the owner, using `/audit` on the live hub minutes after it shipped
  (deploy `a2d71e7b`)
- **Symptom:** "search has a bug, when I type it does full page re-render which completely
  fucks things up" — and, in the same message, "the x5 runs look weird, how can I look at all
  of them? or look at the bodies?"
- **Impact:** prod, from the first ship of the explorer (`9bd3d264`) until the fix. Every pause
  in typing replaced the page with its loading skeleton and gave it back a moment later: the
  search box lost focus and its caret, "Load more" and expanded facet groups reset, the scroll
  position jumped. Search was unusable past one word. The second half is a design gap rather
  than a defect: a ×N run row opened only its newest member's record, so the other N−1 rows —
  and their bodies — could not be reached from the page at all.
- **Class:** boundary-actor (the network is the actor no fixture plays) / spec-gap (the run row)

## Root cause

`AuditPage` reads the window with `useQuery(auditWindowQuery(api, debouncedQ))` and renders
`<LoadingExplorer>` whenever that query `isPending`. The search text is part of the query KEY —
correctly, `text` is the one filter the server applies. But a new key has no data, so each
settled keystroke made the query pending again, and the pending branch does not render
`<Explorer>` at all: the component that owns the `<input>` was unmounted and a skeleton drawn in
its place, then remounted when the read answered. Nothing kept the previous rows on screen
(`placeholderData`), and the input's value lived only in the URL, so the remount was the only
thing holding the text.

The run row: `mergeEvents` collapses consecutive rows with one signature into a row carrying
`runs`, and `EventsView` wires the whole row's click to `onOpenRecord(head)`. The members are in
`row.group` and nothing draws them. The signature also ignored the arguments, so five calls with
five different queries collapsed under the newest one's preview — which is why the row "looks
weird": it claims one thing happened five times and shows one call's arguments.

## Why the tests missed it

The preview gallery — the only place the page was ever rendered before ship — mounts each state
over a query cache that is seeded, permanently fresh, and backed by an API client that THROWS on
any read the seed did not answer. A search that refetches cannot happen there: typing changes
the key, the unseeded read rejects, and the state was never exercised because no seed types.
The closest check was the web agent's own keyboard walk (Tab → Enter opens a record, Escape
returns focus), which never touched the search box. `audit-derive.test.ts` pins the pure module
and cannot see a component unmount. The live smoke reads `/api/hub/audit/window` and the shell
and drives no browser. My own review read `AuditPage.tsx`'s pending branch and the query key in
the same sitting and did not connect them; I checked the paging seam instead.

The run row was reviewed as drawn: the brief, §13 and the boards all said "collapse to ×N runs"
and none said what a reader does next. The demo had the same hole and the owner's session with
it never clicked a run.

## Fix

Spec `9dbdcdf`, boards `8833314`, tests `3c044eb`, code `a8b3299` (2026-09-21).

- The window read keeps its previous answer while a new text loads (`keepPreviousData`) and
  the page branches on "no data at all" rather than `isPending`, so the explorer and its input
  stay mounted; the box says "Searching…" and the rows dim.
- The box owns its text and its debounce and emits once per pause; the URL and the read both
  take the settled text. The FIRST fix wrote the URL on every keystroke and re-seeded the box
  from any `?q=` that differed from the last thing typed — which its own lagging echo does —
  so it could still lose a character under load, and every keystroke re-derived every loaded
  row. Caught in review, not by the walk, which at that point only typed slowly.
- Found by the new walk on the way: the client re-applied `q` over the server's answer. It
  holds only `argsHead`, so it dropped rows the server matched inside a body, and
  mid-keystroke it narrowed the PREVIOUS answer by a needle it was never read for — the list
  flashed "Nothing matches". The client filter is deleted.
- A run is the same call repeated (`argsHead` joins the signature) and the run row is a
  disclosure: every member listed, each opening its own record.
- Found reviewing the fix's own screenshot: a chain row printed its head's time (its OLDEST
  event) at the position of its newest, so a newest-first list read shuffled. `whenOf`.

- The fix regressed the phone before it shipped: the arguments line (nowrap, in a table cell,
  in a content-sized flex pane) made five phone states 541–772 px wide. The agent's overflow
  check SAW it and printed it; its output went through `grep -v` on a note every narrow state
  carries, which discarded every narrow failure. Caught by looking at the 375 shot beside the
  board. The check now exits non-zero and asserts each saved PNG is the viewport's width —
  the ship rule ("never pipe a gating command") holds for an agent's checks too.

Enacted from the candidates below: the late-answering gallery seed (`respond`), and the walk
— `pnpm check:audit-search` — including a burst under 6x CPU throttle.

## Candidate countermeasures (recorded, not enacted)

- A gallery seed whose API client ANSWERS LATE instead of throwing (a responder, not a cache),
  so a state that refetches can be shown and walked at all. The `hanging` channel added for the
  two loading states is half of this already.
- One Playwright walk per page for its one refetching control: type with pauses longer than the
  debounce and assert the input is the same DOM node, still focused, value intact, and that no
  skeleton was ever drawn. `web/scripts/drawer-check.mts` is the existing shape for such a walk.
- A review rule for any `useQuery` whose key holds user-typed text: what renders while the NEW
  key is pending? If the answer is "a different subtree", it is this bug.
- For every collapsed or merged row a board draws, the board must also draw its expanded form —
  "how do I see what is inside" is part of the row's contract, not a follow-up.

## Misdiagnoses along the way

none — the pending branch and the keyed read are a dozen lines apart and the symptom names the
mechanism.
