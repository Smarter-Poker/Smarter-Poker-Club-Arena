DECISION: BBJ requires 3+ players dealt in (not 4)
DATE: 2026-03-29
PHASE: Step 6 — PORT ADVANCED
FIX: 145

RATIONALE: Dan stated "you need 3 or more players to qualify for BBJ.
So no BBJ rake if there are not 3 or more players dealt into a table."

Also: BBJ fee is determined by stakes, not player count. Player count only
matters for the ELIGIBILITY threshold (minimum 3 dealt in).

IMPLEMENTATION:

- File: server/src/config/RakeConfig.ts
- Constant: BBJ_RULES.minPlayersDealt = 3
- Previous value: 4 (wrong)
