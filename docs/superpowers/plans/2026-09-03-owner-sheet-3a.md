# Owner decisions — the open questions, with context

> **Resolved 2026-09-03.** The owner's ruling on this sheet: "the questions you were
> asking were just too basic, you … can resolve those". So every question below was
> decided by the orchestrator along its recommendation — with three changes on reading the
> actual code: #4 keeps "1 arg" (the spec is amended, not the page), #9 keeps the Roles
> count (it is configuration, not a listing), and #14 is not a question because the
> roadmap already schedules the push-library swap as step 14. Each answer is written into
> the spec or the decision log with the date, and shipped: steps 5–8's ledger rows name
> the commits. The sheet stays as the record of what each question was.
>
> Every entry says what the thing is, where you see it on the hub, what happened before,
> what each answer changes, and the recommendation that was taken, with links to the spec
> sentence and the code line it turned on.

## A. Needed before the next batch of fixes (roadmap step 8)

### 1. Reserve the word `agents` as a URL now (G28)

**What it is.** Every user's MCP endpoint lives at `https://<hub>/<username>/mcp`, so a
username is also a top-level URL. That is why some words are reserved and cannot be
usernames: `login`, `apps`, `audit`, `settings` and so on — the list is derived from the
route table so the two can never drift ([02-concepts.md:6-16](../../specs/overview/02-concepts.md:6)).

**Where you see it.** Nowhere yet. The agents pages (`/agents`, a list of your agents and
a page per agent with a grant editor) are roadmap step 9 and do not exist.

**What happens today.** `agents` is *not* reserved. Decision 30 said so explicitly when
the pages were specced ahead of code ([18-decision-log.md:239](../../specs/decisions/18-decision-log.md:239)).
If a user named `agents` is ever created first, `https://<hub>/agents` belongs to that
user forever and the page can never be mounted there.

**The question.** Reserve it now, before the page exists, or wait for step 9.

**Options.**
- Reserve now: one row in the route table plus a stub that answers 404 until step 9
  builds the page. A username `agents` becomes impossible from this deploy on. Cost: a
  few lines, no visible change.
- Wait: nothing changes until step 9 reserves it with the real page. Risk: only that
  someone creates a user called `agents` in between (you create users yourself with the
  script, so the risk is small but permanent if it happens).

**Recommendation: reserve now.** The cost is nil and the downside of waiting is permanent.

**Answer:**

### 2. The Tokens page names a page that does not exist (G12)

**What it is.** Settings → Tokens lists every key in your namespace. Its intro line reads
"Every key issued in this namespace. Issue new keys from an app or agent page."
([settings.tsx:758](../../../server/src/pages/settings.tsx:758)).

**What happens today.** There is no agent page (see question 1), so half of that sentence
points at nothing. The spec already acknowledges it: agent keys are issued with
`pmcp token issue` until the agents page lands ([13-web-surface.md:123-126](../../specs/web-and-oauth/13-web-surface.md:123)).

**Options.**
- Change the sentence now to something true: "Issue new keys from an app page, or with
  `pmcp token issue` for an agent." Then change it back to "or agent page" in step 9.
- Leave it until step 9 (weeks of a sentence pointing at nothing).

**Recommendation: change it now.** One string, two edits over time, no wrong copy in
between.

**Answer:**

### 3. The consent screen sends you to the wrong place to create an agent (G8)

**What it is.** When an external client (an MCP client authorising through the hub's
OAuth) asks for access, you land on `/oauth/consent` and pick which agent it acts as. With
no agents, the screen shows "No agents yet — Create one at /apps before connecting a
client" and disables the submit ([consent.tsx:43-52](../../../server/src/pages/consent.tsx:43)).

**What happens today.** `/apps` has no way to create an agent. Agents are created with
`pmcp agent create`. The spec itself pins `/apps` as the place
([19-inbound-oauth.md:295-301](../../specs/web-and-oauth/19-inbound-oauth.md:295)), so the
spec is wrong, not just the page.

