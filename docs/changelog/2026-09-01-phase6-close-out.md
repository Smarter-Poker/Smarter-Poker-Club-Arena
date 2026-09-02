# Phase 6 close-out - every item, the regressions the full suite caught, and one revert

2026-09-01. Branch `phase6/seat-fill-and-headsup` (consolidated).

This branch carries the whole of Phase 6. The seven earlier Phase 6 branches
were stacked or independent and all seven are merged into this one lineage, so
there is a single reviewable diff and a single CI run instead of eight that
conflict on `SpinWheel.tsx`, `TablePage.tsx` and `docs/LAWS.md`.

## Every item

| #   | Item                                         | State                                                                                                                      |
| --- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| 1   | Spin card said "300 chips / Turbo"           | fixed - prints the stack RANGE from `SPIN_TIERS` until the wheel turns                                                     |
| 2   | 100x celebration two-thirds invisible        | fixed - spread and delay derive from the real piece count                                                                  |
| 3   | One tile's wheel blanked all four            | fixed - scoped to its tile, still plays on an inactive one                                                                 |
| 4   | 14 seconds of dead felt                      | fixed - the wheel holds until the engine deals, with a live count                                                          |
| 5   | Late arrival got a flicker then nothing      | fixed - mounts into the result                                                                                             |
| 6   | Animation Speed did nothing to the wheel     | fixed - in the clamp                                                                                                       |
| 7   | Fallback wheel ran off a different column    | fixed - one deadline from one spec                                                                                         |
| 8   | Play Again onto a full table                 | fixed - capacity checked, dead query string removed                                                                        |
| 9   | Nothing said what the prize was              | fixed - badge reads `4x │ 40`                                                                                              |
| 10  | Paid 2nd/3rd through the bust door           | fixed - celebrated and held like a win                                                                                     |
| 11  | Heads-up never announced on a Spin           | **REVERTED - see below**                                                                                                   |
| 12  | Accessibility                                | fixed - no `aria-modal` without a trap, no `role="table"` over divs, and the buy-in sheet now has the whole focus contract |
| 13  | Short viewport clipped the reveal            | fixed - height media queries, scrollable buy-in sheet                                                                      |
| 14  | No seat-fill indicator                       | fixed - one indicator, both footers, no invented ETA                                                                       |
| 15  | Registration retried with no idempotency key | fixed - a retried "already registered" is adopted                                                                          |

## Item 11 is reverted, and the reason is a standing ruling

I built it: a Spin ran the same authoritative heads-up check and got a quiet
state-driven pill instead of the blocking takeover.

Then the full suite went red on `tests/unit/headsUpIsAnnounced.test.ts`, which
carries this:

> Dan 2026-08-23: "you never have to announce 'heads up' with an animation or
> final table on a spin" - it is three-handed from the first card.

A quiet static pill is arguably not "an animation or final table". That is
exactly the reading that would let me talk myself past a ruling Dan already
made, and this repo has been burned twice by an agent reinterpreting his words
narrowly (CLAUDE.md 10.7, the hamburger revert war). CLAUDE.md 10.8 rule 1 is
explicit: when a change collides with a standing law, STOP and ask - never
write a third law, never delete the other side on your own authority.

So the exclusion is restored exactly as it was, the pill and its CSS and its
law test are gone, and the question goes to Dan:

**The audit says a Spin never acknowledges becoming heads-up. Your 2026-08-23
ruling says it never has to. Do you want a quiet, non-animated marker there, or
is the silence deliberate?** Either answer is one small change.

## Five regressions the full suite caught, all fixed here

Worth naming, because four of them were mine and the targeted suites were green:

1. **`spinSpec` client/server copies must be byte-identical.** I added
   `spinStartingStackRange()` to the client copy only. Two separate tests exist
   to catch exactly that, and both fired. Mirrored.
2. **`headsUpIsAnnounced`** - the item 11 collision above.
3. **`lobbyMobileCards`** pinned "calls a 300-chip spin a turbo", which is the
   bug item 1 fixes. Deliberate replacement, so the pin moved in the same
   commit (rule 8) and now asserts the rule instead: an undrawn Spin has no
   depth label, a drawn one reads the column exactly as before.
4. **`gameplay-wears-the-house-colours`** - my seat-fill dots used `#22c55e`.
   The house green is `#3fb950` and one test keeps all 47 literals honest.
   Changed.
5. A **stale-state gap I found myself**, not a test: `spinPrizePool` is
   captured from one tournament and this component survives the next one
   starting on the same table - Spins recycle a table in seconds. Without a
   reset the badge would carry the PREVIOUS game's prize into the new one until
   its wheel finished. Wrong in the most believable way possible: a number that
   looks right. Cleared on `tournamentId` change, and pinned.

## One thing I wrote and then deleted, on purpose

While this branch was in flight another agent shipped `src/hooks/useFocusTrap.ts`
on main - the same hook, at least as complete as the one written here (it also
handles focus sitting on a non-focusable part of the modal, which mine did
not). The merge conflicted on that file.

