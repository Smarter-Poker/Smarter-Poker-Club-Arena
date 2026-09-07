# Winner prize animation lifecycle

The prize counter cancelled only its initial requestAnimationFrame ID. After the first callback scheduled another frame, cleanup left that work running. The actual original effect reproduced a queued second frame after cleanup.

The effect now owns the latest frame ID, cancels it on cleanup and ignores any callback already queued when cleanup occurs. It also stops when isWinner becomes false while still mounted and resets its displayed value when a new prize animation starts. The existing duration, easing, winner presentation and payout amounts remain unchanged.

Executed the actual effect body against manual frame queues for unmount cleanup, stale callback, hidden/dismissed state, replacement prize and exact terminal value. Added React component tests for the mounted lifecycle, dismissal and replacement. Full component CI and real-device animation verification are separate gates. No financial write occurs.
