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
