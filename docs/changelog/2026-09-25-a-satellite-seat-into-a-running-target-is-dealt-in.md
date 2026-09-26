# A satellite seat into a running target is dealt in

2026-09-25

## What the sentinel said, and why it was right

`RakebackSettlerService.runTournamentChipConservation` reported, every cycle
since 2026-09-22 14:10:02 UTC:

```
TOURNAMENT CHIPS: 1 live tournament(s) do not hold the chips they issued -
Sunday Funday Six-Card Closer: 120000 vs 150000 expected (drift -30000 over 5 players)
```

The tournament is `c7f21a83-367c-459e-9639-067fa92516f5` (PLO6 MTT freezeout,
`mtt-v2`, started 2026-09-21 04:00Z, RUNNING at level 3, one table
`6699816a`, engine lease live).

Read from rows, not assumed:

| line                                                                       | chips          |
| -------------------------------------------------------------------------- | -------------- |
| Rake710, seat 4                                                            | 35,956.00      |
| jen, seat 2                                                                | 24,418.00      |
| Sam02, seat 1                                                              | 28,714.00      |
| hungrycobra, seat 3                                                        | 30,912.00      |
| **felt total** (`fn_ca_tournament_felt_total`)                             | **120,000.00** |
| 4 entrants dealt in x `starting_chips` 30,000                              | 120,000        |
| rebuys 0, add-ons 0, felt acknowledgements 0                               | 0              |
| 5th entrant JulesSA - `status = 'registered'`, `table_id` NULL, `chips` 0  | 0              |
| **supply the checker expects** (`fn_ca_tournament_chip_supply`) 5 x 30,000 | **150,000**    |
| **drift**                                                                  | **-30,000.00** |

The felt is conserved to the chip across everyone who was dealt in. The 30,000
did not go anywhere - it was never created. `ca_tournament_conservation_samples`
holds 473 consecutive samples of drift exactly -30,000, players 5,
**hands_dealt 0 in every one of them**, from 2026-09-22 14:10:02 to
2026-09-25 20:50:00. A chip loss needs a chip movement; there were none.

