# Isolate and retain winner-read evidence

Before: `HorseMind.runInSandbox` swaps its statistics, pair, plan and exploit
maps, but `HorseWinnerRead` owns separate global maps. An isolated decision
therefore inherits live winner history and synthetic observations mutate that
history. `snapshotDecisionReads`/the private codec omit that consumed input,
so a deep decision or replay can read a different winner history from FAST.
Three new regression fixtures reproduce all three failures on the original code.

Change: include winner state in the synchronous sandbox boundary and snapshot
only the decision's bounded actor rows. A new private read-frame version retains
that exact evidence. Older frame bytes remain decodable and re-encodable;
missing historical winner evidence does not establish historical completeness.
No cards, shared intended actions or public/client payloads are added.

This is a prerequisite to independent observer memory, not a claim that current
floor-wide live learning is already observer-scoped. All protected strategy
selectors and the 62 retired accounts remain unchanged. New qualification must
bind this source before any strategy promotion.

Verified: original three fixtures fail before repair; 622 connected tests pass
afterward, including malformed/private-frame bounds, exception/reset isolation,
FAST/DEEP journal and historical codec/plan compatibility. Another 51 source-digest
and authority tests pass: consumed winner sources are already hashed, and changed
source cannot reuse old qualifications. Root/server TypeScript and the source-window
guard pass. Source reread; normal hooks, protected checks, merge and live proof
remain pending. Engine delivery uses ordinary daily maintenance.
