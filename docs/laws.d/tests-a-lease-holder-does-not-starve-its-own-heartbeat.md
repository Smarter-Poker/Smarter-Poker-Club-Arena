# tests/a-lease-holder-does-not-starve-its-own-heartbeat.law.test.ts

`heartbeat_table_leases_v4` renews with `FOR NO KEY UPDATE ... SKIP LOCKED` so
it never queues behind a settlement; the price is that a row it cannot lock
comes back `busy` and is extended by nothing. The cash branch of
`fn_ca_commit_hand_settlement_exact_before_obligations` held that row with
`FOR SHARE`, which conflicts, so for the length of a settlement a table's
heartbeat could not renew that table's lease. Measured on production, twice
each: a holder on `FOR SHARE` leaves the heartbeat seeing 0 rows, a holder on
`FOR KEY SHARE` leaves it seeing 1.

The law is deliberately scoped to the lock and not to an incident. It was found
while chasing a restart loop in which every cash table re-claimed about every
twenty seconds, and the first version of it claimed to be that loop's cure.
It is not: contention measured 0.63 of 78 rows, 0.8%, an expiry needs four
consecutive misses, and on every row `heartbeat_at` equalled `acquired_at`
meaning no renewal had ever succeeded at all. That loop is engine-side and
still open. The conflict is still refused because it costs real renewals under
load and is one keyword to remove.

A holder cannot fix this by locking harder. The primary key is the id alone, so
a takeover is a non-key update and takes the same lock strength as the
heartbeat, and no holder lock blocks one while admitting the other. Exclusion is
asserted by the takeover instead: `claim_tournament_lease_v2` since 2026-09-10
and `claim_table_lease_v2` since 2026-09-12 each take `FOR UPDATE` before their
upsert. The law pins the guard rather than the symptom, because the tournament
half of this exact fix landed on 2026-09-10 and the cash half, eleven lines
away in the same function, was missed for two days.
