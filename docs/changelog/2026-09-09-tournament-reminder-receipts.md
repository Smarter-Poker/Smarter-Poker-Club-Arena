# 2026-09-09: Reminder Receipts Do Not Lock Players

The former reminder generator updates player rows after enqueueing pushes. The replacement commits versioned notification receipts with the outbox and never updates a player row. An isolated PostgreSQL 17 execution reproduced the old lock timeout and verified the replacement through 40 checks, including legacy overlap, bounded batches, rollback, cancellation, rescheduling and abandoned claims. Source re-read: yes. No gameplay timing or accounting changes. The workers service is the intended primary caller; the compatibility cron remains active. Application and publication evidence: docs/audits/2026-09-09-tournament-reminder-execution.md.

The session entry lives here under the existing per-change changelog rule. The frozen shared changelog is not part of this repair. This removes the documentation overlap that blocked this PR, while preserving every other session entry.
