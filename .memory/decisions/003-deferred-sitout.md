DECISION: Sit-out during active hand must be deferred until hand completes
DATE: 2026-03-29
PHASE: Step 6 — PORT ADVANCED
FIX: 143
SPEC: Bible V8 §7.12

RATIONALE: A player who clicks "sit out" during an active hand cannot be
immediately marked as sitting out, because that would cause auto-fold when
their turn comes (via DisconnectEngine.onPlayerTurn()). Bible V8 §7.12 says
"Player sits out during a hand (can't fold mid-hand, wait until next hand)."

IMPLEMENTATION:

- File: server/src/engine/ServerTableEngine.ts
- Added: pendingSitOut: Set<string> instance variable
- Modified: sitOut() — queues to pendingSitOut during active hand
- Modified: postHandTasks() — processes deferred sit-outs after hand
- Modified: dealingLoop() — excludes sitting-out players from next deal
