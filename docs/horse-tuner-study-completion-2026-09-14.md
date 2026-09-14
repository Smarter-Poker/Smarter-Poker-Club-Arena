# Nightly tuner completion and restart recovery

One per-horse audit row previously closed the entire nightly job in both the
scheduler and its shared claim resolver. A restart after the first accepted
horse therefore left the remaining horses unprocessed.

The study now durably captures its eligible horse list before its first write.
Retries receive that original list, even when current study inputs change.
Already recorded horses are identified by the existing atomic write receipts
and are not recalculated from their updated profiles. Missing or newly
under-floor evidence for an unfinished original horse leaves the study open.
Unknown progress or roster responses prevent writes.

A separate completion receipt requires the exact original roster and matching
atomic write plus audit identities for every eligible horse. It cannot shrink
the roster to the one horse that succeeded. Exact replay survives a lost
completion response; conflicting declarations refuse. Both the boot/day latch
and stale-claim takeover now read this receipt. The existing SQL nightly audit
reports incomplete studies from September 14 onward, including studies that
wrote some audit rows. Earlier dates retain their historical liveness check.

The roster and completion requests are capped at 2,048 horses and 100,000 bytes.
Daily progress uses an indexed read with an explicit 2,049th-row refusal.
Both roster writers require the same canonical request encoding as the client,
so an incompatible encoding cannot become an immutable, unreadable roster.
Service-only functions preserve immutable records; player roles have no access,
and service callers cannot directly mutate them. A five-second client deadline
does not claim cancellation of a database transaction whose reply was lost.

The native PostgreSQL fixture covers per-horse transactions, fixed membership,
restart on a new connection, refusal before all receipts exist, missing audits,
lost preparation/completion replies, exact replay, conflicts, contention, invalid requests,
zero eligibility, role boundaries, and the actual SQL nightly audit.
The first native completion check caught a text-versus-UUID audit join; its
failure is preserved. The full regression also caught a stale data-ledger
consumer declaration, which now names the actual completion reader.

Completion certifies execution of the original eligible cohort. Pending horses
are studied again using available inputs on recovery; it does not freeze all
raw study data or establish causal benefit. Existing diagnostic formulas,
sample floors and schedule remain unchanged. This is a Phase 14 recovery
prerequisite; source discovery, causal proposals, independent holdout/shadow,
activation/rollback and full natural certification remain open.
