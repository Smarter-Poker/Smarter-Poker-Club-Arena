# Self-tuner causal activation: design for Dan's decision

Design only. Nothing here activates, applies or schedules anything. Figures
were read from production and origin/main `0a1c74ea5e` on 2026-09-22, 00:30 UTC.

## Where it stands

- PR #4578 (merged 2026-09-14 02:31Z, migration recorded as `20260914022111`)
  sends every study through `recordObservationalHorseStudy`
  (`server/src/services/HorseTunerObservationalAudit.ts`). It writes
  `nextProfile = expectedProfile` and `modsAfter = modsBefore`, stamps
  `stats.causal_permission = 0`, and prefixes every reason with
  `diagnostic proposal, not applied:`. Its reasoning: frequency bands and
  leak-tag counts are correlations, not counterfactual evidence, so they may
  not rewrite `profiles.horse_profile`.
- The database is the second key. The installed `fn_record_horse_tuner_update`
  refuses every new profile change whatever intent the caller sends
  (`causal_permission_missing`, or `invalid_request` for an unknown intent) and
  contains no profile UPDATE at all, so changing TypeScript alone cannot
  activate the tuner.
- `horse_self_tune_log`: 09-10 to 09-13 wrote 650 to 706 rows a night with 639
  to 688 changed dials and no `causal_permission` key. 09-14 to 09-21 wrote 565
  to 705 rows a night, 0 changed, `causal_permission = 0` on all 5,059 rows,
  and 5,058 of them proposed a change. `horse_tuner_write_receipts` shows 0
  changed receipts on those eight nights.
- PR #5015 (`tuner_applied_nothing`) merged 2026-09-21 19:17Z. Its migration
  `20260921101630` is not installed, and the live `fn_audit_tuner_health` does
  not contain the new finding.

## What makes a study causal

A proposal counts as causal evidence only inside a hypothesis registered before
its first night (rule, dial, step, eligible horses, metric, sample, stop rules)
that meets all five:

1. **Assignment.** Randomized, never chosen: eligible horses are split by a seed
   derived from (hypothesis id, start date), stratified by variant-family mix,
   stake band and time on VPIP-floor tables.
2. **Control.** A concurrent arm of eligible horses whose proposal is recorded
   and not applied. The observational path already produces that arm every
   night. Before/after on the same horse does not count: the rules fire on
   extreme weeks, and extreme weeks regress toward the mean on their own.
3. **Pre-registered metric.** One primary metric, rake-adjusted bb/100
   (`adjusted_bb100`: real net plus rake plus BBJ drop), the figure the rake law
   judges. The targeted frequency (VPIP, AF, fold to 3-bet) is a manipulation
   check, never the success measure.
4. **Minimum sample.** Per horse, `MIN_REAL_HANDS_FOR_BB100` (1,500 real hands).
   Per arm, enough horses to resolve the effect claimed. On 09-21, 418 horses
   qualified: mean -0.92, cross-horse SD 27.05 bb/100, median 3,657 hands. At
   50 v 50 the arm difference has an SE of about 5.4, so a live canary can only
   catch a harm larger than about 11 bb/100. Live play is a harm guardrail, not
   proof of a gain.
5. **Confounders handled.** The dials are global multipliers
   (`HorseLogic.decideInternal`) applied to every variant and to tournaments,
   while the study reads cash only, and its review hands on 09-21 were 62,450
   hold'em against 54,007 Omaha. Stakes and rake are handled by the adjusted
   metric, floored play by the floor law. The fleet is a closed system (adjusted
   mean near 0), so a treated horse's gain is paid largely by other horses,
   controls at its table included, and a live difference overstates the effect.
   A HorseLogic release during the window restarts it.

## League gate before anything goes beyond a canary

`server/src/benchmark/HorseLeague.ts` is built to resolve the single-digit edge
live play cannot: duplicate deals with seats swapped, a run is significant when
|bb100| > 2 x stderr, `fn_league_pooled` pools 7 days by inverse variance
against the same bar, and the card's promotion rule is three significant
positive runs. Since 09-14 it wrote 320 rows over 40 matchups, median stderr
1.38 bb/100 at a median 12,000 hands.

It cannot see a dial today. Every seat plays
`HorseLogic.decide(p, gs, 'balanced', {}, seat.opts)`, so the first build item
is a matchup whose arms carry a treated horse's real style and dials, with and
without the proposed step.

