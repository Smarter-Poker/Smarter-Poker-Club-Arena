# A payment the record cannot see is a payment that gets made twice

2026-09-02, chip-integrity pass. Fourteen migrations. Every one of them
is either a leak I found or a leak I caused.

## The one I caused

`public.tournament_payouts` is the authoritative answer to "what has this
player been paid", and `fn_tournament_payout_reconcile` reads it to decide
whether a place is still owed money.

My guarantee overlay back-payment moved **1,703.00 chips** into player wallets
across six tournaments at 01:19 and wrote no row there. My later back-fund
migration raised `prize_pool` to the guarantee so the pool would show the
overlay it received. At 03:54 the reconciler woke up, computed expected against
the higher pool, saw only the original structure payouts as already paid, and
paid the identical shortfall a second time. **1,703.00 back-paid, 1,703.00
re-paid, exactly duplicated in all six events.**

Raising `prize_pool` was not the bug. It was the trigger that exposed it.

Fixed in two parts, and the second is the one that matters: recording the 46
back-payments as `source = 'overlay_backpay'` achieves nothing unless
`overlay_backpay` also joins the reconciler's already-paid source list. All six
events now record at or above their pool, so the reconciler reports them as
overpaid (report-only by design) and can never top them up again.

No clawback. Dan's ruling: these are horses in beta, the extra chips are not
the concern, the leak is.

## The ones I found

**A cancelled spin kept its jackpot draw.** "2 Chip Spin PLO5" drew 8.00 from
the club reserve, was cancelled, refunded all three players from their seat
stacks, and never returned the draw. No code path existed to reverse a draw on
cancellation rather than completion. Returned, and
`zz_ca_spin_cancel_returns_draw` now returns it inside the cancel itself.

**Diamonds moved anonymously.** 1,259,900 non-cert diamonds left
`profiles.diamonds` in one hour with no journal row, and the writer could not
be named - not because the evidence was ambiguous, because there was none.
No `updated_at` trigger, no change log, and seven RPCs moving the column
without journalling. Ruled out on evidence: mass deletion (1,308 profiles
against 1,311 auth users), cert re-tagging (`cert_diamonds` held at exactly
234,480 across the boundary), any scheduled job, and a `diamond_balance`-only
write (the two columns agree exactly). Added `ca_diamond_balance_audit` so the
next one is attributable, and closed all seven writers.

**The dead pool leaks through a cascade, not a write.** The frozen-pool check
paged critical 37 times saying a money path was writing to `public.wallets`.
Nothing was. That table cascades from `profiles` and `auth.users`, and 188 of
its 1,711 pre-freeze rows belong to certification accounts that are torn down
routinely - so deleting a test account silently removes its share of the
stranded pool. The proof is that not one pre-freeze row had been updated since
2026-08-21: a balance that falls with no UPDATE fell because the row left. The
detector's own `suspected_cause` is why nobody ever explained it.

**A cron job that had not succeeded in two hours.** `reconcile-tournament-denormals`
failed 120 times on `record "new" has no field "tournament_id"` - PL/pgSQL does
not short-circuit `AND` across a record field reference, so the whole condition
compiles as one SQL expression and `NEW.tournament_id` resolves even when the
table guard is false. Same trap, different trigger, second time this session.
179 successes since the fix.

## Left open, deliberately

`fn_spin_settle_game` sets `app.ledger_category` to `'spin_prize'` and, unlike
the `spin_entry` block above it and the `treasury_transfer` block below it,
sets no `app.ledger_counterparty` before its `UPDATE public.spin_bonus_pools`.
That one missing line is the entire `spin_reserve -> settlement_suspense` flow
on the board: 243 rows and 15,378.00 chips in 90 minutes, the largest remaining
undeclared path. The money is journalled and not lost - this is a
classification defect, not a leak. Not fixed here because reconstructing a live
settlement function from a filtered view at four in the morning is how the
double-payment above got written.

The residual `fn_ca_supply_snapshot` warnings (a few hundred chips per interval,
alternating sign) are the unexplained-supply endgame and are not closed. They
are not resolved with a shrug, which is what the resolution law exists to
prevent.

## Two vocabulary lessons, same night

Twice I invented an enum value the schema already had, and twice a CHECK
constraint refused it: `draw_returned` when `surplus_return` existed, and
earlier `tournament_pool`/`tournament_overlay` when `prize_liability`/`overlay`
existed. Both rolled back clean. Read the constraint before naming a new value
in this database.
