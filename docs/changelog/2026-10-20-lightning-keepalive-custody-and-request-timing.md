# Lightning keepalive custody and original-request timing

Scope: the existing private six-seat Lightning pilot and its remaining
ack-to-idle spikes. This does not activate a public game or change the roster,
thresholds, money authority, fold release, retry policy or latency acceptance.

A keepalive currently takes an exclusive `lightning_instance` row lock and
updates its deadline even when the existing deadline already covers the
requested extension. Hosts ask every 15 seconds for 45 seconds of coverage,
while a new hand begins with ten minutes. Those redundant mutations conflict
with folds' shared state custody and incur a durable write without extending
anything. Production PostgreSQL logs at 14:42 UTC show a fast fold waiting on
that instance lock. The exact holder's statement was not retained, so that
observation does not establish keepalive as the sole historical cause.

The correction first reads the instance without a row lock. An allowed state
with an unexpired deadline already covering the clamped request returns that
unchanged deadline. This read-only answer linearizes at its database snapshot;
a concurrent terminal transition cannot be undone or extended. Every other
case retains the original exclusive lock, fresh reread, expiry and state
checks, forward-only update and bounded extension. Fold and settlement custody
remain unchanged. No write is acknowledged before durable commit.

The remaining tail also includes provider delays. In 1,280 observed original
fast-fold requests, all HTTP 200, some took several seconds outside the upstream
service and some spent that time upstream. A PostgREST schema reload and pool
initialization occurred during the 14:42 spike. Those aggregates cannot join an
individual engine sample to its provider request or identify the lock holder.

Bounded timing therefore follows the original stable fold request through its
existing retries and records fetch-header/body offsets, sanitized provider
request IDs and maximum sampled timer lateness. It creates no second database
request. Logging is limited to 20 slow records a minute and six attempts per
record. A finite, explicitly selected private log read validates and retains
only the timing schema; it never exposes raw logs, credentials or player data.
Diagnostics are attribution evidence, not completion of the latency repair.

Acceptance remains the latest three complete 60-second windows with at least
20 samples each and p95 below 500 ms, after installed database and containing
engine publication, plus no open post-commit obligations from the affected
source. A passing historical sequence does not certify later windows.

Native PostgreSQL qualification reproduces the covered keepalive blocking a
fold before the change and proves the fold and terminal transition proceed
while the covered keepalive transaction remains open afterward. The deadline,
tuple identity and lack of an assigned writing transaction ID prove the early
answer makes no mutation. Actual extension custody, a terminal writer winning
while keepalive waits, expiry, wrong/missing state, defaults, clock clamp,
interval bounds, metadata preservation and migration replay refusal remain
qualified. Full installed-definition MD5 is `6cd240b1b04cc86be2ca50c0bc26618c`.