- **Canary may start** once the hypothesis is registered and one league run shows
  no significant negative in any variant family the dial reaches.
- **Beyond the canary** needs 3+ separate nightly runs each significant positive,
  the pooled 7-day verdict significant positive, no significant negative in that
  window, in NLH and PLO4 cash at least, and no significant harm in a
  tournament context.

## Blast radius

- **Fleet per night:** canary at most 5% of the 1,000 horses (50), one hypothesis
  live at a time, 7 nights; then 25%; then all eligible. Each step needs the
  league gate and 7 clean nights at the step before.
- **Per horse:** one step per dial per night (today's `STEP` is 0.02; several
  rules move half that), at most 0.06 net per dial per 7 nights, inside the
  0.85 to 1.18 range the RPC already enforces, one activated change per
  run_date (the RPC keeps one row per horse per run_date).
- **Per variant:** while a dial is global, the gate must pass in every family it
  reaches.

## Rollback

- **Automatic triggers:** a significant negative league run or pooled verdict for
  the hypothesis; the treatment arm trailing control by more than 2 x SE once
  every horse has 1,500 real hands; the manipulation check moving the wrong way;
  at the full-fleet stage, a critical from `fn_audit_tuner_health`.
- **Restoring `mods_before`:** the activation path must add the one
  compare-and-set profile write the RPC lacks today, gated on
  `causal_permission`. A revert is a new write through it whose expected profile
  is the current profile and whose three dials equal the activation row's
  `mods_before`. If anyone edited the profile since (`profile_changed`), the
  revert stops and reports; it never overwrites. Persona and leak fields are
  untouched. The one-row rule means a revert needs its own receipt kind or the
  next run_date.
- **Audit trail:** the activation row carries `causal_permission = 1`, the
  hypothesis id, arm, stage and the cited `horse_league_results` ids (the RPC
  accepts numeric stats only, so names go in reasons). The revert row carries
  the activation audit id and the trigger. Every applied dial can be rebuilt
  from `horse_self_tune_log` alone.

## Still forbidden

- Frequency bands, leak tags or a winning week as permission (#4578); leak
  counts as decision inputs (`phase14_review_signal_ignored`).
- Writing persona fields, widening `BENCH`, learning from floored play, raw
  bb/100 regression (the persona, floor and rake laws).
- Any profile write outside the one compare-and-set RPC that also writes the
  audit row and receipt; omitted or unknown intent as permission; permission
  asserted by the caller instead of evidence the database re-reads.
- A cash-only study changing tournament play without the tournament check.
- Any activation while the tuner-health audit cannot tell applied from proposed.

## Decisions needed from Dan

1. **Keep the tuner observational until this path exists, and name its owner.**
   Recommended: yes. Restoring the legacy nudges re-opens the
   correlation-as-cause writes #4578 closed.
2. **Causal instrument.** Recommended: league first (arms carry profile dials),
   with the live randomized canary as a harm guardrail only. Alternative: live
   A/B alone, which resolves about 11 bb/100 at 50 v 50 and about 3.4 bb/100
   even at 500 v 500, before table interference.
3. **Promotion bar.** Recommended: 3+ separate significant-positive nightly
   runs, pooled 7-day significant positive, zero significant negatives, in each
   family the dial reaches. Alternative: the pooled verdict alone.
4. **Blast radius.** Recommended: 5% canary (50 horses) for 7 nights, then 25%,
   then all eligible; 0.02 per dial per night, 0.06 per 7 nights, 0.85 to 1.18
   absolute, one hypothesis live at a time.
5. **Variant scope.** Recommended: allow a global dial for the first hypothesis
   only under the per-family gate, and build per-family dials before a second.
   Alternative: build per-family dials first.
6. **Rollback authority.** Recommended: automatic revert on any trigger,
   reported to Dan afterwards, never overwriting a profile edited since.
   Alternative: every revert waits for Dan.
7. **Who grants `causal_permission = 1`.** Recommended: the database, re-reading
   the registered hypothesis and the cited league rows inside the write
   transaction. Alternative: Dan signs each hypothesis as well.
8. **Install #5015's migration `20260921101630`.** Recommended: yes, so every
   inert night is a finding while the loop stays observational.
