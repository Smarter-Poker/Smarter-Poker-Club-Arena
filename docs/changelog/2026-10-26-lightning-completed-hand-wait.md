# A Completed Lightning Hand Shows The Next-Hand Wait

A winner could finish a Lightning hand and remain on a silent felt while the pool matched another hand. The retained snapshot still carried its completed hand ID, so the next-hand notice treated it as playing even after the result animation finished.

The notice now follows the existing hand-bound completion latch. It starts its normal quiet interval after the full award hold, and keeps its full fade when the next hand arrives. No new timer, polling or engine contract is introduced.

Two focused regressions failed before the correction; all 33 existing between-hand-screen checks passed afterward. The live KingFish session continued to later hands; this change fixes the missing wait presentation and does not claim to change matchmaking timing.
