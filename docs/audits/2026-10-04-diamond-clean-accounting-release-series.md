# The clean-accounting release prerequisite, as an actual time series

Written 2026-10-04. Read-only evidence for Phase 12 of
[the Diamond Arena programme](../POKER-ARENA-DIAMOND-BUILD-PROGRAMME.md), line 1:
"Verify existing clean-accounting release prerequisites with actual time-series
evidence."

Everything below came from `SELECT` inside a read-only repeatable-read
transaction against project `kuklfnapbkmacvwxktbh`. No write, no DDL, no
migration. Both arena switches read `false` throughout.

## 1. The condition, as written, and who wrote it

[`DIAMOND-ACCOUNTING-ROADMAP.md:197`](../DIAMOND-ACCOUNTING-ROADMAP.md), verbatim:

> Entry condition: seven consecutive days of `fn_ca_diamond_trial_balance` at 0
> on every account, suspense 0, and no open critical `ca_diamond_incidents`.

Line 210 of the same file says the same thing from the other side: "When the
first three read zero for seven days ... Phase 3's deletions are due and Phase 5
may open." The programme's Settings And Prerequisites section confirms this
condition "is documented in DIAMOND-ACCOUNTING-ROADMAP, not invented by this
programme", and adds: "Any inability to satisfy it must be reported honestly at
release".

So the seven days attach to **all three** readings, not to the trial balance
alone. That is the reading this document tests.

## 2. What is read right now, and why that is not the answer

Read 2026-10-04 21:48 UTC, `fn_ca_diamond_trial_balance(now() - interval '24 hours')`,
eleven accounts:

| account | balance_now | difference |
| --- | --- | --- |
| `arena_wallets` | 0 | null |
| `dead_stores` | 0.00 | null |
| `diamond_debts` | 0 | null |
| `diamond_house` | 0 | 0 |
| `fixture_accounts` | 13560 | 0.00 |
| `mirror_mismatch` | 0 | null |
| `player_diamonds` | 10697485 | 0.00 |
| `promo_budgets_spent` | 9651048 | null |
| `register` | 10711045.00 | 0.00 |
| `suspense` | 0 | null |
| `total` | 10697485 | 0.00 |

Open critical `ca_diamond_incidents`: **0**. `poker_diamond_custody`: 0 rows.
`diamond_wallet_transfers`: 0 rows. The health reading at 2026-10-04 21:35 UTC
has 13 of 14 areas `ok` and one `attention`: "budget plans: 3 budget line(s) are
fiction. They refuse nobody (ruling 21); setting them is Dan's."

That is a correct point-in-time reading and it is **not** the prerequisite. The
prerequisite is a run of days. Sections 3 to 6 are the run.

## 3. Where each series comes from

| Reading | Source row | Cadence | Retained from |
| --- | --- | --- | --- |
| trial balance per account | `ca_diamond_incidents` rule `DR11:trial_balance_summary`, `detail.accounts_reported` and `detail.accounts_broken` | hourly at `:20`, by pg_cron job `ca-diamond-trial-balance-hourly` | 2026-09-04 21:20 UTC |
| a broken account | rule `DR11:trial_balance_break`, severity warning, and `detail.accounts_broken` naming it | same tick | 2026-09-04 09:20 UTC |
| suspense | rule `DR12:suspense_nonzero`, severity info | same tick | 2026-09-07 05:20 UTC |
| open criticals | `ca_diamond_incidents` where `severity='critical'`, `occurred_at` and `resolved_at` | event-driven; the health watch files hourly at `:35` | 2026-09-08 03:20 UTC |
| unexplained movement | `ca_diamond_snapshots.unexplained` | hourly at `:10`, job `ca-diamond-snapshot-hourly` | 2026-09-08 |

The suspense series is **directly evidenced, not inferred**, because the same
function that writes the hourly summary row also tests suspense in the same
pass. From `fn_ca_diamond_trial_balance_watch()`'s body, verbatim:

```sql
IF r.account = 'suspense' AND COALESCE(r.balance_now, 0) <> 0 THEN
  PERFORM public.fn_ca_diamond_incident('DR12:suspense_nonzero', 'info', NULL, r.balance_now, ...);
  v_filed ...
```

