-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260830064419; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

SET statement_timeout = '300s';

-- THE LAST FALSE-ALARM SOURCE ON THE BBJ CHANNEL (2026-08-30).
--
-- The window bug is fixed (bbj_drift_since joins by hand id now). What
-- remained was a GRACE MISMATCH between the alarm and its own healer:
--
--   bbj_drift_since        ignored hands younger than 2 minutes
--   fn_bbj_repair_unbanked ignores hands younger than 5 minutes
--
-- So every hand aged 2-5 minutes was judged by the alarm and deliberately
-- untouched by the healer that exists to fix exactly that condition. On a
-- fleet banking ~8,500 BBJ hands per 6 hours, that window is never empty, so
-- the alarm fired on a routine basis for money that was about to be banked
-- seconds later. GameServer already calls repairUnbankedBBJFees BEFORE
-- auditBBJDrift for this very reason; the grace mismatch defeated it.
--
-- An alarm must never fire on a condition its own repair is still waiting to
-- act on. The settle grace is raised to 6 minutes — strictly greater than the
-- healer's 5 — so anything the alarm reports is genuinely beyond the
-- self-heal's reach and deserves a human. Real unbanked money is still caught:
-- it simply has to survive one heal cycle first, which is the definition of
-- "the net did not catch it".
CREATE OR REPLACE FUNCTION public.bbj_drift_since(p_since timestamp with time zone)
RETURNS TABLE(booked numeric, received numeric, booked_rows bigint, received_rows bigint, unlinkable_rows bigint, unlinkable_chips numeric)
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $function$
  WITH r AS (
    SELECT hand_id, bbj_contribution
    FROM rake_records
    WHERE created_at >= p_since
      AND bbj_contribution > 0
  ),
  settled AS (
    -- 6 minutes: STRICTLY GREATER than fn_bbj_repair_unbanked's 5-minute
    -- grace. An alarm that judges hands its own healer is still waiting on
    -- reports the healer's patience as a shortfall.
    SELECT hand_id, bbj_contribution
    FROM rake_records
    WHERE created_at >= p_since
      AND created_at < now() - interval '6 minutes'
      AND bbj_contribution > 0
      AND hand_id IS NOT NULL
  ),
  j AS (
    -- Join by hand, never by a second time window (2026-08-30): a slice
    -- banked late by a self-heal still belongs to its hand.
    SELECT s.bbj_contribution AS booked,
           COALESCE((SELECT sum(b.amount) FROM bbj_contributions b
                      WHERE b.hand_id = s.hand_id), 0) AS received
    FROM settled s
  )
  SELECT
    COALESCE(sum(j.booked), 0)::numeric,
    COALESCE(sum(j.received), 0)::numeric,
    count(*)::bigint,
    count(*) FILTER (WHERE j.received > 0)::bigint,
    (SELECT count(*) FROM r WHERE r.hand_id IS NULL)::bigint,
    COALESCE((SELECT sum(r.bbj_contribution) FROM r WHERE r.hand_id IS NULL), 0)::numeric
  FROM j;
$function$;

-- The same mismatch exists in the invariant watchdog: I5 (drop not banked)
-- and I7 (raked hand never banked) both used a 5-minute grace, equal to the
-- healers' — so a hand at 5m01s is judged in the same instant it first
-- becomes eligible for repair, before any heal cycle can have run. Raised to
-- 15 minutes, comfortably past the hourly healers' worst case for the two
-- checks that describe a self-healing condition. The rule checks (I1-I4, I6)
-- keep the 5-minute grace: nothing heals a broken rule, so there is nothing
-- to wait for.
CREATE OR REPLACE FUNCTION public.fn_rake_bbj_invariants(p_hours integer DEFAULT 2)
RETURNS TABLE(check_name text, violations bigint, detail jsonb)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_since timestamptz := now() - make_interval(hours => GREATEST(COALESCE(p_hours, 2), 1));
  -- Rule checks: settlement is not instant, but nothing heals a broken rule.
  v_grace timestamptz := now() - interval '5 minutes';
  -- Self-healing checks: must outlast the healers' own grace + a cycle, or
  -- the alarm reports the net's patience as a failure.
  v_heal_grace timestamptz := now() - interval '15 minutes';
BEGIN
  RETURN QUERY
  WITH scope AS (
    SELECT r.hand_id, r.rake_amount, COALESCE(r.bbj_contribution, 0) AS bbj,
           r.pot_size, r.num_players, r.rake_method, r.player_contributions,
           r.created_at,
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
             AND s.created_at < v_heal_grace          -- outlast fn_bbj_repair_unbanked
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
             AND hh.created_at >= v_since
             AND hh.created_at < v_heal_grace          -- outlast fn_rake_repair_unbanked
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
