# A layer is silent only when its own volume made zero improbable

2026-09-21. Audit items P2.1 and P2.4. The 2026-09-20 horse audit
(`horse_daily_audit.agent_analysis`) said "4 of the 63 layer_went_silent
findings (phase10, phase11_plo6, phase11_plo8, phase12_pineapple, all
reason_multiboard_owned_by_phase13) are not regressions" and asked the
detector to "normalise layer fires by that variant's decide count for the day
before calling a layer silent".

Migration `20260922004006_layer_silence_is_measured_against_its_own_volume.sql`
is in this pull request. **It is not applied to production.** Apply it once,
after merge, outside the :50-:03 break window.

## What was true

`fn_audit_layer_drift` raised `layer_went_silent` (warn) for any counter that
fired on 2 or more of the previous 7 days and read zero today. It never asked
how much of what the counter counts happened today. Called for 2026-09-20 on
2026-09-22 it returns 63 of them, as the audit said.

The variants were not starved, and the suggested normaliser would not have
cleared them. `phase13_variant_<v>` is emitted once per decision (the nine sum
to the day's 914,234 decides), and at each counter's 09-13..09-19 fires per
variant decision:

| counter                                                | variant decides 09-20 | expected at that rate |
| ------------------------------------------------------ | --------------------- | --------------------- |
| `phase10_reason_multiboard_owned_by_phase13`           | 90,217 (plo4)         | 1,597.1               |
| `phase11_plo6_reason_multiboard_owned_by_phase13`      | 48,426                | 1,458.2               |
| `phase11_plo8_reason_multiboard_owned_by_phase13`      | 16,815                | 1,186.0               |
| `phase12_pineapple_reason_multiboard_owned_by_phase13` | 9,555                 | 920.5                 |

What ran out was bomb pots. `Plo4LivePolicy`, `OmahaVariantLivePolicy` and
`RemainingVariantLivePolicy` return `multiboard_owned_by_phase13` only for
`s.bombPot || boardCount !== 1 || communityCards2 || communityCards3`, and
`HandController` sets `activeBoardCount` above 1 only in its bomb-pot branch,
so the counter is the variant's bomb-pot decision count. `hand_history`
(`bomb_pot is not null`) per UTC day:

| variant    | 09-15 | 09-16 | 09-17 | 09-18 | 09-19 | 09-20 |
| ---------- | ----- | ----- | ----- | ----- | ----- | ----- |
| plo4       | 12    | 365   | 1,029 | 1,180 | 606   | 0     |
| plo6       | 0     | 47    | 1,536 | 902   | 485   | 0     |
| plo8       | 0     | 11    | 668   | 706   | 857   | 0     |
| pineapple  | 0     | 12    | 484   | 939   | 221   | 0     |
| flh        | 118   | 542   | 536   | 516   | 730   | 840   |
| flo8       | 0     | 2     | 89    | 116   | 95    | 75    |
| plo5       | 10    | 34    | 1,313 | 1,344 | 549   | 45    |
| nlh        | 66    | 26    | 1,693 | 2,577 | 2,440 | 1,233 |
| short_deck | 0     | 335   | 690   | 916   | 852   | 256   |

The variants that still dealt bomb pots kept their counters firing on 09-20:
`phase12_flh` 5,508, `phase12_flo8` 517, `phase12_short_deck` 1,967,
`phase11_plo5` 305. Measured per bomb-pot hand the plo4 counter is steady
(6.50, 8.52, 9.71, 8.18, 7.16 fires per hand on 09-15..09-19); measured per
plo4 decision it swings from 0.0031 to 0.0237.

## What changed

A zero is `layer_went_silent` only when it was improbable at the day's volume
of the thing the counter counts:

    rate     = the counter's fires / its volume, previous 7 days
    expected = rate x today's volume
    silent   when expected >= 12   (Poisson P(0) = exp(-12) = 6.1e-6)

| counter family                                                                                                         | volume                                                                                                                                           |
| ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `*_reason_multiboard_owned_by_phase13`, `phase13_board_N` (N >= 2), `v36_bomb_*`, `v36_multiboard_*`, `v36_board_lock` | bomb-pot hands in the counter's variants (`hand_history`)                                                                                        |
| `phase8_*`                                                                                                             | tournament postflop decisions (`decide_tournament` minus `decide_tournament_preflop`; Phase 8 runs on `isTournamentMode && stage !== 'preflop'`) |
| `phase10_*`                                                                                                            | `phase13_variant_plo4`                                                                                                                           |
| `phase11_<v>_*`, `phase12_<v>_*`, `phase13_<v>_*`, `phase11_variant_<v>`, `phase12_variant_<v>`                        | `phase13_variant_<v>`                                                                                                                            |
| `phase11_*`, `phase12_*`                                                                                               | their pack's variants summed                                                                                                                     |
| everything else                                                                                                        | `decide`                                                                                                                                         |

A layer-level aggregate whose per-variant parts exist (`phase11_reason_X` is
the sum of `phase11_<v>_reason_X`) is judged through its parts. A zero below
twelve expected is "could not tell" (CLAUDE.md 10.86 rule 1): every such
counter for the day goes into one `note`, `layer_quiet_at_low_volume`, with its
volume and expected count. Bomb-pot volume is read only from days
`hand_history` still holds in full (`sp_prune_hand_history` drops hands with no
human seated after `horse_retention_days`, 8); on an older day those counters
say `volume_today: null` instead of silent or healthy. Signature, owner,
`SECURITY DEFINER`, `STABLE`, `search_path` and grants are unchanged. Section
2, `layer_fire_collapse`, is unchanged. The replay of the new section 1 for
2026-09-20 runs in 128.7 ms on production (`EXPLAIN ANALYZE`, read-only), with
the bomb-pot scan read once (`MATERIALIZED`); inlined it re-ran per counter and
day and took 963.2 ms. `fn_run_horse_daily_audit` runs under a 60 s
`statement_timeout`.

## Why twelve

774 distinct counters were emitted between 2026-09-13 and 2026-09-20. Keeping
chance-only false silences under 1% of days across all of them needs
P(0) <= 0.01 / 774 per counter, so expected >= ln(774 / 0.01) = 11.26. Twelve
rounds that up (774 x exp(-12) = 0.0048 a day). On 09-20 the counters nearest
the line were `phase8_reason_budget_exhausted` at 6.45 (quiet) and
`v41_limp_bloat_read` at 15.14 (silent).

It is a floor. Fires cluster by hand, table and tournament format, so a real
counter spreads wider than Poisson. Replayed over every day 2026-09-08 to
2026-09-20 for the decide-based families (bomb-pot counters left out, since
`hand_history` no longer holds those days), the old rule raised 367
silences; 247 were below twelve expected, and of the 200 whose counter fired
again later in the window, 154 were below twelve. The ones above twelve that
came back are mostly narrow-context counters this cannot see: `v26_prize_read`,
the v37 bounty, bubble and satellite reads, a stack-depth reason, and
2026-09-15, when spins, heads-up SNGs, short deck, flo8 and pineapple made no
horse decisions at all. The old rule reported every one of those as well.

## Measured on 2026-09-20, before and after

The production function called for 2026-09-20, and the new rule replayed as a
read-only query over the same rows (on 2026-09-22, bomb-pot baseline
2026-09-15..19):

| finding                         | before | after                                                        |
| ------------------------------- | ------ | ------------------------------------------------------------ |
| `layer_went_silent` warns       | 63     | 23                                                           |
| `layer_quiet_at_low_volume`     | none   | 1 note, 38 counters                                          |
| aggregates judged through parts | -      | 2 (`phase11_`, `phase12_reason_canonical_state_unavailable`) |

| counter                                       | basis               | volume 09-20 | expected  | after  |
| --------------------------------------------- | ------------------- | ------------ | --------- | ------ |
| the four multiboard counters                  | bomb-pot hands      | 0            | 0         | quiet  |
| `phase15_journal_enqueued`                    | decides             | 914,234      | 287,973.5 | silent |
| `phase15_journal_recorded`                    | decides             | 914,234      | 287,957.5 | silent |
| `phase15_journal_queue_capacity`              | decides             | 914,234      | 29,913.4  | silent |
| `phase8_reason_unsupported_variant`           | tournament postflop | 82,426       | 251.8     | silent |
| `phase8_eligible`                             | tournament postflop | 82,426       | 88.0      | silent |
| `phase8_reason_continuation_operation_budget` | tournament postflop | 82,426       | 80.2      | silent |
| `phase8_reason_context_incomplete`            | tournament postflop | 82,426       | 34.4      | silent |
| `phase8_reason_utility_unavailable`           | tournament postflop | 82,426       | 19.2      | silent |
| `phase8_fired`, `phase8_completed`            | tournament postflop | 82,426       | 1.13      | quiet  |

For 2026-09-21 the same replay gives 81 old warns against 29 silent and 48
quiet, with `phase15_journal_enqueued` at 202,057 expected and
`phase8_eligible` at 49.5, both still silent.

## The two real silences, fires per day

`horse_brain_telemetry` (09-22 is a partial day; a missing day is zero):

| feature                                      | 09-15   | 09-16   | 09-17     | 09-18     | 09-19     | 09-20     | 09-21     | 09-22   |
| -------------------------------------------- | ------- | ------- | --------- | --------- | --------- | --------- | --------- | ------- |
| `phase15_journal_enqueued`                   | 0       | 0       | 2,447,093 | 920,375   | 0         | 0         | 0         | 0       |
| `phase15_journal_recorded`                   | 0       | 0       | 2,447,002 | 920,279   | 0         | 0         | 0         | 0       |
| `phase15_journal_queue_capacity`             | 0       | 0       | 333,200   | 16,598    | 0         | 0         | 0         | 0       |
| `phase15_journal_capture_unavailable`        | 0       | 0       | 6,458,796 | 9,109,042 | 5,839,599 | 3,912,201 | 2,694,110 | 195,542 |
| `phase8_seen`                                | 140,067 | 153,311 | 297,482   | 345,998   | 103,971   | 82,426    | 51,494    | 4,472   |
| `phase8_reason_disabled_eligible_but_silent` | 140,067 | 152,861 | 295,845   | 343,394   | 103,971   | 82,426    | 51,494    | 4,472   |
| `phase8_eligible`                            | 0       | 160     | 388       | 392       | 0         | 0         | 0         | 0       |
| `phase8_fired`                               | 0       | 0       | 13        | 4         | 0         | 0         | 0         | 0       |
| `phase8_completed`                           | 0       | 0       | 13        | 4         | 0         | 0         | 0         | 0       |

No `phase15_journal_*` row exists before 2026-09-17. Since 2026-09-19 every
Phase 8 decision carries `disabled_eligible_but_silent`.

## How it is proved

`scripts/dev/probe-layer-silence-volume-pg17.py`, a new step in the
`Accounting transactions (PostgreSQL 17)` job, builds a private PostgreSQL 17
cluster, installs the definition production holds (refused unless its
`pg_get_functiondef` md5 is production's `deec72616a6dbf948253a5b519250977`),
and replays `scripts/dev/fixtures/layer-silence-volume/`: 230 real
telemetry rows for 2026-09-13..20 and 28,098 real bomb-pot hands for
2026-09-15..20, both refused unless their md5 digests match what production
returned. Then it applies the migration file twice and checks, among 46
checks: the old rule flags the four; the new one lists them as quiet at zero
bomb pots and still flags the three Phase 15 journal counters and three Phase 8
counters at the expected counts above; the line sits between 6.45 and 15.14;
606 plo4 bomb pots on the day turn the plo4 counter back into a silence
(5,158.8 expected); a day `hand_history` no longer holds reads as could not
tell; and the function's authority is unchanged. Two mutations were run
locally and fail it: threshold 0 (18 checks fail), and normalising the
multiboard counters by variant decides as the analysis suggested (14 fail).

## What it still cannot tell

A counter that runs only in a context narrower than its family volume (a
tournament format, a stack depth) is still judged against the family and can
still over-predict: on 2026-09-21 `phase8_format_spin` (15,370.6 expected) and
`phase8_format_hu_sng` (9,558.9) are silent because those formats stopped
dealing. A counter that has read zero for a whole week drops out of this check
(it needs 2 prior days), as before.
