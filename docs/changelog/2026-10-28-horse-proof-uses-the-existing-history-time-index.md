# Horse Proof Uses The Existing History Time Index

The natural horse observation in run `40762123113` passed its four continuity
cases, then stopped before observation because its recent-showdown metadata read
timed out. Filtering and sorting only `ended_at` scanned retained history for
each candidate table despite the final row limit.

The read now also bounds `created_at` and sorts by that column, matching the
existing `(table_id, created_at, id)` index. The finish-time and nonempty-showdown
filters, nine-table discovery bound, 180-row limit, activity ranking, and actual
visible chat/reaction/throw assertions remain intact. Only public table and
finish-time metadata is returned. This changes no engine behavior or schema.

The before regression failed and all 13 focused checks passed after the change.
Read-only EXPLAIN for the actual nine-candidate query uses the existing index
with both table and creation-time index conditions; its bounded metadata read
returned 48 rows in 822 milliseconds of tool wall time. Live horse proof remains
required after protected integration.
