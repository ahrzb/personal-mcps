---
name: psd
description: Use when judging how good a piece of code is, reviewing code or a design, or discussing code quality — applies the value system and vocabulary of Ousterhout's "A Philosophy of Software Design". Judge by these criteria, name findings with these terms.
---

# A Philosophy of Software Design — value system & vocabulary

Distilled from John Ousterhout's *A Philosophy of Software Design* (2018). When this
skill is active: judge code by the metric below, name what you see with this
vocabulary, and cite red flags by their names. A finding phrased in these terms
("this is a shallow module with information leakage into its caller") is worth more
than a paragraph of ad-hoc critique.

## The metric

**Complexity is the only thing being judged.** Complexity = anything about a system's
structure that makes it hard to understand or change, measured in reader/maintainer
effort — never in lines, features, or sophistication.

- **Judged by readers, not authors.** If reviewers find it complex, it is complex;
  "simple once you understand it" is a confession, not a defense.
- **Weighted by touch frequency.** Ugliness in a corner nobody opens barely counts;
  mild awkwardness on the daily path counts enormously.
- **Accumulates incrementally** — hundreds of individually-defensible kludges, so the
  standard is zero tolerance, not "just this once".
- **Two causes**: **dependencies** (code that can't be understood or changed in
  isolation) and **obscurity** (important information not apparent from what you're
  looking at).
- **Three symptoms**: **change amplification** (one decision, many edit sites),
  **cognitive load** (how much a reader must know to make a change), and — worst —
  **unknown unknowns** (you can't even tell what you'd need to know).

Two legitimate strategies: **eliminate** complexity (remove special cases, redefine
semantics) or **encapsulate** it (modular design). Prefer elimination.

## The value system (judgment criteria)

The book's consolidated principles, phrased as judgments:

1. **Sweat the small stuff** — complexity is incremental; the small kludge is the unit of decay.
2. **Working code isn't enough** — code written to be *finished* rather than *extended* is tactical programming; the mess is the price.
3. **Continual small design investments** (~10–20% of effort) beat both big-bang design and none; every change should leave the design as if it had been planned for the change (strategic modification). If you're not making it better, you're making it worse.
4. **Modules should be deep** — depth = functionality ÷ interface. Judge every class, method, and service by what it hides behind how much interface. Small ≠ good; "more classes is better" is classitis.
5. **Make the common case trivial** — defaults over knobs; features most users never learn don't count against effective interface complexity.
6. **A simple interface matters more than a simple implementation** — there are more callers than implementers; good code is uglier inside than outside.
7. **Somewhat general-purpose** — functionality for today's needs, interface not tied to them. Too special leaks the caller's concepts downward; too general makes today's case painful.
8. **Separate general-purpose from special-purpose code** — the general mechanism knows nothing of its customers; specifics get pulled upward.
9. **Different layer, different abstraction** — adjacent layers presenting the same idea (pass-throughs, wrapper stacks, API-mirrors-storage) mean a decomposition mistake.
10. **Pull complexity downward** — the module absorbs unavoidable pain (its author suffers) instead of exporting it via exceptions, knobs, or half-finished results.
11. **Define errors out of existence** — the best exception is one whose condition is redefined as normal behavior; mask low or aggregate high, never handle everywhere; crash on what can't be meaningfully survived. Every thrown exception is interface.
12. **Design it twice** — sketch two radically different designs before committing; a significant design with no considered alternative is a warning sign, not a credential.
13. **Comments say what the code cannot** — rationale, informal contracts, invariants, units, boundary semantics. Written first, they are a design tool; a long interface comment convicts the abstraction (the canary test).
14. **Design for ease of reading, not ease of writing** — obvious code is code whose first reading is its correct reading; obviousness is judged by the reader.
15. **Increments of development are abstractions, not features** — when a feature needs an abstraction, design that abstraction fully, not the special case.

Cross-cutting: **every element must pay for itself** (each interface, argument,
class, and knob costs learning; it stays only if it removes more complexity than it
adds), **consistency creates cognitive leverage** (similar things alike, dissimilar
things different; never break a convention just for a better idea), and
**moderation** — every principle above, pushed to its extreme, becomes the problem.

## Vocabulary

Use these terms verbatim when discussing code.

**Structure**
- **Deep module** — much functionality, small interface. **Shallow module** — interface cost ≈ implementation value.
- **Interface** — everything a caller must know: formal (signature) + informal (behavioral contract, constraints); the informal half is usually larger.
- **Abstraction** — a simplified view that omits unimportant details. A **false abstraction** omits details users actually need — complexity relocated into obscurity.
- **Information hiding** — each module owns named design decisions absent from its interface. **Partial hiding** — rare knowledge kept off the common path.
- **Information leakage** — one design decision reflected in multiple modules. **Back-door leakage** — leakage visible in no interface (two classes both knowing a format); worse for being invisible.
- **Temporal decomposition** — module boundaries drawn by execution order instead of by knowledge; forces the same knowledge into multiple stages.
- **Classitis** — mass-producing small shallow classes on a size rule; their interfaces sum into system complexity.
- **Overexposure** — using a common feature forces learning rare ones.
- **Pass-through method** — forwards its arguments, adds no abstraction. (Dispatchers and multiple implementations of one interface are the legitimate signature repeats.)
- **Pass-through variable** — threaded through signatures that don't use it. **Context object** — the least-bad home for system-wide state; keep it small, prefer immutable.
- **Decorator/wrapper stacking** — layered same-shaped APIs each adding a sliver; trends shallow.
- **Conjoined methods** — neither can be understood without the other; the split was the mistake.
- **General-purpose vs special-purpose** — and the **special-general mixture** when one mechanism contains its customer's specifics.

