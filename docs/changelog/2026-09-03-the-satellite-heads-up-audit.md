# The Satellite Heads-Up Audit

**Date:** 2026-09-03
**Scope:** everything shipped in #2878, swept adversarially for hidden bugs.

Dan asked for a deep sweep of the club-programme work before it is trusted.
Ten defects, three of them on money paths. None had cost a chip yet; four were
one constant, one column value or one refactor away from doing so.

## Money

**1. The elimination path knew one spelling of "satellite" and the finish path
knew two.** `TournamentManagerEliminations` priced places 2..N as cash unless
`variant === 'satellite'`, while `finishTournament` 1,860 lines later tested
`variant === 'satellite' || tournament_type === 'SATELLITE'`. The satellite
heads-up carries the second spelling, so it was priced for cash at elimination
AND paid its remainder by `processSatelliteAwards` - the exact double-dip the
first comment exists to prevent. Nothing was paid twice only because
`HEADS_UP_PAYOUTS` is 100% to place 1, so place 2 priced to zero. A two-place
structure on any satellite turns that into live money. Both halves now ask the
same three-part question, and `satellite_target_id` - the column that actually
means "this pays a seat" - is the third and most durable part. It is added to
the elimination query's select so the test can be made.

**2. A seat guarantee that was advertised and not funded.**
`fn_ca_fund_overlay_on_lock` is the trigger that backs a satellite's advertised
seats from the bank, and it fired only for `variant = 'satellite'`. The new
format advertises "1 Seat Guaranteed" in its own short description and would
never have been funded. Masked today because the feeder is priced so two
entries always cover one ticket; unmasked the moment a target's buy-in is
edited upward after the feeder opens, or a seat is refunded, because
`planSatelliteAwards` still promises the configured seat. Migration
`20260903204843`.

**3. Two payout sweeps that were safe only by delegation.**
`fn_pay_backed_payout_shortfalls` and `fn_tournament_payout_sweep` both exclude
satellites - "satellites award seats, not cash" - by variant alone, so both
took the new format as a candidate. Neither has mispaid, because both hand the
money to `fn_tournament_payout_reconcile`, which does check both spellings and
returns `skipped: satellite_awards_seats`. That is the reconciler's rule
protecting the sweeps' bug. Both now carry their own.

Proven before applying: across all 79,000 tournament rows, the widened
predicate reclassifies **zero** existing rows, so the change cannot touch
anything already played. Proven after, in a rolled-back transaction: a
satellite heads-up whose field covers the ticket funds nothing and the bank is
untouched; one whose pool covers half funds exactly one seat and stops.

## Play

**4. The leader folded aces.** `satelliteRead` is bubble arithmetic - how many
busts are still needed, how many blinds the stack can pay while they happen -
and it is meaningless two-handed. With one seat and two players `bustsNeeded`
is 1 so the bubble reads as near; `rank` counts stacks strictly greater, so at
equal stacks BOTH players rank 1; both then read `locked`, and `HorsePreflop`
folds anything costing 12% of the stack and refuses to open. A human who
simply jammed every hand would have taken the ticket. The satellite layer now
switches off at two players, where the only route to a seat is to win the duel.

## The drain

**5. Horses were walked out from under a person.** The retirement drain took
the first horse it found, once a cycle, human at the table or not - while every
other departure rule in that file protects a human's game. On a nine-handed
table that empties the person's game in twelve minutes and then strands them,
because `retireSurplusTables` refuses to close an occupied table and the fleet
refuses to re-seat a retiring one. Worse, every horse that cashes out calls
`notifyWaitlistSeatOpen`, so the drain would have offered the freed seats to
more people. A retiring table with anybody at it now simply stops draining and
closes when they are done.

**6. `auto_extension` could strand a retiring table forever.** A host's "do not
close my table" flag vetoed the close, so a flagged table would be drained to
empty, refused a re-seat forever, and then skipped by the closing UPDATE:
permanently empty, permanently open, invisible to every sweep. A retirement now
outranks it. (All twelve of today's batch carry `auto_extension = false`; this
is the trap closing before anyone falls in.)

**7. `claimOfferedSeats` could undo the drain.** It seats a horse from a
waitlist offer and never consulted `surplusTableIds`. Nothing had gone wrong
only because `pruneHorseWaitlist` runs earlier in the same cycle and clears
every horse row - an ordering coincidence between two independent methods, not
a rule. Now it is a rule.

**8. The fleet could annex another club's table.** `ensureAllTablesExist`
matched on NAME ALONE, platform-wide, then reopened whatever it found and
stamped the union's id onto it while leaving `club_id` pointing at the original
owner - rake routing to one club and discovery to another. The only thing
preventing it was that no user club happens to name a table the way
`DEFAULT_TABLES` does. It is now scoped to the union it creates for, and it no
longer reopens a table a club deliberately retired.

## What the player sees

**9. The SATELLITE badge was replaced by a false bounty badge.**
`detectTourneyType` tests the name and returns on first match, with `satellite`
last - fine while every satellite was named "Satellite to X", wrong the moment
a feeder carries its TARGET's name. A feeder into "Saturday Mystery" resolved
to `mystery`; the one fact that makes the prize a seat was dropped and a bounty
medallion the row's own columns deny was pushed instead. Satellite is decided
first now. The real bounty flags still come from the columns, which outrank it.

**10. Four surfaces treated a satellite duel as an MTT.** `TablePage` picked
the format with `tournament_type === 'SNG'` alone, so the satellite heads-up
fell through to `mtt`: the player's MTT felt, deck and button art instead of
their Heads Up set, "Poker Tournament" on the masthead, an MTT tab pill, and
the FINAL TABLE announcement armed on a two-handed game. Seat count is the last
word now, as it already is in `rakeRateFor` and every seat-first gate.

**Also:** a feeder no longer inherits its target's speed label (one game read
"Deepstack" in the lobby and "Hyper" on the details page, while actually
running a 300-chip turbo), and the Satellites tab no longer offers a Register
button that the server refuses every time - a seat-first game gets "Take A
Seat", which opens its table.

## Verification

Server 4,764 of 4,764 and client 12,129 tests green on a clean checkout of
merged `main` with these changes applied; both typechecks clean. Four pin tests
that described the old behaviour were rewritten to the new rule rather than
deleted.
