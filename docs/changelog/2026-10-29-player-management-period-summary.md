# Player Management period summary

Add a compatible batch reader for Player Management fees and profit/loss in the same selected Chicago calendar period. The existing Monday-midnight week and existing authorization remain authoritative. Existing lifetime readers and all financial writers are unchanged.

Canonical cash, tournament fee receipts, standing-share daily rounding and effective-date redemptions remain the fee authority; the reader removes timestamped partial UTC-day edges and deduplicates authorized downlines. This database contract installs before its separate client consumer.

Validation: isolated PostgreSQL qualification exercises twelve checks, including exact Chicago microsecond edges, signed tournament refunds, custody rounding, downline access/deduplication, DST and year boundaries, read-only execution, grants and batch validation. Required server shard 4 invokes that qualification.

The summary scopes authorized members and deduplicated descendants before reading daily totals or timestamp edges. Incoming and outgoing standing shares are rounded per rule and UTC day within that scope. This avoids the predecessor helper's unbounded club-wide share aggregation; the exact materialized current-week body completed in 15.687 ms under a read-only 8-second budget. A below-counting-floor month regression preserves the UTC accounting floor while current periods retain Chicago midnight.
