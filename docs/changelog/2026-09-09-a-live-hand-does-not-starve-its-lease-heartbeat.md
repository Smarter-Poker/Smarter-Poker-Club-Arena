# A Live Hand Does Not Starve Its Lease Heartbeat

Active tournament managers were sometimes reporting an exact lease as `busy`
until its 20-second local proof expired, even while their tables were dealing.
The manager then fenced itself and destroyed every child engine, producing a
reconnect wave and skipped table motion.

The database transaction fence now coexists with heartbeat-only updates. Exact
owner/generation replacement and release remain serialized until the accepted
hand or manager mutation commits. The migration refuses a Stage-A catalog,
source drift, an invalid ownership key, or changed function security metadata.

A PostgreSQL 17 two-session harness covers cash settlement, pending add-ons,
tournament settlement, empty-table close, and the manager request hook. Each
case proves the heartbeat is immediate, takeover and deletion remain blocked,
and both proceed only after the exact transaction boundary.
