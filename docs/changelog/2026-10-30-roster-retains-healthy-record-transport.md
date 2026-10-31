# Roster retains its healthy record transport

Kings Club Player Management repeatedly showed Live Sync Failed even though its
roster reads succeeded. Browser diagnostics identified the serving engine closing
the channel with code 1001, `too many connections for this user`. The independent
private-record gateway acknowledged readiness, but each brief engine recovery
retired that healthy fallback before the engine evicted the connection again.

PrivateRecordFailover now retains an acknowledged standby until that standby
actually becomes unavailable. Primary recovery does not replace a healthy reader
or trigger redundant roster refreshes. Only the selected transport delivers record
events; if the standby fails while primary is ready, authority transfers
synchronously to primary and late standby callbacks are fenced. Existing identity
reset and disposal boundaries remain unchanged. No connection limits, credentials,
engine runtime, database or wallet behavior change.

Regression reproduces repeated primary READY/eviction cycles, single delivery,
no duplicate ready notifications and failback after actual standby failure.
The regression failed against the original implementation. Focused transport,
hook and roster tests plus TypeScript and normal protected delivery checks qualify
the change; publication and live behavior are recorded in the task checkpoint.
