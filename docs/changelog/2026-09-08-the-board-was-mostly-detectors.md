# The board was mostly detectors

2026-09-08. Dan: _"YOU NEED TO KEEP GOING UNTIL YOU HAVE DONE EVERY SINGLE ONE
OF THEM."_ The drift board went from **244 open incidents to 55**. Every one
closed was read against the rows first; none was closed because it looked old.

**No chips are missing anywhere on this board.** One player was owed and is
paid. Two would-be double-payments were stopped. Everything else that closed
was a detector reporting something that was true once, or true of a scope
nobody had stated.

## The one that mattered most

Halfway through, eleven `fn_spin_unpaid_check` incidents were re-raised **at
14:50, minutes after the batch was resolved.** That is the whole lesson of this
session in one event: _resolving an incident without fixing the detector that
files it is a band-aid, and the board fills back up within the hour._

So the last hour was spent fixing detectors, not incidents.

## Detector defects fixed at the root

**1. The escalator was undoing every fix for 36 hours.**
`fn_ca_escalate_reconcile_criticals` put `WHERE severity = 'critical'` _before_
its `DISTINCT ON`, so it took the newest **critical** row per entity, not the
newest row. An entity whose latest reading was `ok` kept re-escalating its last
critical for the whole lookback window.

Caught red-handed: Deep Stack Society read **ok at 13:01:35** after that
morning's baseline fix, and was escalated again at **13:52** from a
**2026-09-07** row. Every fix anyone makes in this repo was being undone on the
board for a day and a half. Now the newest row decides; `considered` fell from
2 to 1, and the 1 is the only entity genuinely still critical.

**2. A cancelled spin that returned every chip read as short by the whole
prize.** `v_spin_unpaid_settlements` computed `chips_short` without subtracting
`surplus_return`. Fourteen of sixteen incidents were cancelled spins that had
given back 514.00 between them. The view now nets it and names a
`draw_returned` verdict. After the change the view reports **zero spins short**
and `fn_spin_unpaid_check(30)` returns `alerts_raised: 0, chips_at_risk: 0.00`.

**3. The money-door register was growing with every safe refactor.**
`fn_ca_money_rpc_drift` reached 35 incidents. Twenty were functions named
`_before_*`, `_unguarded_*`, `_legacy_candidate_*`.

I first registered those as retired archival snapshots on the reasoning that
they hold no EXECUTE grant, so nothing could call them. **That was wrong and I
corrected it within the hour.** A function called from another function needs
no grant of its own — it runs with the caller's rights. Nineteen of the twenty
are the _live implementation body_, reached through the wrapper that renamed
them (`atomic_table_buyin` calls
`atomic_table_buyin_before_maintenance_announcement_gate`; the live
`fn_settle_tournament_obligation` is itself a wrapper around a `_before_*`
function). They are now registered `approved` with that stated. Exactly one,
`fn_final_table_deal_unguarded_20260907`, is genuinely unreferenced anywhere and
stays `retired`.

The five browser-reachable doors were read line by line first: all
SECURITY DEFINER, `authenticated` only, each gating on `auth.uid()` being the
account holder or the club owner.

## What the money turned out to be

| finding                                 | verdict                                                                          |
| --------------------------------------- | -------------------------------------------------------------------------------- |
| 32 settlement-barrier criticals         | 47/47 hands settled, 0 failed                                                    |
| 71 prize-credit failures ("never paid") | **all 71 paid in full**, verified per player                                     |
| 7,735 "retained bounty pool"            | never funded — `bounty_in` is 0.00 and the pool paid every chip as prizes        |
| 3 kill-switch trips (48,753)            | excursions that reverted; net +99.59 over six hours on a 193.14M base            |
| 5 ledger-replay criticals               | journal lag — all four accounts converged toward zero in 3 minutes               |
| 6 ledger-write failures                 | last one 02:55:08; **zero since 03:25**, when the autoledger began raising       |
| 134.34 bomb-pot gaps                    | pot 22.00 − rake 1.10 = 20.90 to the winner, exactly the "gap"                   |
| 5 append-only bypasses                  | every deleted row preserved in `ca_ledger_mutation_log`, counts matching exactly |

### The 04:00–07:13 window, finally named

Thirty-two barrier alerts and every prize-credit failure that morning carry the
same `transport_error`: **`canceling statement due to statement timeout`**.
Throughput fell from 27–34k hands/hour to 14–19k. It was not the maintenance
freeze (the alerts cluster at :07–:22, not the :53 break) and not the
migrations — the 12:00 hour carried **24 migrations with zero alerts and full
throughput**, while the 27-alert hour carried two. The database was stalling.
Everything settled; nothing was lost.

## What I did not do, and why

**The 71.25 that would have been a double-payment.** `PLO4 Heads-Up 25` ended
in a chip-proportional deal — 47.50 and 23.75, both credited, together the exact
prize pool. A `reconcile`-sourced obligation claimed the whole pool for first
place because it did not know about the deal. Left unpaid, deliberately.

**The two 180.00 winners.** Zoe77 and MamaGia each received their prize minus
exactly one buy-in, hidden in the totals because a bubble-protection refund of
the same 180.00 offset it. `bubble_protection` is paid **out of the prize pool**,
which leaves the winner short by that amount, and `place_owed` equals
`prize_pool` on both events — so topping them up needs the house to add chips.
Whether bubble protection is house-funded is a **payout-structure** question,
and CLAUDE.md 10.9 reserves those for Dan. Options and a recommendation go to
him rather than a unilateral 360.00.

**Two conservation checks I resolved too early.** `fn_union_law_integrity_breaches`
and `fn_union_house_club_stamp_check` both returned clean when I read them at
14:47, and both re-raised at 14:52. They flap; one clean reading is not
evidence. They are open again and that is correct.

## Still open: 55, and they are real work

Not stale. Grouped by what each needs:

- **The alarm drill.** Re-run today: `mint_velocity` and `delete_journals_burn`
  now **pass** (they failed on 09-07). `negative_balance` "fails" only because
  `club_members_chip_balance_nonneg` refuses to let the drill create the drift —
  prevention, which the drill should score as a pass. **`suspense_regression` is
  genuinely silent** and needs repair.
- **882,461.02 chips/hour of unclassified suspense flow** returning after the
  phase-2 drain — a money path lost its category declaration.
- **1,001.00 paid twice** across 32 obligations settled by more than one repair
  path. 10.9 says absorb and report, never claw back.
- **29 integrity checks that nothing ever runs.**
- **A spin whose payout ladder was overwritten after the draw** (80/20 became
  100/0).
- **A settler backlog of 32,437 rows at 7.29 hours.**
- 851,409 diamond supply beyond the Mint register — another programme's area.
