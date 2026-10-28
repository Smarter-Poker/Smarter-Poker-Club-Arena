# Daily fact input uses its selected date

The October 28 12:25 Club Data rollup timeout occurred in fn_ca_reporting_rollups_from_facts. Its original day_facts input selects stat_date alone. Production EXPLAIN planned a parallel full-table scan; the sole existing fact index begins with club_id. Catalog estimates were 2,281,061 facts and a 294,641,664-byte heap.

Add a concurrent btree on stat_date through the maintained migration installer. Every function, date bucket, amount, attribution, cutoff, writer, schedule and timeout remains unchanged. Mutable amounts stay outside this index, preserving amount-only HOT eligibility. The exact valid/ready index definition is asserted after construction.

Native PostgreSQL runs the original table definition and exact selected projection over 300,000 facts across 60 days. It reproduces examination of 295,000 unselected facts, then proves index admission by date, substantially fewer buffers, identical selected numeric values and keys, date boundaries, generic parameter planning, replay identity and refusal of a wrong existing index. The existing digest reporting workflow runs and retains the native proof.

This removes an evidenced unnecessary historical scan. It does not establish the sole cause of the 300-second timeout or certify full rollup latency; normal production execution still needs verification after protected installation. No production financial write is used as a test.
