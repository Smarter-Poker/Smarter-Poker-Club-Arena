# A busted chair reoccupied by a receipted arrival is movement evidence (2026-09-28)

## What was frozen

494355f1 "Midday Free Buy (NLH)" has dealt nothing since 2026-09-27 17:07 UTC:
three players, one each on tables 6b0f0319, 4ef30976 and bf3cb28d. bf3cb28d is
the source of break fa83dca8 (begun, one of two members moved, no movement
admission ever recorded, origin generation dead). The engine re-admitted it
every ~15 seconds and was refused every time:

    [Tournament.table_engine_readmission_failed] Error:
      f06_movement_admission_unproven [55000]: F06_MOVEMENT_SEAT_CHANGED

## The line that refused

`fn_f06_admit_parked_movement` takes a fresh proof for a begun break from
`smarter_private.f06_movement_prior`. In the proven hand (15899962,
16:20:47.94) 5562bf52 busted from seat row 09b96342. At 16:23:18.91 move
receipt 44efe985 moved c0129701 INTO that same seat row (table_seats reuses a
row for its next occupant). The prior looked the bust up as
`table_seats WHERE id = 09b96342 AND user_id = 5562bf52`, found the row now
carrying c0129701, and raised F06_MOVEMENT_SEAT_CHANGED, although it had
already admitted c0129701 as a receipted arrival and every chip was accounted
for (478,051 moved by a winner receipt, 353,508 on the chair by a move receipt,
0 on the bust).

## The fix

`20260928165716_a_busted_chair_reoccupied_by_a_receipted_arrival_is_movement.sql`
adds one branch to the prior. A zero-stack hand item with no purchase whose
chair row no longer carries it is admitted only when the row is open on this
table and held by a different user who sat after the proven hand through a
committed move receipt of this event into exactly that row and seat number
(moved_at = joined_at), and the busted registration is eliminated with 0 chips
on this table, recorded between the proven hand and the arrival, with no open
seat anywhere in the event. It enters neither the roster nor `eliminated`; it
is recorded as `receipts.reoccupied`, only when present, so every other proof
is byte-identical. Anything else on that path still refuses. Pre-image and
post-image digests are asserted, and removing the three stated passages must
reproduce the pre-image digest.

## Proved

The post-image body installed as a `pg_temp` function inside a psql
transaction that ended in ROLLBACK returned, for 494355f1 / bf3cb28d, a proof
with roster 373a7bc7 (winner receipt 984c0f24) and c0129701 (arrival),
`eliminated` empty and `receipts.reoccupied` naming 5562bf52 via move receipt
44efe985, bound to break fa83dca8.

## Pinned

`tests/a-busted-chair-reoccupied-by-a-receipted-arrival-is-movement-evidence.law.test.ts`
(`docs/laws.d/a-busted-chair-reoccupied-by-a-receipted-arrival-is-movement-evidence.md`).

## Not proven before install

The admission itself (custody claim, insert, `f06_assert_movement`) and the
successor finishing c0129701's active attempt run only after install. The same
successor path finished f261112e's begun break 7c37cf14 (active attempt from a
dead origin generation) on 2026-09-28 at about 16:44 UTC once its admission
existed.
