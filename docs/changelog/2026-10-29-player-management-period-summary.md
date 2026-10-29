# Player Management period summary

Add a compatible batch reader for Player Management fees and profit/loss in the same selected Chicago calendar period. The existing Monday-midnight week and existing authorization remain authoritative. Existing lifetime readers and all financial writers are unchanged.

Canonical cash, tournament fee receipts, standing-share daily rounding and effective-date redemptions remain the fee authority; the reader removes timestamped partial UTC-day edges and deduplicates authorized downlines. This database contract installs before its separate client consumer.

Validation: isolated PostgreSQL qualification exercises eleven checks, including exact Chicago microsecond edges, signed tournament refunds, custody rounding, downline access/deduplication, DST and year boundaries, read-only execution, grants and batch validation. Required server shard 4 invokes that qualification.
