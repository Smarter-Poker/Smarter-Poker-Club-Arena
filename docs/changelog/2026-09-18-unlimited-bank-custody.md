# Unlimited time-bank state survives repeated restarts

The first startup preserved a parked bank until the authoritative seat roster
arrived, but `applyParkedTimeBanks` omitted `unlimitedActivations` from the
accounting metadata. The next checkpoint serialized that incomplete metadata,
so the following engine restored a finite bank. A read-only live comparison
on September 18 at 07:05 UTC found the flag absent from 368 previously flagged
banks with unchanged occupancies.

Restore the saved explicit unlimited flag alongside the existing initial,
base and consumed seconds. Occupancy, completed-hand identity, finite balances,
activation limits and authoritative entitlement revalidation are unchanged.
No database migration or production balance write is required.

The existing `ParkedTimeBank.test.ts` now drives two real startup, roster adoption
and checkpoint cycles and compares every saved bank field. A depleted finite
bank is the negative control. The unlimited case fails before the repair and
passes afterward. The existing required server test shards run this file.

Previously omitted flags are not reconstructed from historical membership.
The existing player activation path reads current account allowance before
refusing a depleted bank; its authoritative v2 response can restore the current
Lifetime entitlement. Historical uncaptured numeric bank losses are not claimed
recovered by this metadata repair. Protected delivery and live proof are recorded
separately in the task's existing completion checkpoint.
