# 2026-09-28: An engine break recovery follows its fault

## What was wrong

The hourly break scorecard (`pg_cron` job `ca-break-scorecard` at :12, which calls
`fn_ca_record_break_scorecard()` with no argument) sends `engine_break_failed` to every active
incident recipient through `fn_ca_break_scorecard_push` when an hour's break fails. When a later
hour passed it sent nothing: the recorder's only notification branch was
`IF v_verdict = 'fail'`. For the owner account every fault notice is captured for the Production
Alerts task (`20260916111614`) as a firing receipt in `operational_alert_events`, and a receipt is
recorded resolved only for a recovery: a type ending in `_recovered`, which the classifier already
routes (`engine_break_recovered`). None was ever sent.

Read from production on 2026-09-28 (read-only): 34 `engine_break_failed` receipts (source
`owner-operational-notifications`, ids 39201 to 88376), all firing; 0 `engine_break_recovered`
notifications anywhere; the last fault the 2026-09-18 19:00 break; all 168 hours of the last seven
days passed, each recorded during a run of the hourly job in `cron.job_run_details`.

## The fix (migration 20260928155739, HELD, stacked on #5512)

1. **The recovery is owed to the notice.** `fn_ca_break_scorecard_recovered` (new) takes a pass
   the scorecard recorded and, per route, sends one `engine_break_recovered` naming every
   `engine_break_failed` notice of an earlier hour, sent on or after 2026-09-28 00:00 UTC, that no
   recovery on that route names yet: key `break-recovered:<UTC hour>` (numbered `:2`, `:3` if a
   fault is notified after that hour's recovery), `data.resolves` the fault keys,
   `data.resolves_notification_ids` their notices. It never reads the verdict history, so no
   re-score or backfill of an hour can hide a notified fault. No role but its owner may call it
   (`service_role` included).
2. **The owner account's route is the task, nothing else.** For the owner account only a resolved
   receipt addressed to the task recovers a fault. His recovery is written only when the classifier
   files it with the task: otherwise it would reach his personal inbox and his phone, so it is not
   written and the fault is held open. A recovery found in his personal inbox recovers nothing and
   is not sent again into that inbox. That the classifier keeps `engine_break_recovered` is held by
   the held classifier change's own law,
   `tests/the-owner-classifier-keeps-its-operational-kinds.law.test.ts` (`20260928171444`).
3. **The recorder.** `fn_ca_record_break_scorecard` is production's body (md5
   `0d9eb4d63244cfc69879f87596439c99`) with four changes: the branch
   `ELSIF v_verdict = 'pass' AND p_end IS NULL` calls the recovery inside its own exception
   handler; the pass row keeps the recovery's account in `detail->'recovery'`, and an explicit
   re-score keeps it; and the function runs in UTC (`SET TimeZone`), so the push it calls keys
   every fault in UTC whatever the caller's session. The hourly job is the only caller that passes
   no `p_end`; an explicit re-score never sends a recovery. The verdict CASE is byte-for-byte
   unchanged, and `tests/the-break-clocks-agree.law.test.ts` now reads it from this migration.
4. **The recovery cannot cost the pass.** Every error on the recovery path is caught (per route,
   around the sending, around the recording, and by the recorder around the whole call), and every
   lock wait on it gives up after 5 s (`lock_timeout`, 55P03, caught), long before the hourly
   job's statement timeout (2 min for its role). A timeout or cancel of the whole call (57014,
   which no handler catches) can still lose an hour, as it could before; the recovery path no
   longer provokes one.
