# A cold cache is not a zero, and the 09-17 cutover gap is absorbed

2026-09-21. Two findings, one migration
(`20260921064151_rakeback_close_refuses_a_stale_daily_cache`). The second is
the one I was sent to decide. The first is one I found on the way - and the
first thing to say about it is that **I overstated it while working, and the
migration's own header comment carries that overstatement.** The correction is
at the top of section 1 rather than buried, because the header is now applied
and I am not spending a second migration on a comment.

## 1. The rakeback close trusted a cache it never checked

### The correction first

While investigating I concluded that the Monday 10:30 UTC payer would underpay
225 Deep Stack Society players by 30,620.75 and stamp them `paid` for ever.
**That is wrong, and the migration header repeats it.** What the evidence
actually shows:

- `/api/cron/rakeback-period-settle` calls `settle_club_rakeback`, which is a
  shim to `fn_settle_club_rakeback_batch`, which **defers to
  `fn_process_weekly_accounting`**. It does not call
  `fn_close_settlement_period` at all. The comment at the top of that cron
  route still says the chain is `settle_club_rakeback ->
  fn_close_settlement_period`; that comment is stale.
- `fn_close_settlement_period` cannot move chips anyway. Called directly it
  raises `rakeback_requires_accounting_authority` from
  `fn_club_members_ledger_writer` - only `fn_settle_accounting_rakeback_stage`
  sets `app.ledger_autoskip_club_members` and may write the rakeback leg.
  Verified by a rolled-back probe.
- That stage computes from `accounting_rakeback_period_calculations`, which
  `fn_calculate_cash_rakeback_periods` builds from **`rake_attributions`** -
  the complete source, never the daily cache - and it cross-checks its own
  figures against the stored `rakeback_periods` values, raising 23514 on
  disagreement.

So the realistic failure was a **jammed or refused weekly settlement**, not a
silent underpayment. I should have traced the caller before pricing the
blast radius. Recording it here because CLAUDE.md 10.86 is precisely about a
check that answers confidently when it cannot tell, and I did that myself.

### What is nonetheless true, and why the fix stands

`fn_close_settlement_period` picks its basis like this:

```sql
SELECT count(*) INTO v_days_have FROM rakeback_daily_state s
 WHERE s.club_id = ... AND s.day BETWEEN period_start AND period_end;
IF v_days_have >= v_days_needed THEN   -- read the cache
ELSE                                   -- scan the source
```

It counted **rows**, not **freshness**, while the comment two lines above it
promised the fallback existed "rather than pay somebody zero because a cache
is cold". Nothing ever tested for cold. The function is still reachable: its
own auth branch admits `fn_is_platform_admin()` and the club owner, so an
admin action can still drive it and write understated figures onto
`rakeback_periods`. A day now counts only when no qualifying rake record for
that club-day arrived after the cache was computed:

```sql
AND NOT EXISTS (
  SELECT 1 FROM public.rake_records r
   WHERE r.club_id = s.club_id
     AND r.created_at >= s.day::timestamp AT TIME ZONE 'UTC'
     AND r.created_at <  (s.day + 1)::timestamp AT TIME ZONE 'UTC'
     AND r.created_at >  s.computed_at
     AND r.rake_amount > 0)
```

Validated against live data before shipping: it marked 09-14/15/16 fresh (0
late arrivals, `rows_seen` equal to the live count) and 09-17/18/19/20 stale,
with no false result either way. The partial index
`idx_rake_records_club_created (club_id, created_at) WHERE rake_amount > 0`
serves the predicate exactly, so it stays an index probe. The cache is now a
pure optimisation: stale or cold, the close falls to the
`fn_rake_shares_for_record` scan that was always there.

### The cache really was cold, and that part was not overstated

`rakeback_daily_user`'s only writer, `fn_rakeback_recompute_day`, is called by
**nothing on a schedule** - not pg_cron, not any database function. It last ran
at **2026-09-17 07:29** and stopped. By 2026-09-21:

| club-day | `rows_seen` | rows actually present |
| --- | ---: | ---: |
| 2a1132b9 2026-09-17 | 5,106 | 36,606 |
| 2a1132b9 2026-09-18 | 0 | 46,228 |
| 2a1132b9 2026-09-19 | 0 | 40,652 |
| 2a1132b9 2026-09-20 | 0 | 33,735 |
| fade0000 2026-09-17 | 4,591 | 59,426 |
| fade0000 2026-09-18 | 0 | 64,152 |
| fade0000 2026-09-19 | 0 | 33,785 |
| fade0000 2026-09-20 | 0 | 11,648 |

Three days of the week held **no cache rows at all**. The eight stale
club-days were rebuilt through the table's own writer
(`fn_rakeback_recompute_day`, force, 2,436 user-day rows): the week's cached
basis went **173,325.45 -> 800,025.45**. That is the product's own idempotent
writer being run, not a new repair job - **no cron, sweep, backfill or
compensating write is created here, and under 10.12 none may be.**

### Still open - NOT fixed here, and it is a money question

1. **Nothing schedules `fn_rakeback_recompute_day`.** With the guard in place
   a cold cache can no longer make `fn_close_settlement_period` lie, but the
   cache still goes stale on its own. A new schedule belongs on Open Claw and
   is the owner's to place (10.85, section 11).
