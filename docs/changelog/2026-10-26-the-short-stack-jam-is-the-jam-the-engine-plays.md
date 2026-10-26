# The short-stack jam is the jam the engine plays

Follow-up to `2026-10-25-the-bubble-hand-can-never-happen-again.md` (#8144).

That change made a tournament stack of 12 big blinds or less, facing a raise
in no-limit hold'em, jam or fold instead of flat-calling. After it went live
at 12:07 UTC on 2026-10-26 the engine began reporting
`horse decision worker returned invalid policy receipt: reference_shape`
(7 refusals in the first hour).

Cause: the Phase 6 receipt check (`referenceReturnShape` in
`server/src/engine/HorsePhase6Attribution.ts`) admitted a `variant_price`
all-in only when the stack was more than 1.5 calls deep AND another live
seat besides the raiser was still in the hand, and never admitted an all-in
from the big-blind defend chart. The new jam is exactly the case it did not
know: the short big blind heads-up against the opener. The receipt was
refused, and the engine's liveness fallback folded the hand the brain had
chosen to jam - A-T, pocket eights and K-9 with 1.5 to 3 big blinds behind
were folded to a min-raise.

Fix: the check now admits the V58 public shape - tournament, no-limit
hold'em, hero total at most `SHORT_STACK_NO_FLAT_BB`, facing a preflop raise
by another seat, with chips left after the call, action all-in, no amount.
Nothing else is widened: a deep stack, a cash game or an Omaha table at the
same spot is still refused.

Pinned in `server/src/engine/HorseBubbleShortStackDiscipline.law.test.ts`
("the jam the brain chooses is the jam the engine plays"), which fails with
`reference_shape` without this change.
