# 2026-08-31 - MTT Phase 5: a satellite seat is a payout

Phase 5 of 7. Phase 3 gave every tournament payout an authoritative record and
Phase 4 made the reconciler read it. Phase 5 finds the one thing of value that
still moved without writing one, and one place where "I cannot tell" was being
answered as "no".

## 1. The one outcome worth something had no record

Every FAILURE path in `processSatelliteAwards` pays cash through
`fn_credit_and_log`, so Phase 3 already evidences all of them: target closed,
seat refused, seat already held, remainder to the next finisher.

The SUCCESS path did not. A player actually receiving a seat moves real value -
the target's `prize_pool` grows by a buy-in, a `rake_records` row is written,
a registration is created - and left nothing in `tournament_payouts`. An audit
query asking "what did this satellite award?" could see every consolation prize
and none of the seats. 19 seats have been awarded this way.

`fn_award_satellite_seat` now writes the record inside the same transaction and
the same `FOR UPDATE` row lock that seats the player, so **the record exists if
and only if the seat does**. Keyed `tourney:{satellite}:seat:{user}` with
`ON CONFLICT DO NOTHING`, so a recovery re-drive writes nothing new.

Its `source` is `satellite_seat`, deliberately **not** one of the sources
`fn_tournament_payout_reconcile` counts. A seat is funded by the satellite's
collected pool buying a ticket, not by its `prize_pool` paying a place; counting
it as structure cash would make every satellite read as a massive overpay - the
exact artefact Phase 4 measured at 7 events and 870.00.

Failure to record must never unseat a player, so the insert is wrapped and any
error becomes a `critical` row in `financial_alerts` instead of an exception.

`tournament_payouts` gains a `metadata jsonb` column, because a seat award has
to name the target it was awarded into and the registration it created, and
putting either in `payout_structure` would make that column mean two things.

## 2. An unknown origin is not a "no"

When the seat INSERT hits `unique_violation` the player already holds the target
seat, and the caller has to choose between two very different things:

```
THIS satellite seated them, this is a recovery re-drive  -> pay nothing
ANOTHER satellite seated them, this one owes them cash   -> pay the ticket
```

`source_satellite_id` decides it, and this function only began writing it on
2026-08-30. **All 19 seats awarded before that have it NULL.** The old
expression

```sql
(v_existing IS NOT NULL AND v_existing = p_satellite_id)
```

collapses NULL to FALSE, which is the "a different satellite seated them"
answer - and answering an unknown with the branch that MOVES MONEY is the wrong
direction. A player really seated by this satellite would be handed the ticket
value in cash on top of the seat they already hold. 13 satellites were live when
this was written.

It now returns NULL for unknown and adds `origin_unknown`. The engine's check is
`=== false`, so NULL already falls through to the branch that pays nothing - the
safe direction - and `TournamentManager` now raises a `warning` alert
(`Satellite.seat_origin_unknown`) instead of logging a seat award that did not
happen.

A missed payment is visible and recoverable. A double payment is neither.

**Checked for damage already done:** four players hold a satellite-won seat and
also took satellite cash. None is a double pay. Three were paid in the same
instant on 2026-08-30 by the documented back-pay migration; the fourth was paid
six days BEFORE they won their seat.

## The overload trap, walked into on the day it was documented

`p_position` was added with `CREATE OR REPLACE`, which cannot add a parameter: a
different argument list is a different function. It created a second overload
and left the four-argument form standing. PostgREST resolves an RPC by ARGUMENT
NAMES, and the engine passes exactly the four names both accept, so **every
satellite seat award would have failed with "function is not unique"** while 13
satellites were live.

This is the identical trap written down that morning in
`20260831133423_every_prize_writes_its_own_evidence.sql`, where the DROP was
deliberate. That note is the only reason this was caught within a minute rather
than by a player failing to receive a seat.
`20260831192947_drop_the_four_argument_satellite_seat_overload.sql` removes it.

## 3. A blind spot recorded rather than closed

`v_spin_unpaid_settlements` begins `FROM draw d JOIN tournaments t`, where
`draw` is spins holding a `jackpot_draw` row. An INNER join means the view -
and `fn_spin_unpaid_check`, which alerts hourly, and
`fn_backpay_spin_unpaid_winners`, which pays - can only see a spin whose
multiplier needed the reserve. A 2x or 3x spin is funded by its own three
buy-ins and never draws. **4,590 of 34,567 completed spins were invisible to all
three by construction.**

The gap is real. It is also worth exactly **0.00 chips**: every one of those
4,590 is CANCELLED with no finisher in first place. There is nobody to pay.

Closing it made things worse, twice:

| attempt                                              | result                                                                                                                                                                                           |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| LEFT JOIN the draw, fall back to `prize_pool`        | all 4,590 cancelled events read as 21,329 short. `fn_spin_unpaid_check` raises one critical alert PER event: 4,590 criticals for money nobody is owed.                                           |
| scope the new arm to COMPLETED with one recorded 1st | correct (0 rows, 0 payable) but materialises a seat aggregate over 197,524 `tournament_players` rows, and `fn_backpay` reads the view three times per run. **It stopped completing inside 60s.** |

A detector that cannot finish is worse than a blind spot over a debt of zero, so
`20260831193833` restores the original view and the file is the record of why.
Both superseded migrations are recorded in production
(`20260831193301`, `20260831193522`) and have no separate repo file, because
their net effect on the schema is nothing.

What covers it meanwhile: `poker_tournaments_unpaid_completed` from Phase 2,
which is format-agnostic - it asks whether a COMPLETED tournament with a prize
pool has any prize payment at all, and does not care about the reserve. It is
what caught the one genuinely unpaid Spin winner earlier today, ten minutes
before the inline reconciler settled it.

Anyone widening this later: fix the cost first. The seat aggregate is what makes
it unaffordable.

## Proven, not asserted

Money paths were probed inside a rolled-back transaction, per `CLAUDE.md` 11.5:

```
award    = {"ok": true, "awarded": true, "prize_contribution": 200.00, "rake": 20.00}
pool     0 -> 200.00 on the target
record   = src=satellite_seat amt=220.00 pos=1 recby=award_satellite_seat
re-drive = {"awarded": false, "held_from_this_satellite": true,  "origin_unknown": false}
unknown  = {"awarded": false, "held_from_this_satellite": null,  "origin_unknown": true}
records  = 1  (the re-drives wrote nothing)
```

Live in production after apply:

```
fn_award_satellite_seat overloads      1
signature   p_satellite_id uuid, p_target_id uuid, p_user_id uuid,
            p_username text, p_position integer
tournament_payouts.metadata            present
seats all time / unknown origin        19 / 19
fn_backpay_spin_unpaid_winners(false)  {"ok": true, "owed_before": 0, "owed_after": 0,
                                        "winners_paid": 0}   -- completes again
v_spin_unpaid_settlements              0 rows
```

## Tests

`aSatelliteSeatIsAPayout.law.test.ts` - 14 pins, including that the seat record
is written inside the seating transaction rather than by the caller, that
`satellite_seat` never appears in the reconciler's structure filter, that NULL
`source_satellite_id` yields NULL rather than FALSE, and that only the
five-argument form of the function exists.
