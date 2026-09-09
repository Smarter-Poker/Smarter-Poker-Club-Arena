# Spin Expiry Rechecks The Board It Cancels

An unfilled-Spin candidate could fill or start before the expiry sweep obtained its cancellation lock. The installed functions reproduced cancellation of a RUNNING game under concurrent transactions.

The sweep now acquires the candidate parent without waiting on active work, then re-reads seats, start state, waiting time and draw evidence before invoking the same refunding cancellation function. The configured timeout and refund policy are unchanged.

Validation: 21 isolated PostgreSQL 17 checks using canonical installed function hashes; 68 client law/invariant checks. Production migration and body/role verification passed. The fixture proves control flow, not financial refund conservation. No production cancellation or historical financial repair was used as a test.
