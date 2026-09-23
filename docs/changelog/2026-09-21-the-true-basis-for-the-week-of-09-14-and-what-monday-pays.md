# The true basis for the week of 09-14, and what Monday actually pays

2026-09-21. I was sent to settle an expected collision: `rakeback_periods` for
the week of 2026-09-14 holding an understated basis against a rebuilt daily
cache, with `fn_settle_accounting_rakeback_stage` predicted to raise 23514 at
Monday's close. **Neither the collision nor the 23514 exists.** What does exist
is a different defect, in the record of what those weeks still owe.

Everything below is read from production rows. Where I changed my own mind
mid-investigation I have said so, because two of those turns are the useful
part.

## 1. The three numbers, and why only one of them is the basis

| figure                        |          value | what it actually measures          |
| ----------------------------- | -------------: | ---------------------------------- |
| `rakeback_periods` (866 rows) |     173,311.84 | legacy daily writer, stalled 09-17 |
| `rakeback_daily_user` cache   |     800,025.45 | **a different quantity**           |
| `rake_attributions`           | **615,842.54** | the accounting basis               |

**The 800,025.45 is not a candidate.** It is not "the corrected basis"; it is
not the same measurement at all. `fn_rakeback_recompute_day` has no tournament
filter, keys on `rake_records.club_id` (the record-OWNING club, which for union
play is the union house club) and uses UTC days. So that total is all rake of
every kind:

```
tournament rake in it   170,534.57
cash rake in it         629,495.88   (UTC days)
                        ----------
                        800,030.45   (800,025.45 for the two cached clubs)
```

The cash rakeback path excludes tournaments explicitly
(`is_tournament IS NOT TRUE AND tournament_id IS NULL`), attributes to the
member club, and uses America/Los_Angeles days. Comparing the cache to the
period basis is a category error, and the handover's framing - that the cache
is the corrected figure the periods should agree with - inherits it.

**The basis is what `fn_cash_rakeback_period_basis` derives**, and it reads
`rake_attributions` directly. It never reads the daily cache. For the week
2026-09-14 07:00Z -> 2026-09-21 07:00Z, cash only, non-ghost-twin:

```
cash rake in rake_records            615,843.40
credited in rake_attributions        615,842.54
uncredited (3 records)                     0.86
```

It closes to the cent. By the paying member club:

```
Deep Stack Society   238,816.96   standalone scope
SHARK CLUB           203,064.22 ) Midway Union scope,
Club JAQK            173,961.36 ) together 377,025.58
```

That reconciles against the record-owning view too: Midway Union's house-club
cash rake of 377,025.58 attributes precisely to its two member clubs.

**So the attribution figure vindicates NEITHER of the other two.** The stored
periods are 28.1% of it; the cache is a larger, different measurement.

All 674 players in this basis are horses. None is filtered anywhere in it
(CLAUDE.md 10.5); the totals above are complete.

### The 09-17 cutover gap is inside this window and does not reduce it

The gap (35,995 cash hands / 70,266.90, `financial_alerts` `2597d4c6`) falls
inside 09-14 -> 09-21. It is a gap in **agent commission accrual**
(`accounting_payable_earning_sources`), not in `rake_attributions`: those hands
are attributed, and their rake is inside the 615,842.54. The alert says player
rakeback is unaffected and the rows agree - 3 unattributed records in the whole
week, 0.86.

## 2. What Monday pays: nothing, and that is correct

Not predicted - probed. `fn_process_weekly_accounting(NULL)` is the call both
Monday paths make (`/api/cron/rakeback-period-settle` at Mon 10:30 UTC reaches
it through `settle_club_rakeback` -> `fn_settle_club_rakeback_batch`, and the
pg_cron `union-weekly-rakeback-close` at :00/:30 through
`fn_union_settlement_cascade_due`). Run inside a transaction that raised at the
end to roll itself back:

```
RESULT={"detail": [], "failed": 0, "checked": 0, "success": true,
        "visited_scopes": 0, "more_remaining": false}
CERTS 0->0   PAIDPERIODS 3777->3777   PAIDAMT 413221.89->413221.89
```

Zero scopes visited. The reason is that **the decision was already taken**:
`20260920232523_the_uncertifiable_weeks_move_below_the_floor_and_stay_owed`
advanced both settlement floors to 2026-09-21 07:00Z, because neither week can
certify - `union_pnl_weekly_capture.captured_at` is 2026-09-18 00:41:12Z and
`accounting_cash_accrual_cutover.starts_at` is 2026-09-17 18:24:04Z, and both
weeks start before them. The first settleable week is 2026-09-21 -> 2026-09-28,
due 2026-09-28 09:00Z.

**`fn_settle_accounting_rakeback_stage` is never reached, so there is no 23514.** The handover expected that raise; the code path stops three functions
earlier, at `fn_calculate_cash_rakeback_periods`, which returns
`historical_week_before_observed_source_cutover` for any week starting before
the cutover.

The timing in the handover was also off in a way worth recording: the week
closed at 07:00Z **this morning**, and the due time is
`fn_union_accounting_run_at` = 04:00 America/Chicago = **09:00Z today**, not
"tomorrow". It made no difference because nothing is eligible, but a report
that says "tomorrow" about something due in ninety minutes is the kind of error
that only looks harmless afterwards.

### The stale periods are not inert, and that matters for later

