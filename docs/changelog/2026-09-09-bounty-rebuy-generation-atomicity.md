# 2026-09-09 — bounty rebuy generation atomicity

## Fixed

- A bounty player choosing Rebuy inside the open decision window could not
  complete the purchase because the rebuy path required the old head to be
  settled while the bounty path waited for the same decision window to close.
- The sole rebuy transaction now settles the accepted hand's exact standard,
  PKO, or mystery-bounty generation and clears that snapshotted head before it
  debits or creates the replacement generation.
- A refused payout, missing completion marker, depleted mystery inventory,
  insufficient balance, or failed seat assignment rolls the entire operation
  back. No watcher, reconciler, repair job, or alternate money door was added.

## Verification

- A disposable PostgreSQL 17 rehearsal proved standard bounty, PKO, and mystery
  bounty rebuys pay the old generation once, replay the same receipt, and leave
  exactly one funded replacement head.
- Corrupted accepted-hand evidence and an injected final-receipt failure rolled
  back payout, wallet, head, seat, candidate, wake, and receipt writes.
- Focused tournament suites passed 90 tests, including the new source laws.

## Release boundary

This records implementation evidence. Merge, production migration application,
engine adoption, and post-deploy verification remain separate release gates.
