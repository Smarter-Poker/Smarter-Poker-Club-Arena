-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260830033734; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

SET statement_timeout = '300s';

-- ═══════════════════════════════════════════════════════════════════════════
-- RAKE + BBJ COLLECTION INVARIANTS — the production-side half of the law
-- (Dan 2026-08-29: "harden the rake and bbj process collection and tracking
--  so it can't regress or break ever.")
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The engine-side law lives in server/src/engine/RakeBBJCollection.law.test.ts.
-- Tests prove the CODE is right at merge time; this proves the DATA is right
-- every hour, forever, including after a config change, a bad deploy, a
-- restart, or a hand-written SQL fix nobody tested.
--
-- Every check below is a bug that shipped or a hole the sweep found:
--   I1  drop taken with fewer than 3 players dealt in            (rule break)
--   I2  drop taken on a BBJ-ineligible variant                   (rule break)
--   I3  rake + drop exceeds the pot                              (mints chips)
--   I4  eligible flopped hand charged NO drop                    (the 49% bug)
--   I5  drop collected but never banked to a jackpot pool        (chips lost)
--   I6  weighted hand whose per-player ledger != rake collected  (attribution)
--   I7  raked hand with no banking row at all                    (engine died)
--
-- Reports only — it never "fixes" money silently. Findings become ONE
-- financial_alerts row per cycle, severity by blast radius, so the alarm
-- channel stays readable (the 2026-08-22 noise lesson).
CREATE OR REPLACE FUNCTION public.fn_rake_bbj_invariants(p_hours integer DEFAULT 2)
RETURNS TABLE(check_name text, violations bigint, detail jsonb)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_since timestamptz := now() - make_interval(hours => GREATEST(COALESCE(p_hours, 2), 1));
  -- Settlement is not instant; never judge a hand younger than this.
  v_grace timestamptz := now() - interval '5 minutes';
BEGIN
  RETURN QUERY
  WITH scope AS (
    SELECT r.hand_id, r.rake_amount, COALESCE(r.bbj_contribution, 0) AS bbj,
           r.pot_size, r.num_players, r.rake_method, r.player_contributions,
           t.big_blind, t.club_id,
           lower(COALESCE(hh.game_variant, t.game_variant::text)) AS variant,
           COALESCE(array_length(hh.community_cards, 1), 0) AS board
      FROM rake_records r
      JOIN tables t ON t.id = r.table_id
      LEFT JOIN hand_history hh ON hh.id = r.hand_id
     WHERE r.source = 'atomic_distribute_rake'
       AND r.created_at >= v_since AND r.created_at < v_grace
       AND t.tournament_id IS NULL AND r.is_tournament IS NOT TRUE
  )
  SELECT 'I1_drop_under_3_dealt'::text, count(*)::bigint,
         COALESCE(jsonb_agg(jsonb_build_object('hand', hand_id, 'n', num_players)) FILTER (WHERE true), '[]'::jsonb)
    FROM (SELECT hand_id, num_players FROM scope
           WHERE bbj > 0 AND num_players IS NOT NULL AND num_players < 3 LIMIT 20) x
  UNION ALL
  SELECT 'I2_drop_on_ineligible_variant', count(*)::bigint,
         COALESCE(jsonb_agg(jsonb_build_object('hand', hand_id, 'variant', variant)), '[]'::jsonb)
    FROM (SELECT hand_id, variant FROM scope
           WHERE bbj > 0 AND variant IN ('plo6','short_deck') LIMIT 20) x
  UNION ALL
  SELECT 'I3_deductions_exceed_pot', count(*)::bigint,
         COALESCE(jsonb_agg(jsonb_build_object('hand', hand_id, 'pot', pot_size, 'take', take)), '[]'::jsonb)
    FROM (SELECT hand_id, pot_size, rake_amount + bbj AS take FROM scope
           WHERE pot_size IS NOT NULL AND pot_size > 0
             AND rake_amount + bbj > pot_size + 0.001 LIMIT 20) x
  UNION ALL
  SELECT 'I4_eligible_flop_no_drop', count(*)::bigint,
         COALESCE(jsonb_agg(jsonb_build_object('hand', hand_id, 'n', num_players, 'board', board)), '[]'::jsonb)
    FROM (SELECT hand_id, num_players, board FROM scope
           WHERE bbj = 0 AND board >= 3 AND num_players >= 3
             AND variant NOT IN ('plo6','short_deck') LIMIT 20) x
  UNION ALL
  SELECT 'I5_drop_not_banked_to_pool', count(*)::bigint,
         COALESCE(jsonb_agg(jsonb_build_object('hand', hand_id, 'bbj', bbj)), '[]'::jsonb)
    FROM (SELECT s.hand_id, s.bbj FROM scope s
           WHERE s.bbj > 0 AND s.hand_id IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM bbj_contributions b
                              WHERE b.hand_id = s.hand_id
                                AND abs(b.amount - s.bbj) <= 0.01) LIMIT 20) x
  UNION ALL
  SELECT 'I6_ledger_not_reconciled', count(*)::bigint,
         COALESCE(jsonb_agg(jsonb_build_object('hand', hand_id, 'rake', rake_amount, 'alloc', alloc)), '[]'::jsonb)
    FROM (SELECT s.hand_id, s.rake_amount,
                 (SELECT COALESCE(SUM(ra.weighted_rake_credit), 0)
                    FROM rake_attributions ra WHERE ra.hand_id = s.hand_id) AS alloc
            FROM scope s
           WHERE s.rake_method = 'WEIGHTED_CONTRIBUTED' AND s.rake_amount > 0
             AND s.hand_id IS NOT NULL AND s.player_contributions IS NOT NULL
             AND round((SELECT COALESCE(SUM(ra.weighted_rake_credit), 0)
                          FROM rake_attributions ra WHERE ra.hand_id = s.hand_id), 2)
                 <> round(s.rake_amount, 2) LIMIT 20) x
  UNION ALL
  SELECT 'I7_raked_hand_never_banked', count(*)::bigint,
         COALESCE(jsonb_agg(jsonb_build_object('hand', id, 'rake', rake_amount)), '[]'::jsonb)
    FROM (SELECT hh.id, hh.rake_amount
            FROM hand_history hh
            JOIN tables t ON t.id = hh.table_id
           WHERE hh.tournament_id IS NULL AND t.tournament_id IS NULL
             AND t.club_id IS NOT NULL AND hh.rake_amount > 0
             AND hh.created_at >= v_since AND hh.created_at < v_grace
             AND NOT EXISTS (SELECT 1 FROM rake_records rr WHERE rr.hand_id = hh.id)
             AND NOT EXISTS (SELECT 1 FROM rake_records rr2
                              WHERE rr2.table_id = hh.table_id
                                AND rr2.created_at BETWEEN hh.created_at - interval '2 hours'
                                                       AND hh.created_at + interval '12 hours'
                                AND rr2.metadata->>'hand_number' = hh.hand_number::text)
           LIMIT 20) x;
