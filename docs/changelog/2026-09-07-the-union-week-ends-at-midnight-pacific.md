# The union week ends at midnight Pacific

**2026-09-07.** Migration `20260907044041_the_union_week_ends_at_midnight_pacific`.
Applied to production before the 07:00 UTC boundary the same morning.

Dan: _"THE WEEK CAN'T END UNTIL 2 AM ON MONDAY MORNING, WHEN THE WEST COAST HITS
11:59:59."_

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
| ---------------------------------- | ------------ | ---------------- |
| rake generated                     | 617,837.36   | **626,097.38**   |
| players won                        | -508,382.90  | **-366,080.18**  |
| ECO adjustment                     | -92,653.19   | **-76,323.86**   |
| settled in chips                   | 665,508.08   | **823,504.84**   |

8,260.02 of rake and 16,329.33 of ECO were landing in the wrong week, every week.

## Why it went unnoticed for three weeks

Three `GLOBAL_SETTLEMENT_FREEZE` rows had been active in `settlement_locks`
since 2026-08-26 (_"EMERGENCY: PROFIT DRIFT INVESTIGATION"_, `unlock_at`
2099-01-01, so they never expire). `fn_union_settlement_cascade` raises on any
active row, and `fn_union_settlement_cascade_all` caught every union in
`EXCEPTION WHEN OTHERS` and returned `'success', true` regardless.

pg_cron logged three green runs. The 2026-09-07 run finished in **0.19 seconds**
and recorded `succeeded`. Behind it: three unsettled periods and 2,592,517.16 of
rake unclosed across 907,134 credit rows. Round 4, the invoices, had never
recorded a single successful run in the table's history.

## What this migration changes

1. **`fn_union_week_start` truncates in `America/Los_Angeles`,** and
   `fn_union_prev_week_start` subtracts on the _local_ timestamp so a DST week
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

The observable symptom: reading the _same closed period_ four times over
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

---

# What the probes found afterwards

Migrations `20260907045901` and `20260907050337`, applied the same morning.

Moving the boundary was not enough. Probing the **real** settlement path in a
rolled-back transaction found three more things, every one of which would have
hit the 07:05 run.

## 1. The hourly maintenance freeze kills the cascade

Probing round 2 at 04:55 UTC returned, from `zz_freeze_guard`:

    PLATFORM_FROZEN: INSERT on chip_transactions was refused

The break announces at :53 and freezes :55 to :00 with `enforce_freeze: true`.
Rounds 1 to 3 move chips through `fn_debit_treasury`, so a cascade still running
at :53 dies and **rolls back every round it had already completed**. Section 13
rule 5 has always required this gate for a periodic sweep that moves money; the
settlement never had it. `fn_union_settlement_cascade_due()` now refuses to
start while frozen, and refuses after :45.

## 2. The due runner would have replayed an anomalous week

Before the Monday boundary, `fn_union_week_start(now())` is still _last_ Monday.
Called at 05:00 on 2026-09-07 the runner offered to settle
**2026-08-24 to 2026-08-31** - one of the two weeks this changelog explicitly
refuses to replay, carrying 1,242,950.74 of ECO against SHARK CLUB. It now
refuses any period that closed more than three days ago. Verified live:

    {"reason": "platform_frozen", "skipped": true, "success": true,
     "period_start": "2026-08-24T07:00:00+00:00",
     "period_end":   "2026-08-31T07:00:00+00:00"}

## 3. `fn_union_club_invoice` was readable without an account

`SECURITY DEFINER`, `EXECUTE` held by `PUBLIC`, and it never calls `auth.uid()`.
It runs as the owner, past RLS, and returns every member club's rake, rakeback,
player win/loss and amount outstanding **to anybody who asks**. Caught by
`check-definer-authorization` in `.husky/pre-push` - pre-existing, and
re-declaring the function is what surfaced it.

Checked before revoking: it backs no RLS policy, no view depends on it, and its
only caller is `pages/api/club-arena/union-invoice.js` using the service role
key. Club owners read their statements through `ca_club_union_invoices`.
Now `service_role` only; `anon` and `authenticated` revoked, `PUBLIC` named
explicitly because anon inherits it.

## 4. The job could never have finished

The close job carried `statement_timeout = 600s`. Round 2 stamps `settled_at`
on every commission row in the period, and `settled_at` is in the predicate of
`agent_commissions_unsettled_idx`, so no update is HOT and eight indexes are
maintained per row version. Measured:

|                                    |                                              |
| ---------------------------------- | -------------------------------------------- |
| rows to stamp for the closing week | 2,124,321 of 3,560,875                       |
| table size                         | 2,035 MB                                     |
| measured rate                      | 100,000 rows in 31.44 s = **3,180 rows/sec** |
| projected for the period           | **668 s**, for round 2 alone                 |

Two full-cascade probes agree: one cancelled at 240 s and one at 540 s, both
inside that UPDATE. The wall clock was never the constraint - :05 to :53 is 48
minutes - the 600 s cap was. Raised to 2400 s, worst case landing at :45.

**This is a ceiling, not an expectation.** If a run approaches it, the thing to
change is the `settled_at` model: stamping two million rows a week to record one
fact per (club, agent, period) is the cost, and deriving "unsettled" from the
last settled period end removes the write entirely. That is a design change and
it was not made at 05:00 on the morning the invoices go out.

