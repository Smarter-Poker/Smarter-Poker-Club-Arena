-- Bible V8 §6.2, owner ruling 2026-08-18: one time bank grants 20 seconds.
--
-- The engine side of this shipped in cfa55e81 (PR #105). These two functions
-- were still converting a PURCHASED time bank at 15 seconds, which disagreed
-- with the engine in both directions:
--
--   * fn_time_bank_allowance handed out uses_remaining * 15 seconds of pool,
--     while each activation spends 20 — a bought bank was under-funded.
--   * fn_consume_time_bank did CEIL(seconds / 15), so one 20s activation burned
--     TWO purchased uses instead of one — a paying player lost half of what
--     they bought.
--
-- Nobody has bought a time bank yet (feature_purchases had 0 rows for
-- feature='time_bank_seconds' when this was written), so this was latent, not a
-- live loss. It is fixed now so it can never become one.
--
-- Verified against production in a rolled-back transaction: 3 purchased uses
-- grant 60s (was 45), and consuming 20s debits exactly 1 use (was 2).
--
-- The VIP monthly pool is denominated in SECONDS (cap 120/month) and needs no
-- conversion; at 20s per use that is 6 activations a month instead of 8.

CREATE OR REPLACE FUNCTION public.fn_time_bank_allowance(p_user_ids uuid[])
 RETURNS TABLE(user_id uuid, is_vip boolean, vip_seconds_remaining integer, purchased_seconds integer, extra_seconds integer)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH vip AS (
    SELECT p.id,
           (COALESCE(p.is_vip, false)
             AND (p.vip_expires_at IS NULL OR p.vip_expires_at > now())) AS is_vip
    FROM profiles p WHERE p.id = ANY(p_user_ids)
  ), monthly AS (
    SELECT m.user_id AS uid, COALESCE(SUM(m.usage_count),0)::int AS used
    FROM vip_feature_usage_monthly m
    WHERE m.user_id = ANY(p_user_ids)
      AND m.feature = 'time_bank_seconds'
      AND m.month = to_char(now() AT TIME ZONE 'UTC','YYYY-MM')
    GROUP BY 1
  ), bought AS (
    -- 20 seconds per purchased use (Bible V8 s6.2, 2026-08-18; was 15).
    SELECT fp.user_id AS uid, COALESCE(SUM(fp.uses_remaining),0)::int * 20 AS secs
    FROM feature_purchases fp
    WHERE fp.user_id = ANY(p_user_ids)
      AND fp.feature = 'time_bank_seconds'
      AND COALESCE(fp.uses_remaining,0) > 0
      AND (fp.expires_at IS NULL OR fp.expires_at > now())
    GROUP BY 1
  )
  SELECT v.id,
         v.is_vip,
         CASE WHEN v.is_vip THEN GREATEST(0, 120 - COALESCE(m.used,0)) ELSE 0 END,
         COALESCE(b.secs,0),
         CASE WHEN v.is_vip THEN GREATEST(0, 120 - COALESCE(m.used,0)) ELSE 0 END
           + COALESCE(b.secs,0)
  FROM vip v
  LEFT JOIN monthly m ON m.uid = v.id
  LEFT JOIN bought  b ON b.uid = v.id;
$function$;

CREATE OR REPLACE FUNCTION public.fn_consume_time_bank(p_user_id uuid, p_seconds integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_is_vip boolean;
  v_month text := to_char(now() AT TIME ZONE 'UTC','YYYY-MM');
  v_used int;
  v_from_vip int := 0;
  v_remaining int;
  v_uses_needed int;
  v_uses_taken int := 0;
  v_row record;
  v_take int;
BEGIN
  -- Engine-only writer. auth.role() is 'service_role' when called with the
  -- service key; migrations/admin run with no claims (NULL) and are allowed.
  IF COALESCE(auth.role(),'service_role') <> 'service_role' THEN
    RAISE EXCEPTION 'fn_consume_time_bank is engine-only';
  END IF;
  IF p_seconds IS NULL OR p_seconds <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'p_seconds must be positive');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('time_bank:' || p_user_id::text, 0));

  SELECT (COALESCE(p.is_vip,false) AND (p.vip_expires_at IS NULL OR p.vip_expires_at > now()))
    INTO v_is_vip FROM profiles p WHERE p.id = p_user_id;
  IF v_is_vip IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'unknown user');
  END IF;

  v_remaining := p_seconds;

  -- 1) VIP monthly pool first (unit: seconds, cap 120/month = 6 uses at 20s)
  IF v_is_vip THEN
    SELECT COALESCE(SUM(usage_count),0)::int INTO v_used
    FROM vip_feature_usage_monthly
    WHERE user_id = p_user_id AND feature = 'time_bank_seconds' AND month = v_month;

    v_from_vip := LEAST(v_remaining, GREATEST(0, 120 - v_used));
    IF v_from_vip > 0 THEN
      INSERT INTO vip_feature_usage_monthly (user_id, feature, month, usage_count, updated_at)
      VALUES (p_user_id, 'time_bank_seconds', v_month, v_from_vip, now())
      ON CONFLICT (user_id, feature, month) DO UPDATE
         SET usage_count = vip_feature_usage_monthly.usage_count + EXCLUDED.usage_count,
             updated_at = now();
      v_remaining := v_remaining - v_from_vip;
    END IF;
  END IF;

  -- 2) Purchased extensions next (FIFO, 20s per use -- was 15, which made a
  --    single 20s activation cost the player TWO purchased banks).
  IF v_remaining > 0 THEN
    v_uses_needed := CEIL(v_remaining / 20.0)::int;
    FOR v_row IN
      SELECT id, uses_remaining FROM feature_purchases
      WHERE user_id = p_user_id AND feature = 'time_bank_seconds'
        AND COALESCE(uses_remaining,0) > 0
        AND (expires_at IS NULL OR expires_at > now())
      ORDER BY created_at
      FOR UPDATE
    LOOP
      EXIT WHEN v_uses_needed <= 0;
      v_take := LEAST(v_row.uses_remaining, v_uses_needed);
      UPDATE feature_purchases SET uses_remaining = uses_remaining - v_take
       WHERE id = v_row.id;
      v_uses_taken := v_uses_taken + v_take;
      v_uses_needed := v_uses_needed - v_take;
    END LOOP;
    v_remaining := GREATEST(0, v_remaining - v_uses_taken * 20);
  END IF;

  -- Shortfall = the engine's free session base (40s = two 20s banks) or a stale
  -- in-memory bank; report it, never fail an in-flight hand over accounting.
  RETURN jsonb_build_object(
    'success', true,
    'consumed_vip_seconds', v_from_vip,
    'consumed_purchased_uses', v_uses_taken,
    'shortfall_seconds', v_remaining
  );
END;
$function$;
