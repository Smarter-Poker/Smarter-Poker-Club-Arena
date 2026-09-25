# tests/a-diamond-seat-exit-goes-home-through-its-own-door.law.test.ts

Phase 8 built the Diamond tournament doors and taught the lobby's
unregistration door to send a Diamond entry home through
fn_poker_diamond_tournament_unregister. The recheck that closed the phase
found that the lobby door was the only one. The chip unregistration
authority, fn_ca_unregister_tournament_player_exact, has six callers: the
two-argument lobby door (routed), the one-argument lobby door, both overloads
of the seat exit a heads-up or sit-and-go player uses, the administrator's
removal and the launch's release of a registrant it could not seat. Five of
them reached the chip authority with a Diamond event. With a fee it refused,
because a Diamond event writes no rake_records and the authority reads the
divergence as a broken state; with no fee it deleted the roster row for a
refund of nothing and left the player's Diamonds in custody, where the
terminal would later pay them to the winners.

Migration 20260914103912 routes inside the authority itself, before the lane
is taken, so every caller present and future sends a Diamond entry home, and
a caller that named no request id is given one exactly as the authority mints
its own. The seat check the chip authority gives - not_seated when the named
table does not seat the player - is kept, except when the request id is
already settled, in which case the Diamond door replays the receipt. That
replay was the second defect: the Diamond door answered a repeated request
id with three keys, and the client's one exact replay after a lost response
parsed that as an invalid receipt and told the player the withdrawal could
not be confirmed after it had committed. The door now rebuilds the whole
receipt from the refund ledger row. It also keeps the chip authority's clock,
which Phase 8 had simplified to status and started_at: a scheduled event
closes at its start time, a spin or heads-up sit-and-go closes when it
actually starts, the launch's release is past the clock by design and is held
to the seat-first proofs, and a persisted hand closes every product. The
third change passes asset and diamonds_after through the seat-first purchase
receipt, as the lobby receipt does, so the client can move the balance it
shows.

The law reads each section of the migration by its heading and pins the
mechanics: one asserted-substitution edit per chip function with its live md5
and the reverse proof, the Diamond door pinned and declared, the replay keys,
the clock clauses, and the final assertions that every caller still reaches
the authority and every watched guard is on its baseline. Nine paths were
rehearsed through the real doors inside one rolled-back transaction before
the apply: the seat purchase receipt, the two-argument exit, its replay, a
new request from an unseated player, the one-argument seat exit, the
one-argument lobby door, the chip administrator's removal (which the arena
refuses before the authority by design: fn_can_create_games answers false for
a Diamond club), the scheduled clock refusing past start_time with custody
untouched, and the launch's release going home under its own request id.
