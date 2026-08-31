# 2026-08-31 — The rebuy becomes a decision

Phase 4 of the bankroll re-land, recovered from `6eae5e2b90` (#2118), with one
correction to the reverted code.

## The defect

Both engine rebuy sites did the same two things wrong. They sized the reload as
`bigBlind * 100` flat — ignoring the table's own minimum and maximum, and the
horse's roll entirely — and they asked exactly one question before reloading:
"have I already rebought twice?"

So a horse whose bankroll could no longer support a stake reloaded it anyway,
forever, at a stack the table might not even permit. That is the opposite of
what Dan asked for: a horse that cannot afford the game is supposed to leave it,
drop a rung, and come back.

## The correction to the reverted code: an off-by-one worth 60% of the fleet

The reverted module compared `rebuysTaken >= policy.stopLossBuyIns`, and its own
comment claimed that left "the standard temperament exactly where the hard-coded
`>= 2` had it (three buy-ins)".

It did not. `rebuysTaken` counts reloads already made, so buy-ins COMMITTED is
`rebuysTaken + 1`. With `standard.stopLossBuyIns = 3`, comparing `rebuysTaken`
permits three reloads — four buy-ins committed — where the old `>= 2` permitted
two reloads for three. Six in ten of the fleet would have quietly gained a
buy-in of rope, inside a change described in its own commit message as a spread
around existing behaviour.

Corrected to `rebuysTaken + 1 >= stopLossBuyIns`, in both `rebuyDecision` and
`atRebuyStopLoss`. That makes the original claim true: standard stops at exactly
the old place, the nit gives up a buy-in earlier, the gambler takes one more.

Found by writing the pin the comment implied — `standard` must refuse at
`rebuysTaken = 2` and permit at 1 — and watching it fail.

## Fails open, three ways

An unknown club, an ABSENT balance key, and a thrown read each return the legacy
flat amount, never zero. `readClubChipBalances` distinguishes "zero" from "could
not read" by key absence for exactly this reason, and the cost of the two
mistakes is not symmetrical: a wrong reload is one buy-in, a wrong stand-up
empties a table that had a game in it.

A roll that reads as genuinely zero is a different case and correctly stands the
horse up — it has no chips, and the recovery path from there is the freeroll
queue that Phase 3 built.

## What this does not change

**Where the chips come from.** A horse is still funded by
`fn_horse_fund_from_treasury`, exactly as before. This module decides only
whether and how much. No money path is touched, no conservation rule moves, and
CLAUDE.md 11.5 is not engaged.

**Timing.** The five-second rebuy window and the pauses around it are upstream of
this call and stay exactly as they are (CLAUDE.md 10.5); this only decides the
answer the horse gives inside that window, which is the same thing the window
exists to let a human decide. A pin asserts the module introduces no delay of
its own.

The wallet read stays a lazy `await import('./supabase/wallets.js')` inside the
one async function that needs it: a static import makes merely LOADING this
module a database dependency, and aborts the process when
`SUPABASE_SERVICE_ROLE_KEY` is unset.

## Pins

`server/src/services/HorseRebuyPolicy.test.ts`, 20 assertions. Ten mutations
applied and observed failing, then reverted: the off-by-one restored in each of
the two places; the roll check dropped so a horse reloads a game it cannot
afford; an unread balance standing the horse up; a thrown read standing the
horse up; a static wallet import; each engine site ignoring a zero decision; the
settlement site reverting to the hard-coded `>= 2`; the dealing site dropping the
table limits.

server 3178/283 green, client 10384 passed 2 skipped/740 green, both tsc clean.
