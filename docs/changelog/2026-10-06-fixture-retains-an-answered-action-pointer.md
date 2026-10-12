# Fixture actors retain the witnessed answered pointer

A real isolated six-player SNG published its accepted all-in action and zero-stack
player delta before advancing the current-player pointer and turn clock. The
maintained actor required every pointer to remain actionable and incorrectly
failed that intermediate state. Fold publication has the same boundary.

The actor now accepts that inactive pointer only on the unchanged original hand,
player and clock, with its preceding actual same-player all-in or fold event.
The first inactive transition must immediately follow the state baseline recorded
with that event. A reconnect grace clock can publish alongside the action only
when it advances within the actual event timestamp; later metadata cannot invent
a new clock or reuse an unrelated action.
Numeric state, roster, patch sequence, unknown events and initial snapshots still
fail closed. It never submits an action for an inactive player, and the original
spent-clock/context guard remains. Subsequent deltas on that same witnessed
pointer remain observable until the next real turn.

Both native connected regressions failed before the source correction. They
verify no duplicate decision on the retained pointer and a decision only after
the next player's real clock. The full maintained boundary suite runs in the
existing component fixture workflow. This is harness repair and does not certify
tournament payout, capacity or the whole launch.
