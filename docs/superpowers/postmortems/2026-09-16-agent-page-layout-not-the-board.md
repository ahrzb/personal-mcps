# The shipped agent page did not look like its board

- **Found:** 2026-09-16, by the user, opening `/agents/pi` on production minutes after deploy `85464d2c`
- **Symptom:** the details pane rendered below the listing instead of beside it at every width; no framed three-pane box; a tunneled app's long declared patterns (`proton_(?:create_draft|…)`) overflowed the listing sideways and pushed the none · ask · allow control out of view; details key/values as a full-width table with right-aligned values
- **Impact:** the page worked (every test green, smoke 34/34) but read as a different design from the four owner-approved boards; no data at risk
- **Class:** verification-blind-spot, fixture-realism

## Root cause

The pages agent wrote its own CSS from the boards' description instead of from the
boards' stylesheet, and the wide split was never rendered side by side. The fixtures
carry short names and short patterns, so nothing in the preview walk showed the
overflow that real declarations produce.

## Why the process missed it

1. The fidelity verifier compared **props, strings and markup** to the boards (which
   it did thoroughly) but never rendered the page — it was read-only by instruction and
   could not open the preview. Layout is not in the DOM; it is in the stylesheet, and no
   stage looked at the two side by side.
2. The pages agent's own preview walk produced screenshots that the orchestrator did not
   look at before shipping; "all fixtures 200" was taken as the visual gate.
3. The fixtures were authored from the boards, which use short demo data; the live
   namespace has role patterns hundreds of characters long. The states preview cannot
   catch what its fixtures do not contain.
4. The user had said "ship, it's fine" while the gate ran, and the orchestrator shipped
   on the mechanical gate alone.

## Fix

The wide layout is being rebuilt from the demo's stylesheet (the boards' actual CSS),
with wrapping for long patterns, by the agent that owns the files for the mobile track;
it lands with that track's ship.

## Process change (candidate, to confirm in the retrospective)

- A visual gate for any page change: the orchestrator opens the preview beside the board
  at 1300 px and compares before the ship, or a verifier with browser tools does and
  reports a screenshot pair — not a props audit alone.
- Fixtures include one "long data" variant per listing (a 300-character pattern, a
  40-word description, a 60-character slug) so overflow shows in the preview.
- A pages brief names the stylesheet to copy when a board's CSS exists, not only the board.
