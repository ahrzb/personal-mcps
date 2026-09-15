# AGENTS.md

## Asking a complex decision question

A decision is **complex** when the options differ in kind rather than degree, or when one of
them is hard to reverse. Put these in the chat as prose, in three parts:

1. **Context** — the constraint that makes this a decision rather than a lookup. Name what has
   already been tried or ruled out, so the answer is not re-litigating settled ground.
2. **Options** — a table, at least two rows, exactly three columns: **Option | Pros | Cons**.
   Every option gets real pros and real cons; an option with an empty Cons cell is a
   recommendation wearing a costume. Include the status quo as a row when it is live.
3. **Recommendation** — pick one, in one paragraph, naming the single consideration that
   decided it. Then name what would flip the choice, and say which judgement is the human's
   rather than yours.

Surface irreversibility explicitly. "Adopting is easier than un-adopting" changes how a human
weighs an option and is invisible in a pros/cons list unless written down.

The `ask` tool's option chips suit small either/ors — a library choice, a naming call. Complex
decisions go in prose, because chips flatten tradeoffs into a menu and push toward a pick before
the human has weighed the cost.

## Comments

A change is done when every module, type, function and field it adds carries the comment kind it
owes, each comment says something the adjacent code cannot, and the interface comments were
written before the bodies. Write them without being asked; review checks them.

**The four kinds, each with a home.** This classification is the whole discipline: naming the
kind a declaration owes is what makes "missing comment" a checkable claim rather than a matter
of taste.

- **Interface** — precedes a declaration and *is* the contract: behaviour, argument meaning,
  units and constraints, return value, side effects, errors, preconditions. Everything a caller
  must know and nothing about how it is done. Every module, exported type and function carries
  one unless the name alone paints the full picture.
- **Data-member** — beside a field: units, bounds and their inclusivity, what null or zero
  means, ownership and lifetime, invariants. Every field carries one under the same exception.
- **Implementation** — inside a body, only where the code cannot be made obvious: what a block
  accomplishes and why, never how. For a loop, what holds at each iteration.
- **Cross-module** — a decision spanning modules has one named home (the spec § or the least
  surprising site) and a pointer to it from every other site. Rare, and the worst kind to lose.

The `psd` skill carries the rest of the vocabulary — contamination, the red flags, and the
`psd-comment-review` procedure for auditing a file's comments. What is always in force here:

- **A comment sits above or below the code, never at its level.** Below adds precision — units,
  bounds, what null means, ownership, invariants. Above adds intuition — intent, the reason, how
  execution reaches here. A comment whose every load-bearing word already appears in the
  entity's name is at the code's level; delete it.
- **Interface comments are written first, as design.** A long one convicts the abstraction:
  shrink the interface, then the comment.
- **Known obscurers owe compensation.** Where the mechanism is non-obvious by construction — a
  handler with no visible call site, a value crossing the tunnel or a DO boundary, code that
  defies what its context leads a reader to expect — the comment states what the reader cannot
  see: when and from where it fires, what the other side assumes, why the expectation breaks here.
- **Copies keep their comments.** This repo deliberately copies wire shapes across languages
  rather than sharing a package (`contracts/README.md`), so a type or field comment crossing
  into Python, Go or TypeScript is rewritten for the new language, never dropped. The copies are
  where the reasons would otherwise be lost.

## Failures

A change is done when its failures name a cause and a secret in its inputs provably reaches no
record. Apply this without being asked.

§15 owns the audit trail — what it records, redacts and caps — and `contracts/README.md` owns
what a fixture may contain. Two rules that do not follow from either:

- **Say whether a failure is transient.** That classification decides retry versus backoff, so
  it belongs in the record rather than in a reader's head, next to the cause and the subject.
- **Log decisions, not progress.** If nothing was decided, nothing is logged. A line per
  decision — a refusal, a verdict, a chosen retry — keeps the stream reconstructable; a line per
  step buries it.
