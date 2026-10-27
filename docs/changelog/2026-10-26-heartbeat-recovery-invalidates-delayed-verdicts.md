# Heartbeat recovery invalidates delayed closed verdicts

TablePage lines4009-4090 allowed a row read begun by an HTTP404 to set the
closed flag after a socket reconnect cleared it. A late HTTP404 could also
start that stale read after recovery. The heartbeat effect does not restart
on socket status, so its mounted flag alone did not prevent the race.

Each beat now captures a recovery generation. Both async boundaries require
that generation to remain current. Socket reconnect, successful heartbeat,
effect setup and cleanup invalidate earlier work. A current positive closed
row still stops beats; failed or live reads keep presence enabled. No new
polling or engine contract. Deferred-result tests cover invalidation and the
TablePage wiring. Existing Lightning room and shared channel guards remain.

Real-time law: recovery is triggered by the connected socket event and the
original heartbeat response; no snapshot diff or new polling.
