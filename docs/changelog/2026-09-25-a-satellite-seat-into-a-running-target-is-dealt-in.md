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