END $function$;

REVOKE ALL ON FUNCTION public.fn_rake_bbj_invariants(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_rake_bbj_invariants(integer) TO service_role;

-- The hourly auditor: run the invariants, file ONE alert when anything is
-- non-zero, resolve nothing on its own.
CREATE OR REPLACE FUNCTION public.fn_rake_bbj_audit(p_hours integer DEFAULT 2)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_rows jsonb;
  v_total bigint;
  v_money bigint;
BEGIN
  SELECT COALESCE(jsonb_object_agg(check_name, jsonb_build_object('n', violations, 'sample', detail)), '{}'::jsonb),
         COALESCE(SUM(violations), 0),
         COALESCE(SUM(violations) FILTER (WHERE check_name IN
           ('I3_deductions_exceed_pot','I5_drop_not_banked_to_pool','I7_raked_hand_never_banked')), 0)
    INTO v_rows, v_total, v_money
    FROM public.fn_rake_bbj_invariants(p_hours);

  IF v_total > 0 THEN
    INSERT INTO public.financial_alerts (severity, source, message, context)
    VALUES (CASE WHEN v_money > 0 THEN 'critical' ELSE 'warning' END,
            'fn_rake_bbj_audit',
            'RAKE_BBJ_INVARIANT_VIOLATION: ' || v_total ||
              ' violation(s) in the last ' || p_hours || 'h. The collection law is: drop on every ' ||
              'flop with 3+ dealt; deductions never exceed the pot; every fee banked and attributed.',
            v_rows);
  END IF;

  RETURN jsonb_build_object('checked_hours', p_hours, 'violations', v_total,
                            'money_violations', v_money, 'detail', v_rows);
END $function$;

REVOKE ALL ON FUNCTION public.fn_rake_bbj_audit(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_rake_bbj_audit(integer) TO service_role;

SELECT cron.schedule('rake-bbj-invariant-audit-hourly', '38 * * * *', $cron$
  select case
           when pg_try_advisory_lock(hashtext('rake-bbj-invariant-audit'))
             then (select (public.fn_rake_bbj_audit(2))::text)
           else 'skipped: previous run still in progress'
         end;
$cron$);
