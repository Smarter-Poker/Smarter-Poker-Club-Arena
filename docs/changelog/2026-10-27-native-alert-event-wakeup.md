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
