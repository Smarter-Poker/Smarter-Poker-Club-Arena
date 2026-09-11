# The horse finish line: the games that could not end, the band that ignored its host, and the rule with no reader

2026-09-11, after the horse audit (#4322) and its database half (#4327).
Three things the audit found and left open, finished here.

## 1. Forty games dealt on 2026-09-08 could never end

Settlement starts from RUNNING. REGISTERING to RUNNING belongs to the atomic
launch completion RPC, and `fn_refuse_new_entries_while_frozen` refuses any
other route - correctly; the audit's proposed migration flipped the status
directly and was refused when it was probed. So the only way to pay these
winners was for that RPC to be able to complete the launch their engine never
committed, and for the engine to offer it one.

Neither half worked, and both were measured rather than guessed.

**The database refused, 31 of 40, with `launch_roster_unproven.`** The roster
proof is written for a field that has not played yet: every entrant still
'playing', at least `GREATEST(2, LEAST(3, max_players))` of them. These fields
have since shrunk to their survivor. One more, "Breakfast Turbo", failed
`launch_tables_unproven`: it had broken and closed three tables while it played
(58, 27 and 49 hands behind them) and the table scan had no status filter, so a
correctly closed table read as an invalid one.

Migration `20260911173003` adds `fn_prove_played_launch_recovery`, the general
form of an escape that already existed for one narrow case
(`fn_prove_played_spin_launch_recovery`, a paid spin with exactly two
survivors). It requires, in order: a finalized pool, at least one hand dealt,
THIS receipt's `started_at` equal to the moment of that first hand, no entrant
in a pre-deal status, a dealt field that met the requirement, and every
survivor holding a live seat. And the table scan now ignores closed tables
while asserting at least one live one.

Probed before applying, all 40 through the sanctioned pair in a rolled-back
transaction: **40 of 40 complete.** Negative cases in the same transaction: 25
healthy REGISTERING rows on the live board, 0 accepted; a receipt naming the
wrong moment, refused; a NULL receipt moment, refused.

**The engine never offered them.** `GameServer`'s start gate has two arms and
both count a field that has not played: `seatFirstReady` wants every seat sold,
`timeReached` wants `current_players >= min_players`. Measured across the
forty: seventeen at 1 of 2, twenty-two at 1-2 of 3, one MTT at 2 of 4. Not one
satisfied either arm. The comment above the gate said the gate recovered
exactly this case. It said so for three days while the games sat there.

There is a third arm now. It is about a finalized pool and a clock that has
passed, it may not read a seat count or a registration counter, and it is
throttled to one offer every five minutes because a refusal is a stable
answer. The engine proposes; the database decides on evidence it holds.

## 2. A horse was banded by a floor it cannot reach

`bandSupply` was the union of every open table on the platform, and a horse
sits only where it holds a membership. Deep Stack Society deals micro, low, mid
and high; Midway Union deals micro, low and mid. One Deep Stack 25/50 game
therefore answered "yes, 'high' has a game" to every Midway horse, whose band
would never step down and whose every Midway table refused it.

The assignment was fixed in #4327 (the SQL projects onto the horse's own
hosts). This is the engine half: `applyStakeBandSupply` takes a per-host map,
`effectiveStakeBandFor` and `stakeBandAllows` take the host being asked about,
and the fleet builds the map in the scan it already runs. A host nobody
published supply for falls back to the platform answer rather than refusing
every band, because narrowing on ignorance is how a fleet disappears.

## 3. A rule with no reader is not a rule

Section 9 of the OPORD: a horse that leaves a game does not buy straight back
into it. Everything for it existed and none of it was connected. The column
`two_hour_window` was written every cycle (4,894 entries live, 544 inside the
window), `inTwoHourWindow` existed, `TWO_HOUR_WINDOW_MS` existed, and nothing
anywhere asked the question. Two audits found it as "no live caller" and each
offered "wire it, or delete the column write".

It is wired, at the sit gate, beside the rest day and the sit cap - the two
rules of the same kind. It is an identity check rather than a money one, so it
still applies when the bankroll could not be read, and it is asked before the
sit cap so the more specific refusal is the one reported. `two_hour_window`
joins the existing per-reason refusal counts, so what it costs the floor is
visible in the cycle line from the first pass.

CLAUDE.md 10.5: this is not a horse-only restriction. A human decides when to
sit; a horse has no browser, so the Stable Hand decides for it, which is the
sanctioned horse branch. Choosing not to re-enter a game you just left is the
same class of choice as a rest day or a persona's sit cap.

## Left documented, deliberately

Two P3s the audit recorded and this pass did not change, both measured at zero
occurrences today and both only ever wrong in the safe direction:

- the fleet's four-game mirror counts a seat at a closed table while
  `fn_concurrent_game_load` does not. It can only hold a horse back, never let
  one through, and a closed table with a live seat row is itself a defect that
  `ca_seat_stack_exits` already watches. The real fix is to stop keeping a
  second copy of that rule in the engine, which is a larger change than this.