So every summary row carrying `incidents_filed: 0` is a positive assertion that
suspense read exactly 0 at that tick, from the same read that produced the
account list. Note the severity: a nonzero suspense files **info**, not critical,
so suspense never shows up in the open-criticals series on its own.

**Where the series starts.** 2026-09-04. There is no reading of any kind before
2026-09-04 09:20 UTC, because the watch did not exist. Anything about the state
of these books before that date is not in this document and cannot be read from
rows.

## 4. The series, per UTC day

`TB readings` is the number of hourly trial-balance ticks that produced a row
(24 is complete). `broken` is the number of those ticks that named at least one
account out of balance. `susp` is `DR12:suspense_nonzero` filings. `crit EOD` is
criticals still open at 23:59:59Z. `crit any` is criticals open at any moment in
the day. `unexpl` is the largest absolute `ca_diamond_snapshots.unexplained`.

| UTC day | TB readings | broken | susp | crit EOD | crit any | unexpl | clean |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-09-04 | 3 | 1 | 0 | 0 | 0 | n/a | no |
| 2026-09-05 | 24 | 4 | 0 | 0 | 0 | n/a | no |
| 2026-09-06 | 24 | 15 | 0 | 0 | 0 | n/a | no |
| 2026-09-07 | 24 | 14 | 2 | 0 | 0 | n/a | no |
| 2026-09-08 | 24 | 1 | 0 | 0 | 28 | 223580.00 | no |
| 2026-09-09 | 24 | 0 | 0 | 17 | 17 | 0.00 | no |
| 2026-09-10 | 24 | 0 | 0 | 36 | 36 | 0.00 | no |
| 2026-09-11 | 24 | 8 | 0 | 45 | 45 | 100.00 | no |
| 2026-09-12 | 24 | 0 | 0 | 45 | 45 | 0.00 | no |
| 2026-09-13 | 24 | 0 | 0 | 45 | 45 | 0.00 | no |
| 2026-09-14 | 24 | 0 | 0 | 45 | 45 | 0.00 | no |
| 2026-09-15 | 24 | 0 | 0 | 45 | 45 | 0.00 | no |
| 2026-09-16 | 24 | 0 | 0 | 45 | 45 | 0.00 | no |
| 2026-09-17 | 24 | 0 | 0 | 45 | 45 | 0.00 | no |
| 2026-09-18 | 24 | 0 | 0 | 45 | 45 | 0.00 | no |
| 2026-09-19 | 24 | 0 | 0 | 45 | 45 | 0.00 | no |
| 2026-09-20 | 25 | 0 | 0 | 0 | 45 | 0.00 | no |
| 2026-09-21 | 24 | 0 | 0 | 0 | 0 | 0.00 | **yes** |
| 2026-09-22 | 24 | 0 | 0 | 0 | 0 | 0.00 | **yes** |
| 2026-09-23 | 24 | 0 | 0 | 0 | 0 | 0.00 | **yes** |
| 2026-09-24 | 24 | 0 | 0 | 0 | 0 | 0.00 | **yes** |
| 2026-09-25 | 24 | 0 | 0 | 0 | 0 | 0.00 | **yes** |
| 2026-09-26 | 24 | 0 | 0 | 0 | 0 | 0.00 | **yes** |
| 2026-09-27 | 24 | 0 | 0 | 0 | 0 | 0.00 | **yes** |
| 2026-09-28 | 24 | 0 | 0 | 0 | 0 | 0.00 | **yes** |
| 2026-09-29 | 24 | 0 | 0 | 23 | 23 | 0.00 | no |
| 2026-09-30 | 24 | 0 | 0 | 46 | 46 | 0.00 | no |
| 2026-10-01 | 22 | 0 | 0 | 0 | 49 | 0.00 | no |
| 2026-10-02 | 24 | 0 | 0 | 0 | 0 | 0.00 | **yes** |
| 2026-10-03 | 23 | 0 | 0 | 0 | 1 | 0.00 | no |
| 2026-10-04 | 22 | 0 | 0 | 0 | 0 | 0.00 | incomplete |

