# Single-Board Cash Hands Stay With The Variant Brain Where It Beats The Joint Owner

**Date:** 2026-10-15
**Area:** Horse Brain Phase 13 (`server/src/engine/multiway/JointActionModel.ts`, `JointLivePolicy.ts`)

## What The Matrices Showed

The locked P13.2 strength matrices measure the Phase 13 joint owner against the current brain, cell by cell.
Every measured variant wins on two and three boards. On one board it does not, except PLO8:

| Variant | Source   | 1 board                 | 2 boards | 3 boards |
| ------- | -------- | ----------------------- | -------- | -------- |
| PLO8    | c84a2bcf | +12.35 [+10.51, +14.19] | +154.1   | +217.5   |
| PLO4    | c84a2bcf | -1.72 [-2.85, -0.60]    | +44.4    | +94.4    |
| NLH     | 1235b47a | -9.19 [-9.84, -8.54]    | +13.7    | +82.8    |

(bb/100 after rake, 99% intervals.) On one board the PLO4 brain is the qualified Phase 10 pack and the NLH brain is the
reference strategy, and both beat the joint owner. Dan's rule is that a strategy is switched on only where it beats the
current brain, so PLO4 could not be selected and NLH failed its gate on the single-board bomb pot and the blinds.

## The Change

For a variant in `JOINT_SELECTION_RULE.singleBoardCashKeepsVariantBrain` (now `['nlh', 'plo4']`), a single-board cash
decision keeps the variant brain's decision: `jointSelectedRow` selects the baseline row there, while the candidates
are still priced and recorded in the receipt. A variant is listed when its own matrix shows a single-board cash loss,
and stays listed until a later matrix shows it winning there. Every other variant, every multi-board hand and every
tournament decision is unchanged. The remaining variants' single-board cells are read the same way when their
matrices on the new source come back.

## What Follows

The change is in the Phase 13 policy source files, so every Phase 13 policy digest changes and every variant is
requalified on the new source: strength league, predeclared natural completion window, then selection.
