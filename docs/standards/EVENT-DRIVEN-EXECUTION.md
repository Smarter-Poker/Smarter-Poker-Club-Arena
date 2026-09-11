# Event-Driven Execution Standard

Status: User-directed Club Arena standard, September 9, 2026.

Significant work must have a built-in server owner and durable recovery. The user
described this as preferring hard-coded anchors over cron. This means reliable
execution wired into the application, not hard-coded balances, user identifiers,
credentials, or duplicated rules.

## Required Execution Model

1. **Own The Business Operation.** The authoritative server operation must enforce
   its required invariants and perform its required state transition. A later cron
   run must not be the only reason a buy-in, cash-out, settlement, payout, start,
   elimination, or other significant operation becomes correct.
2. **Record Required Follow-Up Durably.** When committed state requires an event
   or notification, persist the work atomically with that state, or use an
   equivalent proven durable handoff. A successful database commit must not
   depend on an external provider responding while the transaction holds locks.
3. **Give Delayed Work An Owner.** The engine or an always-running service owns
   deadlines and consumes durable pending work. Creating a delayed queue message
   does not invoke a consumer. Name the actual consumer and its invocation path.
   An in-memory timer is a wake signal, never the only record of the obligation.
4. **Recover After Interruption.** Reconstruct pending deadlines on startup,
   resume overdue work according to its expiry rules, and handle cancellation
   and rescheduling against the current authoritative version. Use bounded
   concurrency, bounded batches, retries with backoff, and an explicit failed-work
   recovery path.
5. **Apply Each Intent Once.** Preserve the same idempotency key across retries
   of an ambiguous operation. Duplicate or replayed display events must not
   execute another accounting mutation. A provider accepting a notification and
   the worker crashing before acknowledgment is a distinct crash window; use
   provider idempotency where available and document remaining limitations.
6. **Make Outcomes Visible.** Distinguish committed state, pending work, consumer
   processing, provider acceptance, and device delivery. Record queue age and
   deadline misses. Use existing management alerts and recovery. Do not introduce
   blanket table, club, or account lockouts.

## Cron's Remaining Role

Cron is limited to product-time behavior, read-only observability/reporting, and
bounded housekeeping such as retention pruning. It may not reconcile, heal,
retry, backfill, re-drive, or recover a correctness or release operation. The
owning event-driven transaction or always-running service must complete and
recover significant work from its own durable record.

An existing repair schedule is transitional debt, never target architecture.
Identify its writer, readers, delivery path, owner, and root cause; ship and
verify the owning hard fix; settle already-created damage through the product's
idempotent path; then delete the schedule and its credentials through the normal
release process. Preserve all accounting, privacy, authorization, and
maintenance rules while the root fix is proved.

## Acceptance

Prove the real caller is wired, the durable record survives process loss, a
restarted consumer resumes it, duplicates do not repeat mutations, and canceled
or rescheduled work cannot deliver stale actions. Exercise the primary path with
the old cron disabled in an isolated test environment. Verify production adoption
and observed outcomes before retiring a production schedule.

Keep implemented, tested, deployed, and production-accepted status separate.
Physical device acceptance remains a separate requirement when delivery reaches
a phone, browser, or PWA.

Related investigation: ../audits/2026-09-09-supabase-email-reconciliation.md
