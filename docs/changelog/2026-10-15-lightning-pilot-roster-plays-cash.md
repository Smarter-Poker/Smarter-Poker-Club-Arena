# Lightning Pilot Roster Plays Cash

Dan, 2026-10-15 10:23 Central: "turn off Spins in the pilot club, swap the 25
tournament-only pilot horses for 25 cash-only horses funded to 200 from the pilot
treasury, and run Stage 1 and Stage 2 on the pilot."

## Why

The pilot's 72 horses were admitted by id order without reading their assigned
game lane: 25 `events` (never seated at cash), 22 `both`, 25 `cash`. The pilot
also opened with Spins enabled by default, and about 400 1-chip Spins absorbed
the `both` horses (Spins seats count toward the four-game limit). At 15:09 UTC
the pilot held 4 and 4 seated against Phase 3's 18 / 27 live.

## Change

- `20261015152535_lightning_pilot_spins_are_switched_off.sql`: the maintained
  door `fn_spin_deactivate` turns the pilot's Spin pool and `spins_enabled` off.
  Live Spins finish and pay normally; the seed returns to the treasury once they
  have settled. Asserts no other club's pool changed.
- `20261015152540_lightning_pilot_roster_plays_cash.sql`, applied after the last
  pilot Spin settles: the 25 `events` horses leave through
  `fn_member_leave_to_treasury` (wallets emptied into the pilot treasury under the
  door's declared leg), 25 idle `cash` horses join through the `join_club`
  source, and `fn_seed_horses_to_floor(pilot, 200)` funds every pilot horse below
  200. Refuses while any leaving horse is seated or entered in a live pilot event.
  Asserts 25 out, 25 in, 72 horses all `cash`/`both` at or above 200, no other
  human, treasury conservation on both legs, and no Lightning state change.
