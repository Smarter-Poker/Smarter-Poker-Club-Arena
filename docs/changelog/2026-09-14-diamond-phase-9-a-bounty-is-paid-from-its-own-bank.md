# Diamond Phase 9, First Piece: A Bounty Is Paid From Its Own Bank

Status: knockout and progressive (PKO) bounties are built in Diamonds, behind the switch. Diamond Tournaments Remain Refused At Every Door (`tournaments_enabled` is false). No real entry has been written against a real wallet. Mystery bounties, satellites, spins, guarantees and promotional entries are the later Phase 9 pieces and stay refused by name.

## What Was Built

Migration `a_diamond_bounty_is_paid_from_its_own_bank` (applied as `20260914111709`; stored text byte-identical to the repo file, md5 `d4855e56cb0b96f4d1116548dd40229a`):

- The Diamond drain holds the bounty bank per custody row exactly as it holds the prize and fee banks.
- The Diamond payer pays category `bounty` (a knockout's cash half, the champion's own head, the residual) from that bank into the collector's wallet, in whole Diamonds, with a `bounty` ledger row and the escrow shadow following. Because a knockout is paid mid-event, the payer opens the shadow first from the ledger's exact parts, so the chip shadow never opens itself from a proportional refund split at the first bounty.
- The Diamond charge carries a bounty part, and once the shadow is open it applies every later inflow (a late entry, re-entry, rebuy or add-on) to it.
- The creation door admits `bounty` and `progressive_bounty` events under the chip door's rule (a whole bounty of at least one Diamond, no larger than the buy-in after the fee); a bounty on any other format is refused, and the remaining formats stay refused by name.
- The registration core's Diamond roster row carries the head, so the roster trigger does not seed it a second time.
- Six chip readers of "bounty paid" - `fn_collect_bounty`, `fn_finalize_bounty_pool`, the terminal writer (twice), `fn_payout_guarantee_check`, the terminal receipt reader - read the Diamond ledger for a Diamond event, in place, with their chip reading kept. The engine's knockout claim, the PKO half rule and the terminal's bounty close are the chip estate's, reused whole; the PKO split was already floored to the unit.

Every chip edit is an asserted substitution with the live md5 pinned and the reverse substitution proved; every Diamond door is pinned, redefined with the same signature and declared to the guard watch. No price is invented: the bounty is what staff enter at creation.

## A Phase 8 Gap Closed On The Way

Migration `a_diamond_rebuy_proves_its_generation` (applied as `20260914111558`; md5 `dc476442a45e3715a87b4437c30293cd`). Both knockout doors resolve a player's older knockout generation as "bought back" only on the evidence of a chip_ledger `rebuy` leg; a Diamond rebuy writes a Diamond ledger row instead. In a Diamond rebuy event, the first player to bust, buy back and bust again would have been refused for ever with an alert for a ruling. Both doors now read the Diamond proof beside the chip proof, in place, on the same window. Found by the Phase 9 survey; proved on real rows in the bounty rehearsal.

## The Rehearsal

One rolled-back transaction through the real doors, before the apply: a Diamond PKO created (buy-in 110 = 99 + 11 fee, bounty 40; a mystery event, a bounty on an MTT and a bounty above the buy-in each refused by name); three entries as clients (59 prize / 40 bounty / 11 fee each, heads of 40 on the roster, pool 120, no trigger seeding); one withdrawal whose refund carried the bounty part, and a return; launch through the estate's protocol; a knockout collected by `fn_collect_bounty` - 20 Diamonds to the collector's wallet from the bounty bank, 20 onto their head, the ledger row, `bounty_pool_paid` 20; a Diamond rebuy through the purchase core (59/40/11 more into custody, a new head of 40) proving a bought-back generation on real candidate rows; two more knockouts (collector's head 100); the terminal paying the place (236) from the prize bank, the champion's own head (100) from the bounty bank and the fee (44) to the house, every bank and the custody at zero, `bounty_pool_paid` = the pool, the identity unmoved through all of it; a replayed terminal paying nothing.

The public rebuy door (`process_tournament_rebuy`) admits a rebuy only against the immutable bust evidence the engine writes with an accepted hand, which a rehearsal cannot forge; the money core was exercised exactly as that door calls it. The chip administrator's tools are unchanged.

## What Is Still Not Here

- Mystery bounties: the engine's chest inventory is built in cents and seeded with the chip unit at `TournamentManagerBase.ts` (two call sites); the Diamond creation door refuses `mystery_bounty` by name until that is Diamond-aware (next piece).
- Bounty formats have no Diamond-specific client text: the seat badge, knockout celebration and results pages format the head with the chip formatter (`SeatSlot.tsx`, `SeatKnockout.tsx`, `TournamentRankingCard.tsx`, `SessionSummaryHost.tsx`, `TournamentResultsPage.tsx`); display only, unreachable while the switch is off, listed for the client pass before the switch opens.
- Satellites, spins, guarantees, promotional entries, fee destinations for those formats: later Phase 9 pieces.

Laws: a-diamond-bounty-is-paid-from-its-own-bank, a-diamond-rebuy-proves-its-generation.
