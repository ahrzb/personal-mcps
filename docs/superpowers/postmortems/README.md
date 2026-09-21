# Postmortems

One file per bug **found by the user** (i.e. it escaped the suite, the gates,
and the smoke). The goal is a track record for pattern analysis, not immediate
process fixes — countermeasures are *recorded as candidates* here and enacted
only when a deliberate analysis pass decides to.

File name: `YYYY-MM-DD-<slug>.md` (date = when the user found it).

Template — keep every section, write "n/a" rather than deleting one, so the
files stay machine-comparable:

```markdown
# <title>

- **Found:** YYYY-MM-DD, by <who>, doing <what>
- **Symptom:** <verbatim user report or error text>
- **Impact:** <who/what was broken, for how long, where (prod/local)>
- **Class:** <one or more: boundary-actor / environment-drift / silent-default /
  exclusion-intersection / upstream-bug / spec-gap / process-lapse>

## Root cause
<the technical chain, shortest complete version>

## Why the tests missed it
<the specific hole; name the test/walk that was closest and why it stopped short>

## Fix
<what changed, when, commit hash once landed; "pending" until then>

## Candidate countermeasures (recorded, not enacted)
<bullets; each names the smallest change that would have caught this class>

## Misdiagnoses along the way
<wrong theories held and how they were disproven; "none">
```

## Index

- [2026-08-25 — web login 415](2026-08-25-web-login-415.md) — browser posts form-encoded, better-auth accepts only JSON; no test ever submitted the login form
- [2026-08-26 — local device flow advertises prod URL](2026-08-26-local-device-flow-prod-url.md) — stale dev server ran with prod PUBLIC_ORIGIN; CLI faithfully printed what the hub returned
- [2026-08-26 — CLI exits with libuv assertion on Windows](2026-08-26-cli-exit-libuv-assertion.md) — crash after successful login, on process teardown; Node bug, process.exitCode workaround
- [2026-08-26 — public sign-up open on production](2026-08-26-public-signup-open.md) — anyone could self-provision an account via /api/auth/sign-up/email; found by the D10 sweep, fixed + deployed same hour
- [2026-09-03 — Sessions pane names every browser session "Unknown client"](2026-09-03-sessions-unknown-client.md) — the login form's translation forwarded only the cookie, so better-auth stored an empty User-Agent; no test signed in through the form and read the pane
- [2026-09-16 — the shipped agent page did not look like its board](2026-09-16-agent-page-layout-not-the-board.md) — the pages agent wrote its own CSS, the details pane stacked under the listing, long real patterns overflowed; no stage rendered the page beside the board and the fixtures carry short data
- [2026-09-21 — typing in the audit search box tears the whole page down](2026-09-21-audit-search-unmounts-the-page.md) — the search text is in the query key and the pending branch unmounts the explorer, input included; the gallery's seeded cache can never refetch, so nothing typed before ship. Same report: a ×N run could not be opened
