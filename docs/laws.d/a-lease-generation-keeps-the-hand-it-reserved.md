# tests/a-lease-generation-keeps-the-hand-it-reserved.law.test.ts

A tournament hand is authorised by one `smarter_private.f06_hand_permits` row in
state `reserved`, written under the tournament's lease generation, and
`smarter_private.f06_one_hand` is a UNIQUE index on `(table_id) WHERE state =
'reserved'`. One reserved permit per table, so while an unresolved one sits
there no successor can reserve the next hand and the table is finished.

`public.claim_tournament_lease_v2` took a stale lease by writing
`lease_generation = EXCLUDED.lease_generation` in place. The outgoing
generation's uuid was recorded in exactly two places, the lease row and the
permit, so that single update left the permit unreachable: the only door that
can void it, `public.fn_f06_abort_abandoned_generation`, takes the generation
as an argument and there was nowhere left to read it from.

Measured on production 2026-09-24 12:51 to 13:02 UTC: 423 tournaments RUNNING
with `started_at` over 24 hours old, holding 3,138 open `table_seats` across 863
players and dealing nothing; 527 reserved permits, every one of them on a
RUNNING tournament and none on a terminal one; 489 of those on a generation no
lease row names, and all 489 on a tournament whose lease row is still there
naming some other generation. Orphaned by replacement, never by release.

The law is that a lease row may not stop naming a generation that still holds a
reserved hand. Refused, the handover rolls back and the lease goes on naming the
outgoing generation, which is exactly what the abort door needs. The refusal
preserves the only state from which the existing writer can still finish, rather
than detecting a state nothing can use. A terminal tournament is exempt, because
a cancelled or completed event releases its lease on purpose and that is the
path a refund travels.
