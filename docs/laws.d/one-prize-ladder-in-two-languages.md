# server/src/tournament/oneLadderTwoLanguages.law.test.ts

The rule that turns a prize pool into per-place amounts exists in exactly two
implementations, and neither can call the other. The engine prices places in
TypeScript, in computePlacePrize; the database prices them in SQL, in
fn_ca_prize_ladder. Before migration 20260912090000 there were four: three
SQL copies and the TypeScript one, and nothing held any of them together.

Two is the fewest possible, so the bond has to be behavioural rather than
textual. Every expected value in oneLadderTwoLanguages.vectors.json was
produced by fn_ca_prize_ladder executing in Postgres, over the payout
structures this platform ships crossed with the pools that land on the
interesting rounding boundaries, in both denominations. The SQL is the source
of truth for the file; computePlacePrize is the thing under test. The law
therefore fails when the TypeScript drifts away from the database.

When the SQL ladder changes on purpose the vectors are regenerated in the same
commit, and the diff shows exactly which answers moved. A regenerated file with
no diff means nothing moved, which is the whole point of keeping it.

What the vectors pin, beyond equality: the ladder never overpays; a place
outside the ladder is worth nothing; and a Diamond tournament whose pool is a
whole number of Diamonds pays every place in whole Diamonds.

On exactness, stated as the ladder behaves rather than as it would be pleasant
to describe it. A chip ladder spends the pool to the cent, always. A Diamond
ladder does too, except in the short field - a pool holding fewer whole
Diamonds than there are places to pay - where the pool's sub-Diamond remainder
goes to nobody, because there is nobody it can go to. An indivisible unit
cannot be split, and handing the fraction to one player would pay somebody more
than the player who beat them. The remainder is strictly smaller than one unit
and is zero whenever the pool is a whole number of Diamonds, which every
Diamond pool in this estate is by construction. The law asserts that bound
rather than the convenient equality, because the bound holds for every input. A structure carrying a trailing zero-percentage place is
required to be present, because that shape is what decides where the residual
lands, and the SQL normaliser keeps such a place precisely because
computePlacePrize keeps it.
