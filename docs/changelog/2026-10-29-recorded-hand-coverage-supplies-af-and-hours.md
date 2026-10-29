# Recorded public evidence supplies aggression and elapsed hours

Both player overview readers now resolve their full authorized hand population through a service-only measurement helper. Complete paired AF counters remain authoritative; otherwise retained public actions supply both counters together. Missing or malformed evidence keeps AF unavailable. Historical immutable facts are never rewritten.

Hours use the union of valid positive hand intervals, clipped to the requested calendar window. A running maximum handles nested overlaps, and hand IDs break ordering ties. Cash hours use a separate interval union and availability flag, so cash profit per hour excludes tournament time. Numeric hours retain nine decimal places; these are recorded hand intervals, not estimated seated or idle time.

A cold table without a hot-table foreign key retains future accepted hand intervals in the existing original fact-insert transaction. The existing trigger function is replaced in place, preserving its identity and permissions. Retained history supplies older intervals on reads; missing intervals remain explicitly unavailable. The change adds no background repair, historical backfill, schedule or live-table schema lock.

Native PostgreSQL coverage checks exercise historical fallback, paired persisted counters, nested and disjoint overlaps, calendar clipping, cash-only time, short-hand precision, zero/missing intervals, history retention, original insert capture, authorization and both real overview readers. Financial totals and BB/100 remain unchanged.
