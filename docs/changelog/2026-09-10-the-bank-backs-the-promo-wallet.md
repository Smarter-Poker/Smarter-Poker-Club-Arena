# The bank backs the promo wallet, and the free spin becomes a welcome

**2026-09-10. Dan, on the phase that had just shipped: "1, the back up is the
union or club main bank, if the promo pool runs dry. wire that in. 2, free spin
should be once for a new user 100 diamonds, and yes its funded by union or club
owners, they simply 'receive no diamonds' but are allowing a free 100 diamond
spin for new members of the union or club. All paid for by the promo wallet."**

Continues `docs/changelog/2026-09-10-the-games-belong-to-the-host.md`.

## The backstop

That morning's migration made the promo wallet the only source of a chip
payout. It was the right wiring and the wrong failure mode: a host whose promo
wallet emptied had its three games close until somebody happened to look at the
operations page and notice a red zero.

The promo wallet is still first and still where an operator is meant to keep
the float. Behind it now stands the host's own chip bank,
`union_wallets.chip_balance` for a union and `clubs.chip_treasury` for a
standalone club. A payout draws the promo wallet down to nothing and takes the
remainder from the bank. Nothing is minted: the bank is a wallet the host
already owns, and moving chips out of it is a debit like any other.

The two together are COVER, and cover is now what every cap, gate and tier lock
in all three games is measured against. `fn_diamond_game_cover_lock` takes both
under one `FOR UPDATE`, because they sit on one row per host shape, so two
rounds cannot both find the same last chip.

## One payer

Every chip these games pay now leaves through `fn_diamond_game_pay_chips`. The
wheel used to move the wallet itself, in eighty lines that were a near-copy of
`fn_diamond_game_prize_leg`; both are one call now. It draws the promo wallet
first, takes the rest from the bank, and writes ONE journal row per wallet it
actually touched, from the paying side, so each row names the column the chips
left. A split payout is two rows that add up to the prize, the bank half keyed
`<round>:bank`, and the function refuses to carry on if a wallet moved without
a leg being written.

The migration will not commit if any game function moves a host wallet itself
again: the self-check reads the four bodies and looks for the assignments.

## The welcome spin

The free spin was daily, drawn on its own five-prize diamonds-only table, and
paid out of the owner's diamonds. It is now one spin per member per host, ever,
on the REAL wheel at the real price: the same eleven segments, the same odds,
the same gates a paying player meets. The member pays nothing and the owner
takes nothing in, which is exactly what Dan described, and whatever it lands on
comes out of the promo wallet like every other payout.

Once means once. A partial unique index on `(host_id, user_id) WHERE
is_welcome` is the promise; the check that answers the player in words sits in
front of it, but the index is what two racing requests hit.

**The budget, which is the part the ruling implies rather than states.** A paid
spin funds its own payout: the intake grows and `paid <= taken in + allowance`
holds. A welcome spin takes nothing in, so charging its payout against the
intake would quietly break that invariant one new member at a time. So it is
not charged there. The pool counts welcome payouts separately against a budget
the host declares, and the two promises are kept apart and are both exact:

    chips_paid + reserved <= intake_diamonds / rate + exposure allowance
    welcome_chips_paid                        <= welcome budget

A host that has not set a welcome budget offers no welcome spin, which is the
right default: an acquisition cost is a decision, not an accident.

## One wheel, two doors

Rather than a second copy of the spin, there is one body,
`fn_wheel_spin_core(club, commit, seed, welcome)`, and two thin wrappers.
`fn_wheel_spin` passes false, `fn_wheel_free_spin` passes true, and the core is
granted to `service_role` only, so a browser cannot ask for a free spin by
argument. The migration refuses to commit if that ever stops being true.

Two consequences worth writing down. A SQL wrapper appears in the call stack as
`SQL function "fn_wheel_free_spin" statement 1`, which is not the shape
`fn_guard_profile_privileged_columns` matches, so the first probe run refused
every diamond prize; the guard names the core now. And the wrappers, being one
line of delegation, never called `auth.uid()` themselves, so
`check-definer-authorization` blocked the push: a SECURITY DEFINER function a
browser can reach that never asks who is calling. It was right to. "The thing I
call asks" is not the same promise as "I ask", and nobody reading the wrapper
can see the difference. Each door asks first now
(`20260910235243_the_wheel_doors_ask_who_is_calling.sql`).

## What the operator sees, and can do

Both operations pages read Cover, then the promo wallet and the bank
underneath it, with the promo row going gold and saying so when the bank is
carrying the games. The welcome console replaced the daily-pot console: spins
given, budget spent against budget set, and one field in chips.

And there is a plate that moves chips from the bank into the promo wallet,
`fn_diamond_game_fund_promo`, one door for both host shapes, gated by
`fn_wheel_can_operate`, journaled as a `treasury_transfer`. The bank backs the
promo wallet automatically; this is how an operator puts the float back where
it belongs without going to find another screen.

## Two more places the door appears

The cashier now carries the Diamonds To Chips plate, because the cashier is
where a player goes when they have run out. And `ArenaAccessBoundary`, the
guard a player meets when a club has not opened its games yet, was four flat
panels in gold-on-cream with CSS buttons: it is built on the painted chassis
now, in the platform's own inks, and it offers the door rather than a dead end.

## Verified

A rolled-back probe on both host shapes, playing the live doors:

- the promo wallet squeezed to a quarter of a chip, then rounds played until
  one paid: the promo wallet is emptied first, the bank covers the remainder,
  and the two journal rows add up to the prize;
- the promo wallet at nothing: the game still pays, out of the bank alone, and
  writes no promo leg;
- a welcome spin taken by a member who has never had one: the player's diamonds
  do not move, the owner takes nothing in, the intake does not grow,
  `chips_paid` does not move, and the welcome budget falls by exactly what the
  prize was worth; a second welcome spin is refused and exactly one is on
  record;
- an unfunded welcome budget closes the offer;
- both wallets empty: no bet is playable, the drop is refused and the chip
  tiers lock;
- the owner may not take their own welcome spin;
- the owner can move chips into the promo wallet and a plain member cannot.
