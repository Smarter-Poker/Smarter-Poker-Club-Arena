# Player Management And Club Data Audit

Player Management rejects refresh before marking it busy while search debounce is unsettled. Reverting a pending query now leaves Refresh and authorized Advanced exports usable.

Club Data tracks the previously observed UTC day so current-day reports advance after midnight while deliberate historical ranges stay fixed. A refresh owns a generation invalidated by account or club changes, preventing outgoing completion from clearing incoming refresh state or consuming its queued events.

Entering an uncached game query now retires outgoing rows, totals, cursor availability and freshness before paint. Older money cannot be labeled with new dates or filters. Verified matching caches and same-query transient-error preservation remain supported.

Mounted regressions exercise both modes, account and club refresh changes, UTC rollover and historical preservation, and pending/failed query changes. Existing pagination, export ownership, permission, realtime, navigation and cache tests remain enforced. No schema, financial transaction, role change or engine dependency is introduced.