The fifth entrant is a satellite qualifier. Satellite
`95b5fd70-e361-4ec4-bae4-78e4d7937db7` delivered place 1 into the RUNNING
target at 2026-09-22 14:08:23, funded
(`chip_ledger 8e974480`, "Satellite ticket place 1 delivered as target seat
(50.00)"), and the winner has held a paid registration and no chair ever since

- the first conservation sample after that delivery is where the drift begins.

## The door

`fn_ca_settle_satellite_cohort`, delivery kind `'seat'`:

```sql
INSERT INTO public.tournament_players
  (tournament_id, user_id, username, chips, status,
   is_satellite_qualifier, source_satellite_id)
VALUES
  (v_target_id, v_finisher.user_id, v_finisher.username, 0, 'registered',
   true, p_tournament_id)
```

and nothing else. The chair is left to the target's launch, which is correct
while the target is ANNOUNCED or REGISTERING: `startLifecycle` reads the roster
with `status IN ('registered','playing')` and `createTablesAndSeatPlayers` seats
every one of them. A target that is already RUNNING has no launch left -
`TournamentManagerBase.resumeLifecycle` adopts the existing tables and never
calls `createTablesAndSeatPlayers` again - so the row is never seated by
anything. The sibling ticket-funded admission,
`fn_ca_register_for_tournament_with_ticket_for`, never had this hole: it takes
the chair through `fn_seat_late_registrant` in the same transaction that admits
the entry.

## The fix

The `'seat'` delivery now takes the chair itself when the target is RUNNING,
through the same canonical authority, inside the transaction that books the
admission, and reads the live chair back before continuing. A refusal raises,
so the delivery is rolled back and retried rather than booking an entry the
tournament will never deal in.

Lane safety: `fn_seat_late_registrant` -> `fn_ca_lock_tournament_seat_acquisition`
takes the global settlement lane SHARED and then the target's rolling lane.
This transaction reaches `fn_ca_settle_satellite_cohort` holding the global lane
EXCLUSIVELY and already holds the target `tournaments` row `FOR UPDATE`, so the
order stays G-before-T with no inversion and no new lane. The migration
re-runs `fn_ca_settlement_lane_doctrine()` and refuses on any violation.

## Proved, against the live rows, rolled back

One Supabase MCP call, one self-aborting `DO` block (CLAUDE.md 11.5): the error
is the success case, and production was re-read afterwards to confirm nothing
committed.

```
receipt {"ok": true, "chips": 30000, "table_id": "6699816a...", "seat_number": 5,
         "opened_table": false}
felt    120000.00 -> 150000.00     supply 150000
drift   -30000.00 -> 0.00          chair seat 5, stack 30000
```

`fn_seat_late_registrant` grants `starting_chips + GREATEST(tournament_players.chips, 0)`
and the satellite admission writes `chips = 0`, so exactly one starting stack is
created for exactly one paid entrant. After the probe rolled back,
`fn_tournament_chip_conservation_check(1)` still reports -30,000: nothing moved.

## Not systemic

- 431 RUNNING tournaments; **1** flagged by the sentinel.
- 59 RUNNING tournaments carry entrants with no live chair (busted players whose
  seat rows were recycled on table teardown). Every one of them shows drift
  **0.00** - the supply function is right about them.
- Across every RUNNING, COMPLETING and COMPLETED tournament on the estate,
  exactly **one** entrant has never been dealt in (`status = 'registered'`): this
  one. No closed tournament baked the error in. (24 further rows sit in two
  CANCELLED tournaments from 2026-08-26, a different and already-closed case.)

## The sentinel is not silenced

`fn_ca_tournament_chip_supply` still counts every registrant - "EVERY REGISTRANT
IS DEALT IN" (2026-09-09) is the invariant, and this change makes it true rather
than measuring around it. The migration pins the md5 of all three sentinel
functions and aborts if any of them changed, and asserts the open finding still
reports exactly -30,000 after it applies.

## What is still owed, and is left to the owner

JulesSA (`5330edb2-9f93-492a-aef3-c7e077c0de68`) is a fully funded entrant of
`c7f21a83` holding no chair and no stack. She is owed her seat with its 30,000
starting stack - the probe above shows `fn_seat_late_registrant` delivers
exactly that and lands the tournament at drift 0.00 - or, if the event is not
to be resumed, the value of her satellite ticket. **Nothing is clawed back from
anyone**: no other player's stack is involved, and the four seated players are
exact. This migration deliberately settles nobody; the correction is a separate
owner-authorised write.

Separately noted and NOT changed here: `fn_tournament_late_registration_open`
judges the window by level alone whenever `late_reg_levels > 0` and never
consults the clock, so this tournament - stalled at level 3 with no hand dealt
since 2026-09-22 13:46 - still reports late registration OPEN four days after
its start, and another satellite could deliver another entry into it today.
That is a second defect at a different owner and wants its own change.

## The first install was refused, correctly, and what changed

Dispatched at 2026-09-25 22:29:52Z from the merged bytes
(`apply-merged-migration`, run 36196987863). The database refused it and rolled
the whole transaction back:

```
[apply] not present in schema_migrations; applying as ONE transaction
[apply] the migration did not commit after 61ms
[apply] ERROR P0001: SATELLITE_SEAT_PREIMAGE_CHANGED:
        fn_seat_late_registrant is not the canonical seat authority this migration calls
```

Nothing committed and the version stayed absent. The cause was the assertion,
not the change: a concurrent delivery had re-declared `fn_seat_late_registrant`
between 21:00 and 22:30 with an added `SET statement_timeout` and an unchanged
body, which moved `md5(prosrc)` from `51a32547...` to `28b68b7f...`.

`fn_seat_late_registrant` is CALLED here, not replaced, so what has to hold is
its contract. The preimage now pins exactly what this change depends on - a
`SECURITY DEFINER` `(uuid, uuid) -> jsonb` owned by `postgres` whose body takes
`fn_ca_lock_tournament_seat_acquisition` and reaches
`fn_seat_late_registrant_before_terminal_seat_gate` - so a
`fn_seat_late_registrant` that stopped taking the lane still refuses this
migration, while a re-declaration that changes nothing this depends on does not.
The byte-for-byte preimage on `fn_ca_settle_satellite_cohort`, the function this
migration actually replaces, is unchanged.

## During a maintenance freeze

`fn_ca_settle_satellite_cohort` has no freeze check of its own, and
`fn_ca_lock_tournament_seat_acquisition` answers
`{"ok": false, "reason": "platform_frozen"}` during the hourly break - observed
in the 22:31Z re-probe, which returned exactly that and left the felt at
120,000.00. The seat delivery therefore raises and the settlement rolls back, so
a satellite that finishes inside a break settles after the thaw rather than
admitting a winner the frozen platform cannot seat. The settlement is idempotent
on its own receipt, so that is a retry, not a loss.

## The contract pin compared names, and was caught before a second refusal

Read back against production on 2026-09-26 02:21Z, before any second dispatch:
`pg_get_function_identity_arguments` returns the parameter NAMES as well as the
types, and production's authority answers
`p_tournament_id uuid, p_user_id uuid`. The merged predicate compared that string
to `'uuid, uuid'`, so it matched no function at all
(`count(*) = 0` against the live catalog) and the install would have been refused
a second time, against the very function it was written for, leaving the door
open.

The predicate now reads the argument TYPES, `oidvectortypes(p.proargtypes) =
'uuid, uuid'`, which is what the seat delivery depends on. Every other clause of
the contract is unchanged, and the byte preimage on
`fn_ca_settle_satellite_cohort` is unchanged.

A text test could not see this, so the guard is now qualified in PostgreSQL:
`scripts/ci/test-satellite-seat-preimage.py`, in `accounting_postgres`, loads
production's real `fn_ca_settle_satellite_cohort` (from 20260921095012, asserted
to hash to the installed `86709c35...`) and production's real
`fn_seat_late_registrant` (asserted to hash to the installed `28b68b7f...`), then
runs the `DO $preimage$` block read out of this migration file. RED: the guard as
merged refuses. GREEN: the candidate accepts. Nothing was weakened: a seat
authority that skips the lane, skips the terminal gate, runs as INVOKER, takes
other argument types, is not owned by postgres, or is missing, is refused; a
one-byte change to, or a widened ACL on, the replaced function is refused; a
re-declaration that only renames parameters is accepted.
