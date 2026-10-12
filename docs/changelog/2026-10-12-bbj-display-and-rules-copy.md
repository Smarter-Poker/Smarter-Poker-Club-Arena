# 2026-10-12 - The Mini jackpot names its bad-beat holder, and the jackpot rules say what the engine enforces

## What was wrong

**D1. Every Mini Bad Beat Jackpot was shown with its two players swapped.** The
money was always right. The main payout (`bbj_atomic_payout_v2`) stores
`bbj_payouts.winner_user_id` = the bad-beat holder (the player who lost the hand
and takes 50%) and `loser_user_id` = the hand winner (25%). `fn_bbj_mini_payout`
stores them the other way round, and its `bbj_winners` row follows suit. Checked
on production: in 112 of 112 minis the 50% share went to `loser_user_id`. Both
readers assumed the main shape - `fn_bbj_recent_hits` (the Previous Winners
list) and `fn_bbj_hand_detail` (the hand drilldown and its BAD BEAT tag) - so
payout `559c6366-9388-4273-a81e-2a151aef8036` named SlyViking (the hand winner,
A8, 175.00) as the jackpot winner and sam1982 (the K7 bad-beat holder, 349.98)
as the hand winner.

**D2. The Mini's hands were never named.** `bbj_winners.winner_hand` and
`loser_hand` were NULL on 112 of 112 minis because `fn_bbj_mini_payout` never
wrote them. The engine always sent them in the payout metadata (`loser_hand` =
the bad-beat holder's hand, `winner_hand` = the hand winner's).

**D3. Player-facing rule text contradicted the rules.** The Mini surfaces
(rules page note and per-game table, the basic panel, the operator panel, the
empty Mini winners list) never said both hole cards must play (Dan 2026-10-11).
The empty Mini list said "Any Quads (Omaha)", which is wrong for PLO5/FLO5
(Quad Tens or better). The FAQ left out the hold'em Ace-in-hand rule, said
"In Omaha Games, Quad Kings Or Better" (PLO5/FLO5 is an 8-high straight flush
or better) and did not mention the Mini. The Pineapple Mini sub-label had no
both-cards clause although the engine enforces it.

**D4.** The main jackpot announcement enriched itself from "the newest payout
on the pool", which can be a Mini paid in the same moment.

## The fix

- Migration `20261012063036_the_mini_jackpot_names_its_bad_beat_holder.sql`
  (one transaction, `lock_timeout` 5s): both readers are kind-aware
  (`bad-beat holder = CASE WHEN COALESCE(kind,'main')='mini' THEN loser_user_id
ELSE winner_user_id END`, the hand winner the reverse) for ids, names, hands,
  amounts, cards, role labels and the pruned-hand branch, and fall back to the
  payout metadata for a Mini's hand names. `fn_bbj_mini_payout`'s `bbj_winners`
  INSERT now writes `winner_hand` / `loser_hand`; nothing else in it changes and
  its stored convention is not flipped. Each live definition, owner and grant is
  asserted before it is replaced and again after. **No payout row is changed**:
  the migration has no INSERT, UPDATE or DELETE outside the function bodies.
- Verified against production by running the new reader bodies as plain
  SELECTs: payout 559c6366 now names sam1982 (K7, Full House, 349.98) as the
  bad-beat holder and SlyViking (A8, Four Of A Kind, 175.00) as the hand
  winner; main payout 5dbdd309 returns byte-identical output; all 112 minis and
  43 mains name the 50% recipient as the bad-beat holder with a known hand.
- `src/config/bbjMini.ts`: `miniRequiresBothHoleCards` (nlh, flh, pineapple -
  the server's `bothCardsRuleApplies` set), `miniBarsPhrase` and
  `miniBothCardsGamesPhrase`, which read the bars from the config. The
  Pineapple sub-label gains the both-cards clause; PLO5/FLO5 does not.
- The rules page, basic panel and operator panel say both hole cards must play
  in Hold'em and Pineapple; the per-game Mini table marks those rows. The empty
  Mini winners list prints its bars from `miniBarsPhrase`. The FAQ states the
  Ace-in-hand rule, the real Omaha bars, the ineligible games and the Mini.
- `src/lib/bbjHitFeed.ts` passes `p_kind: 'main'`.
- Pinned by `tests/bbj-mini-display-and-rules-copy.test.ts`.
