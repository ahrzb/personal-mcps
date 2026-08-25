---
name: psd-comment-review
description: Use when asked to review, clean up, or restructure the COMMENTS of a file or module — classifies every comment by the PSD four kinds, deletes what repeats code, moves what sits at the wrong level, and adds the missing default-duty comments. Comments only; never changes behavior.
---

# Comment review — cleanup and structure, nothing else

A focused pass over one file or module's comments, applying the comment half of
the `psd` skill. **Load the `psd` skill first** — its Reading & writing
vocabulary (four comment kinds, comment levels, contamination, comments-first)
and red flags 9/10/13 are the value system this task applies; this file only
sequences them into a procedure.

## Scope — hard fences

- **Comments and doc-comments only.** No behavior change, no renames (naming is
  its own review), no signature changes, no moving code. If a comment problem
  can only be fixed by redesigning the code (the canary: an honest interface
  comment would have to be long), REPORT it as a finding — do not do it.
- House conventions are settled and preserved: contract-header comments,
  `// deps:` lines, `ponytail:` ceiling comments, comments-first files.
- After edits, the build must still be clean (`npx tsc --noEmit` or the
  project's equivalent) — doc-comment syntax can break tooling.

## Procedure

1. **Inventory.** Walk the target top to bottom. For every comment, note: which
   of the four kinds is it (interface / data-member / implementation /
   cross-module) — or is it pretending to be one kind while doing another's
   job? For every class, exported function, and struct/type member, note
   whether the default-duty comment exists at all.

2. **Judge each comment** — the tests, in order:
   - **Repeats code?** Could a reader write it from the adjacent line alone;
     does every load-bearing word already appear in the entity's name? Delete
     it, or replace it with what the reader actually cannot know.
   - **Wrong level?** At-the-code level narration inside bodies → delete or
     push lower (precision: units, bounds and inclusivity, null-meaning,
     ownership/lifetime, invariants) or higher (intuition: intent, how we get
     here). A loop's comment states what holds at each iteration, not what the
     loop does line by line.
   - **Contaminated?** Implementation mechanics inside an interface comment →
     move them to an implementation comment in the body. If the interface
     comment cannot be honest without them, record the shallow-abstraction
     finding instead of laundering it.
   - **Homeless or duplicated fact?** A design decision spelled in two
     comments will drift like duplicated code. Pick the ONE least-surprising
     home (for cross-module decisions: a central design-notes location or the
     owning module's header), keep the full statement there, and turn every
     other site into a pointer.
   - **Stale?** A comment the adjacent code contradicts is worse than none:
     fix it to the code's truth if the code is right; flag it as a finding if
     the comment looks like the intended truth.

3. **Fill the default duty.** Every class, exported function, and member gets
   an interface or data-member comment unless the name alone paints the full
   picture. Write the caller's contract: behavior, argument meaning /
   units / constraints, return value, side effects, exceptions, preconditions.
   Different words than the name — if there are no different words, the
   comment is not needed.

4. **Verify and report.** Re-run the build check. Report edits grouped by
   action — deleted (repeats), rewritten (level), moved (contamination /
   one-home), added (default duty), corrected (stale) — plus the findings you
   deliberately did NOT fix because they convict the code, each named with its
   PSD red flag.

## Red flags for the reviewer's own output

| Thought | Reality |
|---------|---------|
| "I'll polish the wording while I'm here" | Rewording a correct comment is churn, not review. Touch what fails a test above. |
| "This comment is long, so it's bad" | Length is fine; repetition and wrong level are bad. A long rationale can be exactly right. |
| "The code is unclear, I'll explain it in a comment" | A comment compensating for evitable obscurity is an apology. Report the Nonobvious Code finding instead. |
| "I'll fix this tiny bug I noticed" | Out of scope. Report it. Comments only. |