`unexpl` reads `n/a` before 2026-09-08 because `ca_diamond_snapshots` has no row
before that date.

## 5. What the series says

**The trial balance itself has been clean for 22 complete days.** The last tick
that named a broken account was 2026-09-11 15:20 UTC (`player_diamonds` and
`register`). Every tick from 2026-09-12 00:20 UTC onward reports eleven accounts
and names none broken, and `ca_diamond_snapshots.unexplained` has been exactly
0.00 on every snapshot since 2026-09-12. This half of the condition is
comfortably and genuinely evidenced.

**Suspense has been 0 since 2026-09-07 17:20 UTC**, the second and last
`DR12:suspense_nonzero` filing. Every hourly tick since has asserted it, by the
mechanism in section 3.

**The open-criticals half is the one that does not reach seven days.** The only
run of seven or more consecutive fully clean days anywhere in the record is
**2026-09-21 through 2026-09-28, eight days**. It ended on 2026-09-29.

Since then there have been two complete clean days, 2026-10-02 and, pending the
rest of today, 2026-10-04, separated by 2026-10-03. On the most generous reading
available, counting a day clean if no critical was open at 23:59:59Z and ignoring
hours with no reading, the current run is **2026-10-01 to 2026-10-04, four days,
one of them still in progress**. On the strict reading the table uses, the
current run is **one complete day**.

**Seven consecutive clean days are therefore not currently evidenced.** They were
evidenced on 2026-09-28. The gate reads met at this instant and has not read met
for seven days.

## 6. The three breaks, and what each one actually was

### 6.1 The 45 rows of September 9 to 19 were bookkeeping, not broken money

This is the subtlety the series must not misstate. 45 `DR0:health_critical` rows
were filed between **2026-09-09 07:35** and **2026-09-11 15:35** UTC. Every one
of them was resolved at the **same instant**, `2026-09-20 14:10:11.98905+00`,
which is the first pass of the resolver installed by migration
`20260919223032_the_health_watch_resolves_what_it_filed` (confirmed present in
`supabase_migrations.schema_migrations`).

Their resolution notes, verbatim, are of the form "auto: area money identity read
ok; area deploy gate read ok; area trial balance read ok at 2026-09-20
14:10:11.98905+00". Four distinct notes, naming four areas: `trial balance`,
`money identity`, `deploy gate`, `rewards lost to expiry`.

Two facts settle what happened:

1. **The last of the 45 was filed 2026-09-11 15:35.** Nothing was filed on the
   nine days from 2026-09-12 to 2026-09-19, so the condition that produced them
   had stopped.
2. **The trial balance stopped breaking on 2026-09-11 15:20**, the last
   `DR11:trial_balance_break` tick, and `ca_diamond_snapshots.unexplained` went
   to 0.00 and stayed there from 2026-09-12.

So the cause was fixed on 2026-09-11, the books were clean from 2026-09-12, and
the rows sat open for nine days because **nothing in the database could close
them**. The resolver did not fix money. It gave a watch that files its own
findings a way to retire them, and its notes say "read ok", not "fixed now". The
money was not broken between September 12 and September 19; the record was.

The honest cost of the gap is still real: because the gate names open criticals,
those nine days could not be counted toward seven clean days at the time, which
is what the roadmap meant by "these rows are the only thing keeping that gate
literally unmet". The first day countable after the resolver ran is 2026-09-21,
because 2026-09-20 itself had 45 criticals open for its first fourteen hours.

### 6.2 September 29 to October 1 was horses, and it was real

23 criticals on 2026-09-29, 23 more on 2026-09-30, 3 on 2026-10-01, 49 resolved
together at `2026-10-01 01:35:09.602968+00`. Every one names one area, `horse
claims`, and the detail text is, verbatim from the first of them, "69 horse
reward(s) are owed past the sweep interval; nothing but fn_ca_horse_claim_due
presses a horse's button", rising hour by hour to 158 by 05:35 on the first day.
The resolution reads "auto: area horse claims read attention at 2026-10-01
01:35:09.602968+00".