**Errors**
- **Define errors out of existence** — redefine semantics so the error case is normal (`unset` = "ensure absent").
- **Exception masking** — resolve low so callers never learn it happened. **Exception aggregation** — one high handler for many throw sites. **Error promotion** — escalate rare failures into a recovery path you already have and exercise. **Just crash** — for unrecoverable conditions.
- **Secondary exception** — the subtler failure created by handling the first one.
- **Over-masking** — hiding failures callers had a right to know about. Hide the unimportant; expose the important.

**Reading & writing**
- **Obvious code** — first guess about behavior is correct. Three routes, in order: reduce what the reader must know; reuse what they already know (conventions, expectations); supply what's missing (names, comments).
- **Four comment kinds** — **interface** (precedes a declaration: the contract — behavior, argument meaning/units/constraints, return value, side effects, exceptions, preconditions), **data-member** (beside a field: units, bounds and their inclusivity, null-meaning, ownership/lifetime, invariants), **implementation** (inside a body: *what* a block accomplishes and *why*, never *how* — the code says how; for loops, what holds at each iteration), **cross-module** (a decision spanning modules — homeless by nature, so give it ONE named home, a central design-notes file or the least-surprising site, and point to it from every other site). Interface and data-member comments are the default duty — every class, method, and member carries one unless the name alone paints the full picture; implementation comments only where the code can't be made obvious; cross-module comments are rare and the worst kind to lose.
- **Interface comment vs implementation comment** — the contract vs the mechanics; internals in an interface comment is contamination, and needing them there convicts the abstraction as shallow.
- **Comment levels** — lower than code adds precision (units, bounds, null-meaning, ownership, invariants); higher than code adds intuition (intent, "how we get here"); *at* the level of the code it merely repeats it.
- **Naming** — a name should paint the right picture alone: precise (not `data`/`status`/`result`), not over-specific, one name per concept and one concept per name, booleans as predicates, length scaled to scope distance. **Hard to pick a name ⇒ the entity itself isn't cleanly defined.**
- **Comments-first** — interface comments written before bodies are design; retrofitted ones restate the code.

**Process & performance**
- **Tactical programming / tactical tornado** — fast, celebrated, and the source of everyone else's cleanup. **Strategic programming** — great design that also happens to work.
- **Investment mindset** — proactive (design twice, comments-first) and reactive (fix, don't patch around).
- **Critical path / the ideal** — the minimum code the common case must run, designed as if the current structure didn't exist; get special cases off it with one up-front test.
- **Death by a thousand cuts** — diffuse slowness no single fix rescues. **Measure before modifying; back out unproven complexity.**

## Red flags

The official catalog — cite by name. Each: what it looks like → the question to ask.

1. **Shallow Module** — interface ≈ implementation → *what does this hide from callers?*
2. **Information Leakage** — one decision in several modules → *what reorganization confines it to one place?*
3. **Temporal Decomposition** — boundaries follow run order → *what does each piece* know*, and should the boundary follow that?*
4. **Overexposure** — common use requires learning rare features → *can this be defaulted, derived, or moved aside?*
5. **Pass-Through Method** — body just forwards → *which class actually owns this responsibility?*
6. **Repetition** — same nontrivial chunk again and again → *what abstraction is missing?*
7. **Special-General Mixture** — mechanism contains its customer's specifics → *can the specifics move up a layer?*
8. **Conjoined Methods** — must read B to understand A → *should these be one, or split differently?*
9. **Comment Repeats Code** — writable from the adjacent line alone → *what does the reader actually not know?*
10. **Implementation Documentation Contaminates Interface** → *which sentences does a caller need — and is the method shallow?*
11. **Vague Name** — `count`, `status`, `data` → *what would I guess this means, seeing only the name — and would I be right?*
12. **Hard to Pick Name** → *is this one thing, or several wearing one name?*
13. **Hard to Describe** — honest doc must be long → *what interface would be describable in two lines?*
14. **Nonobvious Code** → *is the fix less information needed, a convention, or a comment?*

Unofficial but strong: exposing internal data structures (getters returning live
collections; API mirroring storage), getter/setter pairs as pseudo-hiding, a growing
pile of configuration knobs, wrapper/decorator stacks, adjacent layers with the same
abstraction, error handlers that have never executed, an explosion of null/sentinel
`if`s mirroring a UI concept, a significant design with no considered alternative,
and global state that prevents two instances coexisting in one test process.

## How to apply in a review

- **Name the flag, state the reader cost, propose the eliminating design.** "Red
  flag: Pass-Through Method — `Shell.deleteChar` forwards to `TextDocument`;
  interface duplicated, no value added. Expose the document directly or move the
  responsibility." Findings that only describe discomfort don't count.
- **Weight severity by depth of damage × touch frequency.** Leakage on a daily-edited
  path outranks a vague name in a dusty corner.
- **Judge as the reader.** If you had to open the implementation to use it, say so —
  that fact alone convicts the interface.
- **Prefer designs that remove the flag over comments that apologize for it**; when
  the mechanism is legitimately obscure (event-driven, callbacks), demand the
  compensating comment.
- **Don't re-litigate documented conventions**, and don't push any principle past the
  point where it starts manufacturing complexity — moderation is part of the system.
