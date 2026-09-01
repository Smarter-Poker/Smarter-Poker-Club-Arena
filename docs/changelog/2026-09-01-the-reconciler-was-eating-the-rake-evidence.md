# The reconciler was eating the rake evidence

Phase 2 of the zero-drift work: the rake and hand-integrity incident classes.
Fourteen incidents, twelve of which had been resolved with nothing recorded
that would stop them happening again.

## The finding that reframes the rest

`reconcile_ledger_nightly` opens with

    DELETE FROM ledger_reconcile_log WHERE run_date = CURRENT_DATE;

so it can rewrite the day's findings from scratch. That is correct for the
eight entity types it writes. It is not the only writer. `fn_rake_law_check`
inserts `entity_type='rake_law'` rows hourly, and the reconciler runs every six
hours, so the rake evidence for the current day was destroyed up to four times
a day by a function that had never written it.

Measured before the fix: **zero `rake_law` rows had ever survived** in
`ledger_reconcile_log`. Every other entity type had rows going back to April.

That changes what the 2026-08-31 incidents mean. They reported "4 hands took a
drop with no flop, 0.80 chips total". Over the same period the real population
was:

| kind                 | hands | chips |
| -------------------- | ----: | ----: |
| `no_flop_no_drop`    |    30 | 11.38 |
| `board_not_recorded` |    22 | 97.91 |
| `over_cap`           |     9 | 18.41 |

The incidents captured only the final two-hour window before a wipe. `over_cap`

- players raked above the legal cap - never produced an incident at all,
  because the detector was not created until 2026-08-31 14:40 and the violations
  predate it.

The earlier resolution was not dishonest. The evidence had been truncated
underneath it. That is worse than a wrong number: it is a reporting layer that
makes a money defect look fourteen times smaller than it is.

## Four fixes

1. **The reconciler deletes only what it owns.** Scoped through
   `fn_ca_reconcile_owned_entity_types()`, so a future writer of this table is
   not silently erased either. Patched in place with a guard rather than
   re-declared, because the function belongs to another workstream.
2. **An illegal rake is classified as an illegal rake.** Every `rake_law` row
   was filed as `reporting_mismatch` at layer `reporting` regardless of kind.
   `no_flop_no_drop`, `over_cap` and `over_percent` are chips taken off a
   player that the rules never owed the house; they now file as
   `incorrect_rake` / `critical` / `settlement`. `board_not_recorded` and
   `impossible_showdown` really are evidence gaps and keep their old shape.
3. **A daily wide scan** (`rake-law-wide-daily`, 26-hour window) so a violation
   missed while a job was down is still found instead of ageing out of the
   two-hour window forever.
4. **The rake law is now a ratchet at zero.** `fn_ca_ratchet_watch` counts
   illegal rake in the last 24 hours every hour. The floor has been clean since
   2026-08-31 16:12, so the baseline is zero and the next violation raises a
   critical incident by itself.

## The tournament conservation check could never read clean

`fn_tournament_chip_conservation_check` compares expected chips against
`SUM(table_seats.stack)`. Chips committed to a live pot are in neither, and the
database has no pot column - `tables.live_state` would carry it and is NULL for
every table on the tournaments it flags. So it measured a quantity that is only
conserved at a hand boundary, at an arbitrary moment mid-hand, and fired on
healthy running tournaments (-29,910 on a 45-player event, -9,992 on a
377-player freeroll). A detector that always fires teaches everyone to ignore
it, which is exactly what happened to its one incident.

`fn_ca_tournament_conservation_confirm` samples instead, and raises only when
the same drift survives a second reading **with completed hands in between**. A
pot pays out; missing chips do not.

## The unbanked-fee repair was half-scheduled

Collecting a drop and banking it are two steps. `fn_bbj_repair_unbanked` ran
every 15 minutes. `fn_redrive_unbanked_rake`, which repairs the raked-hand
half, was scheduled by nothing - it ran only when the auto-reconciler happened
to pick up an incident and call it. It now runs every 15 minutes beside the
other half.

## Verification

Every change proved in a rolled-back probe against production, per CLAUDE.md
11.5:

- `rake_law` rows survive a full `reconcile_ledger_nightly()` run (2 in, 2 out)
  while the reconciler still rewrites its own `club_treasury` rows.
- An inserted `no_flop_no_drop` row files as `incorrect_rake` / `critical` /
  `settlement`; a `board_not_recorded` row still files as
  `reporting_mismatch` / `warning`.
- The conservation confirmer is silent on a first look, silent on a second look
  with no hands dealt, and raises on the third when hands completed with the
  drift unchanged.