This is the episode the programme's Immediate Next Batch section describes: the
daily cap rule `DR7:user_over_daily_cap` moved from log to refuse at
`2026-09-26 06:50 UTC` (`flipped_by: auto:flip_due`, in
`ca_diamond_rule_modes`), and refused claims that carried a milestone over the
cap. It is now resolved: the health reading at 2026-10-04 21:35 says "horse
claims: ok. No horse is owed a reward it cannot claim." The warning-severity
tail is still open, though: `CH3:horse_claim_failed` holds 247 open warnings
(latest 2026-10-04 00:04), `CH3:milestone_refused` 3, `CH3:milestone_step_failed`
4. Warnings never page and are not part of this gate, but they are not nothing.

### 6.3 October 3 was the database's clock, not the books

One critical, id 874553, filed `2026-10-03 19:35:02` and resolved
`2026-10-03 21:35:00`. Its detail, verbatim:

```
{"areas": 1, "detail": [{"area": "trial balance", "detail": "Trial balance is
incomplete: require one known comparison for each of the five reconciling
accounts.", "status": "unknown"}]}
```

Its resolution: "auto: area trial balance read ok at 2026-10-03
21:35:00.689577+00".

The trial balance did not break. It read **unknown**, which is the third outcome
CLAUDE.md 10.86 rule 1 demands and the detector produced it correctly rather than
answering green. What was actually happening is visible in `cron.job_run_details`
for that window:

| hourly job | 18:xx | 19:xx | 20:xx | 21:xx |
| --- | --- | --- | --- | --- |
| `ca-diamond-snapshot-hourly` (`:10`) | ran | **did not run** | ran | ran |
| `ca-diamond-trial-balance-hourly` (`:20`) | ran | ran | **did not run** | ran |
| `ca-diamond-health-watch-hourly` (`:35`) | ran | ran (filed) | **did not run** | ran (resolved) |

And the scheduler estate-wide, same window, all jobs:

| UTC hour | cron runs | not succeeded |
| --- | --- | --- |
| 16:00 | 795 | 1 |
| 17:00 | 833 | 32 |
| 18:00 | 834 | 1 |
| 19:00 | 729 | 7 |
| 20:00 | **268** | 1 |
| 21:00 | 787 | 1 |
| 22:00 | 826 | 1 |

The 20:00 hour ran roughly a third of its normal load. This was a pg_cron stall
across the whole database, not a Diamond defect, and it is why three separate
Diamond watches each lost a tick. The critical was correct, its cause was the
scheduler, and the incident resolved on the next tick that ran.

## 7. The gaps, named as gaps

Three hours in the last four days produced **no** trial-balance reading at all.
A missing reading is "could not tell", and it is not a clean hour:

| missing tick | what `cron.job_run_details` says |
| --- | --- |
| 2026-10-01 00:20 UTC | a run row exists with `status='failed'`, message **`job startup timeout`** |
| 2026-10-01 23:20 UTC | no run row; the job did not fire. 2026-10-01 has 23 run rows against 24 scheduled |
| 2026-10-03 20:20 UTC | no run row; the job did not fire. 2026-10-03 has 23 run rows, all succeeded |

For comparison, 2026-09-26 through 2026-09-30 each have 24 run rows, all
succeeded. The eight-day clean run of September 21 to 28 has a complete 24
readings on every day.

This matters for how the gate is read. The gate is evidenced by an hourly job
that demonstrably drops runs, and **nothing turns a dropped run into a named
outcome.** The summary row simply does not exist for that hour, and the per-day
count that anyone would compute from the rows reads 23 instead of 24 with no
flag. By CLAUDE.md 10.86 rule 1 that is a missing third outcome, and by rule 3 it
has no reader. A seven-clean-day claim built on these rows should state the
reading count per day, as section 4 does, rather than only the break count.

## 8. What is genuinely evidenced, and what is inferred

**Verified from rows:**

- The trial balance has named no broken account on any tick from 2026-09-12
  00:20 UTC to 2026-10-04 21:20 UTC.
- `ca_diamond_snapshots.unexplained` has been 0.00 on every snapshot in that
  period.
- Suspense has filed nothing since 2026-09-07 17:20 UTC, and each hourly summary
  row's `incidents_filed: 0` is a positive read of suspense at that tick.
