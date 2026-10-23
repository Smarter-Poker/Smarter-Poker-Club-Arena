# tests/a-short-all-in-never-offers-a-raise.law.test.tsx

Dan 2026-10-22: when a player cannot raise and can only call, the action bar offers Fold and Call only. A short all-in that does not reopen the betting (TDA 44/47, `HandController.canReopenBetting`) removes both Raise and an all-in past the call; the bar draws no disabled Raise button and closes an open sizing slider. The client rule lives in `src/lib/raiseReopen.ts` and both TablePage wager gates read it.
