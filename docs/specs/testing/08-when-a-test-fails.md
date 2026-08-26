## 8. When a test fails: code wrong, or spec changed?

Three commit types, declared in the message:

- `fix:` — the code was wrong. Row unchanged, spec unchanged.
- `spec:` — the spec changed or was ambiguous. **The row and the spec line change
  in the same commit — never the row alone.**
- `test:` — the row mis-transcribed the spec. Spec unchanged.

Because the oracle is data, discrimination is nearly automatic: a spec change
touches rows; a code regression touches none. Every row prints its spec section
in the test name (`§7 step 2 · pending dedup returns same approvalId`), so a
failure names the sentence to re-read.

