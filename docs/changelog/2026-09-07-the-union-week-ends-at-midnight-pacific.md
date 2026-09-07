# The union week ends at midnight Pacific

**2026-09-07.** Migration `20260907044041_the_union_week_ends_at_midnight_pacific`.
Applied to production before the 07:00 UTC boundary the same morning.

Dan: *"THE WEEK CAN'T END UNTIL 2 AM ON MONDAY MORNING, WHEN THE WEST COAST HITS
11:59:59."*

2 AM Central, 07:00 UTC and midnight `America/Los_Angeles` are the same instant.
None of them was the instant the platform used.

## What the boundary was doing

`fn_union_week_start` truncated in UTC, so the union week ended Monday 00:00 UTC,
which is **Sunday 17:00 Pacific**. Every week, the whole of West Coast Sunday
evening was cut off the week that had just been played and pushed into the next
one. `union-weekly-rakeback-close` then fired at 00:10 UTC, seven hours before
the week had actually finished.

It is not a rounding difference. Re-running the closing week on the two
boundaries, for the same union:

| SHARK CLUB, week ending 2026-09-07 | UTC boundary | Pacific boundary |
| --- | --- | --- |
| rake generated | 617,837.36 | **626,097.38** |
| players won | -508,382.90 | **-366,080.18** |
| ECO adjustment | -92,653.19 | **-76,323.86** |
| settled in chips | 665,508.08 | **823,504.84** |

8,260.02 of rake and 16,329.33 of ECO were landing in the wrong week, every week.

## Why it went unnoticed for three weeks

Three `GLOBAL_SETTLEMENT_FREEZE` rows had been active in `settlement_locks`
since 2026-08-26 (*"EMERGENCY: PROFIT DRIFT INVESTIGATION"*, `unlock_at`
2099-01-01, so they never expire). `fn_union_settlement_cascade` raises on any
active row, and `fn_union_settlement_cascade_all` caught every union in
`EXCEPTION WHEN OTHERS` and returned `'success', true` regardless.

pg_cron logged three green runs. The 2026-09-07 run finished in **0.19 seconds**
and recorded `succeeded`. Behind it: three unsettled periods and 2,592,517.16 of
rake unclosed across 907,134 credit rows. Round 4, the invoices, had never
recorded a single successful run in the table's history.

## What this migration changes

1. **`fn_union_week_start` truncates in `America/Los_Angeles`,** and
   `fn_union_prev_week_start` subtracts on the *local* timestamp so a DST week
   is one calendar week rather than 168 hours. Asserted in the migration: the
   PDT-to-PST week is 169 hours and the PST-to-PDT week is 167.
2. **`fn_union_settlement_cascade_all` returns `success: false` when any union
   failed,** and writes a `critical` row to `financial_alerts` naming the period
   and the count. A settlement that did not happen is now visible to somebody.
3. **`fn_union_settlement_cascade_due()`** settles the week that has just closed,
   once, and returns `skipped` when round 1 already exists for the period. The
   cron offers it four chances (`20 7,8,9,10 * * 1`) because midnight Pacific is
   07:00 UTC on PDT and 08:00 UTC on PST, and a missed Monday now heals on the
   next tick instead of waiting a week.
4. **A delivered invoice is frozen.** The upsert's `DO UPDATE` carried no
   condition, so re-running the issuer restated an invoice that had already been
   delivered while `message_sent` suppressed the corrected statement. The club
   held a message quoting one figure and the database held another. It now
   refuses to restate a delivered invoice and reads the row as it stands.
5. **Presettlements are no longer filtered by a lower bound.** The window was
   `received_at >= v_start`, so a payment made during a week that never settled
   was older than every future period start and was credited to the club on no
   invoice, ever.
6. **Two counters that were lying.** `v_notified` was assigned by
   `GET DIAGNOSTICS` rather than accumulated, so it reported only the last club.
   `v_msg` was declared once outside the loop, so a club whose statement was
   skipped reported the previous club's delivery count.
7. **Notifications are raised only with the statement,** so a re-run cannot
   spam every club owner and admin again.

## The ECO baseline, and what could not be fixed

