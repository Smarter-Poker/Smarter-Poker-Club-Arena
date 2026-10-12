# server/src/tournament/anIoBoundSweepIsNotRationedLikeACpuBoundOne.law.test.ts

The elimination scheduler is sized for round-trip-bound sweeps: twelve general slots and four decided-lane slots by default, still a hard ceiling, so a backlog drains at cap / latency instead of four at a time (2026-10-03).
