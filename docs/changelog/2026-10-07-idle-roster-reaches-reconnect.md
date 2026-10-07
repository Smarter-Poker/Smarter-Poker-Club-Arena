# Idle roster adoption reaches reconnecting players

After the last funded chairs left an idle cash table, native seating and GET /state were empty while a new WebSocket subscription still received the previous two-player snapshot. This was reproduced without purchases or actions on 24 isolated tables using the current official a9731e71 runtime. The earlier load admission refusal that reported more than two wire players remains separately unqualified because its first wire frame was not retained.

The existing short-handed dealing boundary now publishes its freshly adopted roster after pending seat moves and the current-generation guard. This uses the existing public idle projection and TableStateHub sequence/delta/no-op behavior. No new poller, action authority, financial path, lifecycle timeout or maintenance boundary is added.

The regression uses the real dealing loop, public projection and hub with isolated native-reader fixtures. It replaces departed players with zero or one current chair, checks connected strict deltas and late-subscription snapshots, clears old action clocks, and verifies unchanged second-boundary sequence suppression. Both new cases failed against the original engine and passed after the fix; affected idle add-on, dealing-halt and cash reentry checks pass. Production behavior remains pending protected delivery and certified engine activation.