5. **Invariant.** When a live pass commits, every owned fault of an earlier hour is accounted for
   in the same transaction: recovered on its route, or listed in the pass row's account with why
   it is still open (not sent, delivery failed, discarded, receipt not recorded, reached the owner
   account's personal inbox) and held by ONE firing `NotifiedFaultWithoutRecovery` for the task.
6. **Detection, twice.** In the same transaction, that record: `fn_record_operational_alert`,
   source `break-scorecard-recovery-guard`, warning, `payload.target_task_id`
   `01a09b86-5ba8-7290-8657-1041f13dd3ca`, the open faults and why; the same key while it is open,
   and once nothing is open, `<key>:resolved`. It records; it never repairs, retries or deletes.
   And independently of that code, `scripts/ci/check-engine-break-recoveries.mjs` runs after each
   hourly Production Integrity Audit (`workflow_run`, no new schedule, CLAUDE.md 10.85 and 10.12).
   It knows the hourly job's passes from pg_cron's own run log, not from the code it audits: a
   pass row recorded during a run `cron.job_run_details` holds as succeeded for the job calling
   the recorder (older than that log, which pg_cron keeps 14 days, one recorded inside its own
   hour). A fault the task still sees open after such a pass is recorded as one
   `NotifiedFaultWithoutRecovery` (source `engine-break-recovery-audit`, `payload.target_task_id`)
   and later recovered on the same key; the run exits 1 so it is red. With no succeeded run of that
   job in three hours, or no answer at all, it exits 3 COULD NOT TELL. It sees a recorder replaced
   without the recovery, a job passing the recorder an hour or scoring an earlier one, a refused
   record, a pending receipt and a recovery in the owner account's personal inbox; an explicit
   re-score, even inside the hour, is never taken for the hourly job.

## Review history

**Round 1 (`d96b316`): FAIL.** The recovery read a failing episode from the scorecard, so an
explicit re-score or a backfilled clean pass could hide a notified fault (15 of 626 production
scorecard rows were last written outside their own hour); its only detector ran inside the code it
checked; a delivery error cost the pass; the law matched upper-case DDL only; `service_role` could
call the recovery; one `@live-proof` was already true before the install; the probe took a raising
call for a turned hour; keys followed the session's time zone. Fixed in `2e9a05183`.

**Round 2 (`2e9a05183`): FAIL.** Each finding was reproduced before it was fixed.

- The probe built a SQL_ASCII cluster (`LC_ALL=C`, no encoding), so the held classifier migration,
  which names the push and so is applied on top, failed on its `U&` literal and the probe could
  not run. The cluster is UTF8 now, as production is; with that migration present the probe
  passes.
- The invariant and the audit counted a recovery in the owner account's personal inbox as
  recovered: with the classifier no longer filing `engine_break_recovered`, a pass put the recovery
  in his inbox, nothing reached the task, and nothing reported it. Fixed as in 2 above.
- With a lock held on `notifications`, the hourly call ran into its statement timeout (57014, not
  caught) and the hour was lost. Fixed as in 4 above.
- The audit took any pass recorded inside its own hour for the hourly job's, so an in-hour
  fail-to-pass re-score raised a false incident. It reads pg_cron's run log now, which also shows
  it a job changed to score an earlier hour (documented as unseen before; the in-transaction record
  still does not see that, only the audit).

## Deliberately not changed

- `fn_ca_break_scorecard_push`. `20260927235053` pins it in its `@live-proof` and the held cleanup
  `20260928000622` re-checks it, so it is read, never replaced.
- The 34 existing receipts, all sent before 2026-09-28: they stay with the Production Alerts task,
  and nothing sends a recovery for them (0 owned faults in production today).
- The verdict, every measurement (the probe re-scores five hours covering every branch with both
  images and compares every column), every table, policy and schedule.

## Order

`20260927235053` (store-only delivery, #5512), then the held cleanup `20260928000622`, then this,
outside :50-:03 UTC. It refuses to install unless store-only delivery is installed completely
(every `@live-proof` of `20260927235053`, re-checked verbatim, as the cleanup does), because before
it the owner account's recovery would be written into his personal inbox. It also refuses a changed
recorder, a classifier that does not route `engine_break_recovered` to the task for the owner
account alone, an existing function by the new name, and an hourly job that is not the no-argument
call. It proves itself in rolled-back subtransactions. The held classifier change installs before
or after it.

## Regression protection

- `scripts/dev/probe-engine-break-recovery.sh`: a throwaway UTF8 PostgreSQL built from #5512's
  store-only fixture plus `scripts/dev/fixtures/engine-break-recovery/`. Red before (fail, fail,
  pass; an old pass re-scored to a notified fail; a fault ended by a backfilled clean pass; a fault
  keyed in the session's time zone), 109 assertions green after, the same with the held classifier
  migration applied on top, and the audit run end to end against the same cluster. Each of 14
  mutations of the migration and the audit turns it red, and so does a SQL_ASCII cluster with the
  classifier migration present.
- `.github/workflows/engine-break-recovery.yml`: the probe on every pull request that changes its
  inputs or a migration naming the recorder, the push or the recovery; the audit's decision rules
  (`node --test`, 13 cases) on every run; and the audit itself after each Production Integrity
  Audit.
- `tests/a-break-recovery-follows-its-fault.law.test.ts` (required Client Unit Tests): 10/10 on
  this tree; red on #5512's head, on both earlier versions, and on a later lowercase, quoted
  `EXECUTE` or granting migration.

## What remains unseen

- A migration that never spells the recorder's, the push's or the recovery's name (it builds the
  name at run time) is invisible to the law and the probe. The audit sees its effect in production
  after the next pass.
- A job changed outside a migration to pass the recorder an hour or to score an earlier hour sends
  no recovery. The audit reports it from pg_cron's run log; the in-transaction record, which runs
  only on the no-argument path, does not.
