# The champion who was never marked the champion

Phase 3 of the zero-drift work: settlement and payout. Nine incidents carried
no prevention; one was a live critical.

## The live critical, and why the repair could not fix it

`fn_payout_guarantee_check` filed: _Midnight Bounty (NLH) funded a 24.00 bounty
pool and paid out 0_. The incident names its own remedy -
`fn_backpay_unfinalised_bounty_pools` re-drives it - and that function, run at
its default limit, reported everything clean.

Both were right, which is the interesting part. The function scanned

    WHERE status = 'COMPLETED' AND bounty_pool > 0
    ORDER BY ended_at DESC
    LIMIT p_limit                      -- default 200

and only **then** skipped the ones already paid. The limit bounded what it
could **see**, newest first. There are 713 completed bounty events and the
unpaid one sits at rank **238**: at limit 200 it finds nothing, at 300 it finds
the 24 chips. Measured both ways.

That is a repair with a sliding window over its own backlog. The longer a debt
goes unpaid, the further out of reach it moves, and it can never be collected
again - the worst possible failure direction for money owed to a player. The
limit now bounds the **work**, not the **view**, and the scan runs oldest debt
first.

## The actual cause, one level down

The bounty pool was not a bounty bug. That tournament finished with eleven
players eliminated at positions 2..12 and the twelfth still carrying
`tournament_players.status = 'playing'` at position 1. The engine marked the
event COMPLETED and never named a champion, so everything downstream that asks
"who won?" finds nobody.

Measured across **50,572** completed events: **52** have no winner recorded,
and in all 52 the champion is sitting in `playing`. Not one has a different
shape; no event has two winners. Every one falls between 2026-08-21 05:57 and
2026-08-27 01:17, and **15,163 events have completed since with no
recurrence** - so the engine defect is already closed.

What was not closed is that nothing would have told us. There was no guard
saying a finished tournament must have a champion, so the 52 sat for eleven
days and surfaced only because one of them happened to hold a bounty pool that
a different check noticed. `completed_without_a_champion` is now a ratchet at
52, and `ca-bounty-backpay-hourly` settles pools that do have a champion
instead of waiting for a human.

## The overpay alarm was comparing against the wrong number

`FeeReconciler.prize_disbursement` compares credits against `prize_pool`. Over
ten days that fires on 37 events for 20,085.58 chips - and most of it is by
design. Satellites award fixed-value **seats**; Spins pay a club-funded
**multiple** of the buy-in; a **guarantee** is a promise to top the pool up to
a floor. A detector that fires on all three teaches everyone to ignore it, the
same disease as the tournament conservation check in Phase 2, and it hid the
part that is not explained.

**One trap worth recording.** `spin_type` is the string `'standard'` on every
row in the table, MTT freezeouts included. Excluding Spins on
`spin_type IS NULL` reports **zero** unexplained events and silently buries an
18,381.60 chip discrepancy on an MTT. I wrote that filter, saw the convenient
zero, and checked it rather than shipping it. The honest discriminator is
`tournament_type = 'SPIN'`, which matches `spin_multiplier > 0` exactly -
28,710 both ways.

With satellites, Spins and guarantees accounted for, **ten MTT events remain
unexplained for 18,899.68 chips**, and they are now the only ones that reach a
person.

## Two classes that were already fixed, verified rather than assumed

- **`FeeReconciler.queue_failed`** (3): PGRST002 during the 2026-08-31
  schema-cache outage - the engine could not queue collected rake, and the
  chips had already left the pot. The alert said they were "recoverable only by
  hand". They were not: all three hands now carry `rake_distribution_legs`, and
  there are zero unbanked raked hands in the last 24 hours.
- **`fn_ca_quick_reconcile:frozen_pool`** (2): `public.wallets` reads
  732,591,994.33 against a frozen baseline of 732,591,994.33 - exact, to the
  cent. Nothing is writing to it, and the check re-verifies every five minutes.

## Performance, learned twice

Adding the two new ratchets pushed `fn_ca_ratchet_watch` to 31 seconds, so I
measured each one instead of guessing: `undeclared_money_paths` 8.2s (a catalog
sweep, the dominant cost), rake 2.1s, champion 0.41s, overpay 0.27s,
unledgered 0.05s. The overpay window came down from ten days to 48 hours; the
ten-day view stays available by passing the interval.

## For Dan

**18,899.68 chips** paid beyond every funding source across ten MTT events,
97% of it one event: _Sunday $200 Deep Stack_, 115 entrants and 133 rebuys,
pool 44,640, guarantee 20,000, **paid 63,021.60**. Buy-ins and rebuys account
for at most 47,300, so roughly 16k has no source. That is a single-event
investigation of its own and it is recorded, not acted on.

The 52 championless events also still have no champion recorded. Naming them
would let the bounty settlement pay out; that is a money decision, so it is
Dan's.
