# Bounded persistent horse opponent memory

The previous cold reader could reconstruct ten complete player histories in one request and copy large retained public nodes during actor parsing. Production timeout evidence showed that the installed context index alone did not make this safe. The service also retried a failed hand on later streets.

The new original-request reader uses one nonblocking global transaction owner and initializes at most one cold actor per request, preserving the full 1,024-observation horizon, exact counters and atomic merge with accepted hands. Existing profiles return immediately when another initializer owns the lock. Actor parsing projects the required fields directly; malformed arrays retain the previous parser behavior. Installation checks the exact valid predecessor index before replacing the reader or granting access.

The engine bounds concurrent reads at eight, retains validated context-specific snapshots during failures, prevents older observations from replacing newer ones, and remembers failed hand requests. Partial initialization remains explicit. Current shared snapshots refresh later streets without retrying a failed history query. Memory loading shares the decision's original cancellation signal and deadline.

PostgreSQL 17 qualification includes retained public-node payloads, ten successive complete actor horizons under the unchanged per-request budget, lock contention, exact historical/malformed parity, restart, permissions and accepted-hand preservation. Service and real client deadline regressions cover bounded admission, partial receipts, cached knowledge and canceled callers. These checks establish the candidate behavior; protected delivery, installation and safe live adoption remain separately required.

The incident containment revoked only the old read RPC. Saved profiles and accepted-hand learning remain intact. The qualified new migration restores the service grant after replacing that reader. No installed migration is replayed, and no financial, roster or table-setting change is part of this repair.

The reader removes redundant whole-roster containment that made cached generic plans combine the compact index with the large player-roster index. Positive and absent-context forced generic plans are regression protected. The compatible cold-admission predecessor and this replacement share the same nonblocking lock; sequential PostgreSQL qualification applies that predecessor first and this replacement last.