**Options.**
- Amend the spec to name the Agents page as the destination, and until that page exists,
  have the screen say "Create one with `pmcp agent create` before connecting a client."
- Leave both as they are until step 9 builds the agents page.

**Recommendation: amend the spec and use the interim sentence now.** Same reasoning as
question 2.

**Answer:**

### 4. "1 arg" or "1 args" on the app page's Tools pane (32a)

**What it is.** `/apps/<slug>` → Tools lists each tool as name, first line of its
description, and an argument count.

**What happens today.** The page prints "no args", "1 arg", "2 args"
([app-detail.tsx:235-238](../../../server/src/pages/app-detail.tsx:235)). The spec's
sentence writes the pattern as "`N args` / `no args`"
([13-web-surface.md:242](../../specs/web-and-oauth/13-web-surface.md:242)), which read
literally gives "1 args". The design board draws "1 arg". The tests assert only "no args"
and "3 args", so both readings pass.

**Options.**
- Keep "1 arg" and amend the spec sentence to say the count is singular at one. No code
  change.
- Change the page to "1 args" to match the spec literally.

**Recommendation: keep "1 arg", amend the spec.** The earlier version of this sheet said
the opposite; on reading the actual strings, "1 args" is a typo nobody would ship.

**Answer:**

### 5. Two more columns in `pmcp connections` (G29)

**What it is.** `pmcp connections` lists the external clients you have authorised through
the hub's OAuth. Today it prints CONNECTION, CLIENT, AGENT, CREATED, LAST USED, STATUS
([main.ts:1663](../../../cli/src/main.ts:1663)).

**What happens today.** The server already returns two more facts per connection that the
table drops: the client's redirect origin (the site or app the client actually lives at)
and whether the client registered itself dynamically or was pre-registered. Both are the
first things you would want when a row looks unfamiliar.

**Options.**
- Add ORIGIN and SELF-REGISTERED columns.
- Leave the table as is.

**Recommendation: add both.** Zero server work; the data is already in the response.

**Answer:**

### 6. Does the Tokens count in the settings rail follow the filter (G26 i)

**What it is.** Settings has a left rail with a count beside each entry: Passkeys 0,
Sessions 5, Tokens 4. The Tokens pane also has an All · Agents · Apps filter.

**What happens today.** A test pins that when you filter to Agents, the rail's Tokens
count shrinks with the table ([web-pages.test.ts:4217](../../../server/test/worker/web-pages.test.ts:4217)).
That behaviour was never reviewed as a title first; it was written straight into a passing
test, which is the process lapse question 15 is about.

**Options.**
- The rail always counts all keys. The rail names the pane, not the current view, and
  every other rail count works that way. The test gets retitled to say so.
- The rail count follows the filter, and the rail link carries the filter too, so the
  count and the link agree. Keeps the current test.

**Recommendation: always count all keys.** One rule for every rail entry.

**Answer:**

## B. Copy and behaviour on the app page (roadmap steps 9–12)

### 7. Does a tunneled app that has never connected dim Tools (32b)

**What it is.** On `/apps/<slug>` the rail entries Tools, Prompts, Resources show a count,
or a dimmed "—" when the app advertises none of that family. For a tunneled app the hub
learns the families when the app connects.

**What happens today.** The spec says an app "that has never connected lists none"
([13-web-surface.md:219-224](../../specs/web-and-oauth/13-web-surface.md:219)), which can
be read as "dims all three" or "dims prompts and resources, Tools shows 0". The tests pin
only that Prompts and Resources dim.

**Recommendation: dim all three, with "never connected" as the reason on the pane.** The
hub has no catalog to count; "0 tools" would be a claim it cannot make.

**Answer:**

### 8. The literal `<hub>` in the Resources pane's sentence (32c)

