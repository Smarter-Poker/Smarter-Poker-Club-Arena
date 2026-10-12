# The weekly close installs through the managed cron API

The 04:00 Chicago scheduler migration failed before changing job 272 because
Supabase's `postgres` role can read `cron.job` but cannot take `SELECT FOR UPDATE`
on its provider-owned table. The original version never installed and is marked
`SUPERSEDED BY 20261009045421` so the existing installer refuses to dispatch it.

The successor reads its exact preimage in one `REPEATABLE READ` transaction and
uses the supported `cron.alter_job` API. A concurrent edit after the snapshot
raises a serialization failure; the API's row lock protects the complete
postimage assertion through commit. Only the command changes. No table grants,
ownership, timing, coordinator, payment logic or new scheduling path is added.

The existing native PostgreSQL admission fixture now reproduces the refused old
installer as a non-superuser with SELECT but no UPDATE permission, applies the
successor through real pg_cron, and checks two independent concurrent sessions
preserve another editor's command and active flag. Existing admission, budgets,
freeze, held-week, DST and replay checks remain in the same maintained workflow.
This is source qualification; the successor still needs protected delivery and
its exact migration ledger and job postimage readback before installation is claimed.
