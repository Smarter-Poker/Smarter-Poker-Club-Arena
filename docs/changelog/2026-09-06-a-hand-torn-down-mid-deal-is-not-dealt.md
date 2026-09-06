# A hand torn down mid-deal is not dealt (2026-09-06)

Engine log, 09:30 to 12:30 CDT, four times:

    [ServerTableEnginethistableId.Error_attempt_thisconsecutiveE]
    TypeError: Cannot read properties of null (reading 'onEvent')
        at ServerTableEngineDealing.js:2363
        at ServerTableEngine.dealHand (ServerTableEngineDealing.js:2299)
        at ServerTableEngine.dealingLoop

`dealHand` constructs the `HandController`, then awaits exactly one RPC
(`fetchTimeBankExtras`, the VIP time-bank allowance), then registers its
HAND_COMPLETE listener with `this.handController!.onEvent(...)` and starts
the hand. `stop()` and `killForRestart()` both set `this.handController =
null`. When either runs inside that await - a table the cluster controller
has just broken or closed, an engine superseded by its replacement, the :55
cut-over - the `!` dereferences null. Every occurrence today lined up with a
`table_break_started` row.

Nothing was dealt: `start()` is inside the promise, after the listener. The
harm was a stack trace with a misleading name, one wasted attempt on the
dealing loop's retry ladder, and, had the guard been a line lower, a stopped
engine arming timers and writing a snapshot for a table its successor owns.

The fix is a re-read after the await: no controller or not running, log one
line and return. `aHandTornDownMidDealIsNotDealt.test.ts` pins the guard by
position (after the await, before the listener) and pins that there is only
one await in that span, so a second one cannot be added without the same
question being asked again.
