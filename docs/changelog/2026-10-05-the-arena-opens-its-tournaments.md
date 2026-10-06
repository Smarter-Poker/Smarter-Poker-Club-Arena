# The Arena Opens Its Tournaments

Date: 2026-10-05. One migration, one UPDATE of one row. No function, no
trigger, no cron, no client or engine change.

## The decision

Dan's, taken 2026-10-04: open Diamond tournaments now and leave Diamond cash
games closed. `supabase/migrations/20261005105457_the_arena_opens_its_tournaments.sql`
carries it.

## Why only one of the two switches

The two paths are not equally ready, and the difference is money.

**Tournaments have a working fee.** The Diamond entry fee runs today: 10 percent
of the total entry, 5 percent when the field is capped at two players, floored
to whole Diamonds, reaching the house at settlement through
`fn_poker_diamond_tournament_settle_fee`, which returns early on an existing
`poker-tournament-fee:<id>` ledger key so a replay banks nothing twice. Question
B1 of `docs/DIAMOND-DESTINATIONS-DESIGN-2026-09-21.md` asks only whether that
inherited rate is the approved one, so opening loses nothing while the answer is
outstanding.

**Cash games have no rake at all.** None is taken today and six layers refuse it
(that design, section 2.4). B4 to B10 are unanswered, so every Diamond cash hand
played now would be raked at zero. A settled hand cannot be raked afterwards and
ruling 10.9 forbids taking anything back from a player, so that revenue would be
unrecoverable. `cash_games_enabled` stays false, and the migration asserts it
both before and after.

## What opening admits

Read from production on 2026-10-05: no Diamond tournament has ever existed, so
nothing starts by itself. This lets staff create the first one deliberately. A
guarantee, a promised satellite seat, a freeroll and a promotional entry stay
refused by name pending A1 to A20. Horses are not refused: the
"diamond horse funding not open" message is gone from every function body, so
CLAUDE.md 10.5 holds on this path and a Diamond event can fill from the fleet of
1,000 horses as a chip event does.

## What it refuses

The release gate is re-read inside the transaction rather than trusted from the
decision, so the switch cannot open on a board that moved: no open critical
Diamond incident, suspense zero, the register and the supply equal, and cash
still closed. Any one of those aborts the whole transaction. Afterwards it
asserts tournaments open, cash still shut, and that the settings table still
holds exactly one row.

## The law

`tests/only-a-person-moves-the-arena-switches.law.test.ts` refuses a migration
that *defines a function* writing either switch, and admits exactly this shape:
"A migration's own statement, top level or in its DO block, runs once when a
person applies it; that is a person moving the switch and is not refused here."
This file defines nothing. The law is unchanged and still passes.

## Closing it again

A forward migration sets the column false. This file is not edited.

## Verification

The four preconditions were read before writing: zero open critical incidents,
suspense 0, register difference 0.00, `cash_games_enabled` false. All reads went
through `execute_sql` inside `BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ
READ ONLY`.
