# A Player's Overpay Is the House's, and a Skipped Week Stays Owed

2026-09-26. This completes the seven money items of
`2026-09-26-seven-open-money-items-closed-with-receipts.md` and corrects two of
them. Every figure below was read back from production after the migrations
were applied.

| #   | Item                            | Final position                                                               | Migration                          |
| --- | ------------------------------- | ---------------------------------------------------------------------------- | ---------------------------------- |
| 1   | Mystery-bounty make-good        | Paid, 76.90 to five players, seven journal legs                              | `20260926085132`                   |
| 2   | PKO 3f19bd70 shortfall 1,355.00 | Owed again: closure reopened under Dan's ruling; not attributable per player | `20260926092142`, `20260926131420` |
| 3   | Satellite seat into a PKO       | No defect: every path splits or refuses                                      | none needed                        |
| 4   | Ledger replay drift -234.10     | Detector defect, fixed                                                       | `20260926084812`                   |
| 5   | Rakeback, week of 2026-09-14    | Basis decided, stays owed; alert open for Dan's one-off payment              | `20260926131554`, `20260926131420` |
| 6   | 32 obligations paid twice       | Real; the house absorbs 1,001.00 (recovery reversed)                         | `20260926131530`                   |
| 7   | Alert noise                     | 62 closed earlier, 360 floored-week retries closed now                       | `20260926092142`, `20260926131554` |

## Dan's Ruling

Dan ruled on 2026-09-26, in answer to a direct question from another session,
to reverse all three horse-based money decisions of the morning
(`20260926092115`, `20260926092142` for event 3f19bd70, and `20260926093159`).
That session's migration `20260926131420` applied the rest of the ruling after
the two migrations below: it verified the 1,001.00 was returned exactly once
and moved no chips, reopened the three 3f19bd70 alerts (the 1,355.00 is owed;
that nobody can derive who knocked out whom decides how it is paid, not
whether), and reopened `deferred_rakeback_basis_2026_09_14` until Dan's one-off
payment is made.

## Two Corrections

**Item 6.** `20260926092115` took 1,001.00 back from 32 horse wallets on the
rule "a horse is recovered; a human would not be". CLAUDE.md 10.5 forbids that
rule by name, and 10.9 rule 3 says overpay our defect caused is absorbed by the
house and left alone. `20260926131530` returns every chip to the wallet it was
taken from, from the Midway Union bank, one settlement leg and one settled
adjustment each, under the key `double-pay-restore:<event>:<player>`. The
double payment itself was real: the 2026-09-02 01:19:57 back-fund moved each
balance with no payout row, and the 03:54:19 reconcile paid the same shortfall
again. The reconciler has counted `overlay_backpay` since `20260902042044`.

**Item 5.** `20260926093159` closed the week "without payment" because every
recipient is a horse. That contradicts 10.5 and Dan's 2026-09-20 floor record
("the two skipped weeks are NOT written off"). `20260926131554` voids it. The
basis is the rule the code defines, the rate rule of
`fn_calculate_cash_rakeback_periods` on terms observed at earning time, as
applied by `20260921082544`: **138,303.43 owed** (Deep Stack Society 44,931.08,
Midway Union 93,372.35; strictly observed 134,439.33). `pending_amount` is
unchanged. 97,577.72 of it is still derivable per player from the immutable
earning contracts; 103,614.58 of the week's rake lost its per-player record to
the pre-fix pruner. The certified calculator refuses the week
(`historical_week_before_observed_source_cutover`), so it is not paid by this
change.

## Item 3, Recurrence

`fn_settle_satellite_tournament` does not call `fn_tournament_entry_split`, and
it does not need to: its authority refuses any bounty, PKO, mystery-bounty or
Spin target before a chip moves ("uses an unsupported bounty or Spin entry
split"), the cohort path refuses the same way, the trigger
`satellite_feeds_only_a_deliverable_target` refuses creating or re-pointing a
satellite at one, and the seat and ticket paths that can reach a bounty event
(`fn_award_satellite_seat`, `fn_ca_register_for_tournament_with_ticket_for`)
split through `fn_tournament_entry_split`. Production has 0 live satellites
feeding a bounty target. `scripts/ci/test-satellite-bounty-seat-split.py`
reproduces the 09-04 mis-split and pins the refusals. Adding a bounty split to
satellite settlement would be satellite-into-PKO feature work, which is closed.

## Item 7, the Floored Week's Retries

All 360 open `weekly_club_accounting`, `union_accounting_scheduler` and their
two meta-alerts name the week 2026-09-07 to 2026-09-14, which the 2026-09-20
floor removed from the weekly close. Its owed rakeback lives in its own
`accounting_deferred_obligations` rows. None has been raised since 2026-09-18.