## The schedule now

| job                               | schedule           | notes                                     |
| --------------------------------- | ------------------ | ----------------------------------------- |
| `union-weekly-rakeback-recompute` | `45 6,7 * * 1`     | ahead of the boundary in both PDT and PST |
| `union-weekly-rakeback-close`     | `5 7,8,9,10 * * *` | **daily**, four attempts, 2400 s ceiling  |

Daily rather than Monday-only because the runner is idempotent and refuses stale
periods: a Monday missed entirely now heals on Tuesday instead of waiting a full
week, which is the exact failure mode that hid three unsettled weeks.

## Still open, and deliberately not touched tonight

- `fn_union_active_player_counts` and `fn_union_slugify` are executable by
  `anon` (`fn_union_governance_check`, critical). Both are low-yield reads and
  `fn_union_slugify` backs the `unions` slug trigger, so revoking it needs the
  trigger's ownership checked first.
- Two member clubs have no `union_club_terms` row and fall back to the
  hardcoded 0.90 commission default.
- **Deep Stack Society** generated 17,193.48 of rake this week while belonging
  to no union.
- The World Hub club-level settlement defects listed above.

---

# The half-finished change, and closing it

Migration `20260907052051_every_union_week_is_the_same_week`.

Moving `fn_union_week_start` moved the **settlement**. It did not move the
thirteen other union, agent and rake functions that computed the week with
`date_trunc('week', now())` in UTC. The settlement closed Aug 31 07:00 to
Sep 7 07:00 while the operator preview, the agent statements and the risk
reports all described Aug 31 00:00 to Sep 7 00:00. Same nouns, different seven
hours. That is a wiring gap, and it was mine.

Two were worse than cosmetic:

- **`fn_union_settlement_preview`** mirrors rounds 2 and 3 exactly and is what
  an operator reads _before_ approving a settlement. It was previewing a period
  the cascade would not settle.
- **`fn_execute_union_rakeback`** validates week alignment with
  `p_period_start <> date_trunc('week', p_period_start) -> refuse`. In UTC that
  **refuses a Pacific period outright**:

      '2026-08-31 07:00+00' = date_trunc('week', '2026-08-31 07:00+00')  ->  false

  No database caller, no cron caller, no caller in either repo - but granted to
  `authenticated`, so it was a loaded gun aimed at whoever called it next.

## How it was applied

Thirteen function bodies were **not** retyped. Several are 3-5 KB money
functions and a transcription slip in one would be silent. Each definition was
read back with `pg_get_functiondef`, the exact substrings replaced longest-first,
and re-executed - so the only thing that can change is the text being swapped.
One transaction, so `pgrst_ddl_watch` coalesces to a single schema reload.

The migration asserts, end to end, that the preview's period now equals the
cascade's period. Not the text - the wiring.

## Deliberately not touched, each one checked rather than assumed

- **`fn_rakeback_recompute_all_clubs`** runs at 06:45, _before_ the 07:00
  boundary, where `fn_union_week_start(now())` still returns **last** week.
  Swapping the helper in would have made it recompute 2026-08-24 instead of
  2026-08-31. Its UTC arithmetic already yields the correct window. This one
  nearly became a regression introduced by the fix for a regression.
- **`trg_union_rake_weekly` / `fn_union_rake_weekly_verify`** bucket
  `union_rake_weekly` by UTC week. They agree with each other, the table is a
  display rollup whose own trigger comment says the fallback reads the ledger,
  and moving them needs the existing rows rebucketed in the same change.
- **`rakeback_periods` are UTC-DATE buckets**, so a Pacific week cannot align to
  them exactly. Round 3 claims
  `period_start >= p_period_start::date AND < p_period_end::date + 1`, which is
  eight date-buckets for a seven-day week. Pre-existing, unchanged by the
  boundary move, cannot double-pay (status flips `pending` -> `paid`), and the
  steady state is seven days per week. The off-by-one is real and is recorded
  here rather than changed at 05:30 on the morning the invoices go out.

## Also verified this pass

- **The frozen-invoice guard works.** Re-issuing the already-delivered
  2026-08-10 period in a rolled-back probe: `gross_amount` unchanged at
  220,615.68, **0** new notifications, `already_sent = [true, true]`, 0
  messenger deliveries. Under the old code that upsert would have restated both
  invoices while `message_sent` suppressed the corrected statement.
- **A correction to the first report in this changelog.** It said no invoice had
  ever been issued. Two were: `0851b4d8` (Club JAQK, 7,531.11) and `a446fdc5`
  (SHARK CLUB, 220,615.68), both created 2026-08-20 and delivered 2026-08-21
  for the 2026-08-10 period. What never ran was **round 4 of the cascade** -
  those two went out through the API route. The stronger claim was wrong.

## Recommended next, not done here

A law test pinning the boundary. `tests/the-break-clocks-agree.law.test.ts` is
the precedent for pinning a constant across surfaces, but the union boundary
lives only in the database, so a meaningful law needs a schema-manifest entry
or a DB-backed check rather than a source grep. Writing a weak one that greps
migrations would fail on the historical migrations that legitimately contain
`date_trunc('week', now())`, and a red law blocks every publish. Designed and
left for a change that can be tested properly.