**What it is.** The Resources pane prints a rule: "Resources are served on the scoped
endpoint only — `https://<hub>/<user>/mcp/<slug>`" ([13-web-surface.md:274-276](../../specs/web-and-oauth/13-web-surface.md:274)).

**What happens today.** The page prints the placeholder `<hub>` literally
([app-detail.tsx:518](../../../server/src/pages/app-detail.tsx:518)), as the design board
draws it.

**Recommendation: print the real origin and your username**, so the endpoint is copyable.
Printing a URL you cannot paste defeats the point of printing it.

**Answer:**

### 9. When a proxied app's live listing fails, does the Roles count go blank too (32d)

**What it is.** A proxied app's Tools/Prompts/Resources counts come from a live fetch of
the upstream. When that fetch fails, the spec blanks those counts rather than showing a
stale or partial number ([model.ts:1849](../../../server/src/pages/model.ts:1849)).

**The question.** The Roles count is not from the listing; it is your own configuration.
Blank it as well for one uniform rule, or keep it since it is known.

**Recommendation: keep the Roles count.** It is a fact the hub does know; blanking it
would misreport. (The earlier sheet said blank it for uniformity; I no longer think
uniformity beats accuracy here.)

**Answer:**

### 10. Mark the active mobile pill as current (32e)

**What it is.** Below the mobile breakpoint the settings and app-page rails become a row
of pills. The spec pins that the active *rail* entry carries `aria-current="page"`
([13-web-surface.md:353](../../specs/web-and-oauth/13-web-surface.md:353)) and says
nothing about the pills.

**What happens today.** The active pill already carries it
([layout.tsx:156](../../../server/src/pages/layout.tsx:156)); it is just not pinned by the
spec or a test.

**Recommendation: pin it** (one spec sentence, one assertion). No behaviour change.

**Answer:**

### 11. What an unreachable proxied app's Tools pane says (37a)

**What it is.** A proxied app whose upstream cannot be reached shows a failure state in
place of its tool list.

**What happens today.** The page says "Token refresh failed — calls return errors until
you reconnect." ([app-detail.tsx:209](../../../server/src/pages/app-detail.tsx:209)) for
both failure kinds, because the spec quotes that one sentence for both
([13-web-surface.md:239](../../specs/web-and-oauth/13-web-surface.md:239)). For an app
configured with static headers there is no token to refresh and nothing to reconnect, so
the sentence is false there.

**Recommendation:** for the static-headers case say "Couldn't reach `<endpoint>` — the
last catalog refresh failed; the tools shown are from `<time>`", and put that sentence in
the spec. The OAuth case keeps the current sentence.

**Answer:**

### 12. Where Connect / Reconnect / Disconnect land (37b)

**What it is.** OAuth-mode proxied apps have Connect, Reconnect and Disconnect controls in
the app page's header.

**What happens today.** After any of them you are redirected to the `/apps` list with the
outcome notice there ([web.ts:1313-1317](../../../server/src/web.ts:1313)), not back to
the app you were on. The spec's redirect-back rule says "the pane that rendered the form",
and the header is not a pane.

**Recommendation: land on the app's own page (`/apps/<slug>`) with the notice there.**
That is where you pressed the button.

**Answer:**

### 13. Does the Resources pane show an approval line (37c)

**What it is.** Each Tools row shows an approval posture (whether calls need your
approval). Prompts are pinned "never approval-gated". The question is Resources.

**What happens today.** Two spec sentences disagree: §20.6 gives both prompts and
resources the "never" posture ([20-mcp-data-model-beyond-tools.md:330-331](../../specs/gateway/20-mcp-data-model-beyond-tools.md:330)),
while §13's Resources bullet has no approval line at all ([13-web-surface.md:270-278](../../specs/web-and-oauth/13-web-surface.md:270)).
The page follows §13. This is the one place the spec contradicts itself.

**Recommendation: keep §13 (no approval line on Resources) and amend §20.6.** Resources
are never gated, so a line saying "never" on every row is noise.

