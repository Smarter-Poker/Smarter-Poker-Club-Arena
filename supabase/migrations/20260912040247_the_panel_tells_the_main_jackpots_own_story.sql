-- ═══════════════════════════════════════════════════════════════════════════
--  THE PANEL TELLS THE MAIN JACKPOT'S OWN STORY
--  BBJ programme, post-audit phase 5 of 5, enhancement pass (2026-09-12)
-- ═══════════════════════════════════════════════════════════════════════════
--
--  Seen on a real screen for the first time on 2026-09-12, the Jackpot Health
--  panel told a club owner that his jackpot hits **every 0.2 days**.
--
--  It does not. `fn_bbj_analytics` computes `hit_count` and
--  `avg_days_between_hits` over every row in `bbj_winners` for the pool, and
--  since phase 6 that table holds TWO jackpots: the main, which pays six
--  figures every week or two, and the mini, which pays a few hundred chips
--  several times a day out of the backup reserve. Blending them produces a
--  cadence that describes neither.
--
--  MEASURED ON PRODUCTION TODAY, per pool:
--
--    pool                  hits  mini  main   shown        main only
--    Deep Stack Society      18    14     4   0.22 days    1.15 days
--    Midway Union            14     7     7   3.94 days    8.10 days
--    Club JAQK               24     0    24   1.09 days    1.09 days
--
--  So the number an operator reads when asking "when is the big one due" is
--  five times too optimistic on one pool and twice on another, and exactly
--  right on the third - which is the pool that has no minis. A figure that is
--  correct only where the feature it ignores is absent is not a rounding
--  problem, it is the wrong question being answered confidently.
--
--  `last_hit_at` and `days_since_last_hit` have the same flaw: on Midway Union
--  the panel says the jackpot paid 2.95 days ago counting minis, when the MAIN
--  jackpot last paid 8 days before that.
--
--  ── WHAT THIS ADDS ────────────────────────────────────────────────────────
--
--  Five main-only columns beside the mini-only ones phase 6 already added, so
--  the panel can state each jackpot's own cadence instead of an average of
--  two unlike things:
--
--    main_hit_count, main_paid_all_time, main_avg_days_between_hits,
--    main_last_hit_at, main_days_since_last_hit
--
--  plus `hands_30d`, because the refusal list beside it reports a THIRTY-day
--  window and the only hand count the function offered was seven days. The
--  panel was printing "no hand was refused in 30 days, across N hands in the
--  last 7 days" - two windows in one sentence, which is a denominator that
--  does not belong to its numerator.
--
--  The existing columns are UNCHANGED and still count both kinds. They are
--  read by this panel and possibly elsewhere; redefining what `hit_count`
--  means would silently move every other reader's number. The new columns are
--  additive and the panel chooses.
--
--  ── WHY DROP AND CREATE, AND WHY IT IS SAFE ───────────────────────────────
--
--  `CREATE OR REPLACE FUNCTION` cannot change a RETURNS TABLE signature, so
--  the function is dropped and recreated INSIDE ONE TRANSACTION: there is no
--  instant at which a caller finds it missing, because nothing outside this
--  transaction can see the drop until it commits. The grants are re-applied in
--  the same transaction and asserted afterwards - read from the live catalogue
--  first (authenticated, service_role, postgres; NOT anon) so the restoration
--  is what was actually there rather than what I assumed.
--
--  Production DDL policy: one migration, one transaction, applied once outside
--  the :50-:03 break window.
--
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

DROP FUNCTION IF EXISTS public.fn_bbj_analytics(uuid);

