-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260723182107 "ca_sweep3_tier2_money_rpcs_and_anticheat"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 7eadfef3f99694a1515e3b99e713744c of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ═════════════════════════════════════════════════════════════════════════════
-- CA sweep #3 Tier 2+3b — server-authoritative RPCs.
--   * redeem_referral_code        — credits BOTH sides server-side (250/250)
--   * fn_claim_referral_milestone — replaces the client-side add_chips landmine
--   * fn_purchase_feature         — prices from feature_pricing, debits diamonds
--   * increment_promotion_claim_count — derived count (promotions has no counter)
--   * detect_collusion_pairs      — over live collusion_tracking (engine scans)
--   * detect_suspicious_plays     — heuristic over hand_history big pots
-- Chip credits flow through whitelisted atomic_credit_wallet_and_log (wallet
-- guard compliant); diamond debits through deduct_diamonds (idempotent ref).
-- ═════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.redeem_referral_code(p_referee_id uuid, p_code text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_caller uuid := (SELECT auth.uid());
  v_code record;
  v_award_referrer numeric := 250;
  v_award_referee numeric := 250;
BEGIN
  IF v_caller IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'authentication required'); END IF;
  IF p_referee_id IS DISTINCT FROM v_caller THEN
    RETURN jsonb_build_object('success', false, 'error', 'can only redeem for your own account');
  END IF;

  SELECT * INTO v_code FROM referral_codes WHERE upper(code) = upper(trim(p_code));
  IF v_code.id IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'invalid referral code'); END IF;
  IF v_code.user_id = p_referee_id THEN RETURN jsonb_build_object('success', false, 'error', 'cannot redeem your own code'); END IF;
  IF v_code.max_uses IS NOT NULL AND v_code.uses >= v_code.max_uses THEN
    RETURN jsonb_build_object('success', false, 'error', 'code has reached its maximum uses');
  END IF;
  IF EXISTS (SELECT 1 FROM referral_redemptions WHERE referee_id = p_referee_id) THEN
    RETURN jsonb_build_object('success', false, 'error', 'referral already redeemed for this account');
  END IF;

  INSERT INTO referral_redemptions (code_id, referrer_id, referee_id, chips_awarded_referrer, chips_awarded_referee)
  VALUES (v_code.id, v_code.user_id, p_referee_id, v_award_referrer, v_award_referee);

  UPDATE referral_codes SET uses = uses + 1 WHERE id = v_code.id;

  PERFORM atomic_credit_wallet_and_log(p_referee_id, v_award_referee, 'referral_bonus',
          'Referral signup bonus (code ' || v_code.code || ')', NULL, NULL, v_code.id);
  PERFORM atomic_credit_wallet_and_log(v_code.user_id, v_award_referrer, 'referral_bonus',
          'Referral reward — new player joined with your code', NULL, NULL, v_code.id);

  RETURN jsonb_build_object('success', true,
                            'chips_awarded_referee', v_award_referee,
                            'chips_awarded_referrer', v_award_referrer);
EXCEPTION WHEN unique_violation THEN
  RETURN jsonb_build_object('success', false, 'error', 'referral already redeemed for this account');
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_claim_referral_milestone(p_milestone integer)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_caller uuid := (SELECT auth.uid());
  v_reward numeric;
  v_referrals integer;
