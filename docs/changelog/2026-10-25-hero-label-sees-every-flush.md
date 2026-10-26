# 2026-10-25 - The hero's hand label sees every flush

## What Dan reported

A player on a Kings Club / Midway Union PLO5 table (hand #48003911) held
Ks Kc Qs Jc 3d on an 8d 9c 8c Tc board. The label under his seat said
"Straight". He had a king-high flush (Kc Jc with 9c 8c Tc). Dan: "IT MUST 100%
OF THE TIME DISPLAY THE BEST CURRENT HAND THAT THE USER HAS."

## Cause

The label comes from `bestFive` in `src/utils/handEvaluator.ts`. The hero's
hole cards reach the table through `table_hole_cards` and `ENGINE_SUIT_MAP`,
which spell suits as letters (`c`). The board goes through `normalizeCards`,
which spells them as words (`clubs`). `scoreFive` decided a flush with
`suits.every(s => s === suits[0])`, comparing the spelling, so no five-card
combination mixing a hole card with a board card could ever be a flush. Every
Omaha flush, every Hold'em flush that was not five on the board, and every
straight flush or royal built with a hole card was named as the next best
hand instead. Straights were unaffected because ranks were already folded.

## Fix

`scoreFive` now reads each suit through `suitOf`, which folds letters, words
and suit symbols to one value, and the rank table accepts `10` as well as
`T`. The fix is in the evaluator itself, so every caller (the seat label, the
previous-hand rundown, the jackpot board, hand replay) is covered, not only
the one path that was reported. Display only; the engine decides pots with its
own evaluator and was never affected.

## Pinned by

`tests/unit/heroLabelNamesTheBestHand.test.ts` feeds the evaluator cards in
the exact two shapes the table uses, including the reported hand. Three of its
four cases fail on the previous evaluator.
