# tests/a-bounty-paid-after-a-movement-proof-is-not-a-changed-roster.law.test.ts

A PKO bounty paid after a parked table's movement proof was captured moves no chip on the felt, so it must not refuse the table forever: `smarter_private.f06_assert_movement` compares the roster and elimination registrations without exactly `current_bounty`, `bounty_winnings`, `bounties_collected` and `mystery_bounty_value`, compares every other seat and registration column, winner, boundary, permit and count exactly as before, and the release contract pins carry the post-image it installs.
