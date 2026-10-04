# A dropped measurement is not a money break (2026-10-04)

Migration `20261004224309`. Branch `fix/a-dropped-measurement-is-not-a-money-break`.
Law `tests/a-dropped-measurement-is-not-a-money-break.law.test.ts`.

## What was wrong

The Diamond clean-accounting release gate needs seven consecutive days with no
open critical `ca_diamond_incidents`. Two of the three conditions are solidly
met. The criticals condition kept resetting, and never because any money was
wrong.

Section 7 of
[the clean-day series audit](../audits/2026-10-04-diamond-clean-accounting-release-series.md)
named it in one line: **nothing turned a dropped hourly tick into a named
outcome.** Measured on production 2026-10-04, from
`ca_diamond_incidents`: 719 `DR11:trial_balance_summary` rows since 2026-09-04
23:20 UTC, 718 consecutive gaps, and three of those gaps are a missed tick
(2026-10-01 00:20 UTC, cron message `job startup timeout`; 2026-10-01 23:20 and
2026-10-03 20:20, which never fired at all, during a database-wide pg_cron
stall that ran 268 jobs in the 20:00 hour against a normal ~830).

Three places folded "I could not tell" into something it is not, against
CLAUDE.md 10.86 rules 1 and 3:

1. **`fn_ca_diamond_trial_balance_watch` filed nothing when its pass could not
   complete.** The whole body sat inside one handler:

   ```sql
   EXCEPTION WHEN OTHERS THEN
     RAISE WARNING 'fn_ca_diamond_trial_balance_watch failed: %', SQLERRM;
     RETURN -1;
   ```

   A `RAISE WARNING` into the Postgres log has no reader in this estate. The
   hour simply had no row, and the per-day count anyone would compute reads 23
   instead of 24 with no flag. **That line is the one that produced the wrong
   outcome for a dropped tick: silence.**

2. **The same function filed its summary row even when the read compared no
   account at all**, so a hollow row counted as an hour that measured the books.

3. **The un-paged health outcome carried the paged one's name.**
   `20261003220245_a_missed_snapshot_is_retried_not_paged` had already fixed
   the severity (a first unknown files warning, a persistent one files
   critical, and that is right and is kept exactly). But both outcomes filed
   under the rule name `DR0:health_critical`, so the could-not-tell row
   asserted a critical in its own name and only its severity column said
   otherwise. That is rule 1 left one level up, which is rule 4.

## The three outcomes now, and who reads each

| outcome             | what is filed                                                                                                                                                                                                             | reader                                                                                                                                                                                                                                                      |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a money break       | `DR11:trial_balance_break`, critical over 1,000 diamonds (ruling 13); the `trial balance` area reading `critical` -> `DR0:health_critical` at critical on the **first** tick                                              | the `ca_diamond_incident_pages` trigger (`WHEN severity = 'critical'`) -> `fn_ca_raise_drift_incident` -> `ca_drift_incidents` -> `fn_ca_incident_notify`, which gates on the **source** and not the rule, so the rename cannot mute it -> Dan's phone      |
| the books are clean | `DR11:trial_balance_summary`, info, now carrying `reading_complete: true`                                                                                                                                                 | the clean-day series, and `fn_ca_diamond_staff_books('books')`                                                                                                                                                                                              |
| nobody could tell   | `DR14:trial_balance_unreadable` at **warning** (`reason` `read_failed_<SQLSTATE>` with the message, or `no_accounts_reported`); the new `trial balance reading` area reading `unknown` -> `DR0:health_unknown` at warning | `fn_ca_diamond_health_watch` at :35, which escalates to `DR0:health_critical` at critical if the **next** hourly reading still cannot tell; and `fn_ca_diamond_staff_books('health')`, which returns every area verbatim out of `ca_diamond_health_reading` |

`fn_ca_diamond_health` now returns fifteen areas rather than fourteen. The
existing `trial balance` area answers whether the books balance; the new
`trial balance reading` area answers whether anybody read them.

## Why 95 minutes, and where the cadence was read

From `ca_diamond_incidents`, the `DR11:trial_balance_summary` series itself:
718 consecutive gaps, **715 of them at most 65 minutes**, 3 of them exactly one
missed tick, and **not one gap longer than 2h00m01s in thirty days.** The
health watch reads at :35 and the trial balance runs at :20, so a healthy
newest reading is 15 minutes old and the single missed tick the series has
actually produced shows as 75. 95 covers both with slack. Past it, two or more
consecutive hourly ticks produced no reading, which has never happened.

