# The wheel never repeats itself, a VIP never wins an item, and Diamonds deals three cards

Owner rulings of 2026-09-21 (Dan): R2, R12, R13, R15 and the server half of R18.
Migration `20260922194123_diamond_wheel_v4_draws_a_different_prize_every_time_and_diam.sql`.

## What the owner asked for

- **R13.** "A bonus game 50% of the time, an instant chip win 30%, and throwable
  / time bank / rabbit hunt 20%." Told that mix could not hold the 80% payback at
  the old prize values, the owner chose **Hold 80% payback**.
- **R12.** "Back-to-back spins must NEVER give the same prize or game twice in a
  row. 100% always a different game or prize."
- **R2.** An active or lifetime VIP card holder "can NEVER win Throwables, Time
  Banks or Rabbit Hunts"; for them those outcomes become instant chip wins.
- **R15.** "If Diamonds is won it plays a game where 3 cards pop up: one is 50%
  of diamonds risked, one is 2x, one is 3x."
- **R18.** An auto run "should auto run the selected number of spins and
  ACCUMULATE all prizes and bonus games to the end and award all of them then."

## The behaviour

**The model.** Twelve ords, twelve labels and the same order as v3, on new
weights out of 100000: a game 50%, instant chips 30%, an item 20%. Holding 80%
with that mix meant moving the item prizes from half an entry to a quarter and
re-solving the chip ladder, so the wheel is worth exactly `0.8` of every entry
from 25 to 2500 diamonds, with no remainder in tenths of a diamond.

**Never the same prize twice.** The spin after ord _i_ draws from row _i_ of a
symmetric follow-up matrix whose rows sum to the base weights. Symmetry is the
whole mechanism: it makes the columns sum to the base weights as well, which is
exactly the statement that the unconditional law of every spin is still the
published one. So no prize can repeat and yet the long-run mix is still exactly
50/30/20 and the payback still exactly 0.8, and no conditional expectation after
any prize reaches the entry (the worst is 0.8621). A bonus game may not repeat
across the Upgrade tiers either: after an Upgrade that landed Super _g_ the
ordinary _g_ is dropped from the next row and its weight shared by the other
three ordinary games, and the Upgrade wheel drops Super _g_ after an ordinary
_g_. Both moves are value neutral because the games they move weight between are
worth the same. The player's previous outcome is read under a per-player
advisory lock, so two spins at two clubs can never see the same previous.

**VIP.** One helper, `fn_wheel_is_vip`, answers the canonical question that was
inlined in a dozen migrations. For a VIP the wheel's three item cards are chip
cards of exactly equal value (0.2x, 0.25x, 0.3x on weights 6667/6666/6667 =
5000, the same 5000 the items were worth), decided server side at spin time and
shown by `fn_wheel_state_v2` so the wheel a VIP sees is the wheel they get.

**Diamonds is a game.** A Diamonds outcome pays nothing at the spin. It seals
three cards worth half, double and triple the diamonds risked, in one of six
orders drawn from the new `wheel-v4-cards` domain, and creates a
`wheel_card_awards` row. `fn_wheel_diamond_cards_pick(award, card)` pays that
card once, reveals all three and is idempotent. Expected value 11/6 of the risk
whichever card is chosen.

**Runs.** `fn_wheel_run_begin(club, spins)` opens a run of 5, 10 or 25 spins and
`fn_wheel_run_end(run)` closes it and hands back the queue. While a run is open
the bonus games and card games it wins may stay unplayed; anything won before it
still blocks, the spin after the last one is refused, and when the club's cover
cannot carry another pending award the spin says so in words.

## The money

A card can pay three times the entry where v3 only ever paid half, so the gate
that asked for half an entry now asks for three, and every unpicked card holds
its triple against both the owner's daily custody and this wheel's diamond float
until it is picked. That reservation is why `wheel_pools.diamond_float >= 0` did
not have to be weakened: nothing can be drawn that was not covered before the
seed was read. Item prizes cost a quarter of an entry instead of a half. A VIP's
chip cards are paid by `fn_diamond_game_pay_chips` like every other chip prize,
promo wallet first and the host's bank behind it, with their `chip_ledger`,
`chip_transactions` and union wallet rows. The card prize is paid from the
owner's daily custody (`fn_diamond_spin_book`, kind `diamond_prize`) and credited
to the player as one `diamond_transactions` row under `wheel-cards:<award id>`.

## Proof

- `tests/sql/diamond-wheel-v4-model-and-matrix.sql`: twelve ords out of 100000,
  exactly 0.8 for every entry 25..2500 on both the standard and the VIP table, a
  symmetric zero-diagonal matrix whose rows AND columns sum to the base law,
  every conditional expectation below the entry, the cross-tier rule value
  neutral on both wheels, six distinct card orders each worth 11/6.
- `tests/sql/diamond-wheel-v4-draw-and-cards.sql`: four hundred real spins with
  no repeated prize or game and a chi-square of 0.151 against 50/30/20; a
  lifetime VIP shown and paid chips on ords 3, 6 and 9 and never granted an item
  in sixty spins; the card game sealed, paid once, idempotent and revealed; a run
  of five accumulating four games and one card, refusing the sixth spin and
  ending idempotently, with a pre-run award blocking throughout; and every entry,
  prize and grant journaled with its custody movement.
- `tests/sql/diamond-spins-every-movement-has-a-ledger-row.sql` is re-run on the
  v4 contract, so its `fn_wheel_diamond_cards_pick` branch runs for real.
- `tests/unit/wheelV4PostgresContract.test.ts` replays 26 receipts captured from
  that probe through the service, the validators and the browser verifier, and
  proves a receipt that quietly reweighted itself is refused even though its own
  arithmetic adds up. v3 receipts still verify under their own rules.
- `tests/the-wheel-never-pays-more-than-it-takes-in.law.test.ts` gains the exact
  integer proofs, read out of the migration text rather than retyped.
- `scripts/diamond-spins/wheel-v4-follow-matrix.py` derives and proves the whole
  law, and emits both the SQL the migration installs and the TypeScript the
  browser reads.
