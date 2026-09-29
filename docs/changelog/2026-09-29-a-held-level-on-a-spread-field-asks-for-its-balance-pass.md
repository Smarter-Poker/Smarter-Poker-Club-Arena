# A held level on a spread field asks for its balance pass (2026-09-29)

Follow-up to `2026-09-29-a-field-that-cannot-deal-is-not-waiting-behind-one-that-can.md`
(PR #5582, merged as 3148d2d1, live on engine a0cf141c).

## What was still wrong

The consolidation lane is declared by the balance stage, so a spread field
first has to reach that stage through the general queue. After the 06:06 UTC
restart on 2026-09-29 that first pass was the whole wait: measured over 40 s
at 06:21 UTC, general sweeps took 19.5 s each (11 admissions; the database
showed 36 PostgREST calls waiting on transaction locks), 471 managers were
queued with the oldest at 441 s, and Morning Free Buy `6a18ddaa` (10 players
on 7 tables) and $100 Freeroll `c65c414d` (13 on 13) sat in the urgent lane
behind the whole platform for their first post-thaw balance pass. The lane
itself worked: `9d1c08b9` was marked at 06:15 and served from its own slot.

## What changed

`TournamentManagerBase.askForConsolidationIfSpread()`, called from the held
level's existing 15 s recheck (the branch that logs "came due with no hand
dealt"): when two or more of the manager's own dealers hold fewer than two
players each and none holds two, no table can deal until the balancer merges
them. The manager marks itself consolidating and asks for one sweep, which
the scheduler serves from the consolidation slot. The balance stage then
keeps or clears the mark from what it reads. No new timer, no database read;
a single-table event, or one with any table able to deal, asks for nothing.

## Pinned by

`server/src/tournament/aFieldThatCannotDealIsNotWaitingBehindOneThatCan.law.test.ts`
(describe "a held level on a spread field asks for its balance pass").
