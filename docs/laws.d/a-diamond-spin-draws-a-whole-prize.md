# tests/a-diamond-spin-draws-a-whole-prize.law.test.ts

A Spin is three seats and a multiplier drawn at launch: the prize pool is the
multiplier times the buy-in, and the house edge lives in the multiplier table
(its expectation is three seats less the chip rake rate, 2.76, an equality the
chip draw authority refuses a table for missing). In chips the owner's reserve
pool pays every prize above the three entries and keeps every entry above the
prize. A Diamond does not divide and the arena has no owner pool, so the
Diamond Spin needed three things before it could run: a rule that its prize
is always whole, a reserve that moves only whole Diamonds inside the supply
identity, and a single door through which a Spin is drawn.

The rule: a Diamond Spin is created with its multiplier table pinned by sha256
in poker_diamond_spin_contracts (immutable), and the table is admitted only if
it keeps the chip authority's identity, pays each multiplier the terminal
prices from the estate ladder by that ladder, carries the Spin blind ladder,
and makes every tier's pool and every place of its ladder a whole number of
Diamonds at the configured buy-in; anything else is refused by name
(diamond_spin_tier_not_whole_at_the_buy_in, diamond_spin_ladder_is_not_the_estate_ladder,
diamond_spin_multiplier_table_invalid, diamond_spin_requires_its_blind_ladder).
The draw floors the pool to the unit and proves the residue is zero before
anything moves (diamond_spin_prize_not_whole_at_the_unit), so a residue can
never land anywhere; the published table is certified whole at a buy-in of
one Diamond, and therefore at every whole buy-in, by the migration's closing
block.

The reserve: a pool above the three entries is underwritten by the authorized
source into the event's custody (a house burn on the register and a
player-side register mint for each custody share it lands in); a pool below
them releases the surplus from custody to the source (the drain's player-side
burn and a house mint). Each leg is a ledger row (spin_underwrite,
spin_surplus) on one custody row, in the prize bank; the escrow reads the legs
into the prize bank, the chip-facing router keeps the chip shadow convention,
the shadow opens with them as reserve_in and reserve_out, and the drain holds
an underwritten share as prize. The source underwrites only what is
authorized: poker_diamond_spin_reserve_source is one row or none, written by
a values migration that quotes Dan, never by code. With no row every Diamond
Spin is refused at the creation door and at the draw
(diamond_spin_reserve_source_not_authorized); a table that could ask for more
than the authorized cap, or that the source cannot cover in full, is refused
by name at both (diamond_spin_reserve_over_its_authorized_cap,
diamond_spin_reserve_cannot_cover_the_table). No tier is locked out: what is
advertised is what is drawn from.

The one authority: fn_spin_draw_and_settle_atomic, after its own lease,
launch-receipt and freeze proofs, routes a Diamond Spin to its Diamond arm,
fn_poker_diamond_spin_draw, which is owner-only and reachable from nowhere
else. The retired chip draw and the chip settle refuse a Diamond Spin by name
(diamond_spin_is_drawn_by_its_own_authority), the unbooked sweep skips one in
both of its reads, and the third seat books no chip entry for one. The Spin
contract trigger and the launch completion read the Diamond draw back
(fn_poker_diamond_spin_draw_proof), and the refund door refuses an entry whose
Spin has been drawn (diamond_spin_entry_already_booked), so neither a
withdrawal nor a cancellation can unwind a drawn Spin.

The creation door admits 'spin' through fn_poker_diamond_create_spin under the
chip seat-first door's rules - three seats, the buy-in the whole charge, a
multiplier drawn and never configured, a Spin variant (NLH, PLO4, PLO5, PLO6),
no key the Spin would not keep - and refuses a mismatch by name; a Spin key on
any other format is refused (diamond_tournament_spin_requires_a_spin_format).

On the engine side the Spin paid-gate reads a Diamond Spin's custody entry
rows (poker_diamond_tournament_ledger kind entry) where a chip Spin's
evidence is its refund entitlement, and the draw's four data refusals park the
launch instead of retrying it.

The law pins the mechanics: eight asserted substitutions with their live md5
and reverse proof, five Diamond doors pinned and redefined with the same
signature, every refusal by name, the owner-only grants, the engine's gate
and parking reasons, and the closing assertions (nothing authorized, the
switch closed, the identity whole, every watched guard on its baseline).