**Answer:**

## C. Process and hygiene

### 14. Push notifications do not reach iPhones (G23)

**What it is.** Approvals can push a notification to your phone. The library the hub uses
encrypts with an older scheme that Chrome and Firefox still accept but Apple refuses
([push.ts:16-27](../../../server/src/push.ts:16)), so on Safari and iOS, exactly where an
installed PWA lives, no notification ever arrives. The dashboard still holds the truth.

**Options.**
- Swap the library for one that speaks the current standard (RFC 8291). A real piece of
  work, scheduled as step 14.
- Accept the limitation and amend the spec to say Apple is unsupported.

Either way, one test helper should pin the encryption label it checks
([push-service.ts:189](../../../server/test/harness/push-service.ts:189)) so the test
cannot pass by accident when the library changes.

**Recommendation: swap the library in step 14, pin the label now.**

**Answer:**

### 15. May a test that was never reviewed as a title stand (G26 ii)

**What it is.** The working rule is that a test's title lands first as a to-do, you can
read it, and only then does its body get written. One test skipped that step (question 6's
test). The question is whether the gate should reject such rows.

**Recommendation: yes — a new passing test with no prior to-do fails the gate unless you
review it in that gate.**

**Answer:**

### 16. Retire an old debt line about an apps-list column (G39)

**What it is.** An old ledger line still promises a "capabilities" column on the apps list
and spells the page "/services", the name from before the rename. The spec asks for no
such column, and the app page's rail already shows which families an app has.

**Recommendation: retire the line** (fix the spelling, mark it superseded).

**Answer:**

### 17. Fix a flaky tunnel test (D16 flake)

**What it is.** One tunnel test waits a fixed number of ticks before checking that a
change notification rang, instead of waiting for the sockets to be ready the way its
neighbours do ([stream.test.ts:628-632](../../../server/test/tunnel/stream.test.ts:628)).
Under load it failed 3 of 8 runs; it is the row I keep re-running.

**Recommendation: change it to wait for the precondition like its siblings.** Not really
an owner question, but it touches a test's meaning, so it is listed.

**Answer:**

### 18. Correct two ledger entries that describe reviews that did not run (PSD record)

**What it is.** The retrospective found that one earlier ledger entry claims a review
sweep whose script never loaded the review skill, and another reports finding counts that
are copied from a different entry.

**Recommendation: amend both entries to say what actually happened.** Nothing else changes.

**Answer:**

### 19. Merge two duplicate timer helpers (D16 residue)

**What it is.** Two test files carry their own copy of a helper that shrinks a call
timeout ([data-model.test.ts:276](../../../server/test/tunnel/data-model.test.ts:276),
[pipeline-tunnel.test.ts:570](../../../server/test/tunnel/pipeline-tunnel.test.ts:570))
instead of using the shared one in the test harness.

**Recommendation: migrate both to the shared helper.** Pure tidy-up.

**Answer:**

## Not questions — fixes I will just do in step 8

These were listed on the old sheet beside the questions. They need no decision:

- **G17** — on the narrow add-app form, the submit button's label does not update when you
  switch between tunnel and proxy ([app-new.tsx:198](../../../server/src/pages/app-new.tsx:198)).
- **G18** — the "Enable notifications" button ignores a refused permission and a failed
  save; it just swallows the error ([approvals.tsx:228-244](../../../server/src/pages/approvals.tsx:228)).
- **G14** — after connecting a proxied app's OAuth, you land on a bare `/apps` with no
  notice ([upstream.ts:68](../../../server/src/upstream.ts:68)).
- **G36** — four passkey endpoint paths are spelled as literals instead of composed from
  the auth base path ([model.ts:462-468](../../../server/src/pages/model.ts:462)).
- **G52** — losing the race to decide an approval shows as a red "failed" instead of a
  calm "that request is no longer pending".
