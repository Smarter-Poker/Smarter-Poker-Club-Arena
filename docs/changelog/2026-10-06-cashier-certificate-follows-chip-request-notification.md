# Cashier Certificate Follows The Chip Request Notification

Migration `20261006022835_a_chip_request_tells_its_approver` intentionally
changed the private `fn_request_chips_core_20261004` body after the Cashier
release certificate had pinned its previous source. Production correctly ran
the new notification body, but the stale certificate still required md5
`7e5233ef53474fdf4f79ec8a64d6c064` and refused the installed md5
`1dce6c06306523ba83060f1546611648`.

The certificate now requires the exact migration version and history name and
pins that installed post-image. Its source contract independently derives the
post-image by applying the committed migration's notification block to the
previously pinned body, proving the hash change comes only from the migration
that tells the approver after the request row is written.

A read-only production catalog check confirmed the exact migration history,
source hash, `postgres` ownership, `SECURITY DEFINER`, pinned
`search_path=public, pg_temp`, notification call, and denied execution for
`anon`, `authenticated`, and `service_role`. No migration was replayed. This
repair changes only the maintained certificate, its regression contract, and
this record; application, database, engine, permission, financial, and player
behavior are unchanged.