Had the floors not moved, those 866 rows would have blocked the week twice
over: `fn_calculate_cash_rakeback_periods` refuses with
`legacy_or_paid_period_requires_reconciliation` for any overlapping
`rakeback_periods` row that has no certificate (there are 0 certificates), and
the coordinator raises `union_rakeback_wrong_club` for the 493 pending rows
sitting on the union house club. Both are dormant only because the week is
below the floor. Anything that lowers a floor must clear these first.

## 3. The defect that is real: the obligation is recorded on 28% of the week

`accounting_deferred_obligations` records what the two deferred weeks still
owe. For 2026-09-14 it records **26,542.66** across 866 periods - summed from
those same understated `rakeback_periods` rows, whose writer's cache last
refreshed 2026-09-17 07:29 and then stopped.

So the row that exists to say "this is still owed" states a number measured on
28.1% of the week. Whoever reads it to authorise the one-off payment pays that,
and the obligation looks discharged. Nothing anywhere says otherwise.

**What I could read, and what I could not.** The basis is readable
(615,842.54). The payable is not: a per-player rate has to be the rate observed
at the time it was earned, and `accounting_agreement_history` holds **no
observation before 2026-09-14 12:09:27Z** and none at all for the week of
09-07. Applying today's membership rates to historical earning would be an
assumption presented as a decision - the precise failure CLAUDE.md 10.5 was
written about. Under 10.9 that means the path is not clear, so the amount goes
to Dan as options with costs, and this file does not invent one.

`20260921074340_the_deferred_rakeback_obligation_states_its_measured_basis`
therefore changes no number and moves no chips. It leaves `pending_amount`,
`pending_periods` and `observed_at` exactly as observed - they are a true
observation of the legacy rows at that instant, and falsifying an observation
is not a correction - and writes into each `reason` the measured basis, the
coverage, the per-club split and the fact that the payable is not derivable. It
asserts the basis, the floors, the cutover, the row count and the stored
figures first, so it aborts rather than write numbers it no longer stands
behind.

### The week of 09-07 is the opposite case, and the file says so

I nearly made the same mistake in reverse. `rake_attributions` for that week
totals 66,871.71 against stored periods of over a million - which looks like a
massive overstatement until you count coverage: the attribution ledger holds
**43,754 of that week's 494,915 cash records (8.8%)**, leaving 813,123.18 of
879,994.89 uncredited, because attribution only became complete during the
following week. For 09-07 the attribution total is NOT the basis and the legacy
allocator figures are the better evidence. Both 09-07 rows now say this, so the
next reader does not "correct" that week the way this file corrects 09-14.

## 4. The daily cache: measured, and deliberately left alone

The handover's item was that `fn_rakeback_recompute_day` is on no schedule. It
is not, and I am not adding one - not on the Claude scheduler (10.85) and not
on Open Claw either. The measurements are the argument:

- **After #5002 a stale cache cannot produce a wrong number.** The freshness
  test sends a stale day to the full-source scan.
- **The two branches agree exactly.** `fn_rake_shares_for_record` and the cache
  writer share one precedence (attributions, allocator fallback). The only
  structural difference is the scan's `player_contributions ? user_id` filter,
  and for this week the count of attributions that filter would hide is **zero**.
  Measured on one real period: scan 4,530.77 in 7.56s, cache 4,530.77 in
  0.94ms - identical, 8,000x apart.
- **All 14 club-days of the week are currently fresh.** A closed week's cache
  stays fresh once rebuilt; it does not rot on its own after the week ends.
- **Its only consequential reader cannot pay.** Probed:
  `fn_close_settlement_period` raises `rakeback_requires_accounting_authority`
  (42501) from `fn_club_members_ledger_writer`; the stored amount and the
  player's wallet were unchanged. The v3 accounting path - the actual payer -
  never reads the cache at all, and no application code in either repo
  references it.

I started out intending to delete the cache branch and make the basis a pure
derived read, which is the shape the brief prefers. **The measurement stopped
me**: removing it costs 7.56s per period against 0.94ms for an identical
answer, and buys no correctness, because #5002 already guarantees the fallback.
I also considered adding the lazy recompute into the read path, and rejected
that too - it would mean transcribing 200 lines of a money function for a
performance gain on a function that cannot move money, which is a bad trade on
a live real-money platform.

**So the honest answer to "what schedules it" is: nothing should.** The cache
belongs to a legacy closer the v3 rewrite superseded. The right end state is to
retire the cache with that closer, not to keep it warm with a cron - and that
is a piece of work to do deliberately, not a line to slip into this file.

## What this file does not do

No chips move. No `rakeback_periods` row is touched. No cron, sweep, backfill,
repair or compensating write is created, and under 10.12 none may be.

## Still owed, and it is Dan's call

The deferred weeks remain unpaid and the amount is undecided. The options, with
their costs, are in the report that accompanies this change; the
`financial_alerts` row `deferred_rakeback_basis_2026_09_14` stays OPEN until
that payment is made.

## A note on the migration's version

`scripts/reserve-migration-version.sh` reserved `20260921074340`, but the
Supabase apply path stamps the history row with its OWN clock at apply time,
and recorded `20260921080426`. The file on disk is named for the version
production actually recorded, because that is what
`scripts/ci/check-migrations-applied.mjs` resolves and what a rebuild must
reproduce. The applied bytes therefore differ from this file in exactly one
place - their first comment line still carries the reserved number - and
nothing executable differs. Recording it here rather than leaving a silent
one-line divergence for whoever next diffs the two.
