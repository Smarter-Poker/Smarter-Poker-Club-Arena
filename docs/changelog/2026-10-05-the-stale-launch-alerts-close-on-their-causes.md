# 2026-10-05: the stale launch alerts close on their causes

Every open alert from before today was traced to its cause. Where a detector
read a state the platform produces on purpose, the detector was corrected at
the line that made the false finding. Where the cause was already fixed, the
current state was read again. Each alert closes only on an assertion that the
cause is gone.

## Detector fixes (migration `20261005113359`)

- **`union_eco_not_recorded`** (`fn_union_credit_risk_check`, also read by
  `fn_union_governance_check`) asked for the closed week's ECO row as soon as
  the week ended. The row is written by the weekly close. That close is due at
  09:00 UTC, and this week it is gated until 2026-10-06 13:00 UTC. The check
  now asks once the close is owed.
- **`lapsed_week_unclosed`** (`fn_union_treasury_selftest`) gets the same
  correction, but only for the just-closed week.
- **`tiers_locked`** (`fn_spin_fairness_check`) warned about an odds sheet
  that Dan removed on 2026-09-05. The check now reports a lock without
  raising it, and `distribution_warning` is no longer shadowed by that branch.

## Registered maintenance (migration `20261005113403`)

`stale-cert-recovery` and `cert-residue-recovery` go through the same
certification retirement door as `ui-cert-cleanup`. They are registered `info`
the same way, and their two incidents are closed.

## Engine: the Free Buy watch reads the board by name

Every freeroll carries `free_buy` (Dan: "FREE ROLLS MUST ALWAYS BE SET AS
'FREE BUY'"), so the hourly watch and `freebuy:verify` audited every freeroll
against the five-slot board. Both now select `FREE_BUY_BOARD_NAMES`, which is
the same name `freeBuyTournamentRow` publishes under. A test pins that the two
agree.

## Records (migration `20261005113407`)

These are closed with their verified causes:

- the two Oct 3 `leave_pending` rows
- the drift-incident mirrors
- the treasury selftest
- 44 integrity sweep review signals
- the rake basis refresh
- the Spin multiplier repairs
- the Stable Hand alerts
- the duplicate structure payouts (688.30 absorbed by the house, not clawed
  back)
- duplicate rake attribution
- broke seats
- the cash pot fixture
- Spin fairness
- the payout sweep
- the Free Buy board

The two "waits for a quiet hour" warnings of 09:40 today stay open, because
they are true.
