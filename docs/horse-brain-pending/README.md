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

## v17-river-probe-default-off.patch - APPLIED 2026-10-16

Applied with the opponent-exploit change (branch
claude/horse-opponent-exploit-20261016), which moves the Phase 10-13 digests
anyway and goes to requalification. Its audit migration was re-reserved as
20261016182539_audit_v17_river_probe_is_default_off.sql; the installed
md5(prosrc) of fn_audit_layer_silence (3c8ce9e89a4d58177b82f99397dda956) and
fn_audit_league_pooled_findings (542d0d69d10e132101eace69de6c458d) were
re-checked against production before it was renamed. The patch file is gone;
the commit carries it.

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
