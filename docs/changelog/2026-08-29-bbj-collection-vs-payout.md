# 2026-08-29 — BBJ: collection and payout are DIFFERENT rules

Dan, verbatim (BINDING):

> "POT DOESN'T NEED TO BE 10 BB FOR THE BBJ TO BE TAKEN OUT... IF THERE IS A
> FLOP, BBJ SHOULD BE RAKED (3 OR MORE PLAYERS DEALT INTO THE HAND). BAD BEAT
> JACKPOT IS ONLY PAID OUT IF THERE IS MORE THEN 10 BB IN THE POT... BIG
> DIFFERENCE."

## The bug

Every BBJ fee site required `potInBB >= minPotBB` (10). That is the PAYOUT
qualification, not the collection rule — so every flop in a pot under 10 big
blinds paid rake and fed the jackpot NOTHING. Found by the weighted-rake
final sweep: of 10,267 raked weighted-era hands, 5,051 (49%) were skipped for
pot size alone. The jackpot has been under-funded by roughly half its hands.

## The rule now

- **COLLECTION** (the drop): flop seen + 3+ players dealt in + BBJ-eligible
  variant. Pot size is IRRELEVANT.
- **PAYOUT** (winning it): unchanged — pot >= 10BB, 3+ dealt, qualifying
  hands, both hole cards play, no double board, first runout only.

## Changed

- `server/src/engine/HandController.ts` — all three fee sites:
  `completeHand()`, `finalizeRunout(skipDistribution)`, `computeRakeAndBBJ()`.
  The pot-size condition is removed from each; flop + 3-dealt remain.
- `server/src/config/RakeConfig.ts` + `src/config/RakeConfig.ts` —
  `calculateBBJFee` signature changes `potSize` -> `flopSeen` (both were
  reference implementations with zero callers; the engine is authoritative).
  `BBJ_RULES.minPotBB` documented as PAYOUT-ONLY so nobody re-adds it to a
  fee gate.
- `detectBBJHit` / `detectBBJNearMiss` — UNTOUCHED. The 10BB payout floor and
  every other qualification stand exactly as they were.
- Player-facing copy (BBJBasicPanel, BBJRulesPanel) now states both rules
  separately, so the published rules match the engine.
- `server/src/engine/HandController.bbjcollection.test.ts` (new) pins:
  tiny 1.5BB pot with a flop DOES pay the drop; no flop = no drop; heads-up =
  no drop; a big pot still takes exactly one fee; and the payout floor still
  blocks a qualifying beat in a sub-10BB pot.

## Not retroactive

Hands already played kept their old (missing) drop. Backfilling would mean
taking chips out of pots that were already paid out and settled — that is
Dan's call to make explicitly, not an agent's to assume. From deploy forward,
every eligible flop funds the jackpot.
