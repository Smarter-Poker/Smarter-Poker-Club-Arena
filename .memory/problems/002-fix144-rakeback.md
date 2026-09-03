PROBLEM: Rakeback was weighted by pot contribution instead of equal share
FIX: 144
DATE: 2026-03-29

SYMPTOM: Players who put more chips in the pot got more rakeback credit.
This is WRONG — Dan explicitly stated it must be equal share.

ROOT CAUSE: RakebackEngine.recordHandRake() calculated per-player share as
(potContribution / totalPotContributions) \* totalRake — weighted by investment.

SOLUTION: Changed to totalRake / playerCount — each dealt-in player gets
an equal share regardless of how much they put in the pot.

FILES CHANGED:

- server/src/engine/RakebackEngine.ts (recordHandRake method + header comment)
