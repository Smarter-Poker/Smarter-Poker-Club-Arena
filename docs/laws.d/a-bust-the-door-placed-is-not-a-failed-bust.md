# tests/a-bust-the-door-placed-is-not-a-failed-bust.law.test.ts

When the knockout door's accepted answer carries `bounty_blocked` - for any
reason, including `mystery_bounties_start_in_the_money` on a chests-only
mystery event before the money - the bust is recorded and `eliminatePlayer`
never calls `processBountyCollection` for it, so it returns true and the batch
keeps recording. Written after two 190-entrant Sunday Funday PLO5 Mystery
events recorded one bust per admission, fell 24 minutes behind and tripped
`fn_ca_absent_tournament_players`.