- The probe also caught a bug in this work: the sample table keyed on `now()`,
  which is the transaction timestamp, so two samples in one transaction
  collided on the primary key. `clock_timestamp()` now.

## Still owed, for Dan

39 hands over-raked (30 `no_flop_no_drop`, 9 `over_cap`), **16.64 chips** owed
to 35 players, every one of them a horse - which under the horses law means
they are repaid exactly as humans would be. The rake is fully traceable (39
`rake_records`, 29.79 total, distributed across 68 legs including 11.79 into
BBJ pools), so a clawback is possible but touches pools that have since paid
out. Funding it from The Mint instead would add 16.64 chips to supply. That is
a supply decision, not an engineering one, so it is Dan's call and it is
recorded here rather than acted on.

## Follow-up: Dan's ruling, and the two layers nothing was holding

**Dan, 2026-09-01: "DON'T PAY ANY OF THE HORSES FOR THE OVER RAKE, JUST INSURE
THE BUG / GAP / LEAK IS FIXED BEFORE MOVING ON."** The 16.64 chips across 39
hands are left as history; every affected incident records that ruling as its
correction reference. What follows is the "insure it is fixed" half.

The engine-side leak was real and is closed, in three layers:

1. `HandController.start()` refuses to begin inside a dirty controller. The
   2026-08-31 criticals were hands played inside a **corpse**: a stale runout
   continuation from the PREVIOUS hand had already driven the controller to
   showdown, `sawFlop` true and a phantom board dealt, before `start()` ran.
   Live betting then proceeded in a state where no street could deal and the
   fold-out settlement priced rake on `sawFlop=true`.
2. `refuseUnlessRunout` rejects a runout entry point on an unstarted or
   still-bettable hand, which is the only known way to get dirty.
3. `priceDeductions` refuses a drop without a real board - three community
   cards in this controller's state, or `markFlopSeen()` for the RIT path -
   whatever the flag claims, and reports the disagreement to `financial_alerts`
   rather than swallowing it.

**Only layer 3 was pinned by a test.** Layer 3 refuses to CHARGE for the
corruption; layers 1 and 2 stop the corruption happening, and a hand played
inside a dead controller is a correctness bug well beyond rake - walked big
blinds, streets that cannot deal. `server/src/engine/DirtyHandStart.law.test.ts`
now holds both, registered in `docs/LAWS.md`.

Five pins, and each was verified to actually bite by removing the guard and
watching it go red:

| mutation                               | result       |
| -------------------------------------- | ------------ |
| the state reset removed from `start()` | 2 tests fail |
| `refuseUnlessRunout` removed           | 1 test fails |

`over_cap` needed no engine change: `calculateRake` ends `Math.min(rake, cap)`,
and all 2,103 live cash tables were checked against `fn_effective_rake_cap` -
zero configured above the law, zero above 10 percent, none null. The nine
`over_cap` hands all predate the detector, which was created 2026-08-31 14:40,
and none has recurred in 60 hours. (`cap_enabled=false` on every table is the
CAP GAME feature, a per-hand ceiling on what a player may commit; it is
unrelated to the rake cap and correctly off.)

## Follow-up 2: the fix had nothing holding it in place either

The scoped DELETE was applied by patching `reconcile_ledger_nightly` **in
place** - read the live definition, replace the unscoped statement, re-execute.
That was right at the time: the function is ~600 lines owned by another
workstream, and pasting a copy into this migration would silently revert
whatever had landed in it since.

It also left the fix completely undefended. `reconcile_ledger_nightly` exists
in the repository too, so the next agent to run `CREATE OR REPLACE` on it from
their copy restores the unscoped DELETE - and nothing says so. No test can read
a live function body, and the incident that would have been raised is the very
thing being deleted. The fix would die exactly the way the bug lived: quietly.

`fn_ca_reconciler_delete_unscoped()` returns 1 when the scoping is gone (or the
function is missing entirely), and it is now the fourth entry in
`ca_ratchet_baselines` at baseline 0. The hourly watcher raises a **critical**
incident the moment it moves, whoever moved it and however.

Proved in a rolled-back probe by simulating precisely that revert: the guard
read 0, the simulated `CREATE OR REPLACE` without the scoping made it read 1,
and `fn_ca_ratchet_watch()` raised exactly one incident.

The four ratchets now standing: `unledgered_insert_paths` 0,
`undeclared_money_paths` 139, `rake_law_violations_24h` 0,
`reconciler_delete_unscoped` 0.
