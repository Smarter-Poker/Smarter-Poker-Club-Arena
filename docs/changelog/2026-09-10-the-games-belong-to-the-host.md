# The games belong to the host

**2026-09-10. Dan: "there should also be a function when a player is out of
chips or doesn't have enough to rebuy into a tournament or rebuy into a cash
game, they be prompted to play diamonds to chips. there also needs to be a
button for this inside the club lobby. this is controlled and owned by the
union, but also added to 'stand alone clubs' with no union affilliation. make
sure that the chip payouts are 100% connected and wired to the 'promo wallet'
and all diamonds 'taken in' get credited to the union owners wallet, or the
club owners wallet."**

Continues `docs/changelog/2026-09-10-the-marks-the-runs-and-the-week.md`.

## What the games used to do with the money

A spin cost the player diamonds. Those diamonds were retired: `deduct_diamonds`
booked them as a spend and nobody received them. Then, so the house could pay,
the platform **minted** chips out of the issuance reserve into the host's chip
bank, `union_wallets.chip_balance` or `clubs.chip_treasury`, at a fraction of
what had just come in, and the prize was paid from that bank. Two things were
wrong with it. The diamonds went nowhere, so the owner who runs the game earned
nothing from running it. And new chips were created every round, which is the
one thing the platform is not supposed to do casually: the chip supply grew
every time somebody span the wheel.

## What they do now

Nothing is minted. Nothing is retired.

The intake is a transfer. The diamonds a player pays for a spin, a drop or a
crash bet are credited, in the same transaction, to the **owner of the host**:
`unions.owner_id` when a club plays under a union, `clubs.owner_id` when the
club is standalone. `fn_diamond_game_take_bet` now takes the owner and the note
to book it under, calls `deduct_diamonds` on the player and
`add_diamonds_to_balance(owner, +bet, 'transfer')` on the owner, under one
reference so the two halves are findable as a pair. A transfer carries no VIP
multiplier and no earn cap, which is right: this is not the owner earning
diamonds, it is the owner being handed the ones the player spent.

Every chip prize comes out of the host's **promo wallet**:
`union_wallets.promo_wallet` for a union host, `clubs.promo_balance` for a
standalone club. Not the chip bank. The bank is not read, not locked, and never
debited by any of the three games. `fn_diamond_game_promo_lock` takes the
promo wallet `FOR UPDATE` at the top of every round, and that number is the
bank figure the cap, the gates and the wheel's tier locks all work from.

Diamond prizes and the daily free spin are paid by the owner, out of the
diamonds the games took in. `fn_diamond_game_pay_diamonds` moves them owner to
player as two transfer legs. The owner cannot take a free spin from itself, and
`fn_wheel_free_state` says so with `reason = 'owner'`.

## The law, restated

`docs/laws.d/the-games-never-pay-more-than-they-take-in.md` used to be a law
about a mint: the house could never pay more than it had been given. There is
no mint to bound now, so the law is stated on what actually came in.

    chips_paid + reserved <= intake_diamonds / diamonds_per_chip + allowance

and, separately, the promo wallet must actually hold the prize before it is
paid. Both are checked in the same transaction that pays. The exposure
allowance is unchanged and is the only slack in it.

`fn_diamond_game_cap_cents` computes the headroom from the intake and from the
promo wallet, so a host whose promo wallet is empty cannot offer a bet it
cannot pay: the bet options come back unplayable, a drop is refused with "The
Club Cannot Cover A Win At That Bet Right Now. Try A Smaller Bet", and the
wheel's chip tiers show as locked rather than paying out of something else. The
copy no longer says "the bank", because the player has no bank and the club is
what is covering the win.

## One journal row per prize

The chip prize is journaled by the **promo side**, not the member side, so the
leg names the column the chips left. `fn_ca_declare_ledger` is told to stand
the `club_members` writer down for that statement, the promo column is debited,
and the function then refuses to continue if no leg was written. A union host's
promo column journals under the `union_wallet` account and a club host's under
`promo_wallet`; both carry a label naming the promo column, and both pay
`player_wallet`. There is exactly one leg per prize, keyed on the spin, drop or
round id, so a replay cannot pay twice.

## The door into the games

Three places a player runs out of chips now offer the way back in rather than
just refusing: the buy-in and rebuy on a cash table, the add-on, and the
tournament sign-up. Each shows a Diamonds To Chips plate when the player is
short, on the painted `ClubButtonsSurface`, and takes them to the games for the
club they are sitting in. `DiamondsToChipsButton` is one component with one
rule for when it shows (`canEnterDiamondGames`), so the four surfaces cannot
drift apart, and it reads `fn_diamond_games_entry` for the club: whether the
host runs the games at all, which of the three are open, what a spin costs,
what the player holds and whether they are a member.

The club lobby carries the same plate permanently, whether or not the player is
short, because the games are a thing the club offers and not only a rescue.

## The operator sees the host's money

Both operations pages now read the promo wallet rather than the mint. "Chips
Minted To The Union" is gone; in its place are "Chips Taken In", the host's
promo wallet (in red when it is at or below zero, because at zero the games
stop), and the owner's diamond balance, which is what pays the diamond prizes.
The word for the host is Union or Club, whichever this club actually has.

## Verified

A rolled-back probe played 62 real rounds through the live doors, on both host
shapes: Club JAQK under Midway Union, and Deep Stack Society standing alone.
For each it asserted that the player moved by exactly the diamond prizes less
the intake, that the owner moved by exactly the intake less the diamond prizes,
that the promo wallet fell by exactly the chips paid, that the journal paid the
player exactly those chips, that this transaction wrote no leg naming a chip
bank or the issuance reserve, that each prize carries exactly one leg from a
promo column, that the intake invariant holds per game with nothing left
reserved, that the entry read answers, that the owner is refused its own free
spin, and that emptying the promo wallet makes every bet unplayable, refuses a
drop and locks the wheel's chip tiers.

The bank could not be checked by reading its balance: Deep Stack Society is a
live club and its treasury took rake from real tables while the probe ran. The
proof is the journal instead.
