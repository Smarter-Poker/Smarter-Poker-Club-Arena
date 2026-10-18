# Lightning anchors keep their input presence after restart

A cash table restarted while Lightning holds ordinary dealing took the halted
startup branch before restoring player presence. It never started its ordinary
heartbeat tick. The pool matcher therefore withheld seated players as unknown,
even when their pool sessions had no database disconnect stamp. The Action pilot
had 13 such withheld players in its 2026-10-18 13:43 UTC matcher pass.

The existing halted-table pass now adopts carried presence before registering
seats, restores voluntary sit-outs, supplies the normal server heartbeat for
horses, and evaluates stale client heartbeats. This is local input observation
through the same DisconnectEngine used elsewhere. It neither lifts the dealing
halt nor runs continuity releases, eviction, seat moves or add-ons. Maintenance
still suspends this observation.

The regression invokes the real halted pass and reads its actual Lightning
presence report. It failed with both players unknown before the fix. Coverage
also retains silent-client disconnects, voluntary sit-out timestamps, unchanged
stacks and the maintenance freeze. The existing halt-law and boot-presence
tests remain part of validation. Source delivery and serving-engine proof are
recorded separately in the Lightning operational checkpoint.
