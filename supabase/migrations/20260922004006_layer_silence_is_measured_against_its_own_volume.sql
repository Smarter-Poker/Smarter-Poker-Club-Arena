-- 20260922004006_layer_silence_is_measured_against_its_own_volume
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-09-22 00:40:06 UTC.
--
-- NOT INSTALLED. This file is in a pull request and has not been applied to
-- production. Apply it once, after the pull request merges, outside the
-- :50-:03 break window (CLAUDE.md section 2, rule 8).
--
-- WHAT WAS WRONG
--
-- fn_audit_layer_drift reports `layer_went_silent` (warn) for any counter that
-- fired on 2+ of the previous 7 days and read zero today. It never asks how
-- much of the thing the counter measures happened today. On 2026-09-20 it
-- raised 63 of them, and the day's analysis named four as false
-- (horse_daily_audit.agent_analysis for 2026-09-20):
--
--   feature                                                prior-week fires
--   phase10_reason_multiboard_owned_by_phase13                  35,607
--   phase11_plo6_reason_multiboard_owned_by_phase13             31,115
--   phase11_plo8_reason_multiboard_owned_by_phase13             17,954
--   phase12_pineapple_reason_multiboard_owned_by_phase13        14,666
--
-- The analysis attributed them to thin variants and asked for each counter to
-- be normalised by its variant's decide count. Measured, that is not what ran
-- out, and that normaliser would not have cleared them. PLO4, PLO6, PLO8 and
-- Pineapple still made 90,217 / 48,426 / 16,815 / 9,555 decisions on 09-20
-- (phase13_variant_*, which sum to the day's 914,234 decides), and at each
-- counter's 09-13..09-19 fires per variant decision those decisions predict
-- 1,597.1 / 1,458.2 / 1,186.0 / 920.5 fires. Zero against any of those is
-- still a silence. What ran out is BOMB POTS. Plo4LivePolicy, OmahaVariantLivePolicy
-- and RemainingVariantLivePolicy return `multiboard_owned_by_phase13` for
-- exactly one input - `s.bombPot || boardCount !== 1 || communityCards2 ||
-- communityCards3` - so the counter IS the variant's bomb-pot decision count,
-- and hand_history shows plo4, plo6, plo8 and pineapple dealt ZERO bomb-pot
-- hands on 2026-09-20 (they dealt 606 / 485 / 857 / 221 on 09-19), while flh,
-- flo8, nlh, plo5 and short_deck dealt 840 / 75 / 1,233 / 45 / 256 - and their
-- counters kept firing (phase12_flh 5,508, phase12_flo8 517, phase12_short_deck
-- 1,967, phase11_plo5 305). HandController sets activeBoardCount above 1 only
-- inside its bomb-pot branch, so bomb-pot hands are the whole input.
--
-- WHAT THIS CHANGES
--
-- A counter that read zero is `layer_went_silent` only when zero was
-- IMPROBABLE at the day's volume of the thing it counts:
--
--   baseline rate = its fires / its volume over the previous week
--   expected      = baseline rate x today's volume
--   silent        when expected >= 12, i.e. Poisson P(0) = exp(-12) = 6.1e-6
--
-- Volume, by counter family - each one is the population the engine invokes
-- that counter on, and each is recorded independently of the counter:
--
--   *_reason_multiboard_owned_by_phase13,   bomb-pot hands dealt in the
--   phase13_board_N (N >= 2), v36_bomb_*,   counter's variants (hand_history,
--   v36_multiboard_*, v36_board_lock        through its bomb_pot index)
--   phase8_*                                tournament postflop decisions
--                                           (decide_tournament minus
--                                           decide_tournament_preflop; the
--                                           Phase 8 gate is isTournamentMode
--                                           && stage !== 'preflop')
--   phase10_*                               phase13_variant_plo4 (Phase 10 is
--                                           the PLO4 pack)
--   phase11_<v>_*, phase12_<v>_*,           phase13_variant_<v>
--   phase13_<v>_*, phase1[12]_variant_<v>
--   phase11_*                               phase13_variant_plo5+plo6+plo8
--   phase12_*                               phase13_variant_flh+flo8+
--                                           pineapple+short_deck
--   everything else                         all decisions ('decide')
--
-- A layer-level aggregate whose per-variant parts exist (phase11_reason_X is
-- the sum of phase11_<v>_reason_X) is judged through those parts and not
-- again on its own: an aggregate judged against the whole family's volume
-- over-predicts on a day when only one variant of the family is dealing. The
-- parts carry the same information and each has its own volume.
--
-- A counter that read zero where fewer than 12 were expected is not a defect
-- and not a clean bill of health - CLAUDE.md 10.86 rule 1, "I could not tell"
-- has its own name. All of them for the day go into ONE `note`,
-- `layer_quiet_at_low_volume`, listing each counter with its volume and
-- expected count. A counter there whose volume comes back and that still reads
-- zero is reported as layer_went_silent automatically.
--
-- WHY 12
--
-- The rule tests every counter the engine emits: 774 distinct features between
-- 2026-09-13 and 2026-09-20. To keep false silences from pure chance under 1%
-- of days across all of them, each test needs P(0) <= 0.01 / 774 = 1.3e-5,
-- i.e. expected >= ln(774 / 0.01) = 11.3. Twelve is that, rounded up
-- (774 x exp(-12) = 0.005 chance-only false silences a day). On 2026-09-20 the
-- nearest counters on either side of the line are phase8_reason_budget_exhausted
-- at 6.45 expected (quiet) and v41_limp_bloat_read at 15.1 (silent).
--
-- Twelve is a floor, not a guarantee. Fires are clustered (by hand, by table,
-- by tournament format), so a counter's real day-to-day spread is wider than
-- Poisson and a zero above twelve can still be innocent when the counter only
-- runs in a context narrower than its family volume. Replayed over every day
-- from 2026-09-08 to 2026-09-20 for the decide-based families (bomb-pot
-- counters excluded, hand_history no longer holds most of those days), the
-- old rule raised 367 silences; 247 of them were below twelve expected, and of
-- the 200 counters that fired again later in the window, 154 were below twelve.
-- The ones above twelve that came back are mostly the narrow-context kind
-- named under WHAT IT STILL CANNOT TELL: v26_prize_read; the v37 bounty,
-- bubble and satellite reads; a stack-depth reason such as
-- phase13_plo8_reason_depth_outside_domain; and most of 2026-09-15, when
-- spins, heads-up SNGs, short deck, flo8 and pineapple made no horse decisions
-- at all. The old rule reported every one of them too.
--
-- MEASURED ON 2026-09-20 (the day the analysis named), before -> after. The
-- production function was called for 2026-09-20 and this rule was replayed as
-- a read-only query over the same rows on 2026-09-22 (bomb-pot baseline
-- 2026-09-15..19, the days hand_history then held in full):
--
--   layer_went_silent  63 -> 23 warns, plus one layer_quiet_at_low_volume
--     note listing 38. The other 2 of the 63, phase11_ and
--     phase12_reason_canonical_state_unavailable, are aggregates judged
--     through their per-variant parts (all five parts quiet, 0.44 to 3.58
--     expected).
--   the four multiboard counters: expected 0 (0 bomb-pot hands in their
--     variants) -> in layer_quiet_at_low_volume, not warns
--   phase15_journal_enqueued / _recorded / _queue_capacity: expected 287,973 /
--     287,958 / 29,913 at 914,234 decisions -> still layer_went_silent
--   phase8_reason_unsupported_variant / phase8_eligible /
--     phase8_reason_continuation_operation_budget /
--     phase8_reason_context_incomplete / phase8_reason_utility_unavailable:
--     expected 251.8 / 88.0 / 80.2 / 34.4 / 19.2 at 82,426 tournament
--     postflop decisions -> still layer_went_silent
--   phase8_fired / phase8_completed (17 prior fires each): expected 1.13 ->
--     quiet. The Phase 8 silence is still reported, by the five counters
--     above; seventeen fires in a week cannot by themselves make a zero day
--     mean anything.
--
-- WHAT IT STILL CANNOT TELL
--
-- Bomb-pot volume comes from hand_history, which sp_prune_hand_history keeps
-- for hand_history_retention_policy.horse_retention_days (8) days for hands
-- with no human seated. A day older than that is only partly held, so the
-- bomb-pot baseline uses only days hand_history still holds in full, and a
-- bomb-pot counter on a day it no longer holds reads as "could not tell"
-- rather than as silent or healthy. Counters that depend on a narrower context
-- than their family volume - a tournament format (phase7_objective_spin_payout
-- when spins stop dealing), a stack depth - are still measured against their
-- family volume and can still over-predict. Section 2, layer_fire_collapse, is
-- unchanged.
--
-- One transaction (production DDL policy rule 1), lock_timeout set, functions
-- only - no table DDL, no foreign key, no lock on a hot relation (rule 7).
-- Signature, return type, volatility, SECURITY DEFINER and search_path are
-- reproduced exactly as production holds them, and the grants are restated to
-- exactly what production holds (postgres and service_role EXECUTE, nothing
-- for PUBLIC, anon or authenticated), so no privilege changes.

