# tests/a-diamond-mystery-chest-holds-whole-diamonds.law.test.ts

A mystery bounty event splits its bounty pool in two: the regular half pays
flat heads knockout by knockout until the mystery phase opens; the mystery
half is sealed up front into an inventory of chests, one per player who can
still be knocked out, built by the engine from the one tier ladder and
accepted by the database only if it sums exactly to the half. From then on a
knockout reserves the next chest for the claimants of the pot, the designated
revealer opens it, and the payment goes out through the same obligation and
credit path as every other bounty; at the terminal the unclaimed chests are
settled to the champion.

All of that was built in cents. A Diamond does not divide, so four places had
to learn the event's unit before a Diamond mystery event could run: the seed
floors the mystery half to the unit (the engine already floored the pool it
builds from, since September 12, when told the unit) and refuses any chest
that is not a whole number of units; the reserve splits a chest between
several claimants in whole units with the remainder to the first claimant by
user id; the complete marker - the evidence that a knockout obligation was
settled exactly as its claimants deserve, which the claim, the acknowledging
triggers and the mystery payment all consult - expects that split at the
unit rather than the cent split it used to expect (a marker that could never
be true would have left every Diamond knockout obligation pending and the
event unable to finish; the same marker now also expects a PKO cash half
floored to the unit, which is what fn_collect_bounty pays); and the terminal
settlement reads "bounty paid" from the Diamond ledger. At a chip unit every
one of these is the arithmetic it was, by construction. The creation door
admits the format and stamps the activation mode, value, profile, top
percentage and pool split under the chip configuration door's rules, because
that door consults a club owner the arena does not have; the advertised range
is the chip door's multipliers on the flat bounty, in whole Diamonds.

On the engine side the manager reads the unit beside the tournament row and
builds the inventory at that unit (buildInventoryAtUnit: the same ladder in
Diamonds, scaled back to cents), and a manager that could not read its club
does not seed at all rather than seed at a guessed cent - the seed would have
refused the inventory and the chests would never have opened.

The law pins the mechanics: three asserted substitutions with their live md5
and reverse proof, the marker and the creation door pinned and redefined with
the same signature, the rules by name, and the closing assertions. Rehearsed
through the real doors in one rolled-back transaction before the apply: a
Diamond mystery event created with its rules stamped (a mystery range on a
plain event refused); five entries; the launch; a pre-activation knockout
paying the flat head; the seed refusing chests off the unit and accepting
three on it (the mystery half 100 Diamonds of a 200 pool); a three-way
knockout split 8 + 6 + 6 in whole Diamonds with its obligation settled and
its marker complete; two more chests; the terminal paying the place, the
remainder of the bounty bank to the champion and the fee to the house with
every bank, chest, award and custody row closed and the identity unmoved.