- 95 `DR0:health_critical`, 1 critical `DR11:trial_balance_break` and 27
  `MINT:register_follow_failed` rows exist in total; **0 are open now**.
- The three break episodes, their exact filing and resolution timestamps, and
  their detail text, as quoted above.
- The three missing trial-balance ticks and the October 3 scheduler stall.
- The only run of seven or more consecutive clean days is 2026-09-21 to
  2026-09-28.

**Inferred, and labelled as such:**

- That the eleven accounts `accounts_reported` counts are the same eleven
  `fn_ca_diamond_trial_balance` returns today. The count has been 11 on every
  tick since 2026-09-12 and the function returns 11 rows, so the identification
  is near certain but it is an identification, not a stored list.
- That the September 29 cause was the `DR7:user_over_daily_cap` flip. The flip
  timestamp (2026-09-26 06:50) and the incident window (from 2026-09-29 00:35)
  are both read from rows, and the programme states the causal link; this
  document did not re-derive it from the claim path.
- That the October 3 scheduler stall caused the three dropped Diamond ticks. The
  stall and the dropped ticks are both measured; the causal direction is the
  obvious one but was not proved.

**Not available at all:**

- Any reading before 2026-09-04 09:20 UTC. There is no series to show.
- `arena_wallets` is 0 today but was not always: `ca_diamond_snapshots.arena_diamonds`
  read 12400 on 2026-09-20, 33200 on 2026-09-21 and 33400 on 2026-09-22, then 0.
  With `poker_diamond_custody` at 0 rows throughout, that is open Diamond Spin
  day balances, which `fn_ca_arena_diamonds()` also counts. The arena account has
  carried real value during the clean run and still balanced.

## 9. Is the programme line satisfiable now

**The line is satisfiable in the sense it asks for: this document is the actual
time-series evidence, and it exists.** What it evidences is not a pass.

| Part of the condition | Evidenced | Verdict |
| --- | --- | --- |
| `fn_ca_diamond_trial_balance` at 0 on every account for seven consecutive days | yes, 22 complete days | **met** |
| suspense 0 for seven consecutive days | yes, 27 days | **met** |
| no open critical `ca_diamond_incidents` for seven consecutive days | yes, and it says no | **not met**; longest current run is 1 complete day strictly, 4 days at best |
| no open critical right now | yes | met, since 2026-10-03 21:35 UTC |

Earliest date the third part could be met, on the strict reading and if nothing
else files: 2026-10-03 is the last unclean day, so 2026-10-04 is day one and the
seventh consecutive clean day closes on **2026-10-10**. On the end-of-day reading
day one is 2026-10-01 and the seventh closes on **2026-10-07**. Both assume the
three `CH3:` warning families stay warnings and that the scheduler does not drop
another trial-balance tick into a critical the way it did on 2026-10-03.

## 10. What needs Dan

1. **Which reading of the seven days he wants.** "No critical open at any moment
   in the day" and "no critical open at the end of the day" give different
   answers today, one day against four. This document does not choose for him.
2. **The budget plans area.** It is the one `attention` in the health reading:
   "3 budget line(s) are fiction. They refuse nobody (ruling 21); setting them is
   Dan's." It does not block this gate, and it is his number.
3. **Whether a dropped hourly tick should be able to break the run.** Three ticks
   went missing in four days and one of them turned into a critical. The gate's
   own evidence has a measurement gap that nothing names.
4. **The 254 open `CH3:` warnings** from the horse episode. Resolved as an
   episode; the rows are still open.

## 11. One correction to the release manifest

[The Diamond release manifest](../dr/diamond-release-manifest.md) section 1 records
two F06 migrations on `main` and not applied. Read from
`supabase_migrations.schema_migrations` on 2026-10-04:

- `20260918232558_mixed_f06_custody_transfer_retains_original_operations` is
  **now applied**.
- `20260919024039_unresolved_f06_custody_retains_its_lease_evidence` is **still
  not applied**.

Also not applied: `20261004124546_the_chip_circulation_marks_count_no_diamond`,
while `20261004194622_the_chip_circulation_proof_reads_one_snapshot` is applied.
That pair belongs to another lane and is noted here only because it was read in
the same query. Nothing in this document depends on either.
