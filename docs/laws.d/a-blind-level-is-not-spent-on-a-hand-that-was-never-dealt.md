# tests/a-blind-level-is-not-spent-on-a-hand-that-was-never-dealt.law.test.ts

`advanceBlindLevel` already refused to spend a level during a break and during
the maintenance freeze, because a blind level is a wall-clock deadline a player
loses to (CLAUDE.md 13 invariant 4). It did not refuse while the tournament's
own tables were dealing nothing, so the level clock - a local setTimeout chain
that keeps perfect time with every table under it dead - climbed the blinds
against stacks that could not act. Measured on production 2026-09-23: twelve
RUNNING events had run past their own last dealt hand, and Evening Mystery
Bounty (PLO5) went from two players holding 7.5 big blinds each to 0.03 big
blinds each, less than a quarter of one ante. This pins the third guard: the
level is owed, not spent, and goes up the instant the tournament deals again.
It also pins the witness being recorded for every hand rather than only
eliminations, and seeded to zero rather than `Date.now()` so an adopted manager
cannot inherit a clean witness and burn the level it was adopted to rescue.
