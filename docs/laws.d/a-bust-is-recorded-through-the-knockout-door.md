# tests/a-bust-is-recorded-through-the-knockout-door.law.test.ts

Seven knockout candidates sat `pending` for 57-82 hours, freezing five events
and 884.00 of prize escrow, because `fn_eliminate_tournament_player_atomic` has
exactly one caller - the engine that owns the tournament - and it never called.
The door itself refuses nothing: probed with constraints forced immediate, it
accepted every claim and returned the right place. This law pins the two facts
that make the obvious wrong fix cost a day: the constraint trigger
`tournament_elimination_has_a_place` must keep demanding a place for an
elimination in a live event, and the retired `ca-eliminate-absent-players`
schedule must never be re-activated - its predicates refuse exactly the
candidates it would need, and the NULL-place row it writes is refused at commit.
A bust recorded outside the engine's own sweep goes through the door, which
assigns the place.