**The direction of failure is deliberately upward.** A single dropped tick
never again files a critical money incident. Books that genuinely stop being
measured still page: `unknown` at two missed ticks, `critical` at three, about
three and a quarter hours, against a measured worst case of one. The health
watch was not made quieter anywhere.

## What this does not do

- It resolves, edits, backdates and deletes **no** incident row. The 95
  `DR0:health_critical` rows and the one incident of 2026-10-03 19:35 stay
  exactly as they are (10.9). The clock restarting from today is the honest
  position and it is left that way: this prevents the next false reset, it does
  not clean the record.
- No cron, sweep, backfill, reconciler or healer (10.12), and no `fn_*_repair_*`.
- No schedule, grant, index or table change. No arena switch touched.
- It does not contest `20261003220245`. That migration's law reads that
  migration's own text, which is unchanged, and its rule - a first unknown is
  retried, not paged - is carried through here unaltered.

## The pg_cron stall is already addressed

`20261003223747_a_cluster_wake_does_not_queue_behind_the_pass` and
`20261004003020_the_heavy_hourly_watches_do_not_start_together` landed on it
first. Measured from `cron.job_run_details` at 2026-10-04 22:50 UTC: every hour
from 2026-10-04 01:00 onward ran 830 to 844 jobs with **zero** non-succeeded
runs, twenty-one consecutive clean hours, and no trial-balance tick has dropped
since 2026-10-03 21:20. No unaddressed cause was found and nothing here touches
the scheduler.

## How it was proved

Exact substitution through a `pg_temp` helper, the pattern of `20261003025434`
and `20261003220245`: live md5 pinned before and after, each anchor proved to
occur exactly once by arithmetic, the postimage computed read-only on
production with the reverse substitution proved to return the preimage md5, and
owner, security, settings and grants asserted unmoved. One migration, one
`BEGIN`/`COMMIT`.

Every postimage was rehearsed in `pg_temp` inside a transaction that ended in
`RAISE EXCEPTION`, so nothing committed (CLAUDE.md 11.5, section 2 rule 3). The
rehearsals substituted `fn_ca_diamond_incident` and `ca_diamond_incidents` for
captured temporary copies, so no production row was written or locked:

| rehearsal                                           | result                                                                                                                                                                       |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| normal tick                                         | `ret=0`, one summary row, `accounts_reported=11`, `reading_complete=true`, 0 `DR14`, 0 criticals                                                                             |
| read compared no account                            | `reading_complete=false`, 1 `DR14` `reason=no_accounts_reported` at warning, **0 criticals**                                                                                 |
| pass could not run (forced `1/0`)                   | `ret=-1`, exactly **one** row filed: `DR14` `reason=read_failed_22012` at warning, no summary row, **0 criticals**. Before the change this filed nothing at all              |
| **a real break of 5,000 on `player_diamonds`**      | `DR11:trial_balance_break` at **critical**, amount 5000, 1 critical, 0 `DR14`. Unchanged force                                                                               |
| health report                                       | 15 areas; `trial balance` still `ok`; new `trial balance reading` `ok`, 30 minutes old. With the threshold forced, the same area reads `unknown` with the unmeasured wording |
| health watch, first unknown                         | `DR0:health_unknown` at warning, **0 criticals**, `first_unknown_retried_next_tick: true`                                                                                    |
| health watch, still unknown next tick               | `DR0:health_critical` at **critical**                                                                                                                                        |
| **health watch, a critical area on the first tick** | `DR0:health_critical` at **critical** immediately, `first_unknown_retried_next_tick: false`                                                                                  |

The law's negative control was executed three times, each removal turning a
different pin red: restoring the old blanket handler fails "gives a pass that
could not run its own name"; making the new area read `critical` instead of
`unknown` fails "names the unmeasured hour unknown, and never critical"; and
folding the un-paged outcome back under `DR0:health_critical` fails "gives the
un-paged health outcome its own rule name". The file was restored byte for byte
(sha256 `2638a90b7090a9fd5fe56ff6420e968b6174030e7e7ca6ab0f118c58c642c70f`) and
all six pins pass again.
