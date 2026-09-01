## 1. The frame

Tests are the spec stated precisely. The prose spec (2026-08-24 design doc) is the
starting point — expected to be wrong or ambiguous in places, and it evolves.
Three consequences drive everything below:

- **Writing a test is design work.** Making a pinned behavior executable is where
  contradictions surface; amending the spec is a normal *output* of test authoring,
  not a failure of it. (Authoring this strategy — and pinning the decisions it
  produced — found three spec inconsistencies and a handful of skeleton
  problems — §11.)
- **A one-line spec change must not ripple through forty tests.** Change
  amplification in a test suite is the same disease as in code. The cure is
  structural: the spec's matrices live as *data tables*, the assertion logic lives
  once in a thin runner. A spec change edits rows; a code regression touches none —
  which is also how you tell the two apart when a test fails.
- **Much implementation will be agent-written.** Tests are the oracle agents build
  against, so oracle strength and authorship separation matter (§9). A supporting
  concern, not the headline.

The risk profile sizes the suite. The expensive bugs are not in computation — they
are in **ordering, refusal, state, and concurrency**: the pipeline check order, the
401/404 anti-enumeration matrix, approval exactly-once under concurrent retries,
`hub/*` _meta stripping, redaction-before-hashing, the tunnel close-code protocol.
Four green unit tests compose into a wrong order; only the pipeline exhibits the
pipeline's bugs. So the center of gravity is **in-process integration inside
workerd** (real D1, real Durable Object, fake app on a real WebSocket) — not
per-function unit tests, and not deployed e2e, which can't express concurrency
interleavings or exhaustive refusal matrices at all.

**Size: ~26 test files (most of them tables) + 3 harness modules, across four
vitest projects plus pytest. Dependencies beyond the runners: `@cloudflare/
vitest-plugin` and `fast-check`. No coverage tooling, no lint gate, no browser
framework.**

