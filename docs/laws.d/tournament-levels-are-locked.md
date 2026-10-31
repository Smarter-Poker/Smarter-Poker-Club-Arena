# server/src/tournament/TournamentLevelsAreLocked.law.test.ts

Dan 2026-10-21: tournament levels are never a range. Every MTT and satellite level runs one fixed clock: freerolls and turbos 5 minutes, standard and bounty 8, deep stack 10. Spins and Sit & Gos are excluded. The engine rule and the database trigger tournaments_lock_level_clock are the same rule.

Owner October 31: the ten-minute deep clock requires is_pinned (highlighted); ordinary deep events are eight minutes. Faster turbo/freeroll clocks are preserved.

The global ceiling also caps oversized custom Spin/SNG levels while preserving their faster per-level clocks; the old exclusion applies only to uniform MTT clock selection.
