# Daily Missions Releases Each Player Before Taking The Next

Production PostgreSQL logs exposed a direct table-action delay: each of the
four Daily Missions outbox shards processed many players inside one top-level
function transaction. The per-event exception blocks were subtransactions,
not commits. Every `profiles FOR UPDATE` lock therefore accumulated until the
whole shard returned. Hand settlement's `table_seats.user_id` foreign-key
check needs a conflicting key-share lock on those same profile rows, so an
otherwise healthy hand commit could sit behind a mission shard for 8-15
seconds and time out.

The primary outbox consumer is now a postgres-only procedure invoked directly
by the existing four pg_cron shards. It books one player's ordered, bounded
event group through the unchanged authoritative enqueue/receipt path, commits,
and only then selects the next player. The service-role compatibility function
is retained but can process only one player per call, so it cannot recreate a
multi-player lock convoy. The same-player advisory/profile lock, payload
binding, replay horizon, retries, dead-lettering, and exactly-once receipts are
unchanged.

`scripts/dev/probe-daily-mission-outbox-transaction-boundary-pg17.sh` runs the
real migration twice on PostgreSQL 17, starts the procedure in one session,
and holds the second player's transaction open. A concurrent table-seat FK
write for the already-booked first player must complete under a 400 ms lock
budget, while the equivalent write for the in-flight second player must still
serialize. The probe then requires one receipt per event, an empty successful
outbox, and all four cron commands wired to top-level `CALL`.
