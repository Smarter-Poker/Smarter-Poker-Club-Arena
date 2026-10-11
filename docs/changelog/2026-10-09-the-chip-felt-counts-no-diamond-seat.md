# The Chip Monitors Read Chips

**Date:** 2026-10-09

Three chip-era monitors were still misreading Diamond Arena or house activity. Each one buried real signals under false criticals.

| Monitor                                   | False Alarms                                                                                                           | Cause                                                                                                                                                                                    | Fix                                                                                                                                                                                                                  |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fn_ca_ledger_replay` and the kill switch | Felt drift of -4,860.88 (10-07), +117,689.83 (10-08) and +42,309.60 (10-09). The kill switch tripped all three nights. | `fn_ca_account_balance` read the felt with Diamond seats included. No chip leg ever moves a Diamond seat, and the Diamond felt grew to about 186,700 after Diamond cash opened on 10-06. | 20261009164317: the felt is read exactly as `fn_ca_supply_snapshot` reads it. The felt account took one new reading on that definition, in one statement with its snapshot, so the change is not judged as movement. |
| `fn_ca_escalate_reconcile_criticals`      | 29 `rake_law` / `over_spec` incidents and about 70 alert copies, re-filed hourly                                       | `fn_ca_remeasure_entity` could not measure a `rake_law` finding. The findings were raked Diamond hands priced by the chip spec.                                                          | 20261009180352: a Diamond `rake_law` finding is measured again against its settlement receipts. All five tables read ok (recorded rake equal to accepted rake).                                                      |
| `fn_union_integrity_sweep`                | 2 `agent_roster_winning` warnings                                                                                      | The roster counted a house horse as an agent's player                                                                                                                                    | 20261009180401: the roster leaves horses out, as the co-seating signal already did                                                                                                                                   |

Every migration was proved in a rolled-back transaction before it was applied. After the felt change, the reader and the supply meter agree to the cent (123,085.32). No balance moved.

## Not A Monitor Error

The supply meter's -14,081.45 reading at 2026-10-06 16:05 was real. At 15:33:04 a bulk retirement of patterned house-horse identities vacated 42 cash seats with triggers off, so no cashout leg was written. Only house horses were affected; no player lost chips. No journal leg was posted, because the only door that records one (`fn_ca_post_correction`) takes a management account; on Dan's instruction the incident closed with the cause recorded (20261009233939).

Law: `tests/the-chip-felt-counts-no-diamond-seat.law.test.ts`.
