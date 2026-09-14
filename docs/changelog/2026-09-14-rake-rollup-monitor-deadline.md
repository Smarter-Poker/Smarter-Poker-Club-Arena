# A daily result becomes overdue after its writer can produce it

The rollup monitor reported a missing previous day at 00:52 UTC on both
September 13 and September 14. The first daily writer is scheduled for 00:55.
On September 14 that run succeeded at 00:55:12 and recorded the missing day.
The monitor was counting the newly completed day before its scheduled writer.

The missing-day deadline now uses UTC and allows the configured 600-second
writer budget, making yesterday due at 01:05 UTC. Earlier missing days in the
seven-day window and the configurable silence threshold still alert during
that interval. Existing rollups, the writer, accounting and payout behavior
are unchanged. The output still identifies the newest completed day; its
description also identifies the newest day already due.

The migration verifies the existing function, closed operator permissions,
writer schedule and configured budget. It preserves the postgres owner and
service-only access. It changes no rollup data.

The required PostgreSQL 17 gate exercises the exact prior SQL, actual guarded
installation, migration replay, authority refusal, time zones, the precise
01:05 boundary, older missing days, and real silence. Boundary cases substitute
only transaction clock expressions; the untouched production candidate is
also installed and its exact definition and permissions verified. This proves
the detector correction, not the health of every historical financial event.
