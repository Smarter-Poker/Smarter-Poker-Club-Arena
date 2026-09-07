# Resync Errors Stay Inside Recovery

Private-state replay callbacks could throw directly out of the RESYNC message
handler, reject an idempotent SUBSCRIBE promise, or skip the connected-presence
callback during the initial subscription. All three cases were reproduced by
regression tests against the previous implementation.

One guarded replay helper is used by initial single-table and mux connections,
idempotent subscriptions, and explicit resync requests. It reports the engine
error through the existing error reporter while preserving public-state delivery,
connection ownership and the ability to retry. Initial presence is still notified
when private-state replay fails. No extra socket, timer or retry loop was added.

The transport cannot manufacture unavailable private state; engine replay still
needs to succeed on a later attempt. This change prevents a replay error from
breaking the surrounding recovery path. Live deployment remains to be verified.
