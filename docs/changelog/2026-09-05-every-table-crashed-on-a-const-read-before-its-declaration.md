# Every table page crashed on a const read before its declaration (2026-09-05)

Found on production at 08:40 UTC while verifying #3069: opening any
`/table/:id` (as a player or a spectator) showed the "Something Went Wrong"
card. Console: `ReferenceError: Cannot access 'He' before initialization` in
the MultiTablePage chunk, inside an `Array.some` callback on first render.

## Cause

`parseTimed` was a `const` arrow declared INSIDE the component body, a few
hundred lines below the `anyTurnLive` gate. #3089 ("rit and previous hand
second sweep", merged 2026-09-05 07:xx) made that gate call
`parseTimed(t.decision)` so an expired decision would not count as a live
clock. A `const` read before its declaration in the same scope is a temporal
dead zone error, and the gate runs on the FIRST render whenever at least one
table is open. So every table, for every player, since that merge published.

Nothing caught it: no test renders MultiTablePage with a table, the law tests
are source pins that did not look at declaration order, and the CSS Beat E2E
either ran before the merge or does not reach a render with a table tab.

## Fix

`parseTimed` is a module-level `function` declaration above the component.
Function declarations are hoisted and have no temporal dead zone, so its
position can never matter again. Behaviour is byte-for-byte the same.

`tests/unit/multiTablePageHelpersAreHoisted.test.ts` pins two things: that
`parseTimed` is declared at module level above the component, and that no
identifier `anyTurnLive` calls is a `const` declared after it in the file. The
pin fails on the pre-fix source (verified by running it against the stash).

## Not this PR

Hub tabs (#3069) shipped in the same window and were the reason anyone was
looking at a table page in a browser pane; they are unrelated to the crash and
are not touched here.

## Two agents, one fix, two declarations (08:57 UTC)

Another agent shipped the same hoist as #3105 (`export function parseTimed`)
minutes before #3106 landed. The two touched different lines, so GitHub
merged both cleanly and `main` held TWO `function parseTimed` declarations:
`tsc` refuses a duplicate implementation, so `main` was red and the publisher
(which runs `tsc -b` first) could not ship anything after a505dca7f. This
removes the second copy and keeps the exported one; both pins
(`no-tdz-in-table-route`, `multiTablePageHelpersAreHoisted`) still hold.
Production was never on the red commit.
