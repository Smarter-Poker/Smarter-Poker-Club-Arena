# A slow seal read does not fail a release (2026-10-02)

Three engine releases on 2026-10-02 failed with
`recovery announcement reservation could not be established`
(runs 37009478601, 37025137053, 37025705796).

## Cause

`engine-release-seal.py reserve-recovery-window` looked for an unshipped failed
ancestor by asking git twice per failed release receipt. The engine host holds
277 failed receipts, every one already shipped, so every call walked all of them:
554 `git merge-base` processes, measured at 12.2s on a quiet host and 18.9s at
load 9.5. The transaction bounds the call at 15s, and the timeout was fatal.

## Change

- The seal reads `git rev-list <highWater>..<target>` once and checks each failed
  receipt's commit against that set. Same rule (ancestor of the target, not of the
  high-water), one git process. A failed commit git does not know is simply not in
  the range instead of aborting the reservation.
- A reservation that still fails is not fatal: nothing was announced, so the
  release defers and waits for the scheduled break, like a rate-limited one.
