# A voided Lightning hand gives back its blind stamps (2026-10-24)

## What Dan asked

"NEW PLAYERS SHOULD ALWAYS BE BB FIRST." (2026-10-24)

## What was wrong

The live matcher (`fn_lightning_match_plan`, 20261024195059) treats a pool
slot as a newcomer while `lightning_pool_slot.last_bb_at IS NULL`, and orders
the big blinds by that same column. `fn_lightning_form_hand` stamps
`last_bb_at`, `last_sb_at`, `last_button_at`, `hands_since_bb` and
`hands_since_sb` when a hand FORMS.

A formed hand can be voided before it is dealt (begin_dealing refused,
deal_failed, host_lease_not_held, the reaper, a drain). 20261007222717 already
gave such a hand's blind-ledger counts back, but not the pool-slot stamps, so:

- the voided hand's big blind was recorded as having had the big blind without
  posting one, and dropped to the back of the rotation;
- a newcomer in that seat stopped being a newcomer, so their first real hand
  could be the small blind.

Measured in production: 24 Lightning hands voided before dealing in the
24 hours to 23:15 UTC (26 in seven days).

## The fix

Migration `20261024231549_lightning_voided_hand_returns_its_blind_stamps.sql`
adds one block to `fn_lightning_instance_releases_its_reservations`, the
trigger every abandon path crosses exactly once, as an md5-guarded text
replacement of the live definition. For a hand abandoned before dealing, every
slot's stamps are recomputed from its own dealt hands, excluding the voided
one; a slot with no dealt big blind is a newcomer again. Everyone else's
hands-since counters, which formation incremented, are decremented.

No slot of a voided hand can have been formed into a later hand before the
void (its committed reservation bars it), so the restored stamps are exactly
the pre-formation values. No money, seat or ledger row is written. No horse
distinction.

## Proof

- A self-aborting probe on production (one `DO` block ending in
  `RAISE EXCEPTION`) ran the block's UPDATE against the most recent voided
  hand: it compiled, ran in milliseconds on the indexed
  `lightning_hand_player_by_pool_slot`, excluded the voided hand and picked
  each slot's latest dealt stamp.
- `tests/a-voided-lightning-hand-gives-back-its-blind-stamps.law.test.ts`
  pins the guard, the trigger condition, all five stamps and the dealt-hands
  history.

## Delivery

A function replacement only; it takes no lock on a live table, so it installs
through the normal Apply Merged Migration path on merge (outside the :50-:03
UTC DDL window). No engine change.
