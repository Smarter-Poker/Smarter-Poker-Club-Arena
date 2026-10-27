# Durable inbox commits wake the canonical Production Alerts intake

The producer's successful `destination: codex` receipt recorded database capture
without invoking native Codex. The canonical chat was also archived. Unarchiving
and finite native/CLI transport tests proved it can run again, but did not supply
automatic production event delivery.

The source repair attaches an opaque Realtime signal and private delivery record
to each original inbox insert. A receive-only plugin in the existing local
OpenClaw gateway uses the documented native queue command. It serializes one
bounded batch until the canonical chat acknowledges actual full reads through
service-only RPCs. Queue timeouts/crashes retain an unknown operation instead of
blind resubmission. Alert text, accounts, amounts and original IDs never enter the
credential-authenticated receive-only projection. No public listener, privileged local API key,
polling repair loop, scheduler, financial writer or release action is introduced.

The existing PostgreSQL alert qualification invokes a real isolated RLS/ACL and
transaction fixture for the exact migration; Vitest checks the queue receipt,
concurrent event burst, durable submission, unknown outcome/restart and malformed
or unavailable source response. Local manual queue tests independently used the
actual desktop CLI. Protected merge, migration installation, pinned plugin install
and automatic live event/read/ack remain separate required delivery evidence.

This repairs intake delivery only. It does not establish the original 09:12 lease
expiry cause, resolve financial incidents, or certify the engine source fixes live.

The existing reader-silence notification now measures complete canonical native
read receipts and actual pending-event age. An unrelated investigation edit no
longer establishes reader liveness; successful native ACKs no longer look silent.
Fresh or empty intake is not called stalled. The exact retained production
preimage reproduces both incorrect verdicts in isolated PostgreSQL; the actual
replacement preserves the twelve-hour threshold and one-page-per-silence rule.
Its preimage assertion refuses an unreviewed concurrent source change.

Local ownership uses an exclusive SQLite connection, with committed submission
state before the native side effect. Actual SIGKILL/restart testing preserves an
uncertain operation, releases process ownership without a stale lock file, and
refuses a second live owner or corrupt state. A failed journal write before queue
submission can recover on the next explicit event without inventing a native
receipt. These tests run in the existing required native-smoke gate; the database
fixture also runs from the existing required owner-alert accounting entry. The
classifier adds these specific input paths without narrowing any prior selector.
