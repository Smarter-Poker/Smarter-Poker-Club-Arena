# 2026-09-02 - Chip Accounting Standard, Lane C: one rake spec read by the engine and the database

Branch `fix/chip-std-rake-spec`. Rule R7 of `docs/CHIP-ACCOUNTING-STANDARD.md` (3.3, Lane C in 5).

## What was wrong

The rake specification lived in four places that could not read each other:
`tables.rake_percent = -1 / rake_cap_bb = -1` (a sentinel), `ca_rake_schedule`
(per-stake percent, cap and BBJ drop; no players-dealt dimension; no row for
the live 3.00 stake), `ca_rake_tier` (bands), and engine constants
(`getPlayerCountCaps` 0.5x / 0.67x, `HEADS_UP_RAKE_PERCENT = 5`,
`noFlopNoDrop`, `BBJ_RULES.minPlayersDealt = 3`, the override ceilings).
`fn_rake_law_check` could not reproduce the engine's number, so 421 of 2,044
flop hands in the standard's 90-minute measurement read as "under-raked" when
the engine was right on every one: heads-up 5% at half cap, 3-dealt at 67%
cap, 3.00 BB priced by the tier fallback, plo6 and short-deck dropping no BBJ.
A rake change on either side was invisible to the other.

## What the live migration changed

`supabase/migrations/20260902173200_one_rake_spec_read_by_engine_and_database.sql`
(migration name `one_rake_spec_read_by_engine_and_database`), applied to
production at 17:32 UTC in one transaction. Verified 18:2x UTC that all
thirteen function bodies live in `pg_proc.prosrc` are byte-identical to the
file (md5 of every body matches).

New, all `service_role` only, RLS on, `anon`/`authenticated` revoked:

- `ca_rake_rules` (one row): `heads_up_percent 5`, `heads_up_cap_factor 0.5`,
  `short_handed_cap_factor 0.67`, `short_handed_max_players 3`,
  `no_flop_no_drop true`, `bbj_min_players_dealt 3`, `bbj_min_pot_bb 10`,
  `max_rake_percent 10`, `max_rake_cap_bb 10`,
  `bbj_ineligible_variants {plo6,short_deck}`, `tier_priced_big_blinds {3}`.
- `ca_rake_schedule_caps (bb, players_dealt, rake_cap, source)`: the cap ladder
  materialised for every stake the engine deals, 60 rows = (19 scheduled
  stakes + the tier-priced 3.00) x (2, 3, 4+ dealt). Rebuilt by
  `fn_rake_spec_rebuild_caps()`; `fn_rake_spec_self_check()` proves the table
  equals its own derivation (0 rows disagree).
- `fn_effective_rake(bb, pot, dealt, saw_flop [, sb, override_pct,
override_cap_bb])` and `fn_effective_bbj_drop(...)`: the engine's arithmetic
  in SQL, step for step (schedule row else tier fallback held to the ladder;
  override moves downward only; heads-up percent ceiling; cap by dealt; no
  flop no drop; rake + drop <= pot with the drop yielding first).
- `fn_rake_spec_canonical()` / `fn_rake_spec_checksum()`: the canonical text
  and its md5, built by the same rule as `rakeSpecCanonical()` in TS.
- `fn_rake_law_violations` / `fn_rake_law_check` / `fn_rake_bbj_invariants`
  rewritten on the two functions above. `fn_rake_bbj_audit` (the pg_cron
  wrapper) is unchanged and now reads the rewritten invariants.

## The checksums

| Side                                        | Value                              | How obtained                                                                     |
| ------------------------------------------- | ---------------------------------- | -------------------------------------------------------------------------------- |
| Production `select fn_rake_spec_checksum()` | `24f571834759564ce7929c33e50bb983` | read-only query, 2026-09-02 18:36:55 UTC                                         |
| TS `rakeSpecChecksum()`                     | `24f571834759564ce7929c33e50bb983` | `npx tsx` script importing `server/src/config/rakeSpec.ts`                       |
| Migration `c_expected`                      | `24f571834759564ce7929c33e50bb983` | pinned in the post-apply assertion; the transaction would have aborted otherwise |