BEGIN
  IF v_caller IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'authentication required'); END IF;

  v_reward := CASE p_milestone
    WHEN 5 THEN 2500 WHEN 10 THEN 5000 WHEN 25 THEN 15000 WHEN 50 THEN 50000
    ELSE NULL END;
  IF v_reward IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'unknown milestone'); END IF;

  SELECT count(*) INTO v_referrals FROM referral_redemptions WHERE referrer_id = v_caller;
  IF v_referrals < p_milestone THEN
    RETURN jsonb_build_object('success', false, 'error', 'milestone not reached', 'referrals', v_referrals);
  END IF;

  BEGIN
    INSERT INTO referral_milestone_claims (user_id, milestone, chips_awarded)
    VALUES (v_caller, p_milestone, v_reward);
  EXCEPTION WHEN unique_violation THEN
    RETURN jsonb_build_object('success', false, 'error', 'milestone already claimed');
  END;

  PERFORM atomic_credit_wallet_and_log(v_caller, v_reward, 'referral_milestone',
          'Referral milestone: ' || p_milestone || ' referrals', NULL, NULL, NULL);

  RETURN jsonb_build_object('success', true, 'awarded', v_reward);
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_purchase_feature(p_user_id uuid, p_feature text, p_cost integer DEFAULT 0)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_caller uuid := (SELECT auth.uid());
  v_price record;
  v_deduct jsonb;
  v_expires timestamptz;
  v_uses integer;
BEGIN
  IF v_caller IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'authentication required'); END IF;
  IF p_user_id IS DISTINCT FROM v_caller THEN
    RETURN jsonb_build_object('success', false, 'error', 'can only purchase for your own account');
  END IF;

  -- Server-side pricing — the client-supplied p_cost is IGNORED by design.
  SELECT feature, diamond_cost, usage_type INTO v_price
    FROM feature_pricing WHERE feature = p_feature;
  IF v_price.feature IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'unknown feature: ' || p_feature);
  END IF;

  IF v_price.diamond_cost > 0 THEN
    v_deduct := deduct_diamonds(
      p_user_id        := v_caller,
      p_amount         := v_price.diamond_cost,
      p_description    := 'Feature purchase: ' || p_feature,
      p_transaction_type := 'feature_purchase',
      p_source         := 'feature_purchase',
      p_metadata       := jsonb_build_object('feature', p_feature),
      p_reference_id   := 'feat_' || p_feature || '_' || v_caller || '_' || extract(epoch from date_trunc('second', now()))::text
    );
    IF COALESCE((v_deduct->>'success')::boolean, false) = false THEN
      RETURN jsonb_build_object('success', false, 'error', COALESCE(v_deduct->>'error', 'diamond charge failed'));
    END IF;
  END IF;

  v_uses := CASE v_price.usage_type WHEN 'per_use' THEN 1 ELSE NULL END;
  v_expires := CASE v_price.usage_type WHEN 'per_session' THEN now() + interval '8 hours' ELSE NULL END;

  INSERT INTO feature_purchases (user_id, feature, cost, usage_type, uses_remaining, expires_at)
  VALUES (v_caller, p_feature, v_price.diamond_cost, v_price.usage_type, v_uses, v_expires);

  RETURN jsonb_build_object('success', true, 'cost', v_price.diamond_cost, 'usage_type', v_price.usage_type);
END;
$function$;

