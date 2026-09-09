# tests/only-a-user-budget-refuses.law.test.ts

Ruling 21 (Dan, 2026-09-08): a platform-wide budget never refuses a player, only
a per-user one does. A shared monthly pot refuses whoever arrives last for what
everybody else earned. The per-engine pot is retired as a gate and its rule row
deleted - it would have refused every daily-mission award from 2026-09-14, at 4.2x
its line - and award_diamonds_v2 no longer refuses with budget_exhausted nor
silently truncates an award to whatever the shared pot has left. Every per-user
cap survives, including the daily caps, their 2026-09-14 flip and the per-user
monthly allowance; both budget columns are labelled a forecast so nobody re-arms
them.
