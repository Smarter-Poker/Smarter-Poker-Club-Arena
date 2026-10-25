# A parked table never freezes on an unproven move

Owner rule: tournaments always heal themselves and finish. They never freeze and are never cancelled, and no sweep or repair cron does it for them.

## The incident (2026-10-24, from the rows)

Event 12135e5b "Union PKO Afternoon (PLO4)", Table 13 (3e3d1587):

- 19:53:26: TylerRVA (fb825ba4) busted on Table 16 (da33eedb).
- 19:53:30.71: he rebought. `process_tournament_rebuy` -> `fn_ca_choose_tournament_seat_locked` seated him on Table 13 at 19:53:30.74. At that moment Table 13's hand 46740543 was in flight (started 19:53:07.16, sealed 19:53:40.14), so the sealed hand never dealt his chair.
- 19:53:41.56: balancing parked Table 13 (break 5135b05b).
- Every movement admission after that refused `F06_MOVEMENT_WHOLE_ROSTER_REQUIRED` (`smarter_private.f06_movement_prior`). The table dealt nothing for 3h46m, until migration 20261024211825 (#7940) taught the proof this one arrival shape.

That was the fifth patch of this kind since 09-29: the changelogs of 09-29, two of 10-02, 10-16 and 10-24. Each one taught the proof one more arrival shape.

## Two causes, both fixed at the root

**1. A refused movement proof had no exit.** After `prepareParkedTournamentBreak` failed, `withdrawUnplaceablePark` only withdrew a park whose last refusal started with `destinations_full:`, through `fn_f06_withdraw_unplaceable_park`. Any other refusal left the table parked indefinitely. `continueAbandonedNoStartPark` only covers the event's last open table.

**2. A rebuy could be seated under a hand in flight.** The chooser ranked tables by free chairs only, so it seated rebuys onto tables mid-hand. That leaves a chair the next sealed hand never dealt, which is exactly the shape the proof kept having to learn. I measured it on 2026-10-25 over 600 seated rebuys in the last 6 hours: 62 were seated onto a table mid-hand, and in every one of those cases another table of the event was between hands at that moment.

## The fix

Migration `20261025052423_a_parked_table_never_freezes_on_an_unproven_move.sql` is one BEGIN/COMMIT with `lock_timeout` set and md5 pre-image guards on every body it reads.

- **`fn_f06_withdraw_unproven_movement_park`** is a new sibling door. Its body is the live withdrawal door's body (md5 8560ec3a) with four stated edits:
  1. The capacity block is removed, because this door is not about seats.
  2. `f06_movement_prior` is asked inside a sub-block. If the proof succeeds, the door refuses (`F06_WITHDRAWAL_MOVEMENT_PROVEN`) and the break can go on. Only a refusal with SQLSTATE 55000 and a message starting `F06_MOVEMENT_` admits the withdrawal. Every other error is re-raised.
  3. The receipt kind is `unproven_movement_park_withdrawal`, and the receipt records the proof's refusal.
  4. The answer's state is `withdrawn_unproven_movement`.

  Every other guard is the withdrawal door's own: the live lease lane, replay by break_id, the platform freeze, the exact pre-manifest park held by its caller, the positive witness, no reserved permit, a RUNNING event, an open source, the last-table rule, the full seat/registration roster check, and no trace of any hand after the witness. Credit is 0 and nothing moves. The SECURITY DEFINER settings, owner and grants (service_role only) match the original door.

- **The chooser** now ranks a table whose hand permit is `reserved` (a hand in flight) after every table between hands. This key sits behind the existing break-in-progress key and before the free-chair count. It is a ranking, never an exclusion: when every table is mid-hand, the chooser picks exactly as before.

I chose to fix the chooser rather than add a sixth arrival shape to the proof. Changing the chooser removes the undealt chair at its source. Admitting a chair taken by an immutable purchase receipt would mean teaching the proof yet another shape, and the proof would stay exactly as fragile.

Engine (`server/src/tournament/TournamentManager.ts`, `tournamentTableBreakRpc.ts`):

- `startParkedMovementEngine` names a movement refusal on its break as `movement_unproven:F06_MOVEMENT_*`.
- After `UNPROVEN_MOVEMENT_PARK_GRACE_MS` (60 s, long enough for an unrecorded bust to be recorded), `withdrawUnprovenMovementPark` takes the new door. The dealer is then stopped and readmitted through the same core the capacity withdrawal uses (`withdrawUnbegunPark`).
- The refusal is still thrown and reported on every admission it refuses, and the withdrawal itself is reported (`Tournament.parked_movement_unproven_withdrawn`). The table no longer waits on it.
- `recoverTournamentBreak` takes the same exit when a begin is refused by the movement proof.
- A database without the door yet withdraws nothing and behaves exactly as before.

## Proof

- Production was read only, with SELECTs and `pg_get_functiondef`. Nothing was written.
- A throwaway local PostgreSQL 16 held byte-exact copies of the live chooser (32ed1ece), the withdrawal door (8560ec3a), `f06_movement_prior` (d21b415b), `f06_prefix` (d857e9d6) and `f06_immutable_identity` (31329a1d). The migration applied there and replayed idempotently.
- The door, tested against stub proofs on that copy:
  - A proven roster refuses.
  - A non-movement 55000 error, any other error, a wrong lease and a reserved permit all propagate, and nothing is written.
  - The Table 13 shape withdraws: one receipt, the park becomes `withdrawn_before_manifest`, and seats, chips and registrations are unchanged.
  - A replay returns the same receipt.
- The chooser on the same copy picks a between-hands table over an emptier one that is mid-hand, and picks exactly as before when every table is mid-hand.

## Damage already done

None to settle. Table 13's break 5135b05b was acknowledged after #7940 went live, no chip moved, and no other park is currently open past two minutes.

Pinned by `tests/a-parked-table-never-freezes-on-an-unproven-move.law.test.ts` (SQL) and `server/src/tournament/aParkedTableNeverFreezesOnAnUnprovenMove.law.test.ts` (engine).
