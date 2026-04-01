DECISION: Rake credit is ALWAYS equal share — NEVER weighted
DATE: 2026-03-29
PHASE: Step 6 — PORT ADVANCED
FIX: 144

RATIONALE: Dan explicitly stated multiple times that rakeback credit must be
equal share among all dealt-in players. The rake is taken from the POT (not
per person), and each dealt-in player gets credited with totalRake / playerCount.
This is NEVER weighted by pot contribution under ANY circumstances.

This is the KEY element for determining weekly player and agent earnings.

IMPLEMENTATION:
- File: server/src/engine/RakebackEngine.ts
- Method: recordHandRake()
- Formula: equalShare = Math.round((totalRake / playerCount) * 100) / 100
- Filter: All entries in contributions map with invested >= 0

PREVIOUS (WRONG): (potContribution / totalPotContributions) * totalRake (weighted)
CORRECT: totalRake / playerCount (equal share)
