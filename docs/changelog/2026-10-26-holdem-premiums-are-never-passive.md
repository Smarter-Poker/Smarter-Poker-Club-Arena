# Hold'em horses never play premiums passively, and fold dominated hands to a 3-bet

Dan, 2026-10-25 21:09 Chicago, after a text from a real player about a hand he
lost to two horses:

> "HORSES CAN NOT EVER BE PLAYING PASSIVELY WITH PREMIUM HANDS. ... THE ONE
> HORSE SHOULD BE FOLDING TO A HUGE THREE BET WITH KQO. AND THE ACES SHOULD BE
> FIRING ON A SMALL FLOP AND TAKING COMMAND OF THE HAND! NEVER CHECKING IT
> DOWN!! MAKE THESE FIXES NOW FOR THE HORSE BRAIN AND UPDATE ALL 1000 HORSES"

## The hand

`hand_history` 7c0a1fb9-a60a-41b9-a2c5-2cdce82335ea, 2026-10-26 02:02 UTC,
mystery-bounty MTT level 6 (150/300, 300 BB ante, about 77bb deep). The human
opened KQo under the gun to 600. Horse seat 3 3-bet AA to 2,746 (4.6x). Horse
seat 5 cold-called the 3-bet with KQo. The human folded. On 9h 5s 3s 9s 6c both
horses checked the flop, turn and river.

## Why the brain did it

The brain mixes: replaying this exact spot with the new rule switched off, the
KQo horse calls on some seeds and folds on others, and the aces check the flop
or river on some seeds and bet on others. A mixed strategy is a frequency, and
the player at the table sees only the hand he lost.

Measured across the fleet (NLH, the 90 minutes to 02:15 UTC): horses holding
QQ, KK or AA saw 472 flops and fully checked down 30 of those pots (28 of them
in tournaments), and horses flat-called preflop 3-bets with KK, QQ and AK
instead of re-raising.

## The rule (`server/src/engine/HorseHoldemPremiumAggression.ts`)

No-limit hold'em only, one board, cash and tournaments, every horse:

1. **Dominated hands fold to a 3-bet.** Facing a 3-bet or more that is at
   least 2.5x the level it raised, an offsuit unpaired hand other than AKo
   folds instead of calling or raising. A cold caller also folds AQo. Left to
   the brain: 20bb effective or less (push/fold) and token prices under 15%.
2. **Premiums raise preflop.** AA and KK never limp, check the option or flat:
   they raise, over a 4-bet too. QQ, AKs and AKo raise over limps, a single
   raise and a 3-bet. Sizes: 3x plus one per caller, 2.3x over a 3-bet. The
   tournament shove discipline still runs on the result.
3. **Premiums keep betting.** An overpair QQ+ or AK with top pair or better
   that is checked to or first to act bets: half pot on a dry flop,
   two-thirds on a wet flop, the turn and the river, all in once the bet would
   be 60% of its stack. Facing a bet, the brain still picks call or raise. The
   only checks left are a board with four to a flush the horse does not hold,
   or four to a straight.

Applied after every other layer in `HorseLogic.decide`, and again at commit in
`ServerTableEngineTurns`, so no policy owner or withdrawn selection can put the
passive line back. Every override keeps the brain's own think time.
Telemetry: `holdem_dominated_3bet_fold`, `holdem_premium_preflop_raise`,
`holdem_premium_postflop_bet`. The `holdemPremiumAggression` option exists
only so an ablation can measure an older layer alone; live always runs it.

Pinned by `HorseHoldemPremiumAggression.law.test.ts`, which replays the
recorded hand through the whole brain across seeds and every style.
