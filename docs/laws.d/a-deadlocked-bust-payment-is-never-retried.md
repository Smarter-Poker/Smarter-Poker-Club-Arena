# tests/a-deadlocked-bust-payment-is-never-retried.law.test.ts
The deferred bust payer never retries a deadlock (40P01): a retry re-closes the same cycle and only delays the hand commit; only lock timeouts and serialization failures retry, at most four times.
