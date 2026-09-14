# Bounded adaptive journal retention

Journal receipts and completed work previously grew without expiry. One
service-only retention call now removes at most 100 completed jobs, 100
unreferenced batch receipts and 1,000 expired observations. It touches only
the three isolated learner tables. No financial table, hot-table foreign key,
trigger, scheduler or policy activation is involved.

Completed job metadata stays for at least 32 days after completion. A batch
requires both its recording time and source-window end to be older than 32
days, and no remaining job may refer to it. This includes completed jobs:
their buffered payload has been cleared, so recovery still relies on the
batch's canonical payload. Queued and quarantined jobs do not expire here.
The existing 256-job and 64-MiB unfinished-work limits include quarantine.

An observation requires recording time older than 32 days and observation
time older than 30 days. Both checks matter because a transaction timestamp
can precede a later observation. Recent model evidence is retained even if
its recording timestamp is old. Locked rows are skipped, and a later bounded
pass can retry them. Supporting indexes belong only to these learner tables.

Admission and pruning share the same nonwaiting capacity reservation. A new
enqueue must still have a source window within the journal's 30-day limit and
must not end in the future. An expired new source returns `source_expired`,
even if an old journal receipt exists. An already accepted durable job can
still replay. This prevents new work from being admitted across deletion of
an expired receipt; it does not invent source coverage or repair stale work.

The caller reports only verified counts for one transaction. A lost reply is
unknown, including when deletion committed. Retry is safe and bounded, but
zero reported deletions does not prove the backlog is empty: rows may be
locked or still protected. Historical batch recovery can become unavailable
after its retention contract expires. No complete-window flag follows from
either a receipt or retention.

Native PostgreSQL proof first reproduces acceptance of expired new work in
the prior queue, then verifies its rejection after the forward migration.
It also covers budgets across multiple passes, both age clocks, recent source
protection, all job dependencies, capacity contention, locked rows, a lost
committed reply and service-only permissions. The same fixture retains the
actual-controller, source reader, journal, restart and durable-work checks,
then stops and removes its private database. Transport tests reject malformed
counts and preserve unknown outcomes.

An isolated worker lifecycle, durable source discovery, full scoped model
consumption, counterfactual evaluation, held-out/shadow gates and rollback are
still required. This retention component does not complete Phase 14.

Validation passed: compilation,221focused tests,27native database groups with
verified cleanup, and11,517full server tests across782files, with145existing
skipped tests and one skipped file (75.52s). An initial test used a matcher
absent from the installed test framework; it was replaced by the equivalent
call-count and argument assertions. Both initial errors and final proof remain.

Migration20260913193221 was applied once at19:39:24UTC under database history 20260913193924. Exact queue/prune bodies, three retention indexes, RLS and
service-only permissions matched. All three production learner tables were
empty; no synthetic production records or retention calls were made.