Both canonical texts are 4,947 bytes. The canonical rule is documented
identically in `rakeSpec.ts` and the migration header: compact JSON, keys in
the order written, every money/percent/factor number a two-decimal string,
counts bare integers, flags true/false, open-ended tier `max_bb` null; caps
sorted by (bb, dealt), schedule by (bb, sb), tiers by min_bb, rules keys
alphabetical, ineligible variants in byte order.

## The engine (this PR)

- `server/src/config/rakeSpec.ts` (new): the one object. Schedule, tiers,
  rules, the derived `unscheduledCapBB` (15 BB) and the materialised caps.
  `effectiveRake` / `effectiveBbjDrop` are the TS twins of the SQL functions;
  `rakeSpecCanonical` / `rakeSpecChecksum` are the twins of the canonical
  functions. Imports nothing from the engine (no cycle).
- `server/src/config/RakeConfig.ts`: every number now re-exported from
  `RAKE_SPEC` (`RAKE_SCHEDULE`, `STAKES_TIERS`, `getPlayerCountCaps`,
  `BBJ_RULES.minPotBB/minPlayersDealt`, `MAX_RAKE_PERCENT`, `MAX_RAKE_CAP_BB`,
  `UNSCHEDULED_CAP_BB`, `findScheduleMatch`, `getTierForBB`,
  `unscheduledCapFor`). Lookup and BBJ-detection logic unchanged.
- `server/src/engine/PokerEngine.ts`: `HEADS_UP_RAKE_PERCENT` is
  `RAKE_SPEC.rules.headsUpPercent` (same value, same export name).
  `calculateRake` itself is untouched; the parity test is what proves
  behaviour is byte-identical.
- `server/src/services/rakeSpecGuard.ts` (new): at boot and every 60 s,
  compares `rakeSpecChecksum()` with `fn_rake_spec_checksum()`.
- `server/src/GameServer.ts`: calls the guard before table engines boot;
  `/health` publishes `rakeSpec: { drifted, compiledChecksum,
databaseChecksum, detail, checkedAt }`.

## The decision: alert, never refuse (Dan, 2026-09-02, binding)

The previous draft of this lane held every cash table at its next hand
boundary while the two checksums disagreed (a flag the deal loop and the
watchdog read). Dan's risk ruling for the swarm: anything that is high risk
for live play is not enforced. So:

- On a mismatch the guard raises CRITICAL `RakeSpec.drift` with both
  checksums and both canonical texts, ONCE PER BOOT (a second tick of the
  same or a different mismatch logs but does not re-file), logs
  `[RakeSpec] DRIFT ...` every tick, and dealing continues on the compiled-in
  spec. When the two agree again it files info `RakeSpec.drift_resolved`.
- An unreadable checksum (RPC error, malformed value) is a WARNING
  `RakeSpec.checksum_unavailable` and keeps the previous verdict.
- There is no `blocked` flag, no `isCashDealingBlockedByRakeSpec`, no
  `rake_spec_drift_hold` loop phase; `ServerTableEngineDealing.ts` and
  `ServerTableEngineTurns.ts` are back to `origin/main`.
  `rakeSpecGuard.test.ts` pins that the deal loop, the watchdog, the base
  engine and HandController do not import the drift state, and that the only
  reader is `/health`.

Why this is the right call and not a weaker one: the engine prices every hand
from its compiled spec regardless. What a hold would have bought is bounding a
one-cent-per-hand drift during the minutes between a migration and its deploy
(or the reverse); what it would have cost is the whole cash fleet parked over
a hash mismatch that could be a comment change, a canonicalisation bug, or a
deploy racing a migration by sixty seconds. The alert makes the disagreement
visible inside a minute, which is the thing the four-way split never had.

## Parity result

`server/src/engine/RakeSpecParity.law.test.ts` (row in `docs/LAWS.md`):

- 500 deterministic cases (fixed LCG; the first 352 walk the full grid of 22
  stakes x 8 dealt counts x flop/no-flop, the rest sample it with owner
  overrides including the -1 inherit sentinel, an absurd 20% / 50 BB, and a
  rake-free 0 / 0). `calculateRake` fed exactly as
  `ServerTableEngineBase.getRakeConfig` feeds it equals an independent
  integer-arithmetic (Postgres numeric semantics) transcription of
  `fn_effective_rake` on every case; `effectiveRake` agrees on rake, cap and
  percent.
