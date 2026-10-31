# Diagnose the native snapshot transport without widening capture

Run41243049767 exhausted its actual remaining capture budget in pg_dump at
34695ms with zero stdout/stderr bytes. Node TLS/catalogue capture passed;
native libpq connection, snapshot import and export capacity remain unknown.
No successful comparable production-native export baseline was found. The
single external activity witness ran near cleanup and established no attribution.

Before exporting, the existing capture now uses the installed native psql17
client once to import the same original snapshot in a read-only repeatable
transaction. SQL travels on stdin and returns exactly six boolean fields covering the
database, isolation, read-only state, actual five-second statement timeout,
one-second lock timeout and fixed application-name forwarding. Every field must
be true; a refusal retains only the closed named booleans so a failed timeout
and failed application-name match remain distinguishable. Literal ROLLBACK
closes it. The probe has a five-second hard cap, 256-byte stdout cap and64KiB
private stderr cap. Failure prevents dump; no connection string, password,
snapshot identifier, SQL, raw error or nested cause is published.

PG17's actual pg_dump handler sends its own PQcancel on SIGINT and ignores
the return value. Both owned native children now request SIGINT with at most
one second of grace inside their existing hard deadline, then hard-kill only
that child if necessary. Receipts distinguish OS signal acceptance, hard-kill
attempt and observed child close from server acknowledgement, which remains
NOT_OBSERVED after cancellation. Process exit is not proof of server cleanup.
No global GUC, privileged cancellation, query watcher or additional database
inspection is added. Source:
https://github.com/postgres/postgres/blob/REL_17_11/src/bin/pg_dump/parallel.c

The original45-second capture/idle limit, five-second finalization reserve,
strict provider CA, read-only schema export and existing byte/lock limits stay
intact. Native pg_dump still resets statement_timeout, so no five-second export
query guard is claimed. Focused tests cover stdin/privacy, refusals, snapshot
wiring, first-failure ownership and graceful/hard cancellation. Actual native
transport, full-schema parity and all14 connected cases remain unproved until
their real run; helper tests confer no acceptance credit.
