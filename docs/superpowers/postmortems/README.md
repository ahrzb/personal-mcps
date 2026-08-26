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
- [2026-08-26 — CLI exits with libuv assertion on Windows](2026-08-26-cli-exit-libuv-assertion.md) — crash after successful login, on process teardown; root cause under investigation
