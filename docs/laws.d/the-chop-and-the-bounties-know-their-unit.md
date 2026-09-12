# tests/the-chop-and-the-bounties-know-their-unit.law.test.ts

Three of the eight division sites the Phase 8 audit found, and the last three
in SQL. All three had one shape: floor a proportional share to a cent, and hand
the remainder to a designated party. The chip chop divides an undistributed
pool by play-chip stacks and gives the residual to the chip leader. The bounty
chop divides a bounty by claimant weight and lets the last claimant take the
rest. The PKO half splits a share down the middle, the head keeping the odd
cent, so a 1 Diamond bounty was 50 cents cash and 50 cents to the head.

The change at every site is a single wrap in fn_ca_unit_floor_cents, and that
is the point rather than a convenience. Because the only thing inserted
anywhere is a call to that one function, the whole chip-invariance argument
collapses into a single claim that can be proved exhaustively: at a unit of one
cent it is the identity. Three separate hand-checked rewrites would each have
needed their own argument, and each would have been its own chance to be wrong.

Where a Diamond cannot be split, the chop refuses rather than rounds. The chip
chop already raised on a non-positive share and that guard is kept untouched,
so a Diamond chop that cannot give every player at least one whole Diamond
refuses deterministically and the tournament plays on. That is the right answer
here and the wrong answer for the prize ladder, which pays what it can. The
difference is whether the players have somewhere to go if the answer is no: a
deal is a voluntary agreement, and a finished tournament is not.

The law reads the migration with comments stripped, because its header
discusses every string the assertions look for. Beyond the three wraps it pins
the rules the change did not set out to touch, which are the ones most likely
to be lost by accident: the chop's refusal, the chop's residual to the leader,
the bounty's last-claimant remainder, and the PKO head's remainder. It also
requires that the migration actually runs the identity proof rather than
merely claiming it.
