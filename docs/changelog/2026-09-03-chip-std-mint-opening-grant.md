# A new club's first 100,000 chips come from the Mint, and stay in the club

2026-09-03, migration `20260903212855_a_new_clubs_first_100000_chips_come_from_the_mint_and_stay_in_the_club`
(applied once, 21:36 UTC), mirrored byte-exact. Dan's ruling of 2026-09-03:
"'THE MINT' WHERE ALL CHIPS AND DIAMONDS ARE CREATED, AND MUST FLOW FROM. NEW
CLUBS THAT ARE JUST CREATED START WITH 100,000 CHIPS (FROM THE MINT TO THE CLUB
UPON CREATION). THOSE CHIPS CAN EVER ONLY BE USED INSIDE THAT CLUB."

## What was wrong

The opening grant was two triggers on `clubs` that set the treasury to 100,000
against the retired `system_mint` name and wrote a `club_opening_grant`
transaction - and never touched the Mint register. `ca_mint_ledger` held 337
rows at 21:30 UTC, all diamonds, zero chips, while 16 clubs were created in 30
days (13 with the grant: 1,300,000 chips off the register). And
`fn_union_clawback_from_club` could pull a member club's treasury to zero,
opening grant included (0 clawbacks in 30 days; the door was open).

## What it does now

- The opening grant journals `issuance_reserve -> club_treasury` (category
  `mint`), the same account `fn_ca_mint` issues from, and writes one
  `ca_mint_ledger` row (asset chips, holder club, op `club-opening-grant:<club
id>`, linked to the journal row). The `club_opening_grant` transaction stays
  (the integrity report and the quick reconcile read it). Amount and timing
  unchanged: 100,000 at INSERT.
- The opening grant never leaves the club: the union clawback refuses to take
  the treasury below 100,000 for a club that received one, naming the floor
  and the maximum clawback. Sends to the club's own agents and players and the
  opening allocations (BBJ seed, spin seed, promo budget) are inside the club
  and untouched.
- Self-check inside the migration: a probe club is created in a savepoint, its
  journal row, register row and transaction are read and asserted, and the
  club is rolled back. It passed on apply.

## Not done (Phase 3)

The register's chip baseline - the chips that exist today, pre-standard - so
that `supply_after` on the register equals chips in circulation. The diamond
side posted its baseline on 2026-09-03; chips need the same one-off entry
after the epoch reset ruling.