- the departure cap is spent in table-id order, so a busy cycle can starve high
  ids. It binds only when more than four certain departures coincide.

## 4. Fourteen thousand hands played without a decision

Found by one of the alarms shipped this morning. `HorseDecisionFallbacks` went
critical and paged: horses were taking the legal check or fold because their
decision never arrived.

Read off engine-01 at 20:2x UTC, 470 tables dealing and 2,646 horses seated
after the day's fixes put them back on the floor:

| gauge                                                 | reading                        |
| ----------------------------------------------------- | ------------------------------ |
| `poker_event_loop_delay_p50_ms` (main)                | 309                            |
| `poker_main_event_loop_governor_scale`                | 0.2, already shedding          |
| `poker_horse_decision_worker_event_loop_delay_p50_ms` | 22                             |
| `poker_horse_decision_worker_last_compute_ms`         | 0.07 to 337                    |
| `poker_horse_decision_worker_queue_depth`             | ~520                           |
| `poker_horse_decision_worker_oldest_queued_age_ms`    | ~8,200, pinned at the deadline |
| `poker_horse_decision_worker_expired_jobs`            | +49 per second                 |
| `poker_horse_decision_fallbacks_total`                | 13,973                         |

The worker was not busy. Its own loop ran at 22 ms while the queue drowned,
because every job pays a round trip through the MAIN loop, which was at 309 ms.
A lane that keeps four jobs posted finishes about `4 / 0.309` = 13 a second
against that round trip, so the queue sat 520 deep with its head at the
8-second caller deadline and ~49 decisions a second EXPIRED. An expired
decision is a seat taking the legal check or fold without thinking.

`DEFAULT_MAX_IN_FLIGHT` is 32. The depth is the lane's throughput, and 4 was
derived when the round trip was small and ~185 tables were dealing. Nothing
else moves: FIFO ownership, CANCEL on abort or expiry, the integrity clock
starting at the head of the posted FIFO and the dispatch barrier are all
independent of the depth, and their pins are untouched. `status()` now reports
`maxInFlight`, because an operator watching 520 queued had no way to see what
the lane was configured to sustain.

**This is not a capacity fix and must not be read as one.** engine-01 is three
cores, its main loop is genuinely saturated at 309 ms with its own governor at
0.2, and the floor roughly doubled today (horses seated 1,470 to 2,646, tables
with horses 705 to 1,187) because the rebuy door, the registration door and the
re-tag all put horses back on it. This stops the decision lane being serialised
behind that saturation. It does not create headroom that is not there, and
`EngineCoreOutOfHeadroom` is pending on that box as this is written.

## 5. The floor configuration, and the one thing that is Dan's

- **The tagger was re-run** (`horses:tag --club=all --force`), which the audit
  had left as "TO LAND IT". Its host-aware draw is what the fix was for.
  Stranded bodies - horses whose every tag names a game their own host does not
  deal, so they can sit nowhere - went **58 to 0 on Midway and 2 to 0 on Deep
  Stack**. Midway's average reachable games per body went 5.15 to 5.96 and its
  bodies with fewer than four went 254 to 196. `tagged_at` is now stamped; it
  had read 2026-09-04 on all 1,580 rows while the values were from a later run.

- **Dan's 2026-09-03 standing order is now fully executed.** One cash game
  above 2/5 had survived it: NLH 25/50 on Deep Stack, dormant, one open table,
  zero seats sold. It was also the only reason `fn_available_stake_bands()`
  answered 'high' to every Midway horse. Disabled, with the reason recorded in
  `cash_cluster_events`. There are now no cash games above 2/5 anywhere, and
  every band answer reads `{micro, low, mid}`.

- **Deep Stack action and madness templates: created, and held back.** The
  audit's finding 3 was that Deep Stack runs one template per (variant, rung)
  while Midway runs three, so 66% of Deep Stack bodies can never reach four
  games and "4 tables at once" is unreachable there by any seating code. The
  sixteen rows exist (`fn_cash_game_ensure`, nlh/plo4/plo5/plo6 at 1/2 and
  2/5), and the probe measured exactly what they buy: bodies with fewer than
  four reachable games **192 to 115**, average reachable games **2.94 to 4.31**,
  which crosses the line Dan's rule asks for. They are `enabled = false` right
  now, one UPDATE from live, with the reason in `cash_cluster_events`, because
  each one opens a table and engine-01 has no room for sixteen more.

  So the remaining half of "4 tables at once" is not a configuration question
  any more. It is a box: three cores, a main loop at 309 ms, a governor already
  at 0.2. The rows are staged for the hour that box gets bigger.

- **Occupancy needs no ruling.** The audit escalated `CASH_FULL_FRACTION = 0.75`
  against the curve's 40% peak as two written rules in conflict. Measured this
  evening the floor is at **74.7% of seats on Midway and 69.7% on Deep Stack**,
  so the two agree in practice and no constant needs changing. The half that is
  genuinely unmet is tables per body (2.2 to 2.4 against 4), and that is the
  box, above.