2. **`rakeback_periods` for the week of 09-14 still carries the understated
   figures**: stored basis 173,311.84 / amount 26,542.66 across 866 periods,
   against a now-correct cache of 800,025.45.
   `accounting_rakeback_period_calculations` has **0 rows** for that week, so
   the weekly calculator has not run yet. When it does, its
   attribution-derived figures and the stored ones will disagree and
   `fn_settle_accounting_rakeback_stage` raises 23514 on disagreement. **Who
   reconciles those stored values, and how, is unresolved and should be the
   next thing looked at.** I did not touch `rakeback_periods`.

## 2. The 2026-09-17 cash accrual cutover gap: absorbed

The cutover was armed at `now()` = 18:24:04 while the settler cursor stood at
07:28:31. Everything cash in between fell into a gap no writer owns.

**Reconciled population.** 35,995 positive cash rake records over 35,995
distinct hands, **70,266.90** of rake, earned 07:28:33 to 18:24:02. 35,994
carry a work row latched `legacy_unverified`; one more (0.23) was never
enqueued. The wider figure this was first reported as - 52,305 records /
111,962.41 - counted **tournament** rake in the same window too (16,311
records / 41,719.51), which belongs to `accounting_tournament_fee_*` under its
own cutover. The tournament legacy writer ran to 18:23:53 and its canonical
writer began at 18:46:28, so that side has no comparable hole.

**Nobody was paid.** `agent_commissions` `rake_settlement` ends at 07:29:05;
`cash_rake_accrual` begins at 18:25:06. Controls confirm the shape rather than
assume it: 09-16 and 09-17-pre-cursor are 100% legacy-covered, post-cutover is
100% canonical-covered, the gap has 1 of 35,995.

**What was owed**, computed over all 107,538 attributions with
`fn_accounting_earning_contract` (STABLE, reads agreement history at the
earning instant, needs no receipt), every one resolving without error:

| role | amount | beneficiaries |
| --- | ---: | ---: |
| agent | 23,750.59 | 71 |
| sub_agent | 4,145.73 | 40 |
| super_agent | 27,547.66 | 5 |
| club residual | 14,822.92 | 3 clubs |
| **total** | **70,266.90** | |

It sums to the rake exactly, so the allocation conserves. Agreements were
establishable throughout: `accounting_agreement_history` begins 2026-09-14.

**Why it cannot be paid**, proven in a rolled-back transaction on a real gap
record. Both doors refuse: `credit_agent_commission_from_rake(...,
'rake_settlement', ...)` raises `cash_source_requires_reconciliation` (55000)
because its cash branch no longer writes commissions at all - it delegates to
`fn_process_cash_accounting_source`, which returns the latched verdict; and
`fn_accounting_cash_commission_plan` raises `cash_game_union_stamp_missing`.
The canonical path cannot be opened because its evidence was never recorded:
of 35,995 records, **0** carry `accounting_source_version=2`, **0** carry
`union_id`, **0** have an `accounting_cash_bank_receipts` row - against 30,704
of 30,704 on all three post-cutover. Those receipts attest to a union wallet
credit or a chip retirement that did not happen in that form; writing them to
unlock the payment would be manufacturing financial evidence. The verdicts are
latched, the batch table is immutable, and the cutover cannot move. The only
remaining option is a backfill function, which 10.12 forbids - so the honest
answer is to say so, not to ship the plaster.

**Decision: absorbed by the house**, recorded in `financial_alerts`
(`source = 'cash_accrual_cutover_2026_09_17'`, resolved, full reasoning in
`resolution`).

**Who is out of pocket.** The rake was collected normally - all 35,995 records
have a `chip_ledger` rake entry - so the chips left the pots and stayed with
the clubs. What was never booked is the commission liability the clubs would
have owed their uplines: **55,443.98 across 116 beneficiaries.** The clubs are
better off by that; those 116 are worse off by it. 115 are horses and 1 is
human (`kingfish`, 149.71). Under **10.5** that changes nothing and nothing
was applied differently: every horse was computed on the same terms as the
human and the absorption falls on all 116 identically - because no door opens
for any of them, not because a horse was filtered out of anything.

**Player rakeback is not affected by the cutover gap.** Rakeback basis does not
flow through `rakeback_stats_applied`; it is rebuilt from `rake_attributions`,
and all 107,538 attributions for these hands are present and sum exactly to the
rake. The 351 players lose nothing from the gap. Their exposure was finding 1,
and the cache half of that is now repaired.

**Recurrence is prevented, verified not assumed.** A rolled-back probe
confirmed the cutover row is immutable
(`accounting_agreement_history_is_immutable` on UPDATE) and that a new cutover
five hours ahead is refused. `fn_ca_guard_cash_cutover_not_ahead_of_settler` is
armed on INSERT OR UPDATE and treats "could not tell" as its own refusal. The
settler cursor is healthy again (lag 0.29h at 06:47 UTC).

One inaccuracy left alone: that guard's `HINT` describes the incident as "150
hands holding 266.61 of rake". The real figure is 35,995 hands and 70,266.90.
Only the prose is wrong - the behaviour is correct and verified - so a money
guard was not reopened for a comment. The accurate numbers live in the
`financial_alerts` row.