`fn_union_eco_adjustment` runs in `club_cash_profit` mode, so
`eco_base = rake_earned - cash_players_won`, and `cash_players_won` needs the
seated-stack delta across the period. When the opening baseline carries no
seated figure the fallback makes `seated_start` equal `seated_stack`, the delta
**silently collapses to zero**, and the ECO base is computed from realized cash
alone.

That was every row. `fn_union_pnl_baseline` reads the newest
`union_pnl_settlements` row, the newest was 2026-08-20, and **no row in that
table had ever carried a `seated_end_cash` key** - `fn_union_pnl_bootstrap`
writes one, but every stored row predated that code. The function reported this
honestly as `baseline_cash_exact: false` and nothing had ever looked at it.

The observable symptom: reading the *same closed period* four times over
thirteen minutes returned four different answers, drifting from -92,653.19 to
-92,701.73 on SHARK CLUB's ECO. `outstanding` is entirely ECO plus
presettlements, so that is the number a club is billed.

A fresh baseline carrying `seated_end_cash` is written here, stamped `now()`,
which is before the 07:00 boundary and is therefore the baseline the **next**
week resolves to. Verified after apply:

- closing week 2026-08-31 to 2026-09-07: `baseline_cash_exact = false`
- next week 2026-09-07 to 2026-09-14: `baseline_cash_exact = true`

**The closing week cannot be given a baseline it never had.** Its seated stacks
at 2026-08-31 07:00 were not recorded and are not reconstructable, and inventing
them would be exactly the assumption-dressed-as-a-decision that section 10.5
exists to forbid. So its statements say so, in words, in the club messenger:

> PROVISIONAL. The ECO adjustment on this statement was calculated without an
> exact opening seated-stack figure for the period, so it is subject to
> correction. Raise it with the union if it looks wrong.

`baseline_cash_exact` is now carried in the invoice `breakdown`, in the
messenger metadata and in the issuer's return payload.

## The freeze

The three rows are **deactivated, not deleted**, with their original reason,
original `locked_at` and the releasing evidence preserved in `metadata`.
Re-arming is one UPDATE.

The investigation they were raised for is closed on the evidence:
`fn_settlement_conservation_check`, `fn_union_money_path_check`,
`fn_union_chip_integrity_check`, `fn_union_law_integrity_breaches`,
`fn_union_law_extra_breaches` and `fn_union_rake_weekly_verify` all return zero
rows, and the union rake ledger checkpoint recomputes to **0.00 drift across
1,281,259 rows**.

## Deliberately not done

**The weeks 2026-08-17 and 2026-08-24 are not replayed.** They carry ECO of
1,015,731.49 and 1,242,950.74 against SHARK CLUB, against 76,323.86 for an
ordinary week, and `settled_in_chips` of -6.5M and -9.8M. That is the drift the
freeze was raised for, not a bill, and running the cascade over it would invoice
it. Under section 10.9 the first condition of a clear path is that the outcome
is READ rather than assumed, and this one cannot be read: those weeks were
computed on the old UTC boundary against a baseline that never carried the field
the ECO needs. It goes to Dan with the numbers, which is what that section says
to do when a condition fails.

Also still open, in the World Hub and not in tonight's automated path:
`settle-period.js` closes a period and reports `unionHold` as collected when the
treasury debit failed (449-452, 639-646); `settlement-history.js` force-closes a
period on the 409 the balance guard raises and answers 200 (122-133); and
`close` has no row lock, so the cron path and a human clicking Settle both
charge the hold in full (275-291, 443-464). Those are club-level settlement, a
separate surface, and they need their own change.

## Verification after apply

    active GLOBAL_SETTLEMENT_FREEZE rows      0
    fn_union_week_start(now())                2026-08-31 07:00:00+00
    union-weekly-rakeback-close               20 7,8,9,10 * * 1  active
    union-weekly-rakeback-recompute           45 6,7 * * 1       active
    baseline rows carrying seated_end_cash    1
    next week baseline_cash_exact             true

Every assertion in the migration passed, including both DST week lengths; the
migration aborts rather than leaving the platform half-moved.
