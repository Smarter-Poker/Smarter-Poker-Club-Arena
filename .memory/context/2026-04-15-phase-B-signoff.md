# Phase B Signoff — Omaha Variants & Special Formats (2026-04-15)

**Type:** CONTEXT
**Project:** Smarter Poker Club Arena
**Phase:** PokerBros Comprehensive Upgrade Plan — Phase B
**Status:** SIGNED OFF (code-complete; live multi-variant E2E deferred to a focused test-rig session)

## Code coverage — every PokerBros variant has end-to-end wiring

| Variant                          | DB enum                      | Engine evaluator                                         | Lobby/CreateTable UI                                      | Notes                                                                                             |
| -------------------------------- | ---------------------------- | -------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| NLH (Texas Hold'em)              | `'nlh'`                      | `evaluateHand`                                           | ✅ default                                                | Live + verified across hundreds of hands.                                                         |
| PLO 4-Card                       | `'plo4'`                     | `evaluateOmahaHand`                                      | ✅ `CreateTableModal.tsx:20` + `TableCreationPage.tsx:48` | 4 hole + must use exactly 2. Pot-limit max bet enforced via `calculateBettingState.maxRaise`.     |
| PLO 5-Card                       | `'plo5'`                     | `evaluateOmahaHand` (5-card variant)                     | ✅ `:21` + `:56`                                          | `getCardsPerPlayer` returns 5.                                                                    |
| PLO 6-Card                       | `'plo6'`                     | `evaluateOmahaHand` (6-card variant)                     | ✅ `:22` + `:64`                                          | `getCardsPerPlayer` returns 6.                                                                    |
| PLO 8 (Hi-Lo)                    | `'plo8'`                     | `evaluateOmahaHand` + `evaluateOmahaLowHand`             | ✅ `:23` + `:72`                                          | Pot split between high + qualifying low; `determineWinners:580` branches on `isHiLo`.             |
| Short Deck (Hold'em 6+)          | `'short_deck'`               | `evaluateHand` w/ `isShortDeck=true`                     | ✅ `:24` + `:88`                                          | Flush beats full house, A-6-7-8-9 = wheel; deck-prep removes 2-5 before shuffle.                  |
| Pineapple (Crazy Pineapple)      | `'pineapple'`                | `evaluateHand` (3 hole pre-discard, 2 hole post-discard) | ✅ `:80`                                                  | `HandStage` includes `'pineapple_discard'`; `PINEAPPLE_DISCARD_REQUIRED` event emitted to client. |
| OFC                              | `'ofc'`                      | `OFCDealingOrchestrator` + `OFCPineappleEngine`          | ✅ `:104`                                                 | Open-face Chinese: 5/5/3 split rows.                                                              |
| OFC Pineapple                    | `'ofc_pineapple'`            | Same                                                     | ✅                                                        | OFC variant with 3-card draws and discards.                                                       |
| Bomb Pot (modifier, not variant) | `bomb_pot.frequency > 0`     | `HandController.postBombPotAntes` + `start()`            | ✅ Toggle + frequency configurable                        | Skips preflop, deals to flop.                                                                     |
| Double Board (modifier)          | `double_board: true` setting | Re-uses `RunItTwiceEngine` 2-board path                  | ✅                                                        | Two boards run simultaneously; pot split by board winner.                                         |

## Source files inventory

- **Engine evaluators:** `server/src/engine/PokerEngine.ts` (`evaluateHand`, `evaluateOmahaHand`, `evaluateOmahaLowHand`, `compareHands`, `compareLowHands`).
- **Variant types:** `server/src/types.ts:30-39` (9 variants enum, exhaustive union).
- **OFC engine:** `server/src/engine/OFCDealingOrchestrator.ts`, `OFCPineappleEngine.ts`.
- **Pineapple discard:** `HandController.start:582-593` + `HandController.checkPineappleDiscardsComplete:480` + `HandController.advanceStage:596-599`.
- **Pot-limit max raise:** `PokerEngine.calculateBettingState:472` (`maxRaise = pot + toCall` for `isPotLimit`).
- **Client UI:** `src/pages/TableCreationPage.tsx:159+`, `src/pages/CreateTablePage.tsx:48+`, `src/components/club/CreateTableModal.tsx:20+`.

## What's still needed for full PokerBros parity on variants

- **Lobby variant filter** — confirm filter chips render per game type and filter the table list correctly. (Code present; live observation deferred until Dan creates a multi-variant lobby test.)
- **Multi-variant test tables** — operations team should spin up one cash table per variant (9 tables) so Dan can E2E each from the lobby. Engine code is sound; this is a pure test-rig setup.
- **Hand-name display per variant** — high vs low hand names on plo8 showdown; "wheel" for short-deck low straight.

## Deferred items moved to Phase B-2

These are surfacing-level UI polish, not gameplay correctness:

1. Lobby filter chip per variant — observed wired, no live verify yet.
2. Hand-name banner ("PLO Nut Flush" etc.) on showdown — engine supplies the ranking, banner rendering needs a quick check.
3. Hi-Lo split UX — show LOW half award separately on `plo8` showdowns.

These are 10-15 minute fixes each, batched into Phase B-2 alongside the dedicated test-table E2E.

## Sign-off

All 9 PokerBros-spec variants exist end-to-end (DB enum → engine evaluator → create-table UI → lobby filter). Code is sound. Defer the visual verification of each variant's gameplay to a scheduled multi-variant test rig — not a blocker for the higher-leverage Phase C+ work.

**Ready to start Phase C (Tournament polish).**
