# Already-played MTT launch rehearsal

Run `TMPDIR=/tmp python3 scripts/dev/probe-played-mtt-launch-pg17.py` from the
repository root. PostgreSQL 17 must be installed. It creates and removes its
own private cluster, keeps its results, and accepts no production URL.

The actual captured read-only proof, generation-bound begin/complete wrappers,
their launch delegates and immutable-receipt trigger execute as PostgreSQL.
The fixture supplies synthetic tournament, roster, table, seat and hand rows.
Maintenance is an explicit boolean fixture; the excluded paid-Spin proof is
an explicit refusal stand-in. No financial function is invoked. It is not a
full production trigger graph, HTTP/RLS, funded-entry or dealer certification.
The separate registration/funding probe retains that distinct scope.

Twelve groups cover the service-only read grant, two survivors and one survivor
of an already-played field, preserved levels/stakes/stacks/pool/history, exact
microsecond start identity, lost-response replay, fresh short-field refusal,
preliminary-proof drift, missing seats, stale leases, maintenance refusal and
rollback when completing the launch receipt fails. All captured function bodies
match their recorded source hashes. No production event data is loaded.
