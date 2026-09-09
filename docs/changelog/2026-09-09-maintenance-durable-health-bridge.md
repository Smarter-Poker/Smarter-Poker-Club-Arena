# Maintenance durable-health bridge

The engine now publishes `maintenance.durableConfirmed` only after the exact
maintenance phase, timestamps, reason, and ownership token have committed to
the database or an ambiguous response has been recovered by an exact read-back.
The field closes before a phase transition and remains false on idle or failed
persistence paths.

This is an additive rolling-upgrade contract. Existing deploy automation can
ship it during the already-announced break; the stricter deployment revision
can then require it without a legacy bypass or an unsafe first-cutover deadlock.
