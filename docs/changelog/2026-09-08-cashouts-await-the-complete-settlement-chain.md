# Cashouts Await The Complete Settlement Chain

A voluntary or forced between-hand leave captured postHandTasksPromise once.
Settlement could replace that promise with a longer chain while leave was waiting.
Once the original promise resolved, cashout proceeded while the appended stack
or bank task was still running. The existing dealing loop already re-read this
barrier; the leave path did not.

The shared leave path now re-reads the barrier after each await and proceeds only
when the same chain has settled. It does not clear the dealing loop's barrier.
A rejected barrier propagates instead of being swallowed as permission to cash out.
No table status, clock policy, watcher or reconciler is added.

Both forced and voluntary races were reproduced against the old implementation.
The fix has four focused behavior cases: both extended-chain waits and both
rejected-chain cases, alongside the eleven existing leave behavior cases.

This fixes barrier reassignment only. It does not establish crash durability or
turn a resolved barrier whose caller discarded a failed payment into a successful
financial receipt. The broader complete cash-hand candidate remains separate.
