# A streak milestone never takes the daily reward down - evidence

2026-09-30 / 2026-10-01 UTC. Branch
`agent/claude-fix/a-streak-milestone-never-takes-the-daily-reward-down`.
Migrations `20260930233000_a_streak_milestone_never_takes_the_daily_reward_down`
and `20260930233500_a_horse_claim_run_ends_inside_its_timeout`. Decided by
Claude on Dan's delegation of 2026-09-30, recorded under ruling 18 in
`docs/DIAMOND-RULINGS.md`.

## The defect, measured before anything changed (production, read-only)

| Reading (2026-10-01 00:05:30 UTC)                     | Value                               |
| ----------------------------------------------------- | ----------------------------------- |
| `fn_ca_diamond_health()` area `horse claims`          | critical                            |
| Horse rewards owed past the 5-minute sweep interval   | 3,053                               |
| All horse rewards owed (inside the 7-day window)      | 3,080 (100,047 Diamonds)            |
| Horses owed                                           | 934                                 |
| Open `DR0:health_critical` rows (all `horse claims`)  | 46, first 2026-09-29 00:35          |
| Last horse claim                                      | 2026-09-30 00:54:00 UTC             |
| Horses at a 30-day streak whose milestone was refused | 160 (126 from 09-01, 34 from 08-31) |
| players + house + custody - register                  | 0.00                                |

Cause: the claimed-row trigger paid the streak milestone inside the claim, on
the `daily_missions` line (cap 500); `DR7:user_over_daily_cap` refuses since
2026-09-26 06:50, so a 1,000 milestone was refused and rolled the claim back;
the refused rows filled the sweep's 500-row, oldest-first window. No horse was
forfeited a milestone: all 160 are still on the streak that earned it
(consecutive completed days counted with each horse's recorded freezes).

## The rehearsal (rolled back, production)

Fixture: `docs/evidence/diamond-phase-11/a-streak-milestone-never-takes-the-daily-reward-down-rehearsal.sql`.
It copies a stuck horse's daily-mission state (horse `...0005`, 10 owed
rewards, streak 31, 7- and 14-day milestones paid) onto synthetic hydra.bot
accounts made horses inside the transaction, proves the sweep's window holds
only those rows before every sweep, and runs the real sweep and claim.

```
/Volumes/SmarterWork/agent-work/claude-tools/bin/rehearse.sh \
  supabase/migrations/20260930233000_a_streak_milestone_never_takes_the_daily_reward_down.sql \
  docs/evidence/diamond-phase-11/a-streak-milestone-never-takes-the-daily-reward-down-rehearsal.sql milestones
```

- `20260930233000` (md5 `49252c283232b71da6105fec508d576c`), 2026-10-01 00:05 UTC:
  `REHEARSAL OK: 20 checks passed. Stuck horse 00000000-0000-0000-0000-000000000005 (10 owed) copied: C {"claimed":0,"capped":1,"failed":0,"ran":true,"milestones_refused":0} | A {"claimed":10,"capped":0,"failed":0,"ran":true,"milestones_refused":0} paid 1227 | B {"claimed":9,"capped":0,"failed":0,"ran":true,"milestones_refused":1} | B2 {"claimed":1,"capped":0,"failed":0,"ran":true,"milestones_refused":0} | scene 1972 ms, sweep-lock wait 0 ms, total 9512 ms`
- `20260930233500` (md5 `faf2e0fb4dc69eb9193bbfb271d02198`), same fixture on top, 00:19 UTC:
  `REHEARSAL OK: 20 checks passed ... | scene 10168 ms, sweep-lock wait 27294 ms, total 43657 ms`
  (the wait is the fixture queueing for the sweep's own advisory lock while a
  live run held it; it holds nothing live play needs).

What the 20 checks cover: C - a reward its own cap refuses is counted
`capped`, deferred by name to the America/Chicago midnight its cap resets, left
unpaid and unclaimed, and skipped by the next window although it is the oldest
owed row; A - the stuck horse's copy is paid every owed reward plus the 30-day
milestone once (1,000, under its own reference, booked to
`daily_mission_milestones`), the balance moves by exactly that, the
`daily_missions` line is untouched and the 7- and 14-day milestones are not
paid again; B - with 5,500 already on the milestone line, the refused milestone
takes nothing down (every reward claimed and paid), stays owed (recorded, not
credited), is counted `milestones_refused = 1` with `capped = 0`, and is filed
once as `CH3:milestone_refused` naming the cap; B2 - the next daily claim on a
day with room pays it once; and the supply identity moves by nothing.

## Apply and the production watch (read-only)

- `20260930233000`: `=== APPLIED AND RECORDED 20260930233000` at 2026-10-01 00:06 UTC.
- The watch found the next defect: the first runs on the new code (00:07,
  00:09, ...) died at exactly 120.0 s, `canceling statement due to statement
timeout`, inside `fn_ca_register_diamond_journal_row`'s sum over
  `ca_mint_ledger` (176 ms per journal row measured; pg_cron runs as postgres,
  `statement_timeout=2min`). A run that times out rolls back whole: 0 paid.
- `20260930233500` (stop starting claims at 45 s): `=== APPLIED AND RECORDED 20260930233500` at 00:19:58 UTC.
- First budgeted run, 00:21:02: succeeded in 45.5 s, 118 rewards claimed, 78
  milestones paid (78,000 Diamonds), 0 deferred, identity 0.00.

## The drain (production, read-only)

| Reading (UTC)                          | Owed past 5 min | Paid since apply (rewards / milestones) |
| -------------------------------------- | --------------- | --------------------------------------- |
| 00:05:30, before apply                 | 3,053           | -                                       |
| 00:22:17, after the first budgeted run | 3,078           | 118 / 78                                |
| 00:30:29                               | 2,046           | 1,279 / 177                             |
| 00:37:57                               | 1,387           | 2,229 / 205                             |
| 00:46:06                               | 548             | 3,388 / 235                             |
| 00:52:21                               | 0               | 4,273 / 274 (181,500 Diamonds)          |

Every budgeted run succeeded (45 s while the backlog lasted, then 9-21 s).
The supply identity read 0.00 at every reading. Incidents along the way: three
`CH3:milestone_refused` (`deadlock detected` against a concurrent writer, at
00:21; each stayed owed and was paid by that horse's next claim) and one
`CH3:horse_claim_failed` (`deadlock detected` at 00:26; deferred ten minutes,
then claimed). At 00:52 `fn_ca_diamond_health()` read `horse claims` ok: "No
horse is owed a reward it cannot claim." No area read critical.

## Verdict

Tick: milestones pay on their own line, a refused milestone can no longer take
a reward down or block the sweep, the sweep finishes inside its timeout, and
the whole backlog was paid within 31 minutes of the second apply. The 47 open
`DR0:health_critical` rows (all `horse claims`) close at the next hourly watch
by its own rule, which resolves a row once every area it names reads other than
critical; that closure is reported with its numbers in the line's final report.