- 384 BBJ cases: `calculateBBJFee` and `effectiveBbjDrop` equal the
  transcription of `fn_effective_bbj_drop` across nlh / plo4 / plo5 / plo6 /
  short_deck / pineapple; the pot-ceiling yield is checked on seven tiny pots.
- Checksum pin: `rakeSpecChecksum()` equals the production value and the
  migration's `c_expected` (read from the file).
- Canonical rule pin: key sets, key order, two-decimal string formatting,
  and orderings of `rakeSpecCanonical()`; the SQL `format()` key sequences
  pinned from the migration text.
- 900 tests, all green.

Negative controls (both restored):

1. 1/2 row `rakeCap` 5 -> 5.5 in `rakeSpec.ts`: checksum pin red
   (`80baa7f8...` vs `24f57183...`), known-answers pin red (HU cap 2.75 vs
   2.50). The 500-case table stayed green, correctly: it compares two
   arithmetics over the same spec; the checksum is what catches a one-sided
   spec edit.
2. `calculateRake`'s final `Math.min(rake, cap)` -> `cap + 0.01`: 104 of 500
   cases red (every capped pot).

## Read-only post-apply evidence (2026-09-02 18:2x-18:4x UTC, nothing inserted)

The SELECT behind `fn_rake_law_check` (`fn_rake_law_violations('2 hours')`),
run directly:

| Kind                    | Count |
| ----------------------- | ----- |
| over_spec               | 0     |
| under_spec              | 0     |
| bbj_over_spec           | 0     |
| bbj_under_spec          | 0     |
| no_flop_no_drop         | 0     |
| board_not_recorded      | 0     |
| players_not_recorded    | 0     |
| impossible_showdown     | 0     |
| bbj_club_switch_ignored | 0     |

Denominator: 7,440 cash hands in the window; 2,303 flop hands with a board and
a dealt count on record, across 10 distinct big blinds, 2,553.96 chips raked;
4,535 preflop hands raked 0.00. The 421 "under" findings from the standard's
measurement are gone because the audit now knows the rules the engine plays
by, not because anything was hidden.

`fn_rake_bbj_invariants(2)` (the SELECT behind `fn_rake_bbj_audit`): I1
drop_under_3_dealt 0, I2 drop_on_ineligible_variant 0, I3
deductions_exceed_pot 0, I4 eligible_flop_no_drop 0, I5 drop_not_banked_to_pool
0, I6 ledger_not_reconciled 0, I7 raked_hand_never_banked 0.

## Performance

`fn_effective_rake` costs ~1 ms/call on the scheduled path and ~3 ms on the
tier-fallback path (1,000-call timing). The hourly `rake-law-adherence-hourly`
pg_cron job (jobid 161, role `postgres`, no 8 s cap) ran post-migration at
17:40 UTC in 20.8 s against 4.8-26.9 s for the pre-migration runs the same
day, so no regression. The previous agent had started converting
`fn_rake_tier_price` from SQL to plpgsql for speed; it did not land and it is
not needed - a second DDL round is a second 28 s PostgREST reload for nothing.
Watch item: the daily `rake-law-wide-daily` (jobid 215, 26-hour window, 07:50
UTC) has not yet run on the rewritten function; at ~3 ms/hand over ~100k hands
it should take 3-5 minutes under `postgres`.

## Findings left open (none hidden)

- `clubs.bbj_rake_enabled` is written by ClubSettingsPage and read by nothing
  in the engine; `fn_effective_bbj_drop` does not gate on it either, so the
  audit cannot mistake the gap for a rake bug. `bbj_club_switch_ignored` is
  reported separately; 0 clubs have it off today. Making the engine honour the
  switch is Dan's call.
- `bbjPayoutTotalPercent` per tier is a payout parameter and is deliberately
  outside the checksum.

## Files

- `server/src/config/rakeSpec.ts` (new)
- `server/src/config/RakeConfig.ts`
- `server/src/engine/PokerEngine.ts`
- `server/src/services/rakeSpecGuard.ts` (new), `rakeSpecGuard.test.ts` (new)
- `server/src/GameServer.ts`
- `server/src/engine/RakeSpecParity.law.test.ts` (new)
- `supabase/migrations/20260902173200_one_rake_spec_read_by_engine_and_database.sql` (applied)
- `scripts/ci/schema-manifest.d/chip-std-rake-spec.json`
- `docs/LAWS.md`
