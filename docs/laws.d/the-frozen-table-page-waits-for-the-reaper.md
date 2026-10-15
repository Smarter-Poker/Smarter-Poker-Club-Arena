# tests/the-frozen-table-page-waits-for-the-reaper.law.test.ts

PokerTablesFrozen is a critical owner page that means the engine's recovery chain did not recover a table. It must fire at least a minute after the 180-second zombie reaper (stall threshold plus `for:` measured against the two thresholds in `server/src/GameServer.ts`) and no later than five minutes, and the runbook must state the same rule. With `for: 1m` it fired at 180 seconds, the reaper's own moment, and paged six recoveries on 2026-10-15.
