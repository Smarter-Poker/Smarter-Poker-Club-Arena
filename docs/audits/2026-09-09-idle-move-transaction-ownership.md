# Idle Seat Move Transaction Ownership

Status: local implementation verified, publication pending.

The dealing loop previously raced an idle move against a step timer. The timer did not cancel the database operation, allowing the loop to resume while that operation remained active. Both startup waiting and normal idle dealing now call executeIdleSeatMoves, which acquires the existing seat boundary, rechecks engine authority, and joins the raw transaction and its budget before releasing ownership. The settlement caller remains within its existing awaited seats lane and does not acquire the boundary, avoiding a dependency cycle with a departure awaiting settlement.

Verification: 17 tests passed across IdleSeatMoveOwnership, PendingAddOnIdleSweep and CashDepartureReadOverlap. The new behavioral cases prove an elapsed budget cannot release a queued departure, a failed transaction releases ownership with its original error, a queued retired engine starts no move, and a successful operation returns its actual result. Existing idle add-on and departure-read tests remain green.

Pending: combined regression gates and live adoption. Distributed engine replacement and crash recovery remain Phase 3 work.
