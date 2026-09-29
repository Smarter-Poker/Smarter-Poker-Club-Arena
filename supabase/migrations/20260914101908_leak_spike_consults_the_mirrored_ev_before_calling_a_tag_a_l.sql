-- 20260914101908_leak_spike_consults_the_mirrored_ev_before_calling_a_tag_a_l.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- `leak_tag_spike` calls a tag a leak on the strength of a LOSS-ONLY count.
-- The same audit run already knows better. fn_audit_river_aggression_ev reads
-- fn_horse_tag_ev, which pairs every `<tag>` with its `<tag>_won` mirror and
-- ranks the situation across BOTH outcomes - and that function's own
-- recommendation text says why, in as many words: "Ranked by bb per hand
-- across BOTH outcomes, which is the only honest ranking: a loss-only total
-- ranks situations by how often they occur in big pots."
--
-- The spike detector is that loss-only total, and on 2026-09-13 it produced
-- three warnings and every one of them was wrong. Measured on the live
-- seven-day window at the moment this was written:
--
--   straight_into_flush_stackoff       +18.30 bb/hand   2342 hands   69.0% won
--   nonnut_straight_stackoff           +27.18 bb/hand   2080 hands   78.9% won
--   straight_into_flush_stackoff_won   (the WIN side of the first pair,
--                                       reported as a "leak tag" that "spiked")
--
-- Those are two of the fleet's most profitable situations, and the third
-- finding warned that winning was happening more often than usual. An agent
-- following the recommendation ("a spike after a deploy means the brain
-- regressed on this pattern") would tune the horses AWAY from +18 and +27
-- bb/hand spots. For contrast the detector is right about
-- dominated_straight_stackoff, which fn_horse_tag_ev puts at -3.71 bb/hand -
-- so the fix is not to silence the detector, it is to make it read the number
-- the audit has already computed.
--
-- CLAUDE.md 10.86 rule 1: "I could not tell" is a distinct outcome and must
-- have its own name. There are three outcomes here, not two - the mirrored EV
-- is positive (not a leak), negative (a leak), or unavailable - and
-- `mirrored_bb_per_hand` is now carried in the evidence of every spike finding
-- so the reader can see which one they have. It is null when the situation has
-- under 100 hands in seven days or has no winning mirror at all (the fold
-- family), and in that case the original warn/critical behaviour is unchanged.
--
-- This does not repair anything and it is not a new detector (10.11 / 10.12) -
-- it stops an existing detector asserting a cause it never checked.
--
-- HOW: the body is patched by an asserted, single-occurrence text replacement
-- rather than by retyping all 16,464 characters of the function, so every line
-- outside the replaced block is provably byte-identical to what production
-- holds. The observed pre-image was md5 4a153233b1f149ee52a6932b54393342. The
-- migration aborts, changing nothing, if the block is not found exactly once.
--
-- COST: fn_horse_tag_ev is called once per SPIKING tag (not per tag), measured
-- at 77ms, and only tags with 20+ flagged hands that also cleared the 1.5x
-- baseline reach it - three on 2026-09-13. The function's 60s statement_timeout
-- is unchanged and is not at risk.
--
-- One transaction (production DDL policy rule 1). One function, no table DDL,
-- no foreign key, no lock on a hot relation (rule 7). Signature, volatility,
-- security, search_path and statement_timeout are carried over unchanged by
-- construction, because they are part of the text being patched.

BEGIN;

DO $mig$
DECLARE
  v_def text;
  v_new text;
  v_hits int;
  v_old_block constant text := $blk_old$      elsif r.base_rate is not null
            and (r.base_rate = 0 or r.day_rate > r.base_rate * 1.5) then
        v_findings := v_findings || jsonb_build_object(
          'severity', case when r.base_rate = 0 or r.day_rate > r.base_rate * 2.5 then 'critical' else 'warn' end,
          'category','logic','code','leak_tag_spike',
          'title','Leak tag ' || r.tag || ' spiked',
          'evidence', jsonb_build_object(
            'tag', r.tag,
            'count', r.cnt,
            'rate_per_1k', round(r.day_rate, 2),
            'baseline_rate_per_1k', round(r.base_rate, 2),
            'baseline_days', r.tag_base_days,
            'day_hands', v_day_hands,
            'baseline_hands', r.tag_base_hands),
          'recommendation','Rates are per 1,000 captured hands on both sides and the baseline counts only days this detector was live, so this is neither a volume artifact nor a new-detector artifact. A spike after a deploy means the brain regressed on this pattern. Diff the day''s engine deploys against the tag definition and sample flagged hands carrying it.');
      end if;$blk_old$;
  v_new_block constant text := $blk_new$      elsif r.base_rate is not null
            and (r.base_rate = 0 or r.day_rate > r.base_rate * 1.5) then
        declare
          /*
           * A RISE IS NOT A LEAK UNTIL THE MIRRORED EV SAYS SO (2026-09-14).
           * The count above is the LOSS side only. fn_horse_tag_ev pairs it
           * with its _won mirror over seven days, which is the ranking
           * fn_audit_river_aggression_ev already treats as the honest one. A
           * situation that is winning money did not regress because it
           * happened more often. Null means under 100 hands in the window, or
           * the fold family, which has no winning mirror by construction -
           * then the original warn stands, because nothing contradicted it.
           */
          v_situation text := case
            when r.tag like '%\_won'  then left(r.tag, length(r.tag) - 4)
            when r.tag like '%\_lost' then left(r.tag, length(r.tag) - 5)
            else r.tag
          end;
          v_ev_bb    numeric;
          v_ev_hands bigint;
          v_ev_win   numeric;
        begin
          select e.bb_per_hand, e.hands, e.win_rate
            into v_ev_bb, v_ev_hands, v_ev_win
            from fn_horse_tag_ev(p_day - 6) e
           where e.situation = v_situation and e.mirrored
           limit 1;

          if v_ev_bb is not null and v_ev_bb >= 0 then
            v_findings := v_findings || jsonb_build_object(
              'severity','info','category','gto','code','leak_tag_spike_positive_ev',
              'title','Leak tag ' || r.tag || ' rose, and its mirrored situation is WINNING ' || v_ev_bb || 'bb per hand',
              'evidence', jsonb_build_object(
                'tag', r.tag,
                'situation', v_situation,
                'count', r.cnt,
                'rate_per_1k', round(r.day_rate, 2),
                'baseline_rate_per_1k', round(r.base_rate, 2),
                'baseline_days', r.tag_base_days,
                'day_hands', v_day_hands,
                'baseline_hands', r.tag_base_hands,
                'mirrored_bb_per_hand', v_ev_bb,
                'mirrored_hands', v_ev_hands,
                'mirrored_win_rate', v_ev_win),
              'recommendation','Counted on the loss side alone this rose, which is what the spike threshold saw. Counted on BOTH sides over seven days it MAKES money, so the rise is the fleet reaching the spot more often, not the brain regressing into it. Do not tune away from it on this finding and do not open a league matchup for it. It becomes a real warning on its own the day fn_horse_tag_ev turns the situation negative.');
          else
            v_findings := v_findings || jsonb_build_object(
              'severity', case when r.base_rate = 0 or r.day_rate > r.base_rate * 2.5 then 'critical' else 'warn' end,
              'category','logic','code','leak_tag_spike',
              'title','Leak tag ' || r.tag || ' spiked',
              'evidence', jsonb_build_object(
                'tag', r.tag,
                'count', r.cnt,
                'rate_per_1k', round(r.day_rate, 2),
                'baseline_rate_per_1k', round(r.base_rate, 2),
                'baseline_days', r.tag_base_days,
                'day_hands', v_day_hands,
                'baseline_hands', r.tag_base_hands,
                'mirrored_bb_per_hand', v_ev_bb,
                'mirrored_hands', v_ev_hands),
              'recommendation','Rates are per 1,000 captured hands on both sides and the baseline counts only days this detector was live, so this is neither a volume artifact nor a new-detector artifact. mirrored_bb_per_hand is the seven-day EV across BOTH outcomes: negative confirms a real leak, and null means the situation has under 100 hands in the window or has no winning mirror (the fold family), so the rise is unexplained rather than confirmed. A spike after a deploy means the brain regressed on this pattern. Diff the day''s engine deploys against the tag definition and sample flagged hands carrying it.');
          end if;
        end;
      end if;$blk_new$;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_run_horse_daily_audit';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'fn_run_horse_daily_audit does not exist - nothing to patch';
  END IF;

  -- Already carrying the fix: a replay of this migration must be a no-op
  -- rather than an abort.
  IF position('leak_tag_spike_positive_ev' in v_def) > 0 THEN
    RAISE NOTICE 'fn_run_horse_daily_audit already consults the mirrored EV - no change';
    RETURN;
  END IF;

  -- Exact occurrence count of the pre-image block. Zero means the body has
  -- drifted from what this migration was written against; more than one means
  -- the replace would touch somewhere it was never read.
  v_hits := (length(v_def) - length(replace(v_def, v_old_block, ''))) / length(v_old_block);
  IF v_hits <> 1 THEN
    RAISE EXCEPTION 'expected the leak_tag_spike block exactly once, found % (observed md5 %) - refusing to patch', v_hits, md5(v_def);
  END IF;

  v_new := replace(v_def, v_old_block, v_new_block);

  IF v_new = v_def THEN
    RAISE EXCEPTION 'replacement was a no-op';
  END IF;
  IF position('leak_tag_spike_positive_ev' in v_new) = 0 THEN
    RAISE EXCEPTION 'patched body is missing the new code path';
  END IF;
  IF position('code'',''leak_tag_spike''' in v_new) = 0 THEN
    RAISE EXCEPTION 'patched body lost the original leak_tag_spike path';
  END IF;

  EXECUTE v_new;
END
$mig$;

-- Post-apply assertion: production holds the patched body, both paths present.
DO $chk$
DECLARE
  v text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_run_horse_daily_audit';

  IF position('leak_tag_spike_positive_ev' in v) = 0 THEN
    RAISE EXCEPTION 'post-apply: the mirrored-EV path is absent';
  END IF;
  IF position('fn_horse_tag_ev(p_day - 6)' in v) = 0 THEN
    RAISE EXCEPTION 'post-apply: the mirrored-EV lookup is absent';
  END IF;
  IF position('code'',''leak_tag_spike''' in v) = 0 THEN
    RAISE EXCEPTION 'post-apply: the original leak_tag_spike path is absent';
  END IF;
END
$chk$;

COMMIT;
