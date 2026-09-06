# server/src/engine/TheDrainWaitsForTheMoney.law.test.ts

A stopping engine is not a drained one while `postHandTasks` is still writing, and the settlement barrier reports the condition that actually ended its wait. `drainHands` counted `!isRunning()` as parked and exited on in-flight settlement at :55 every hour; the barrier reported every shutdown as "exceeded 300s" while carrying `waitedMs: 30000` (fifteen criticals, three shutdowns, 2026-09-06).
