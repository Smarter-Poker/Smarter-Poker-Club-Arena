# A horse's history read waits for the answer the database already gave

PR #8075 went live in the 01:08 UTC engine release. In its first hour the
database answered every one of the 6,692 history reads with 200, the slowest in
1,330 ms (p50 46 ms, p99 613 ms), yet the engine recorded roughly a quarter of
them as unavailable. The engine gave up at a 1,500 ms deadline, and a context
that gives up is not asked again for the life of the process, so those horses
played that game type without their own restored history.

The deadline is now `HORSE_OWN_PUBLIC_HISTORY_TIMEOUT_MS` = 5,000 ms, sized like
the engine's other non-blocking calls (`SEEDING_DB_TIMEOUT_MS`). Nothing waits
on this read: the turn never blocks on it and a load holds one of the cache's
16 slots. Three new fires name how a failed load failed
(`horse_observer_history_error`, `_empty_response`, `_thrown`) beside the
existing `horse_observer_history_unavailable` count, so the next hour's numbers
say which path is left.

No database change. Reads stay individual: the reader, its context and its
pinned definition are unchanged.
