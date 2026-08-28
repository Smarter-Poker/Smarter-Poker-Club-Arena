# The unranked, the unfunded, and the undead cron

Session 2026-08-28, second pass. Everything below is applied to production and
verified by a second measurement.

## 1. 1,013 players had no finishing position. All of them do now.

146 COMPLETED tournaments (oldest 2026-05-11, newest 2026-08-25) still held
players at `position IS NULL`. `guard_completed_ranks_survivors` fixed the
source this morning but is a BEFORE UPDATE trigger, so it could never reach an
event that had already finished.

This is not cosmetic. `fn_tournament_payout_reconcile` will not pay a place
whose holder is unknown, so it refused, filed a critical alert, and the money
stayed where it was. **129 of the 146 events owed 32,439.50 chips to players who
finished in the money.**

Ranked all 1,013 with the canonical `fn_rank_survivors`. **Backlog is 0.** The
class is closed, not leaking - nothing has joined it since the trigger landed.

### The last 4 rows exposed a guard that never let go

`fn_refuse_zero_chip_field_elimination` protects a live table: if 2+ players are
still `playing` and all read 0 chips, the stacks have not been credited and
nobody really busted, so it returns NULL and drops the write. Correct while an
event is running.

It never checked whether the event was over. For a tournament that finished
weeks ago nothing is going to credit those stacks, so the guard fired forever,
those players could never be ranked, and their places could never be paid.
**Refusing to bust somebody in a finished tournament does not protect them; it
withholds their money.** And it did it silently - a BEFORE trigger returning
NULL is indistinguishable from "nothing matched", which is why
`fn_rank_survivors` reported 0 rows ranked while looking straight at 2 free
places and 2 survivors to put in them.

It now releases on terminal status, and says so at WARNING level. Live behaviour
is unchanged.

## 2. The 32,439.50 was NOT paid as one number

Split by whether the pool actually holds chips:

|                                     | events | chips                    |
| ----------------------------------- | ------ | ------------------------ |
| backed by money the event collected | 15     | **1,026.70 — paid**      |
| drawn on an already-overdrawn pool  | 114    | **31,412.80 — withheld** |

The rule is per event and strict: pay only where `delta >= total_top_up`. Not
`delta >= 0`, which would let an event with 3 chips spare pay out 300.

Withholding is the whole point. Those 114 pools are set to an advertised
guarantee that no overlay row ever funded - the pool is a number on a row, not
chips in a wallet. Topping a place up out of one **mints** the difference: the
exact act the conservation sentinel exists to catch, performed by the repair
meant to fix it. Verified: overdrawn events among the set were 103 before and
103 after.

## 3. A cron that had never once done anything, failing loudly every 10 minutes

`tourney_auto_settle_completed` ran `auto_settle_completed_tournaments()`, which
reads `club_tournaments` and `tournament_entries` - neither exists here. Every
run threw and refiled a critical alert reading "Completed tournaments are NOT
being auto-settled."

The alert was right about the failure and wrong about the stakes. Read the body:
even against the correct tables it only does `UPDATE ... SET updated_at =
NOW()`. It settles nothing, pays nothing, books nothing.

Three real settlement paths already work (`fn_settle_tournament_rake` per event,
`fn_sweep_unsettled_tournament_rake` hourly, `fn_tournament_payout_sweep`
daily). So it is **retired, not repaired** - rewriting it would have created a
fourth competing path, which RULE 12 forbids. The migration asserts the three
real paths still exist, so retiring the no-op cannot be the thing that removes
settlement.

## 4. Two agents disagree about 453,571.88 chips. Dan has to break the tie.

Splitting every unconserved event by whether the overlay-funding mechanism
existed yet:

| era                                                  | events | chips minted   | had a guarantee |
| ---------------------------------------------------- | ------ | -------------- | --------------- |
| **A** — before funding existed (to 2026-08-27 05:45) | 14,126 | **453,571.88** | 2,651           |
| **B** — after funding existed (06:09 onward)         | 146    | **2,641.74**   | 5               |

**Era A is settled policy — twice, in opposite directions.**
`20260827f_overlay_union_bank_first_with_history` states plainly: _"Historical
minting is NOT retroactively charged to any bank: those pools are settled and
long since paid out to players."_ The amnesty clause inside
`fn_tournament_conservation_delta` was how that decision was encoded. This
morning at 02:20 a different agent applied
`watchdog_remove_conservation_delta_amnesty`, which stripped it out — and at
02:24 the newly-scheduled sweep filed **1,006 alerts nobody can action**.

Neither agent was wrong on its own terms. The amnesty was a magic date literal
buried in a delta function, which is a bad way to encode a policy; removing it
without knowing the policy existed turned a quiet decision into a permanently
red queue. **Nothing here should be funded or forgiven until Dan says which it
is.** Note the union bank (`unions.chip_balance`) is 0.00 and Midway Union's
treasury is -4,455.60, so "just fund it" is not available for the 269,629.94
that sits under Midway.

## 5. Era B is not a leak. It is Spin, unbanked.

Of era B's 2,641.74, **141 events and 2,251.84 chips are Spin** — and the
conservation sentinel deliberately skips `variant = 'spin'`, so it never says
so.

A Spin pool is buy-ins x multiplier, so a 10x pays out far more than it
collected by design; that is the format, not a bug. The question is whether the
low multipliers bank the difference. They do:

|                                 | events  | net           |
| ------------------------------- | ------- | ------------- |
| high multiplier (>= 4x)         | 37      | -1,840.60     |
| low multiplier                  | 284     | +3,497.76     |
| **all Spins since 08-27 06:00** | **321** | **+1,657.16** |

**The format is profitable and working.** What is missing is bookkeeping: the
retention is credited to no bank and the overlay is debited from no bank, so
per-event conservation shows a deficit on every high multiplier and nobody ever
nets it. Dan's 2026-08-27 ruling already covers the fix — _"that money comes
from the union bank... there must be a transaction history of those chips
leaving the bank"_ — a Spin pool exceeding collections IS an overlay.

**Not built here on purpose.** Another agent applied four Spin migrations
between 02:20 and 02:23 today and owns that lane; building a Spin banking path
underneath them is the collision section 7 warns about. Handed over rather than
started.

## Still open

1. **Era A, 453,571.88** — fund it, or restore the amnesty as explicit
   acknowledged data instead of a hidden date. Dan's call.
2. **Spin variance banking, ~+1,657 per day** — for the Spin lane.
3. **31,412.80 owed to real players** across 114 events, unblocked the moment
   item 1 is answered. `fn_pay_backed_payout_shortfalls` pays them
   automatically once their pools are funded.
4. **Two events with two winners each** (Sunday Freeroll Special, Bounty Builder
   Turbo) from the first pass, ~389 chips.
