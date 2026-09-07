# Channel Reconnect Sends Current State Once

Channel subscriptions were recorded in desired state and also queued offline.
Reconnect replayed desired state, then flushed every historical queued JOIN,
LEAVE and presence update. Initial connection flushed the history instead of
its net result. Reproductions sent 100 identical lobby joins on initial open,
and 41 identical tournament joins after a reconnect. The channel server limits
clients to 30 messages per second, so duplicates can trigger their own closure.

Keep subscription and presence intent in desired state only while offline.
Every fresh connection replays that state once. The bounded queue remains for
transient requests such as hand replay, preserving their order and delivery.
A room joined and left before connection no longer creates needless server
work. Periodic subscription reassertion still heals silent subscription loss.
No extra physical socket or retry loop was added.

Three regressions failed before the change: repeated offline joins, cancelled
initial room subscriptions, and replay-plus-queue duplicates on reconnect.
Existing recovery tests continue to cover desired state, presence, heartbeat,
wake recovery, and missing snapshots. Live browser verification remains needed.
