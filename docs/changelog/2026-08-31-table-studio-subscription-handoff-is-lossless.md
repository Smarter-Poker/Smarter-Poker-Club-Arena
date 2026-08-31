# Table Studio Subscription Handoff Is Lossless

## What Changed

- Table Studio no longer reports `Table Art Live` during the first render,
  before its entitlement channel has actually subscribed.
- A successful entitlement subscription now triggers an authoritative
  ownership reconciliation read before the Studio leaves its linking state.
- Ownership snapshots merge with INSERT events received while the read is in
  flight, so neither side of the SELECT-to-subscribe handoff can overwrite the
  other.
- The asset grid now exposes its ownership and pricing reconciliation through
  `aria-busy`, rather than advertising a settled catalog while paid locks are
  still undecided.

## Why

The production 60-SKU certification proved checkout, charging and entitlement
delivery, but an already-open second mobile device could miss purchases that
committed between its initial ownership SELECT and the Realtime `SUBSCRIBED`
acknowledgement. The database contained every entitlement while that browser
continued to show stale locks. The post-subscription snapshot closes that gap,
and merge semantics preserve any events arriving during the snapshot itself.

## Real-Time Law

Server-authored `theme_asset_unlocks` INSERT events remain the live source of
truth. The new post-subscription SELECT is a bounded reconciliation step for
the connection handoff; it does not poll and it does not invent ownership.
