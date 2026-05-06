PROBLEM: Sit-out during active hand caused immediate auto-fold
FIX: 143
DATE: 2026-03-29
SPEC: Bible V8 §7.12

SYMPTOM: Player clicks "sit out" mid-hand → DisconnectEngine marks them
sitting out immediately → when their turn comes, handleTurnChange() calls
onPlayerTurn() which sees isSittingOut=true → auto-folds their hand.

ROOT CAUSE: sitOut() in ServerTableEngine called disconnectEngine.sitOut()
immediately regardless of whether a hand was active.

SOLUTION: Added pendingSitOut Set<string>. During active hand (handController !== null),
sit-out requests are queued. In postHandTasks(), deferred sit-outs are applied.
Also added isSittingOut() filter to dealingLoop() so sitting-out players
aren't dealt into the next hand.

FILES CHANGED:

- server/src/engine/ServerTableEngine.ts (4 locations)
