# Superseded requests reach their existing eight-day retention owner

Disposal usually happens after thirty minutes. Trying action compaction only
when that receipt was created could never reach the eight-day age threshold.
The original disposal transactions now capture their exact returned superseded
receipt IDs in a private due queue. The existing retention job commits due work
before discovering up to 5,000 historical keys in a third transaction. No new scheduler is added.

Original pruning and due compaction each commit before historical discovery;
a later failure stays visible without rolling back either completed phase. Each
new phase has a two-second outer statement deadline and nonqueueing admission.
Due compaction also has a 900ms soft budget. Historical discovery waits for a
post-install transaction barrier, covering old producers still executing at
installation. Long old transactions postpone only historical discovery. Generic qualification refusals and locked requests remain retryable;
certified or immutable noncandidate bookkeeping can be discarded. Certificates,
financial evidence and replay fences remain unchanged.

The historical scan is one finite keyset pass. At the observed estimate of
27,022,000 disposal rows and a 30-second schedule, 5,000 examined keys per admitted
turn gives approximately 1.88 days of nominal discovery. Locks, freezes and
budget admission can extend this, so this is not an eight-day hard guarantee.
Queue entries cost storage until resolved; no physical disk or invoice reduction
is claimed before installed behavior and provider allocation are measured.

Focused isolated PostgreSQL regression exercises the actual disposal owners,
unchanged qualifier/compactor, finite backlog, due-first scheduling and all three
transaction outcomes using the complete job command in one simple-query message.

The three-transaction command requires pg_cron's libpq execution mode. The
installer refuses `cron.use_background_workers` values other than `off`; it
does not change that configuration. Native qualification uses a catalog/API
shape substitute and the real PostgreSQL simple-query path, not a running
pg_cron extension. Production completion therefore also requires actual job117
run readback after protected installation.
