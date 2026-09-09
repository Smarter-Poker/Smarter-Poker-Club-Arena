# Tournament Reminder Execution Repair

Status: Database, Sender And Continuous Worker Published. Server Execution Verified. Physical Device Acceptance Unverified.

The former reminder function performed four updates of tournament_players after queueing notifications. The September 9 cron errors include waits on a tournament foreign-key check during push_2m_sent bookkeeping. Notification receipts must not lock or update gameplay records. The old dispatcher also treats failed subscription reads as missing subscriptions, digests separate tournament deadlines together, and uses a 24-hour provider TTL for two-minute reminders.

The replacement records each tournament, recipient, advertised start, and reminder stage in a separate receipt with no foreign keys to gameplay tables. The receipt and outbox insertion commit together. A queue trigger deduplicates even an old function already running during rollout. Existing sent flags are imported once; rescheduling creates a distinct intent. Seated recipients receive a durable suppression receipt. No player or balance writes are added.

The primary caller is the existing always-running workers service, restoring due work from authoritative registration/start records on startup and after interruption. Its timer is only a wake signal. The existing pg_cron function remains a bounded compatibility wrapper until complete adoption is verified. The existing World Hub sender owns preferences, subscriptions and provider dispatch. It must revalidate the receipt immediately before sending, expire the provider TTL with the reminder, and retry unknown subscription results.

Publication and device acceptance are separate gates. No schedule has been removed. The unavoidable provider-accepted-before-database-ack window must not be represented as exactly-once device delivery.

## Verified Database Contract

Applied through Supabase as migration 20260909195446 on September 9, 2026.
The local reserved filename was aligned to the actual migration ledger version;
the migration was not applied twice. All five installed function bodies match the
tested source. Receipt RLS is enabled, anon cannot execute preparation, and the
receipt has zero foreign keys. Forty-three PostgreSQL 17 checks pass, including the
reproduced legacy lock timeout, claim expiry recovery and exhausted attempts.

The existing PostgreSQL CI job now runs the same isolated test against its own
throwaway server. It reuses the existing small pg test dependency and installed
PostgreSQL tools. No second database server package is installed.

Scope follows the user's September 9 direction: one reproducible reminder repair,
focused verification and required gates. No unrelated audit expansion, extra
schedules, or repeated acceptance claims.

## Release And Remaining Acceptance

The initial cross-service cron credential was rejected in production and was replaced by verified database service authority through the existing service-only reminder RPC. The corrected sender and worker are running. The natural 21:58 UTC cycle is accounted for, with zero unresolved rows. Physical device acceptance remains unverified. Exact revisions, gates, observations and limitations: [release verification](2026-09-09-tournament-reminder-release.md).
