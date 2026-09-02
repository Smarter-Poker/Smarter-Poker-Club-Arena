# The spin treasury credit double-paid what the distributor already pays

Correction to the same day's earlier entry, "A check that never runs is the
biggest leak on this platform". That entry claimed spin house rake was being
destroyed and that I had fixed it by crediting the club treasury. The first
half was true only of an earlier era. The second half was a defect.

## What I got wrong

I proved that on a completed spin, 300.00 left player wallets, 276.00 reached
the reserve and 200.00 reached the winner, leaving 24.00 exactly equal to
`house_rake` unaccounted. I then checked `chip_ledger` for
`to_type = 'club_treasury'` over six hours, found no spin rake, and concluded
the chips were destroyed.

**I never checked `to_type = 'union_wallet'.** From 2026-09-01 19:11, when
`fn_spin_book_entry` began writing a `rake_records` row, `atomic_distribute_rake`
had been consuming that row and crediting `union_wallets.rake_wallet`. The rake
was reaching the house. Only the pre-2026-09-01 era genuinely lost it.

## The defect

`rake_records` is not a passive log. It is the entry point that triggers
distribution: `atomic_distribute_rake` reads it and writes **both**
`union_wallets` and `clubs.chip_treasury`. My change wrote the row **and**
credited the treasury directly, so every spin paid its rake twice.

Measured over the ~9.8 hours it was live:

- treasury credited **8,521.44**, exactly equal to spin rake owed **8,521.44**
- the pre-existing `prize_liability -> union_wallet` stream continued at 14,414.38
- unexplained chip supply moved from an average of +270/hr to +724/hr, starting
  at the exact interval the change landed

**8,522.88 chips were created.**

## The fix

Migration `20260902150500` removes the direct treasury credit. The per-player
attribution added the same night is **kept** - `player_contributions` and
`metadata.rake_per_player` are what VIP points, rakeback and agent commission
read, and they were the actual instruction. `metadata.treasury_credited` is now
`false` with `distributed_by: atomic_distribute_rake`.

Verified: last `prize_liability -> club_treasury` rake row at 14:52:30, last
spin booked at 14:54:20, **six spins booked since with zero new credits**, and
attribution still at 100%.

## Not reversed

The 8,522.88 is **not** clawed back. Midway Union's treasury holds 320.82
against an 8,522.64 over-credit - the chips have already flowed onward through
the distributor - so a reversal would drive a treasury negative, which the
reconciler flags as critical. The disposition is Dan's call and is recorded as
Blocker B1 in `docs/HANDOFF_CURRENT_STATE.md`.

## Lessons

1. When concluding money "vanished", enumerate **every** destination bucket, not
   the one you expect. One unchecked `to_type` inverted the conclusion.
2. `rake_records` triggers distribution. Never write the row _and_ move the
   chips.
3. My own supply metric contradicted me within one hour and I did not look at it
   until the next day's audit. **Watch the metric after a money change.**
