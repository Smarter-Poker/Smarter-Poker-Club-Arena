# Physically impossible action compaction leaves its derived due queue

The installed compactor refuses a stored request of at most 4096 bytes before
writing because it cannot repay the unchanged certificate-plus-4096-byte
physical overhead. Its progress caller still deferred these same immutable
requests by one day and retried them forever when their raw action arrays were
large. This repeated derived bookkeeping without making storage reclaimable.

The caller now removes only that derived queue entry in its original progress
transaction. The new point read measures the actual stored request and takes
`FOR UPDATE SKIP LOCKED`: a concurrent source owner retains the existing retry
behavior. The original request, hashes, disposal receipt, financial records and
certificates are never deleted or rewritten by this exit. Current immutable
source authority permits only certified action removal or certified complete
payload removal; it cannot expand this payload back into a beneficial candidate.

The migration guards the complete current progress, compactor and immutable
function identities, private owner/ACLs and the enabled source-immutability
trigger. It preserves exact progress authority, every existing guard, its
900 ms budget, 100-ID limit, locks, cron command and actual schedule. Larger
net-negative, missing, locked and temporarily refused work keeps its retry path.
No new scheduler, cleanup frequency, eight-day policy or transport flag changes.

The existing required native PostgreSQL owner reproduces the previous daily
requeue, proves the caller upgrade removes only bookkeeping, and verifies exact
source/receipt preservation, no certificate, source immutability, locked-small
retry, unlocked exit, rollback restoration and larger net-negative retry. The
original positive compaction, generic refusal, freeze, discovery, concurrency,
source-pin, replay, cron transaction and timeout cases continue unchanged.

Source qualification is not installation or a dollar-saving claim. Protected
merge, main-only installation and live readback remain separate requirements.
Paid Realtime stays enabled and the independent gateway stays inactive.
