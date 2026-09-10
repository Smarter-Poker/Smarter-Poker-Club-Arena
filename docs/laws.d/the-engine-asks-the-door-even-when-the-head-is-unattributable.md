# tests/the-engine-asks-the-door-even-when-the-head-is-unattributable.law.test.ts

The engine half of "a place is not a bounty". `knocker_not_attributable` is the
one bounty-gate verdict that says nothing about whether the player busted, so
`loadPersistedBountyEvidence` admits the elimination on the candidate's own
evidence and marks the attribution unavailable; every other verdict still
defers, because every other one means the bust is not proven. The engine then
proposes NULL claimants (an empty array is refused as `invalid_claimants`),
accepts the door's `bounty_blocked` reply as a durable commit with no
obligation row, carries no knocker and no claimants, and never calls
`processBountyCollection`. Written after 27 busts across nine events stayed
unrecorded because the engine would not ASK whether a player busted when it
could not work out who to pay.
