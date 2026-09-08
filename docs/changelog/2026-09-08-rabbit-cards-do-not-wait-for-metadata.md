# Paid Rabbit Hunt cards do not wait for metadata

The engine awaited a second database request after the purchase succeeded.
A stalled metadata insert therefore kept a paid reveal loading, even though
the charge and its durable purchase receipt had already committed. The
metadata-only insert now starts immediately with error reporting, but does
not hold the HTTP response or join the next-hand settlement barrier.

Payment remains awaited. Eligibility, private cards, in-flight billing
protection and the revealed-hand cache retain their existing gates. This
change does not shorten the Rabbit Hunt opportunity window or skip money
settlement. An engine exit can interrupt the supplemental metadata write;
the atomic purchase receipt remains the payment record.

A behavioral regression failed against the previous implementation and now
proves that cards return while metadata remains pending, with no repeat
charge. Returned errors, rejected promises and synchronous metadata failures
are also covered. All 24 reveal behavior tests pass and server typechecking
passes. The roughly twelve-second overall hand gap remains unresolved;
this fixes the additional metadata wait on an actual Rabbit Hunt purchase.
