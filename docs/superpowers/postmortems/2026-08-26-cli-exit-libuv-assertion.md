# CLI crashes with a libuv assertion on exit (Windows)

- **Found:** 2026-08-26, by the user, immediately after a successful `pnpm pmcp login --profile local`
- **Symptom:** after the CLI printed `logged in as user:ahrzb on http://localhost:8787`, the process emitted `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 94`
- **Impact:** the operation itself succeeded (token stored); the crash fires on process teardown — alarming output, and a crash exit code that would break any script checking the CLI's exit status; Windows-specific
- **Class:** boundary-actor, upstream-bug (suspected)

## Root cause

CLOSED 2026-08-26 (investigator, deterministic repro). A Node/libuv bug, not
our code semantically: `process.exit()` tears the loop down while undici
teardown work is still in flight; Node's V8 platform then calls
`uv_async_send` on an async handle libuv has already flagged
`UV_HANDLE_CLOSING`, and libuv asserts. Minimal trigger: **≥ 2 global
`fetch()` calls, then `process.exit()`** — 2 fetches crash 5/5, 1 fetch 0/5
(the first fetch warms the undici pool; the second leaves pooled-socket
teardown outstanding at exit). Ruled out empirically: strip-types, the pnpm
wrapper, proto shims, TTY vs piped, POST vs GET, `.json()` vs `.text()`.

Environment: Node v24.19.0 / undici 7.29.0 / libuv 1.52.1, Windows 11.
Upstream: nodejs/node#56645 (canonical, closed), #64322, #58091 (dups);
fix PR #61999 shipped **in v26.7.0 only** — not backported to 24.x as of
v24.19.0, so this machine stays unpatched on its current Node.

## Why the tests missed it

The suite and the smoke script both invoke the CLI's `main()` **in-process**
(vitest imports it; `scripts/smoke.ts` imports it). No test anywhere runs
`node cli/pmcp.mts` as an actual OS process — so the entry wrapper, the exit
path, the runtime flags (`--experimental-strip-types`, warning suppression),
and OS-specific process teardown are exercised by nothing. The program's
*functions* are thoroughly tested; the *program* is not.

## Fix

`process.exitCode = await main(...)` replacing `process.exit(...)` in
`cli/pmcp.mts` and `scripts/users.mts` (one line + workaround comment each,
naming nodejs/node#56645 and the revert condition). Proven: 0/4 crashes vs
4/4 before, against the real login polling shape; exit latency 0–1 ms from
last await (the feared keep-alive hang does not occur on this Node/undici
pair — cli holds no server/WebSocket/interval handles); real-console TTY
path verified; cli test project 5 files / 80 tests green. Measured-and-
rejected alternatives: `setImmediate(() => process.exit(0))` still crashes
5/5; `sleep(100)+exit` works but only narrows the race. Applied to the
working tree 2026-08-26; commit hash recorded at its gate.

Known trades (recorded in-code): any future CLI command that leaves a handle
open will hang instead of exiting; `scripts/smoke.ts` deliberately NOT
converted — it needs a forced exit to kill its real WebSocket, and if it
starts crashing it needs socket teardown, not this one-liner. Revert both
sites to `process.exit` when the machine's Node carries #61999 (v26.7.0+ or
a 24.x backport).

## Candidate countermeasures (recorded, not enacted)

- Process-level CLI test leg: spawn the real entry as a child process
  (`node --experimental-strip-types cli/pmcp.mts …`), assert exit code and
  clean stderr — catches crash-class, flag-wiring, and warning regressions.
- Same real-actor generalization as the 415 postmortem records.

## Misdiagnoses along the way

None — the working hypothesis (process.exit racing undici teardown, upstream
Node bug) was confirmed exactly as stated; the bisect only sharpened it to
the ≥ 2-fetch trigger.
