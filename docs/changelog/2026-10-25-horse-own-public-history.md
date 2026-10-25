# Individual public history across restart and table shards

The isolated observer bank previously started empty after restart and lost a
horse's own reads when the horse moved to another table shard. A real two-worker
regression reproduced the latter gap while the owning worker retained the read.

The pool now records only validated original FAST participants, with the exact
hand/lease and explicit observer partition. Completed public observations update
only that same observer's already-existing private views on other shards.
Another horse on the receiving worker learns nothing from an unobserved hand.
Caller-supplied enrollment is overwritten; rejected FASTs, wrong leases,
uncommitted hands, conflicts, duplicates and bounded eviction cannot enroll a
new observer. The Phase 14 accepted roster remains owner-only.

A service-only, read-only RPC retrieves a bounded window from the observer's
original dealt facts and retained public hand records. Known original seat and
position prove participation; the wider RLS chair roster does not. Variant,
explicit persisted format and exact dealt count remain separate. Retired
accounts return unavailable. No card column is read, and action projection
excludes every card and unknown field. There is no new table, financial write,
backfill, repair loop or scheduler. An existing user/time index bounds the scan
to 512 candidates and the window to 64 whole hands over eight days. A byte
budget reduces the number of whole hands explicitly, never truncating actions.
The native-qualified function definition is pinned by the runtime adapter.

History loads only on actual requests without holding a turn for I/O. The
response availability time must precede the original snapshot; database row
timestamps cannot establish that visibility. Pending turns use temporary own
read views, preserve accepted plans, and buffer bounded public completions.
On loading, historical observations precede those live tails and overlap is
counted once. Failure retains explicit unavailable history. Version 2 private
read receipts record the window digest, availability, hand count and cap flag;
these are bounded-history evidence, not full-history or activation authority.
Incomplete tournament context cannot attest an exact format partition.

Qualification fingerprints include the actual reader, pool, participant
admission, canonical action projection, worker wiring and database-definition
pin. Old qualification artifacts cannot activate this source. No selector is
changed. Protected integration, exact-source strength qualification, migration
installation, daily-window engine activation and live evidence remain distinct.

Validation: 89 checks on a disposable PostgreSQL 17 cluster passed, including
permissions, forged role claims, card exclusion, all 62 synthetic retirement
cases, format separation, legacy identity refusal and whole-hand byte bounds.
Real client/worker/HorseLogic cases cover chronological recency, live overlap,
private scope, payload acknowledgement and retained plans. Read-only production
audits found original dealt facts and a public-history candidate for every one
of the 938 eligible horses; that is availability evidence, not proof this new
reader is installed or live. Full hooks and hosted checks remain pending.

The hosted whole-source rejection guard caught the loader's missing explicit
`.catch()` outside the local related-test selection. The loader now marks
transport and response-processing failures unavailable and releases its finite
request capacity once through an idempotent finalizer. Regression cases cover
synchronous throws, rejected promises and processing exceptions without retries,
partial history or unhandled rejections. The guard itself remains unchanged.
