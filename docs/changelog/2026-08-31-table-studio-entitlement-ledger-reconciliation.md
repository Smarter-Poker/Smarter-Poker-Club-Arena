# 2026-08-31 — Table Studio treats Realtime as a signal, not the ownership ledger

## What production proved

The production commerce certificate bought every one of the 60 sellable Table
Studio designs. Server truth was correct: the buyer held exactly 60 receipts and
65 category entitlements, and both the purchase observer and bundle probe stayed
account-scoped. One already-open second device nevertheless still displayed all
seven paid Looks as locked.

The earlier SELECT-to-SUBSCRIBE handoff fix closed the opening race, but it did
not make a websocket a durable queue. A burst of preset purchases can insert six
entitlement rows per transaction, and a mobile tab can miss frames during radio
handoff, sleep/wake, or backpressure. The old refresh effect also cleared every
verified entitlement whenever a theme event requested a new snapshot, briefly
re-locking paid designs while the read was in flight.

## What changed

- Ownership is cleared only when the Studio opens for a different account, not
  during background reconciliation.
- Every received entitlement event still unlocks its exact tile immediately,
  then coalesces the burst into one authoritative ledger read after 250 ms.
- While an authenticated Studio is open and visible, a two-second safety read
  repairs the case where the entire Realtime burst was missed. The safety read
  also runs immediately when the browser comes online or regains focus.
- Background reads merge into verified ownership without changing the Studio
  back to a loading state, so a paid design never flashes locked during repair.
- Hidden tabs pause the fallback cadence; closing the Studio removes every
  timer and browser listener.

Realtime remains the immediate path. `theme_asset_unlocks` remains the durable
ownership truth.

## Regression coverage

The real component now proves all three failure boundaries:

1. a delivered cross-device entitlement unlocks in the same render;
2. a dropped row is recovered from the authoritative snapshot after another
   event wakes the reconciliation; and
3. a tab that missed the entire burst recovers on the bounded safety cadence,
   without re-locking already verified designs while its read is pending.