BEGIN;

SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.fn_audit_layer_drift(p_day date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_findings jsonb := '[]'::jsonb;
  v_decides bigint;
  v_already text[];
  r record;
  /*
   * FALLBACK COUNTERS: SILENCE IS THE GOAL, BUT NOT ALWAYS THE CAUSE
   * Some counters name the DEGRADED path, not a layer: icm_legacy is the flat
   * heuristic used only when TournamentBrainContext arrives without stacks or
   * payouts (icm_real takes over the moment it has them), icm_warming is a
   * context that has not arrived yet, gto_depth_fallback and gto_miss_* are
   * the solver store having no cell for the spot. Zero fires on a big day is
   * the INTENDED direction for all of them, so their silence is info rather
   * than a warning - the six-day icm_legacy migration to icm_real reached
   * exactly zero on 2026-09-04 and this function used to report it as a layer
   * that "was executing and is not any more".
   *
   * What this function CANNOT tell (2026-09-12) is WHY one went quiet. The
   * primary genuinely covering every spot, and the whole lane being retired by
   * a deploy, produce an identical zero here. On 2026-09-11 all three
   * gto_miss_* counters read zero and were reported as "the primary path
   * covered every spot" while their primary, v31_gto_open, had itself been
   * removed from the source by PR #3849 and the certified store it was
   * repointed at was empty. So the title now states only what was counted and
   * the recommendation names both causes. A fallback that starts firing AGAIN
   * is caught by the ratio checks in fn_audit_data_receipts, not here.
   */
  v_fallback_exact constant text[] := array['icm_legacy', 'icm_warming', 'gto_depth_fallback'];
  v_fallback_prefix constant text[] := array['gto_miss_'];
  v_is_fallback boolean;
  /*
   * SILENCE IS MEASURED AGAINST THE COUNTER'S OWN VOLUME (2026-09-21)
   * A zero means something only when the thing the counter counts happened
   * often enough that zero was improbable. Each counter gets the volume of
   * the population the engine invokes it on (see the basis CASE below), its
   * previous-week fires per unit of that volume, and an expected count for
   * today. Below v_silent_min_expected a zero is "could not tell" and goes to
   * the one layer_quiet_at_low_volume note. Twelve: 774 counters tested, 1%
   * of days allowed one chance-only false silence, P(0) <= 1.3e-5 each,
   * expected >= ln(774/0.01) = 11.3, rounded up. Measured 2026-09-20: the
   * four *_reason_multiboard_owned_by_phase13 counters of plo4, plo6, plo8
   * and pineapple read zero because those variants dealt zero bomb-pot hands,
   * not because their layers stopped.
   */
  v_silent_min_expected constant numeric := 12;
  v_quiet_listed constant integer := 40;
  v_quiet jsonb := '[]'::jsonb;
  v_quiet_n integer := 0;
  v_hh_from date;
  v_basis_label text;
begin
  select coalesce(sum(fires), 0) into v_decides
    from horse_brain_telemetry where day = p_day and feature = 'decide';

  if v_decides < 1000 then
    return v_findings;
  end if;

  select coalesce(array_agg(f->'evidence'->>'feature'), '{}')
    into v_already
    from jsonb_array_elements(fn_audit_layer_silence(p_day)) f
   where f->>'code' = 'layer_silent';

  -- The first day hand_history still holds in full. sp_prune_hand_history
  -- deletes hands with no human seated once they are older than
  -- horse_retention_days (8), so an older day has only its human hands left
  -- and would undercount bomb pots. Bomb-pot volume is read only from here on.
  select ((now() at time zone 'UTC')
          - make_interval(days => greatest(coalesce(max(horse_retention_days), 8), 1)))::date + 1
    into v_hh_from
    from hand_history_retention_policy;

  -- 1. A layer that was firing and stopped - judged against its own volume.
  for r in
    with hist as (
      select feature,
             count(*) filter (where day < p_day and fires > 0) as prior_days,
             coalesce(max(fires) filter (where day = p_day), 0) as today,
             coalesce(sum(fires) filter (where day < p_day), 0) as prior_fires,
             max(day) filter (where day < p_day and fires > 0) as last_fired
        from horse_brain_telemetry
       where day between p_day - 7 and p_day and feature <> 'decide'
       group by feature
    ),
    cand as (
      select h.*,
             case
               when h.feature ~ '^phase1[0-3]_(nlh|plo4|plo5|plo6|plo8|flh|flo8|pineapple|short_deck)_'
                 then array[substring(h.feature from '^phase1[0-3]_(nlh|plo4|plo5|plo6|plo8|flh|flo8|pineapple|short_deck)_')]
               when h.feature ~ '^phase1[12]_variant_(nlh|plo4|plo5|plo6|plo8|flh|flo8|pineapple|short_deck)$'
                 then array[substring(h.feature from '_variant_(nlh|plo4|plo5|plo6|plo8|flh|flo8|pineapple|short_deck)$')]
               when h.feature like 'phase10\_%' then array['plo4']
               when h.feature like 'phase11\_%' then array['plo5', 'plo6', 'plo8']
               when h.feature like 'phase12\_%' then array['flh', 'flo8', 'pineapple', 'short_deck']
             end as variants,
             case
               -- The policy packs return this reason for bomb pots and
               -- multi-board hands and for nothing else; phase13_board_N and
               -- the v36 multi-board reads are noted only on those hands.
               when h.feature like '%\_reason\_multiboard\_owned\_by\_phase13'
                 or (h.feature like 'phase13\_board\_%' and h.feature <> 'phase13_board_1')
                 or h.feature like 'v36\_bomb\_%'
                 or h.feature like 'v36\_multiboard\_%'
                 or h.feature = 'v36_board_lock'
                 then 'bomb_pot_hands'
               -- Phase 8 runs only on tournament postflop decisions.
               when h.feature like 'phase8\_%' then 'tournament_postflop_decides'
               else 'decides'
             end as basis
        from hist h
       where h.prior_days >= 2 and h.today = 0 and not (h.feature = any(v_already))
         -- A layer-level aggregate whose per-variant parts exist is judged
         -- through those parts (each against its own variant), not again here.
         and not exists (
           select 1 from horse_brain_telemetry s
            where s.day between p_day - 7 and p_day - 1
              and s.feature ~ '^phase1[1-3]_(nlh|plo4|plo5|plo6|plo8|flh|flo8|pineapple|short_deck)_'
              and regexp_replace(s.feature,
                    '^(phase1[1-3])_(nlh|plo4|plo5|plo6|plo8|flh|flo8|pineapple|short_deck)_', '\1_') = h.feature
         )
    ),
    days as (
      select d::date as day from generate_series(p_day - 7, p_day, interval '1 day') d
    ),
    vol as (
      select day,
             coalesce(sum(fires) filter (where feature = 'decide'), 0) as decides,
             coalesce(sum(fires) filter (where feature = 'decide_tournament'), 0)
               - coalesce(sum(fires) filter (where feature = 'decide_tournament_preflop'), 0)
               as tournament_postflop,
             coalesce(jsonb_object_agg(substr(feature, 17), fires)
                        filter (where feature like 'phase13\_variant\_%'), '{}'::jsonb) as by_variant
        from horse_brain_telemetry
       where day between p_day - 7 and p_day
         and (feature in ('decide', 'decide_tournament', 'decide_tournament_preflop')
              or feature like 'phase13\_variant\_%')
       group by day
    ),
    bomb as (
      select (created_at at time zone 'UTC')::date as day, game_variant as variant, count(*) as hands
        from hand_history
       where bomb_pot is not null
         and created_at >= ((greatest(p_day - 7, v_hh_from))::timestamp at time zone 'UTC')
         and created_at <  ((p_day + 1)::timestamp at time zone 'UTC')
       group by 1, 2
    ),
    per_day as (
      select c.feature, d.day,
             coalesce(t.fires, 0) as fires,
             case c.basis
               when 'bomb_pot_hands' then
                 (select coalesce(sum(b.hands), 0) from bomb b
                   where b.day = d.day and (c.variants is null or b.variant = any(c.variants)))
               when 'tournament_postflop_decides' then coalesce(v.tournament_postflop, 0)
               else case
                      when c.variants is null then coalesce(v.decides, 0)
                      else (select coalesce(sum((v.by_variant->>x)::bigint), 0) from unnest(c.variants) x)
                    end
             end as units,
             (c.basis <> 'bomb_pot_hands' or d.day >= v_hh_from) as measurable
        from cand c
        cross join days d
        left join vol v on v.day = d.day
        left join horse_brain_telemetry t on t.day = d.day and t.feature = c.feature
    ),
    judged as (
      select c.feature, c.prior_days, c.prior_fires, c.last_fired, c.basis, c.variants,
             coalesce(sum(p.fires) filter (where p.day < p_day and p.measurable), 0) as base_fires,
             coalesce(sum(p.units) filter (where p.day < p_day and p.measurable), 0) as base_units,
             max(p.units) filter (where p.day = p_day and p.measurable) as today_units
        from cand c
        join per_day p on p.feature = c.feature
       group by c.feature, c.prior_days, c.prior_fires, c.last_fired, c.basis, c.variants
    )
    select j.*,
           case when j.base_units > 0 then j.base_fires::numeric / j.base_units end as rate,
           case when j.base_units > 0 and j.today_units is not null
                then j.base_fires::numeric * j.today_units / j.base_units
                else 0 end as expected
      from judged j
     order by j.prior_fires desc, j.feature
  loop
    v_is_fallback := r.feature = any(v_fallback_exact)
      or exists (select 1 from unnest(v_fallback_prefix) p where left(r.feature, length(p)) = p);
    if v_is_fallback then
      v_findings := v_findings || jsonb_build_object(
        'severity', 'info',
        'category', 'logic',
        'code', 'fallback_went_quiet',
        'title', 'Fallback ' || r.feature || ' fired ' || r.prior_fires ||
                 ' times in the previous week and ZERO on ' || p_day,
        'evidence', jsonb_build_object(
          'feature', r.feature,
          'prior_days_active', r.prior_days,
          'prior_fires', r.prior_fires,
          'last_fired', r.last_fired,
          'decide_fires', v_decides,
          'cause_not_determined', true
        ),
        'recommendation',
          'This counter names a degraded path (the legacy ICM heuristic, a ' ||
          'warming context, a solver-store miss), so zero is the intended ' ||
          'direction and this is not a warning. It does NOT by itself mean the ' ||
          'primary path covered every spot - this check cannot tell that from ' ||
          'the whole lane having been retired by a deploy, and the two look ' ||
          'identical here. Separate them in one step: if the fallback primary ' ||
          'is still firing today the coverage reading is the right one; if the ' ||
          'primary also read zero, or its feature name no longer appears in ' ||
          'server/src, the lane was retired and this counter should be deleted ' ||
          'with it. Measured 2026-09-11: all three gto_miss_* counters reached ' ||
          'zero because PR #3849 removed their primary v31_gto_open on ' ||
          '2026-09-08 and repointed the read path at a certified store that ' ||
          'holds no rows - which is the opposite of coverage. If it starts ' ||
          'firing again the receipts audit will say so.'
      );
      continue;
    end if;

    v_basis_label := case when r.basis = 'decides' and r.variants is not null
                          then 'variant_decides' else r.basis end;

    if r.expected >= v_silent_min_expected then
      v_findings := v_findings || jsonb_build_object(
        'severity', 'warn',
        'category', 'logic',
        'code', 'layer_went_silent',
        'title', 'Layer ' || r.feature || ' fired ' || r.prior_fires ||
                 ' times in the previous week and ZERO on ' || p_day ||
                 ', where about ' || round(r.expected) || ' were expected at the day''s volume',
        'evidence', jsonb_build_object(
          'feature', r.feature,
          'prior_days_active', r.prior_days,
          'prior_fires', r.prior_fires,
          'last_fired', r.last_fired,
          'decide_fires', v_decides,
          'volume_basis', v_basis_label,
          'variants', to_jsonb(r.variants),
          'volume_today', r.today_units,
          'baseline_fires', r.base_fires,
          'baseline_volume', r.base_units,
          'fires_per_unit', round(r.rate, 6),
          'expected_today', round(r.expected, 1),
          'p_zero', case when r.expected >= 700 then 0 else exp(-(r.expected::double precision)) end,
          'min_expected_for_silent', v_silent_min_expected
        ),
        'recommendation',
          'This layer was executing and is not any more. Trace the gate: a flag ' ||
          'default, an upstream condition that can no longer be true, or a newer ' ||
          'layer returning before it. A retired layer is a valid answer - if the ' ||
          'feature name no longer exists in the source it is not a regression, ' ||
          'and this finding should be answered by deleting the counter. The zero ' ||
          'is improbable, not unlucky: at the fires per unit of volume this ' ||
          'counter showed over the previous week, the day''s volume ' ||
          '(evidence.volume_today, in evidence.volume_basis) predicted ' ||
          'evidence.expected_today fires, and the chance of reading none at ' ||
          'that rate is evidence.p_zero.'
      );
    else
      v_quiet_n := v_quiet_n + 1;
      if v_quiet_n <= v_quiet_listed then
        v_quiet := v_quiet || jsonb_build_array(jsonb_build_object(
          'feature', r.feature,
          'prior_fires', r.prior_fires,
          'last_fired', r.last_fired,
          'volume_basis', v_basis_label,
          'variants', to_jsonb(r.variants),
          'volume_today', r.today_units,
          'expected_today', round(r.expected, 2)
        ));
      end if;
    end if;
  end loop;

  if v_quiet_n > 0 then
    v_findings := v_findings || jsonb_build_object(
      'severity', 'note',
      'category', 'logic',
      'code', 'layer_quiet_at_low_volume',
      'title', v_quiet_n || ' layer counter(s) read zero on ' || p_day ||
               ' where the day''s volume made zero unsurprising',
      'evidence', jsonb_build_object(
        'count', v_quiet_n,
        'listed', least(v_quiet_n, v_quiet_listed),
        'min_expected_for_silent', v_silent_min_expected,
        'bomb_pot_volume_held_from', v_hh_from,
        'features', v_quiet
      ),
      'recommendation',
        'Not a defect and not a clean bill of health: this check could not ' ||
        'tell. Each counter listed read zero on a day when the volume it is ' ||
        'invoked on was too small for zero to mean anything - fewer than ' ||
        v_silent_min_expected || ' fires were expected at its own ' ||
        'previous-week rate, so an innocent zero had better than a 6 in a ' ||
        'million chance. Bomb-pot counters (the multiboard_owned_by_phase13 ' ||
        'reasons, phase13_board_2 and up, the v36 multi-board reads) are ' ||
        'measured against bomb-pot hands dealt in their variants, read from ' ||
        'hand_history; phase8 against tournament postflop decisions; ' ||
        'per-variant counters against phase13_variant_<variant>; everything ' ||
        'else against all decisions. volume_today null means hand_history no ' ||
        'longer holds that day in full. A counter here whose volume returns ' ||
        'and that still reads zero is reported as layer_went_silent. Measured ' ||
        '2026-09-20: the multiboard_owned_by_phase13 counters of plo4, plo6, ' ||
        'plo8 and pineapple read zero because those variants dealt zero ' ||
        'bomb-pot hands that day, while they still made 90,217, 48,426, ' ||
        '16,815 and 9,555 decisions.'
    );
  end if;

  -- 2. A layer that collapsed without going silent - REPORTED ON THE DAY OF
  --    THE STEP ONLY (2026-09-04).
  for r in
    with dec as (
      select day, sum(fires) filter (where feature = 'decide') as d
        from horse_brain_telemetry
       where day between p_day - 7 and p_day
       group by day
      having sum(fires) filter (where feature = 'decide') > 1000
    ),
    rate as (
      select t.feature, t.day, (t.fires::numeric * 1000) / dec.d as rate, t.fires
        from horse_brain_telemetry t
        join dec on dec.day = t.day
       where t.feature <> 'decide'
    ),
    cur  as (select feature, rate as cur_rate,  fires as cur_fires  from rate where day = p_day),
    prev as (select feature, rate as prev_rate, fires as prev_fires from rate where day = p_day - 1),
    base as (
      select feature,
             (percentile_cont(0.5) within group (order by rate))::numeric as med_rate,
             count(*) as n_days,
             sum(fires) as prior_fires
        from rate where day < p_day group by feature
    )
    select c.feature, c.cur_rate, c.cur_fires, b.med_rate, b.n_days, b.prior_fires,
           p.prev_rate, p.prev_fires
      from cur c
      join base b using (feature)
      left join prev p using (feature)
     where b.n_days >= 3
       and b.prior_fires >= 5000
       and b.med_rate > 0
       and c.cur_rate < b.med_rate * 0.40
       -- THE STEP MUST BE NEW. If yesterday was already below the line, this
       -- is the same step reported again - the median simply has not rolled
       -- past it yet. Reporting it daily for a week is what buried three real
       -- criticals under three false ones on 2026-09-01.
       and (p.prev_rate is null or p.prev_rate >= b.med_rate * 0.40)
       -- AND IT MUST ACTUALLY HAVE FALLEN. icm_legacy went 441 -> 641 fires
       -- and v16_unblocker 2,428 -> 2,512 on the day they were both reported
       -- as collapsing. A layer whose raw count rose is not collapsing today,
       -- whatever a median that straddles a deploy says.
       and (p.prev_fires is null or c.cur_fires < p.prev_fires)
     order by (1 - c.cur_rate / b.med_rate) desc
  loop
    v_findings := v_findings || jsonb_build_object(
      'severity', 'warn',
      'category', 'logic',
      'code', 'layer_fire_collapse',
      'title', 'Layer ' || r.feature || ' fell to ' ||
               round(100 * (1 - r.cur_rate / r.med_rate)) || '% below its usual rate',
      'evidence', jsonb_build_object(
        'feature', r.feature,
        'rate_per_1k_today', round(r.cur_rate, 2),
        'rate_per_1k_yesterday', round(coalesce(r.prev_rate, 0), 2),
        'rate_per_1k_median', round(r.med_rate, 2),
        'pct_drop', round(100 * (1 - r.cur_rate / r.med_rate)),
        'fires_today', r.cur_fires,
        'fires_yesterday', coalesce(r.prev_fires, 0),
        'prior_fires', r.prior_fires,
        'baseline_days', r.n_days,
        'step_day', p_day
      ),
      'recommendation',
        'Reported ONLY on the day the step happened: yesterday was still near ' ||
        'the median and the raw count fell today, so this is new rather than a ' ||
        'week-old change the median has not caught up with. Measured per 1,000 ' ||
        'decisions, so fleet volume is already divided out. Two innocent ' ||
        'explanations remain and both are worth confirming rather than ' ||
        'assuming: a SUPERSEDED layer legitimately declining (icm_legacy as ' ||
        'icm_real took over), and a newer layer that RETURNS EARLY displacing ' ||
        'the ones below it (V32 did exactly that to v16_reads_tell and ' ||
        'v16_unblocker on 2026-08-31). The third explanation is a broken gate.'
    );
  end loop;

  return v_findings;
end
$function$;

-- OPERATOR TELEMETRY, NOT PLAYER SURFACE. CREATE OR REPLACE keeps the owner
-- and the grants; they are restated so the file says what production holds
-- (postgres and service_role EXECUTE, nothing else). PUBLIC is named as well
-- as the roles because anon inherits whatever PUBLIC holds.
REVOKE ALL ON FUNCTION public.fn_audit_layer_drift(date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_audit_layer_drift(date) TO service_role;

COMMIT;