Main's copy is the one that survives. Mine is deleted rather than kept beside
it under another name: two focus traps is the shape of problem CLAUDE.md 10.7
is about, and RULE 12's "write into the canonical thing" applies to a hook as
much as to infrastructure. The buy-in sheet is wired to theirs, and the law
test now pins the CONTRACT - first focus in, Tab wrapping both ways, focus
restored, and no Escape handling inside the hook - rather than my
implementation of it.

## main was red before I got here, and is not any more

`server/src/services/GtoAggregationFloor.test.ts` has been failing on
`origin/main` since 2026-08-30. Verified in a pristine detached worktree of
`origin/main`, so this is not a regression from any of the work above -
CLAUDE.md rule 8 says fixing a red main comes first, and you cannot ship past
it in any case because the server suite is a required check.

The guard is right and the failure is true:

> the newest migration DECLARING the aggregator's batch clamp is
> `20260830053917_v30_revert_lateral_optimization_it_was_slower.sql`, and it
> declares `greatest(200, ...)` while `GtoAggregationDriver` sends 100.

That is exactly the clobber #1855 wrote the guard for. The lateral-optimization
revert restored the whole function body from a copy predating #1849 and carried
the old floor back with it. A floor above what the driver sends rounds every
call up to 200, which is the measured timeout cliff - about 8 seconds, one call
in three cancelled with 57014.

**But production is already correct.** Read live:

```
v_batch integer := greatest(25, least(5000, coalesce(p_batch, 1500)));
```

Somebody patched the live function surgically - reading `prosrc` and replacing
the text, which the guard's own comment calls the safe way to touch it while
other agents are shipping - and never recorded a declaration. So the database
has been right and the repository has been lying about it for three days, with
the guard correctly shouting and every server test run red for it.

`20260902020000_v30_batch_floor_declaration_matches_production.sql` is the
repository catching up: `pg_get_functiondef` of the live function, byte for
byte. It is deliberately NOT applied by hand - there is nothing to change, and
the only effect would be a PostgREST schema reload, about 28 seconds on this
database, which 503s live traffic (the DDL policy written after the 2026-08-31
PGRST002 outage). It applies harmlessly on the next migration push.

## Two more live stalls, found by looking at production rather than at the diff

Both are the Phase 4 family and neither was covered by what Phase 4 shipped.

### A manager that has held a finish for fifteen minutes is not finishing it

`Sunday Deep Stack Satellite $10` (e210486c) at 01:05 UTC: variant satellite,
23 entrants, **207 chips of prize pool**, 448 hands dealt, ONE survivor, ZERO
payout records, sixteen minutes in COMPLETING - and **not one incident naming
it in two hours**. Every branch of the stuck-COMPLETING recovery reports;
silence is what proves it was never reached.

The recovery skips any row a `TournamentManager` still holds. That is right for
the seconds a finish takes and was unbounded after that, so a wedged manager
held its row out of reach of the only thing that could rescue it.

Past three times the dwell (15 minutes) the manager is stopped, dropped, and
the row goes to the recovery - which is idempotent and shares its ledger keys
with the finish path, so a manager that wakes up mid-rescue cannot double-pay.
A row never seen before is never called wedged, so a first sighting cannot tear
a manager off a healthy finish.

### Two players, two tables, nobody can deal

`$100 Freeroll - 6:00 PM` (f1b134c0) at 01:20 UTC: RUNNING, 314 hands then
nothing for 35 minutes, two players still playing, two live seats, and **two
OPEN tables with one player on each**.

Nothing is orphaned, so the closed-table repair plans nothing - and neither
table can deal, because a table needs two. This is the balancer's job and the
balancer had not done it for thirty-five minutes.

`planStalledConsolidation` brings the field onto one table. Moving a player off
OPEN felt is dangerous in a way that moving one off a closed table is not - a
hand may be in flight and `executePlayerMoves` reads the seat stack, which is
the 2026-07-19 pre-hand-stack incident - so the stall is the entire licence and
it is proved by a bounded read of `hand_history`, not assumed. An unreadable
answer is NOT a stall.

It refuses on every axis that could put it on a game which can still play: no
stall, one table, ANY open table already able to deal, a player holding two
live seats, or a field that does not fit on the destination. The destination is
the most populated open table, so the fewest people move.

## Verification

- `npx tsc --noEmit`, client and server: clean.
- **Full client suite: 818 files, 11,226 tests, all green.**
- Full server suite runs in CI on this pull request.
- 9 new law tests across Phase 6, all registered in `docs/LAWS.md`.

## Still not verifiable from here

No logged-in browser session is available to this agent, so everything visual -
the confetti spread, the seat-fill dots, a wheel inside a tile, 375px landscape,
and how any of it reads in a screen reader - is argued from arithmetic and
markup rather than from having looked at it. That is the one gap this work
cannot close on its own.
