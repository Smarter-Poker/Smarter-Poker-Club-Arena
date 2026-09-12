# Diamond Phase 8: The Chop And The Bounties Know Their Unit

Status: Phase 8 In Progress. No Checklist Line Is Claimed By This Work. Diamond Tournaments Remain Refused At Every Door.

## The Last Three In SQL

Three of the eight division sites the Phase 8 audit found, and the last three that live in the database. All three had the same shape, which is the shape the prize ladder and the recovery fee had before them: floor a proportional share to a cent, and hand the remainder to a designated party.

The chip chop divides an undistributed pool by play-chip stacks and gives the residual to the deterministic chip leader. Because it is proportional to stacks rather than to money, it is almost never a whole anything. The bounty chop divides a bounty by claimant weight between all-in winners and lets the last claimant take the rest. The PKO half splits a share down the middle, the head keeping the odd cent, which made a 1 Diamond bounty 50 cents of cash and 50 cents to the head.

## One Wrap, And Why That Is The Point

The change at every site is a single wrap in `fn_ca_unit_floor_cents`, the helper the recovery fee work introduced this morning. That is deliberate rather than convenient.

Because the only thing inserted anywhere is a call to that one function, the entire chip-invariance argument collapses into a single claim that can be proved exhaustively: at a unit of one cent, `fn_ca_unit_floor_cents` is the identity. The migration proves it over every value from 1 to 20,000, over the large values these sites can actually produce, and it proves the non-positive answer separately. Three separate hand-checked rewrites would each have needed their own argument, and each would have been its own chance to be wrong.

In the isolated fixture a chip tournament's chop still pays 20520, 17955 and 12825 against a 513.00 pool, with a zero residual, and its bounty still splits 166, 166 and 168 with 0.83, 0.83 and 0.84 halves. Byte for byte what it paid before.

The same tournament in the Diamond arena pays 205, 179 and 128 Diamonds with one whole Diamond of residual to the chip leader, and its bounty splits into 1, 1 and 3 Diamonds, whose PKO halves are 0 cash plus 1 to the head, and 1 cash plus 2 to the head. Every amount whole, and the head still keeping the odd unit exactly as it kept the odd cent.

## Where A Diamond Cannot Be Split, The Deal Is Refused

The chip chop already raised when any rank's share was non-positive, and that guard is kept exactly as it was. So a Diamond chop that cannot give every player at least one whole Diamond does not quietly pay somebody zero. It refuses, deterministically, and the tournament plays on.

That is the right answer here and the wrong answer for the prize ladder, which pays the places it can. The difference is whether the players have somewhere to go if the answer is no. A final-table deal is a voluntary agreement, so refusing one costs nobody anything; a finished tournament has to pay somebody.

## The Fourth Site Is In TypeScript

`mysteryPoolCents` decides how much of a bounty pool becomes the mystery half, and its comment already explained why the regular half keeps the odd cent: the regular half is spent knockout by knockout against a pool checked for exhaustion on every payment, while the mystery half is committed to a fixed chest inventory up front, and an extra cent there leaves the event unable to reconcile.

At a Diamond unit the same reasoning gives the regular half the odd Diamond, for a harder reason: the inventory is built from this number, so half a Diamond is an event that cannot be seeded at all. It takes a `unitCents` parameter defaulting to 1, in the same shape as the `alreadyPaidCents` parameter added in August, so every existing caller reproduces the old arithmetic exactly.

It imports the floor from `recoveryFee.ts` rather than writing it a second time. That module had no imports at all, and `recoveryFee` is itself a dependency-free leaf, so this adds no cycle; writing the floor out again would have recreated the exact drift this phase exists to remove.

## The Wires Left

No caller passes a unit to `mysteryPoolCents` yet, and none passes one to the quote in `TournamentBrainContext`. Both need the manager or the read to know its tournament's unit, which belongs with the work that opens the Diamond tournament door rather than with the arithmetic. Both default to a cent, so the chip path is unchanged, and both are named here rather than left to be discovered.

## Applied

Migration `20260912114952_the_chop_and_the_bounties_know_their_unit.sql`, applied once. Never reapply. It adds no function and no column; it rewrites three expressions inside two existing functions and proves the rest of both were left alone.
