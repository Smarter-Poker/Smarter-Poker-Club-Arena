# tests/reading-a-report-does-not-change-it.law.test.ts

fn_ca_diamond_health was declared STABLE and called fn_ca_diamond_snapshot,
which is VOLATILE and INSERTs - so reading the report advanced the baseline its
own deploy-gate area measured against, leaving 25 snapshots in eight hours where
8 belonged to the hourly cron. It reads the stored row now, isolates every area
so one failure cannot empty the report, has an `unknown` status, and reads cron
liveness from job_run_details rather than from `active` alone. The claim sweep
gained the maintenance-freeze gate CLAUDE.md 13 rule 5 requires (zz_freeze_guard
covers neither profiles nor diamond_transactions, so nothing else would have
stopped it crediting inside a break), an xact-scoped lock with no unlock to miss,
and a return shape where "did not run" differs from "nothing was owed". A new
area watches the one number that must never be non-zero - rewards that expired
unclaimed - because an expired row leaves the horse-claims count, so that area
would have gone green as the diamonds were lost. The flip gate reads would_refuse
instead of the resettable since_config. And Ruling 3's 4,703-row write-off is
filed as an incident: an adversarial review proposed settling those 159,275
diamonds, and the counts match amendment 2 exactly, so they are Dan's ruling
being applied and must not be paid.