CREATE OR REPLACE FUNCTION public.increment_promotion_claim_count(p_promotion_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_count integer;
BEGIN
  -- promotions has no persisted claim counter; the count is derived.
  SELECT count(*) INTO v_count FROM promotion_claims WHERE promotion_id = p_promotion_id;
  RETURN jsonb_build_object('success', true, 'claim_count', v_count);
END;
$function$;

CREATE OR REPLACE FUNCTION public.detect_collusion_pairs(p_club_id uuid, p_threshold numeric DEFAULT 0.75, p_min_hands integer DEFAULT 5)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_caller uuid := (SELECT auth.uid());
  v_pairs jsonb;
  v_analyzed integer;
BEGIN
  IF v_caller IS NULL THEN RAISE EXCEPTION 'authentication required'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM clubs c WHERE c.id = p_club_id AND (
      c.owner_id = v_caller
      OR EXISTS (SELECT 1 FROM club_members cm WHERE cm.club_id = c.id AND cm.user_id = v_caller
                   AND cm.role IN ('owner','co_owner','admin')))
  ) THEN
    RAISE EXCEPTION 'not authorized for this club';
  END IF;

  SELECT count(*) INTO v_analyzed
    FROM hand_history hh JOIN tables t ON t.id = hh.table_id
   WHERE t.club_id = p_club_id AND hh.created_at > now() - interval '30 days';

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'dumper_id', p.player_a,
      'receiver_id', p.player_b,
      'hands_together', p.hands_together,
      'chip_flow_ratio', p.score / 100.0,
      'net_chips_transferred', p.net_chips,
      'severity', CASE WHEN p.score >= 90 THEN 'high' WHEN p.score >= 75 THEN 'medium' ELSE 'low' END
    ) ORDER BY p.score DESC), '[]'::jsonb)
  INTO v_pairs
  FROM (
    SELECT ct.player_a, ct.player_b,
           max(ct.suspicion_score) AS score,
           COALESCE(max((ct.evidence->>'hands_together')::numeric), 0)::integer AS hands_together,
           COALESCE(max((ct.evidence->>'net_chips_transferred')::numeric), 0) AS net_chips
      FROM collusion_tracking ct
     WHERE ct.scan_date > current_date - 30
       AND ct.status <> 'dismissed'
       AND EXISTS (SELECT 1 FROM club_members cma WHERE cma.club_id = p_club_id AND cma.user_id = ct.player_a)
       AND EXISTS (SELECT 1 FROM club_members cmb WHERE cmb.club_id = p_club_id AND cmb.user_id = ct.player_b)
     GROUP BY ct.player_a, ct.player_b
    HAVING max(ct.suspicion_score) >= p_threshold * 100
       AND COALESCE(max((ct.evidence->>'hands_together')::numeric), p_min_hands) >= p_min_hands
  ) p;

  RETURN jsonb_build_object('pairs', v_pairs, 'analyzed_hands', v_analyzed);
END;
$function$;

CREATE OR REPLACE FUNCTION public.detect_suspicious_plays(p_club_id uuid, p_limit integer DEFAULT 500)
RETURNS TABLE (hand_id uuid, player_id uuid, hand_rank text, pot_total numeric, completed_at timestamptz, severity text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_caller uuid := (SELECT auth.uid());
BEGIN
  IF v_caller IS NULL THEN RAISE EXCEPTION 'authentication required'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM clubs c WHERE c.id = p_club_id AND (
      c.owner_id = v_caller
      OR EXISTS (SELECT 1 FROM club_members cm WHERE cm.club_id = c.id AND cm.user_id = v_caller
                   AND cm.role IN ('owner','co_owner','admin')))
  ) THEN
    RAISE EXCEPTION 'not authorized for this club';
  END IF;

  RETURN QUERY
  SELECT hh.id,
         NULLIF(w.value->>'userId', '')::uuid,
         COALESCE(w.value->'hand'->>'name', 'Unknown'),
         hh.pot_size,
         COALESCE(hh.ended_at, hh.created_at),
         CASE WHEN hh.pot_size >= 100 * NULLIF(hh.big_blind, 0) THEN 'high'
              WHEN hh.pot_size >= 60 * NULLIF(hh.big_blind, 0) THEN 'medium'
              ELSE 'low' END
    FROM hand_history hh
    JOIN tables t ON t.id = hh.table_id AND t.club_id = p_club_id
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(hh.winners, '[]'::jsonb)) w
   WHERE hh.created_at > now() - interval '30 days'
     AND hh.big_blind > 0
     AND hh.pot_size >= 40 * hh.big_blind
   ORDER BY hh.pot_size / NULLIF(hh.big_blind, 0) DESC, hh.created_at DESC
   LIMIT p_limit;
END;
$function$;

-- Grants
REVOKE ALL ON FUNCTION public.redeem_referral_code(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fn_claim_referral_milestone(integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fn_purchase_feature(uuid, text, integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.increment_promotion_claim_count(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.detect_collusion_pairs(uuid, numeric, integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.detect_suspicious_plays(uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.redeem_referral_code(uuid, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_claim_referral_milestone(integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_purchase_feature(uuid, text, integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.increment_promotion_claim_count(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.detect_collusion_pairs(uuid, numeric, integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.detect_suspicious_plays(uuid, integer) TO authenticated, service_role;