CREATE FUNCTION public.fn_bbj_analytics(p_pool_id uuid)
RETURNS TABLE(
  main_balance numeric, backup_balance numeric, promo_balance numeric,
  contributions_24h numeric, contributions_7d numeric, contributions_30d numeric,
  hands_24h bigint, hands_7d bigint,
  total_contributed_all_time numeric,
  hit_count bigint, total_paid_all_time numeric, biggest_hit numeric,
  last_hit_at timestamptz, avg_days_between_hits numeric,
  days_since_last_hit numeric, net_pool_position numeric,
  mini_enabled boolean, mini_hit_count bigint, mini_paid_all_time numeric,
  mini_hits_30d bigint, mini_paid_30d numeric, mini_last_hit_at timestamptz,
  mini_reserve_floor numeric, mini_parked numeric, mini_available numeric,
  /* NEW, and additive on purpose - see the header. */
  hands_30d bigint,
  main_hit_count bigint, main_paid_all_time numeric,
  main_avg_days_between_hits numeric, main_last_hit_at timestamptz,
  main_days_since_last_hit numeric
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_club_id uuid;
  v_union_id uuid;
  v_allowed boolean := false;
BEGIN
  SELECT bp.club_id, bp.union_id INTO v_club_id, v_union_id
  FROM public.bbj_pools bp WHERE bp.id = p_pool_id;

  IF v_club_id IS NULL AND v_union_id IS NULL THEN
    RAISE EXCEPTION 'BBJ pool not found';
  END IF;

  -- Admin of the owning club, or of ANY club in the owning union.
  IF v_club_id IS NOT NULL THEN
    v_allowed := public.fn_is_club_admin_uid(v_club_id);
  ELSE
    SELECT EXISTS (
      SELECT 1 FROM public.clubs c
      WHERE c.union_id = v_union_id
        AND public.fn_is_club_admin_uid(c.id)
    ) INTO v_allowed;
  END IF;

  IF NOT v_allowed THEN
    RAISE EXCEPTION 'Not authorized: club admin role required for this jackpot pool';
  END IF;

  RETURN QUERY
  WITH pool AS (
    SELECT bp.main_balance, bp.backup_balance, bp.promo_balance,
           COALESCE(bp.mini_reserve_floor, 0) AS reserve_floor
    FROM public.bbj_pools bp WHERE bp.id = p_pool_id
  ),
  contrib AS (
    SELECT
      COALESCE(SUM(amount) FILTER (WHERE created_at > now() - interval '24 hours'), 0) AS c24,
      COALESCE(SUM(amount) FILTER (WHERE created_at > now() - interval '7 days'), 0) AS c7,
      COALESCE(SUM(amount) FILTER (WHERE created_at > now() - interval '30 days'), 0) AS c30,
      COUNT(*) FILTER (WHERE created_at > now() - interval '24 hours') AS h24,
      COUNT(*) FILTER (WHERE created_at > now() - interval '7 days') AS h7,
      COUNT(*) FILTER (WHERE created_at > now() - interval '30 days') AS h30,
      COALESCE(SUM(amount), 0) AS call_time
    FROM public.bbj_contributions WHERE pool_id = p_pool_id
  ),
  hits AS (
    SELECT
      COUNT(*) AS n,
      COALESCE(SUM(total_payout), 0) AS paid,
      COALESCE(MAX(total_payout), 0) AS biggest,
      MAX(awarded_at) AS last_at,
      MIN(awarded_at) AS first_at
    FROM public.bbj_winners WHERE pool_id = p_pool_id
  ),
  /* THE MAIN JACKPOT ON ITS OWN. A row written before the mini existed has a
     NULL kind and is a main hit - the same COALESCE every other BBJ surface
     applies to this column. */
  main_only AS (
    SELECT
      COUNT(*) AS n,
      COALESCE(SUM(total_payout), 0) AS paid,
      MAX(awarded_at) AS last_at,
      MIN(awarded_at) AS first_at
    FROM public.bbj_winners
    WHERE pool_id = p_pool_id AND COALESCE(kind, 'main') = 'main'
  ),
  mini AS (
    SELECT
      COUNT(*) AS n,
      COALESCE(SUM(total_payout), 0) AS paid,
      COUNT(*) FILTER (WHERE awarded_at > now() - interval '30 days') AS n30,
      COALESCE(SUM(total_payout) FILTER (WHERE awarded_at > now() - interval '30 days'), 0) AS paid30,
      MAX(awarded_at) AS last_at
    FROM public.bbj_winners WHERE pool_id = p_pool_id AND kind = 'mini'
  ),
  parked AS (
    SELECT public.fn_bbj_parked_reserve(p_pool_id, 'backup') AS amt
  )
  SELECT
    p.main_balance,
    p.backup_balance,
    p.promo_balance,
    c.c24, c.c7, c.c30,
    c.h24, c.h7,
    c.call_time,
    h.n, h.paid, h.biggest, h.last_at,
    CASE WHEN h.n > 1
      THEN ROUND(EXTRACT(EPOCH FROM (h.last_at - h.first_at)) / 86400.0 / (h.n - 1), 2)
      ELSE NULL END,
    CASE WHEN h.last_at IS NOT NULL
      THEN ROUND(EXTRACT(EPOCH FROM (now() - h.last_at)) / 86400.0, 2)
      ELSE NULL END,
    ROUND(c.call_time - h.paid, 2),
    EXISTS (SELECT 1 FROM public.bbj_mini_tiers t WHERE t.enabled),
    m.n, m.paid, m.n30, m.paid30, m.last_at,
    p.reserve_floor,
    pk.amt,
    GREATEST(0, COALESCE(p.backup_balance, 0) - pk.amt - p.reserve_floor),
    c.h30,
    mo.n,
    mo.paid,
    CASE WHEN mo.n > 1
      THEN ROUND(EXTRACT(EPOCH FROM (mo.last_at - mo.first_at)) / 86400.0 / (mo.n - 1), 2)
      ELSE NULL END,
    mo.last_at,
    CASE WHEN mo.last_at IS NOT NULL
      THEN ROUND(EXTRACT(EPOCH FROM (now() - mo.last_at)) / 86400.0, 2)
      ELSE NULL END
  FROM pool p, contrib c, hits h, mini m, main_only mo, parked pk;
END;
$function$;

COMMENT ON FUNCTION public.fn_bbj_analytics(uuid) IS
  'Jackpot health for one pool, for a club admin of that pool or of any club in its union. Computes from the authoritative ledgers (bbj_contributions + bbj_winners), never the legacy pool counters. hit_count / avg_days_between_hits / last_hit_at count BOTH jackpots and are kept that way so no existing reader''s number moves; main_* and mini_* give each jackpot its own cadence. Blending them told one club its jackpot hit every 0.2 days when the main jackpot''s own interval was 1.15.';

REVOKE ALL ON FUNCTION public.fn_bbj_analytics(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_bbj_analytics(uuid) TO authenticated, service_role;

DO $$
DECLARE
  v_cols int;
BEGIN
  /* The new columns exist and the old ones survived the drop. */
  SELECT count(*) INTO v_cols
    FROM unnest(string_to_array(
           pg_get_function_result('public.fn_bbj_analytics(uuid)'::regprocedure), ',')) col
   WHERE col ILIKE '%main_hit_count%' OR col ILIKE '%main_avg_days_between_hits%'
      OR col ILIKE '%main_last_hit_at%' OR col ILIKE '%main_days_since_last_hit%'
      OR col ILIKE '%main_paid_all_time%' OR col ILIKE '%hands_30d%';
  IF v_cols <> 6 THEN
    RAISE EXCEPTION 'expected 6 new analytics columns, found %', v_cols;
  END IF;

  IF pg_get_function_result('public.fn_bbj_analytics(uuid)'::regprocedure) NOT ILIKE '%mini_available%' THEN
    RAISE EXCEPTION 'the drop-and-create lost the mini columns';
  END IF;

  /* THE GRANTS ARE BACK, EXACTLY. A dropped function takes its grants with
     it; restoring them is part of this migration, not a follow-up. */
  IF NOT has_function_privilege('authenticated', 'public.fn_bbj_analytics(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'authenticated lost EXECUTE on fn_bbj_analytics - the panel would be blank for every operator';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.fn_bbj_analytics(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'service_role lost EXECUTE on fn_bbj_analytics';
  END IF;
  IF has_function_privilege('anon', 'public.fn_bbj_analytics(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'a signed-out visitor can read jackpot analytics';
  END IF;
END $$;

COMMIT;
