# Identify the bounded native export phase without private output

Actual41247721937 proved all six native transport/session facts and original
snapshot import in1170ms, then pg_dump reached its existing bounded deadline
at32513ms with zero stdout and28 stderr bytes. SIGINT was accepted and child
close observed without hard kill; server cancellation acknowledgement remains
NOT_OBSERVED. The28 private bytes were transient and are not recoverable from
sanitized receipts. Their text and the underlying dump phase remain unknown.

The existing pg_dump invocation now enables its supported verbose progress.
The same64KiB total private stderr cap remains, so a verbose stream exceeding it
refuses with STDERR_LIMIT rather than widening capture. Only exact anchored,
non-parameterized PG17 messages map to a fixed last_stage enum on failure.
The earliest post-setup built-in-OID marker additionally maps to SETUP_COMPLETE
only after an anchored uint32-format check; its numeric value is never retained
or published. That marker follows snapshot setup and precedes role/schema reads.
Names, object identifiers, queries, settings and arbitrary lines never enter the
receipt. Partial stream chunks are joined only in the existing bounded buffer,
which is cleared on every outcome. No raw logs or SQL artifacts are added.

Markers were read from official PostgreSQL REL_17_11 common.c and pg_dump.c:
https://github.com/postgres/postgres/blob/REL_17_11/src/bin/pg_dump/common.c
https://github.com/postgres/postgres/blob/REL_17_11/src/bin/pg_dump/pg_dump.c
A marker identifies the last announced phase, not a proved query root cause.
No timeout, CA, role, route, original snapshot, readiness or game safeguard changes.
No additional database activity query or unchanged retry is added. Full-schema
parity and all14 connected cases remain unproved until actual execution.
