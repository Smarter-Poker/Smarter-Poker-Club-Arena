# The Gameplay Prerequisite Covers The Recorded V3 Release

Post-deploy run 36292616717 began waiting at 03:53:01.395 UTC on September 27
and exhausted its fixed 600-second budget at 04:03:01.445. The unchanged
engine's durable v3 receipt scheduled release at 04:03:52.999083; all eight
resume waves finished at 04:04:03.902. The engine was still legitimately
waiting for its credited release boundary when verification timed out.

The existing one-shot prerequisite now has a fixed 720-second limit. Its
recorded-timeline regression fails against the former limit and admits the
same engine only after the final wave. The enclosing job changes from 30 to 45
minutes: the 12-minute prerequisite plus three 6.5-minute tournament cases and
one 5-minute cash case leave 8.5 minutes for setup, provenance and cleanup.
A source regression reads those maintained case limits and requires separate
headroom rather than allowing a job deadline equal to its prerequisite.
Unknown or malformed health, HTTP/transport failure, changed engine SHA,
incomplete waves and replies after the fixed deadline still fail. No gameplay
assertion, engine runtime, activation reserve or maintenance operation changed.

The former run also detected a client publication during certification. That
independent provenance refusal remains correct and unchanged. A 12-minute
limit covers this measured case; it does not certify every future maintenance
duration or replace the live-hand/reconnect result.
