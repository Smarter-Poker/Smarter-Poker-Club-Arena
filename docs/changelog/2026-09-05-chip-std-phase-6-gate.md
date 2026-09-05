# 2026-09-05 - chip standard: the Phase 6 gate (deep dive before Phase 7)

**Branch** `fix/union-to-club-money-declares-itself`. One migration, `20260905223231_phase_6_gate_no_detector_is_unowned_and_every_leg_names_its_`, probed rolled back first, applied 22:34 UTC, mirrored byte-exact. Law test extended (LAW 3b, LAW 4b in `tests/the-controls-enforce.law.test.ts`). Every figure read from production between 22:29 and 22:40 UTC.

## Pushed and mirrored

All 20 chip-standard migrations applied today are byte-exact against `schema_migrations.statements` on the branch (checked programmatically, 0 bad; the one mismatch in the sweep is the diamond programme's own file-version defect, named for its owner). PR #3115 carries them; autopilot refreshed it with `main` at 22:27 and the required checks are running on that head.

## Live health of the Phase 6 controls (two hours since they landed)

- **Every cron green.** 40 `ca-*` jobs, 0 failures since 20:30, including all three meters that now call the kill switch: `ca-supply-snapshot-hourly` (21:05, 22:05), `ca-escrow-shadow-hourly` (21:35) and `rake-bbj-invariant-audit-hourly` (21:38, three pool snapshots). The switch is wired into live code paths, not just probes.
- **6.1 refused nothing real.** 1,144 settlements since the gate went in, from 8 sources, every one a platform source; 0 refusals. (One alert matching "adjustment" is the journal guard on another agent's cert cleanup, not this control.)
- **6.2 stayed quiet.** 0 kill-switch incidents, 0 open freezes; the meters read 1.24, 0.00 and 5.44 unexplained on the hour against a 1,000 threshold.
- **6.3 is doing its job.** 0 incidents filed by a retired detector, 2 more transient findings auto-resolved on clear, the escalation tick ran 120 times without error.
- **6.4 is stamping.** 5,854 of 5,854 BBJ drop legs name their hand; every spin leg names its event; 0 ledger write failures.

## Two gaps found and closed

1. **A detector could file where the board cannot see it.** `v_ca_alert_board` is built FROM `ca_detector_registry`, which was seeded from the sources on record at 20:38. Every source filing today is in it (checked: zero unregistered). But the next detector another agent writes would file into a hole - the one way this control could fail silently, which is the failure mode Phase 6 exists to end. A source filing for the first time now registers itself as `unassigned` with the standard 24h SLA, after the retired check (so a retired detector still registers nothing and files nothing). The migration asserts that no incident source is off the board.
2. **777 rake legs and every cash buy-in named nothing.** 6.4 named the hand on the drop and the rake and the event on spin and tournament wallet legs; measured over the three hours since, 3,674 of 4,439 rake legs carried a hand and the remaining 777 were tournament FEE SETTLEMENTS (`prize_liability` to a union rake wallet or a club treasury), which have no hand by nature and were carrying no event either. All 777 `from_entity_id` values are real tournaments, so the name is exact rather than a guess: a `prize_liability` side IS the event, on every category, not only the two spin ones (this also names tournament add-ons). The same for the felt: a `table_stack` side IS the table, and 231 cash buy-ins, 53 add-ons and 222 cash-outs in that window carried no `table_id` at all. The caller's own stamp still wins in both cases.

**Measured after the change: 0 legs with no hand, no event and no table.** Every leg written in the window since names one of the three.

## Named, with their owner

- The `ca_mint_ledger.chip_ledger_id` foreign key is what makes chip_ledger partitioning a dated cut of its own (a partitioned parent's unique key must carry the partition column); measured at 1.3 GB and 232k rows a day, due before December.
- `guard-def-drift:fn_ca_diamond_snapshot` and the diamond programme's mirror-version mismatch (`20260905041753` carrying a file named `20260905041033_...`) are the diamond programme's.
- 30 `escrow:<id>` residues from 09-02 to 09-04 remain open as the epoch reset gate's list, which is Dan's.
