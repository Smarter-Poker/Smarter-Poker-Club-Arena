# A check that never runs is the biggest leak on this platform

Second pass of 2026-09-02. Audited all 40 drift classes ever recorded, one at
a time. The single largest finding is not a bug in any one money path - it is
that twenty integrity checks existed, were correct, and had never once run.

## The systemic root cause

Six separate times tonight the same defect appeared: a check that exists and
nothing calls it. Four money checks, `fn_uncollected_entry_check`, then a whole
tier of conservation audits. Four of them were holding real findings nobody had
ever seen.

Scheduling them one by one is what everybody has done, and it is why there were
twenty. Two mechanisms went in instead:

- **`fn_ca_conservation_sweep`** runs seventeen checks in ONE job and RAISES a
  drift incident for any that reports a finding. Most of these functions only
  _return_ a verdict, so scheduling them without reading the verdict would have
  been theatre.
- **`fn_ca_orphaned_checks`** names any check-shaped function that is neither
  scheduled, nor called by the sweep, nor exempted with a reason. Coverage is
  derived by reading the sweep's own body, so there is no second list to forget
  to update. It reports **zero** orphans now and runs daily.

## Every spin was destroying its own house rake

Proved on six completed spins. "100 Chip Spin NLH": three players were debited
100.00 each, so 300.00 left player wallets. 276.00 entered the spin reserve.
The winner was paid 200.00 from the reserve. Reserve net +76.00 plus the
winner's 200.00 accounts for 276.00.

**The missing 24.00 is exactly `house_rake`.** Taken from the players, credited
to nobody. `fn_spin_book_entry` computed the rake, subtracted it from the
reserve contribution, wrote a `rake_records` row for it, and never moved the
chips. `rake_records` is an accounting record, not a balance.

**142,321.00 chips across 33,972 spins since 2026-08-20.**

Two defects in one: chips destroyed on every spin (a real component of the
unexplained supply drift), and the house earning nothing on spins, so every
downstream earner keyed off treasury rake - club share, union share, agent
commission, VIP points, rakeback - was paid zero for spin play. Under the
horses-are-players law that shorted everybody equally.

Fixed both halves, on Dan's instruction that the rake reach the treasury AND
every player who paid it be credited for it:

- the club treasury is credited in the same transaction that books the entry,
  declared so the auto-journal files it as rake rather than to suspense;
- `player_contributions` now carries each seat's buy-in and metadata carries
  `rake_per_player`, so VIP points, rakeback and agent commission have a basis.

Verified live: clean cutover at 05:02, and since then rake due equals rake
credited to the chip. A 24.00 rake now records 8.00 against each of three
players.

Not backfilled. The historical rake was destroyed, not misplaced, so restoring
it would MINT chips rather than move them.

## 12,893.70 paid to players who were promised it

34 completed MTTs carried a guarantee that was never met, between 2026-08-21
and 2026-09-01. All predate `zz_ca_fund_overlay_on_lock`, so it is a closed
historical set. Paid from the main bank, distributed pro-rata to what each
player was already paid, or by the event's payout structure where nothing had
been paid at all. 127 credits.

Excluded on evidence rather than assumption: a spin's `guaranteed_prize` is
buy-in x seats x multiplier while the winner is correctly paid buy-in x
multiplier, so treating it as a promise would have invented 3,050.00 of debt
across 538 events. Bounty credits count toward a guarantee; ignoring them
overstated the debt by 900 across four events.

Every credit wrote a `tournament_payouts` row. That is the lesson from my own
bug earlier the same night: the overlay back-payment moved 1,703.00 chips
without one, so the reconciler could not see them and paid the same shortfall
twice.

## The same invariant written twice only learns once

`fn_chip_integrity_report` carried its own copy of two invariants that
`fn_ca_quick_reconcile` had already been corrected on, and had never been told:
the frozen-pool comparison against a hardcoded constant (it cascades away, see
the previous entry) and a swallowed-ledger-write count that included the one
benign shape - idempotency refusing a duplicate club-opening grant that is
already posted. Both now read the same sources of truth.

## Three constraints caught three mistakes

`spin_reserve_ledger.kind` refused an invented `draw_returned` when
`surplus_return` existed. `wallet_transactions.wallet_type` and
`chip_ledger.performed_by` each refused a NOT NULL omission and rolled the
whole back-payment back with nothing written. That is the system working.

And one I made twice: the back-payment's LIMIT bounded the CANDIDATE rows
instead of the QUALIFYING ones, so the dry run reported zero against a set I
had just measured at 34 - the identical mistake as "a limit must bound the work
not the view", which I had fixed in another function four hours earlier.
