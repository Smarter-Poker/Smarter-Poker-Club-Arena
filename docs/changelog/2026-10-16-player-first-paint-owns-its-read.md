# Club Data first paint owns its player read

The post-deploy browser sweep reached the Players tab but remained on Loading
Players past its 60-second assertion budget. The initial load and every
same-question realtime invalidation shared the response version, but only a
background refresh with existing rows claimed the in-flight guard. With no
verified rows yet, each invalidation started another spinner-owning request
and retired the previous answer. A live visit likewise waited over a minute
before eventually showing the 570-player report.

The player reader now retains the owning request version for both first paint
and later refreshes. Realtime and recovery invalidations coalesce while that
read is pending. Explicit changes of club, reporting range or sort still retire
that ownership and start their own request. Only the request that holds the
version may release it, so an older response cannot unlock a newer sort.
Pagination, verified payload checks, error presentation and manual retry remain
intact. This changes client request ownership only; no database, financial,
engine, artwork or Club Bank Transaction Ledger behavior changes.

A rendered regression deferred both initial player RPCs and fired the real
realtime callback. It failed before the fix because two player-page reads were
started. It passes with one read and a visible verified response. A second
rendered case verifies a refused first read releases ownership and an explicit
retry renders verified rows. Existing stale sort, cache, pagination, denied,
malformed and refresh cases continue to run in the same component suite.
