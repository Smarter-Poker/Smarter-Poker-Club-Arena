# Horse brain changes held for the next requalification

A change here is finished and tested, but it edits a file whose bytes are hashed
into a qualified policy digest. Shipping it alone would drop every qualified
pack built on that digest back to shadow until its strength runs are redone.
So it waits and goes in WITH the next requalification of the affected phases,
on the same source commit the strength runs measure.

Check what a patch touches against the hashed lists before planning:
`HORSE_PHASE10_POLICY_SOURCE_FILES` (HorsePhase10Authority.ts), the Phase 11
and 12 lists (HorsePhase1{1,2}PolicyDigest.ts) and `HORSE_PHASE13_POLICY_SOURCE_FILES`
plus `HORSE_PHASE13_POLICY_BOUNDARY` (HorsePhase13PolicyDigest.ts).

## v17-river-probe-default-off.patch (held 2026-10-16, Dan's decision)

From the 2026-10-15 daily horse audit. `league_layer_negative_pooled` (critical):
v17_river_probe -0.11 +/- 0.04 bb/100 pooled over the audit's 7-day window
(8 runs), -0.20 +/- 0.09 on 2026-10-16, -0.10 +/- 0.05 over the 14 runs since
2026-10-03. Over all 32 runs since 2026-09-15 it is -0.02 +/- 0.03: it has
never resolved positive. Production footprint is small (1,764 fires of 4.03M
decisions on 2026-10-15).

What the patch does: v17RiverProbe is opt-in (`opts.v17RiverProbe === true`);
the league matchup keeps its name and sign (arm A = probe on); the ledger flag
text records the default and the receipt floor goes; an audit migration makes
zero fires `layer_default_off` and a significant negative
`default_off_flag_confirmed_negative`, and a significant positive says the flag
earned its default back; a test pins that no option plays like the layer off.

Touches `server/src/engine/HorseLogic.ts`, which is in the Phase 10, 11, 12
and 13 hashed lists. Measured on the candidate: tsc clean; HorseV17, ledger
and benchmark suites green once committed; HorsePhase10/11/12Authority,
aSelectedPackShipsItsEvidence and workerRuntime fail with the qualified
admissions `refused` / `shadow`, which is the digest change and exactly why
this is held.

Applying it: `git am` it onto the requalification source, then RE-RESERVE the
migration version with `node scripts/new-migration.mjs` (20261016101800 was
reserved for this day) and rename the file and its header. Re-check that the
two audit functions' installed md5(prosrc) still match
20261012111944_audit_default_off_flags_are_not_silent_layers.sql
(fn_audit_layer_silence 3c8ce9e89a4d58177b82f99397dda956,
fn_audit_league_pooled_findings 542d0d69d10e132101eace69de6c458d) before
installing; rebuild the bodies if another change replaced them.

## Phase 7 recovery_option split (not written yet, same constraint)

Tournament utility covers about 95% of complete tournament contexts (never
above 96.6% since 2026-09-28) against the ledger's 99%. On 2026-10-15 the
124,426 misses were recovery_option 77,140, field_reconciliation 34,236,
baseline_not_modeled 8,918, sample_calibration 3,206, candidate_settlement 737,
equity_evidence 189. recovery_option is optionValue() returning null on
purpose (bounty-format rebuys and rebuys overlapping an open add-on are not
modeled, so the baseline action is kept). Splitting that reason into its exact
sub-causes means editing `HorseTournamentUtility.ts`, which is in
`HORSE_PHASE13_POLICY_BOUNDARY` (hashed): it goes in with the next Phase 13
requalification, not before.
