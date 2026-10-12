CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE SCHEMA auth;
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql AS $$ SELECT 'service_role'::text $$;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT '00000000-0000-0000-0000-000000000001'::uuid $$;
CREATE FUNCTION fn_caller_is_engine() RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
CREATE TABLE vip_points(user_id uuid PRIMARY KEY,current_points bigint,lifetime_points bigint,updated_at timestamptz);
CREATE TABLE vip_points_carry(user_id uuid PRIMARY KEY,carry numeric,updated_at timestamptz);
CREATE TABLE vip_points_ledger(id uuid DEFAULT gen_random_uuid(),user_id uuid,points bigint,reason text,source_type text,source_id uuid,credit numeric,UNIQUE(user_id,source_type,source_id));
CREATE TABLE vip_reward_catalog(id text PRIMARY KEY,points_cost bigint,is_active boolean,grant_type text,grant_ref text,stock int);
CREATE TABLE vip_reward_claims(user_id uuid,reward_id text,points_spent bigint,status text);
CREATE TABLE lucky_wheel_segments(id text,reward_type text,amount numeric,weight numeric,active boolean);
CREATE TABLE user_lucky_wheel_spins(user_id uuid PRIMARY KEY,total_spins int,last_spin_date timestamptz,updated_at timestamptz);
CREATE TABLE rake_records(id uuid,rake_amount numeric,is_tournament boolean,tournament_id uuid,player_contributions jsonb,rake_method text);
CREATE FUNCTION fn_allocate_rake_credits(numeric,jsonb,text) RETURNS TABLE(user_id uuid,credit numeric) LANGUAGE sql AS $$SELECT '00000000-0000-0000-0000-000000000001'::uuid,$1$$;
CREATE FUNCTION atomic_credit_wallet_and_log(uuid,numeric,text,text,uuid,uuid,uuid,text) RETURNS boolean LANGUAGE sql AS $$SELECT true$$;
CREATE FUNCTION add_diamonds_to_balance(uuid,integer,text,text,text) RETURNS jsonb LANGUAGE sql AS $$ SELECT '{"success":true}'::jsonb $$;
CREATE OR REPLACE FUNCTION public.add_vip_points(p_user_id uuid, p_amount integer, p_type character varying, p_desc text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  -- STUB: vip_points_ledger table removed. VIP is now handled by
  -- vip_subscriptions + tier rollups; no ledger of discrete points.
  RETURN;
END; $function$;

CREATE OR REPLACE FUNCTION public.add_vip_points(p_user_id uuid, p_points integer)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  -- STUB: profiles.vip_points column removed. No-op.
  RETURN;
END; $function$;

CREATE OR REPLACE FUNCTION public.claim_lucky_wheel_spin(p_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid    uuid;
  v_today  date := (now() AT TIME ZONE 'UTC')::date;
  v_last   date;
  v_pick   record;
  v_roll   numeric;
  v_acc    numeric := 0;
BEGIN
  IF COALESCE(auth.role(), '') = 'service_role' THEN
    v_uid := p_user_id;
  ELSE
    v_uid := auth.uid();
    IF v_uid IS NULL THEN
      RAISE EXCEPTION 'claim_lucky_wheel_spin requires an authenticated caller' USING ERRCODE = '28000';
    END IF;
    IF p_user_id IS NOT NULL AND p_user_id <> v_uid THEN
      RAISE EXCEPTION 'Cannot spin the wheel for another user';
    END IF;
  END IF;

  INSERT INTO public.user_lucky_wheel_spins (user_id, total_spins, updated_at)
  VALUES (v_uid, 0, now())
  ON CONFLICT (user_id) DO NOTHING;

  SELECT (last_spin_date AT TIME ZONE 'UTC')::date INTO v_last
    FROM public.user_lucky_wheel_spins WHERE user_id = v_uid FOR UPDATE;

  IF v_last IS NOT NULL AND v_last >= v_today THEN
    RAISE EXCEPTION 'Already spun today';
  END IF;

  v_roll := random() * (SELECT sum(weight) FROM public.lucky_wheel_segments WHERE active);
  FOR v_pick IN SELECT * FROM public.lucky_wheel_segments WHERE active ORDER BY id LOOP
    v_acc := v_acc + v_pick.weight;
    EXIT WHEN v_roll <= v_acc;
  END LOOP;

  UPDATE public.user_lucky_wheel_spins
     SET total_spins = total_spins + 1, last_spin_date = now(), updated_at = now()
   WHERE user_id = v_uid;

  IF v_pick.reward_type = 'chips' THEN
    IF NOT public.atomic_credit_wallet_and_log(
         v_uid, v_pick.amount, 'bonus',
         'Lucky wheel: ' || v_pick.id,
         NULL, NULL, NULL,
         'lucky_wheel:' || v_uid::text || ':' || v_today::text) THEN
      RAISE EXCEPTION 'lucky wheel credit failed';
    END IF;
  ELSIF v_pick.reward_type = 'vip_points' THEN
    PERFORM public.add_vip_points(v_uid, v_pick.amount::integer);
  ELSIF v_pick.reward_type = 'diamonds' THEN
    PERFORM public.add_diamonds_to_balance(
      v_uid, v_pick.amount::integer, 'bonus', 'Lucky wheel: ' || v_pick.id,
      'lucky_wheel:' || v_uid::text || ':' || v_today::text);
  END IF;

  RETURN jsonb_build_object(
    'segmentId', v_pick.id, 'rewardType', v_pick.reward_type, 'amount', v_pick.amount);
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_award_vip_credit(p_user_id uuid, p_credit numeric, p_source_type text, p_source_id uuid, p_reason text)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_ledger_id uuid;
  v_carry numeric(14,4);
  v_total numeric(14,4);
  v_pts bigint;
BEGIN
  -- SERVER ONLY. A browser calling this would be minting its own points.
  IF NOT public.fn_caller_is_engine() THEN
    RAISE EXCEPTION 'fn_award_vip_credit is a server-side path' USING ERRCODE = '42501';
  END IF;
  IF p_user_id IS NULL OR COALESCE(p_credit, 0) <= 0 THEN
    RETURN 0;
  END IF;

  /* The carry row first, locked for this transaction: it serialises awards
     per user, and it is what the points depend on. Before phase 8 the leg
     was inserted with points = 0 and rewritten after this step. */
  INSERT INTO public.vip_points_carry (user_id, carry)
  VALUES (p_user_id, 0)
  ON CONFLICT (user_id) DO UPDATE SET carry = public.vip_points_carry.carry
  RETURNING carry INTO v_carry;

  v_total := v_carry + round(p_credit, 4);
  v_pts   := floor(v_total)::bigint;

  /* The leg, once, final. The unique (user, source_type, source_id) key is
     the idempotency: a second award for the same source writes nothing and
     changes nothing - the carry above was only locked, not moved. */
  INSERT INTO public.vip_points_ledger (user_id, points, reason, source_type, source_id, credit)
  VALUES (p_user_id, v_pts, p_reason, p_source_type, p_source_id, round(p_credit, 4))
  ON CONFLICT (user_id, source_type, source_id) DO NOTHING
  RETURNING id INTO v_ledger_id;
  IF v_ledger_id IS NULL THEN
    RETURN 0;
  END IF;

  UPDATE public.vip_points_carry SET carry = v_total - v_pts, updated_at = now() WHERE user_id = p_user_id;

  IF v_pts > 0 THEN
    PERFORM set_config('app.vip_points_writer', 'fn_award_vip_credit', true);
    INSERT INTO public.vip_points (user_id, current_points, lifetime_points)
    VALUES (p_user_id, v_pts, v_pts)
    ON CONFLICT (user_id) DO UPDATE
      SET current_points = public.vip_points.current_points + v_pts,
          lifetime_points = public.vip_points.lifetime_points + v_pts,
          updated_at = now();
    PERFORM set_config('app.vip_points_writer', '', true);
  END IF;
  RETURN v_pts;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_award_vip_points_from_rake()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  rec record;
BEGIN
  /* Tournament rake (entry fees, rebuys, satellite seats, spin books) is
     attributed ONCE, at settlement: fn_settle_tournament_rake ->
     fn_attribute_tournament_rake, by metadata.user_id or spread across the
     field. Awarding here as well credited every spin twice (2026-09-07). */
  IF COALESCE(NEW.is_tournament, false) OR NEW.tournament_id IS NOT NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.player_contributions IS NULL OR jsonb_typeof(NEW.player_contributions) <> 'object'
     OR COALESCE(NEW.rake_amount, 0) <= 0 THEN
    RETURN NEW;
  END IF;

  /* RAKE PAID IS RAKE EARNED (20260831100610): the credit is the player's
     share of NEW.rake_amount under the hand's own method, from the one
     allocator. Never the raw contribution - that is a pot figure, not rake. */
  FOR rec IN
    SELECT a.user_id, a.credit
      FROM public.fn_allocate_rake_credits(
             NEW.rake_amount, NEW.player_contributions,
             COALESCE(NEW.rake_method, 'DEALT_EQUAL')) a
     -- One order for VIP rows everywhere (2026-09-17): the tournament finish
     -- credits its players by player_id; a hand crediting the same players
     -- in seat order met it in the middle on vip_points_carry (three-way
     -- deadlocks at 11:46 and 12:32 UTC).
     ORDER BY a.user_id
  LOOP
    BEGIN
      PERFORM public.fn_award_vip_credit(rec.user_id, rec.credit, 'rake', NEW.id, 'Rake generated');
    EXCEPTION WHEN others THEN
      -- The rake is banked whether or not the points land; the ledger row
      -- is the audit and a warning is the trace.
      RAISE WARNING 'fn_award_vip_points_from_rake: % for user % on %', SQLERRM, rec.user_id, NEW.id;
    END;
  END LOOP;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_redeem_vip_points(p_cost bigint, p_reason text DEFAULT 'Reward redemption'::text, p_reward_id text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_bal bigint;
  v_reward record;
  v_cost bigint;
  v_status text := 'pending';
  v_theme_id text;
  v_avatar_id text;
  v_granted jsonb := jsonb_build_object('type', 'none');
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
  END IF;
  IF p_reward_id IS NOT NULL THEN
    SELECT * INTO v_reward FROM public.vip_reward_catalog WHERE id = p_reward_id AND is_active;
    IF v_reward.id IS NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'unknown_reward');
    END IF;
    v_cost := v_reward.points_cost;
    IF v_reward.grant_type = 'theme' THEN
      v_theme_id := public.sp_resolve_theme_preset(v_reward.grant_ref);
      IF v_theme_id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'invalid_reward_sku');
      END IF;
    ELSIF v_reward.grant_type = 'avatar' THEN
      v_avatar_id := public.sp_resolve_avatar_entitlement(v_reward.grant_ref);
      IF v_avatar_id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'invalid_reward_sku');
      END IF;
    END IF;
  ELSE
    v_cost := p_cost;
  END IF;
  IF v_cost IS NULL OR v_cost <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_cost');
  END IF;
  IF p_reward_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(
      hashtextextended('fn_redeem_vip_points:' || v_uid::text || ':' || p_reward_id, 0)
    );
    IF v_reward.stock IS NOT NULL AND v_reward.stock <= 0 THEN
      RETURN jsonb_build_object('success', false, 'error', 'sold_out');
    END IF;
    IF v_reward.grant_type = 'theme' AND EXISTS (
      SELECT 1 FROM public.theme_asset_unlocks
       WHERE user_id = v_uid AND category = 'theme_id' AND asset_id = v_theme_id
    ) THEN
      RETURN jsonb_build_object('success', false, 'error', 'already_owned', 'already_owned', true);
    END IF;
    IF v_reward.grant_type = 'avatar' AND EXISTS (
      SELECT 1 FROM public.avatar_unlocks WHERE user_id = v_uid AND avatar_id = v_avatar_id
    ) THEN
      RETURN jsonb_build_object('success', false, 'error', 'already_owned', 'already_owned', true);
    END IF;
  END IF;
  SELECT current_points INTO v_bal FROM public.vip_points WHERE user_id = v_uid FOR UPDATE;
  IF COALESCE(v_bal, 0) < v_cost THEN
    RETURN jsonb_build_object(
      'success', false, 'error', 'insufficient_points', 'balance', COALESCE(v_bal, 0)
    );
  END IF;
  PERFORM set_config('app.vip_points_writer', 'fn_redeem_vip_points', true);
  UPDATE public.vip_points SET current_points = current_points - v_cost, updated_at = now() WHERE user_id = v_uid;
  PERFORM set_config('app.vip_points_writer', '', true);
  INSERT INTO public.vip_points_ledger (user_id, points, reason, source_type, source_id)
  VALUES (v_uid, -v_cost, p_reason, 'redeem', gen_random_uuid());
  IF p_reward_id IS NOT NULL THEN
    IF v_reward.grant_type = 'theme' THEN
      PERFORM public.sp_grant_theme_preset(v_uid, v_theme_id, 'vip_points');
      v_status := 'granted';
      v_granted := jsonb_build_object('type', 'theme', 'theme_id', v_theme_id);
    ELSIF v_reward.grant_type = 'avatar' THEN
      INSERT INTO public.avatar_unlocks (user_id, avatar_id, unlock_method)
      VALUES (v_uid, v_avatar_id, 'vip_points')
      ON CONFLICT DO NOTHING;
      v_status := 'granted';
      v_granted := jsonb_build_object('type', 'avatar', 'avatar_id', v_avatar_id);
    END IF;
    IF v_reward.stock IS NOT NULL THEN
      UPDATE public.vip_reward_catalog SET stock = stock - 1 WHERE id = p_reward_id;
    END IF;
    INSERT INTO public.vip_reward_claims (user_id, reward_id, points_spent, status)
    VALUES (v_uid, p_reward_id, v_cost, v_status);
  END IF;
  RETURN jsonb_build_object(
    'success', true,
    'balance', COALESCE(v_bal, 0) - v_cost,
    'charged', v_cost,
    'status', CASE WHEN p_reward_id IS NULL THEN NULL ELSE v_status END,
    'granted', v_granted
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_vip_points_move_only_with_a_leg()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_writer text := NULLIF(current_setting('app.vip_points_writer', true), '');
BEGIN
  IF NEW.current_points < 0 THEN
    RAISE EXCEPTION 'vip_points.current_points cannot go negative (% for %)', NEW.current_points, NEW.user_id
      USING ERRCODE = 'P0403';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF (NEW.current_points <> 0 OR NEW.lifetime_points <> 0) AND v_writer IS NULL THEN
      RAISE EXCEPTION 'a vip_points row is born at zero unless a ledger writer (fn_award_vip_credit) creates it with its first leg'
        USING ERRCODE = 'P0403';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.lifetime_points < OLD.lifetime_points THEN
    RAISE EXCEPTION 'vip_points.lifetime_points cannot shrink (% -> % for %)', OLD.lifetime_points, NEW.lifetime_points, NEW.user_id
      USING ERRCODE = 'P0403';
  END IF;
  IF (NEW.current_points IS DISTINCT FROM OLD.current_points OR NEW.lifetime_points IS DISTINCT FROM OLD.lifetime_points)
     AND v_writer IS NULL THEN
    RAISE EXCEPTION
      'vip_points for % moves only through fn_award_vip_credit or fn_redeem_vip_points, which write the leg in the same transaction. A balance with no leg is the defect this guard exists for.',
      NEW.user_id USING ERRCODE = 'P0403';
  END IF;
  RETURN NEW;
END $function$;

CREATE TRIGGER trg_award_vip_points_from_rake AFTER INSERT ON rake_records FOR EACH ROW EXECUTE FUNCTION fn_award_vip_points_from_rake();
CREATE TRIGGER zz_vip_points_move_only_with_a_leg BEFORE INSERT OR UPDATE ON vip_points FOR EACH ROW EXECUTE FUNCTION fn_vip_points_move_only_with_a_leg();
SELECT fn_award_vip_credit('00000000-0000-0000-0000-000000000001',10,'rake',gen_random_uuid(),'fixture');
INSERT INTO vip_reward_catalog VALUES('avatar',10,true,'avatar','avatar',10);
INSERT INTO lucky_wheel_segments VALUES('points','vip_points',10,1,true),('diamonds','diamonds',5,1,true);
CREATE TABLE preserved_snapshot AS SELECT (SELECT jsonb_agg(to_jsonb(v)) FROM vip_points v) balances,(SELECT jsonb_agg(to_jsonb(v)) FROM vip_points_ledger v) ledger,(SELECT jsonb_agg(to_jsonb(v)) FROM vip_points_carry v) carry;

REVOKE ALL ON FUNCTION public.fn_award_vip_credit(uuid,numeric,text,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_award_vip_credit(uuid,numeric,text,uuid,text) TO service_role;
REVOKE ALL ON FUNCTION public.fn_award_vip_points_from_rake() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_award_vip_points_from_rake() TO service_role;
REVOKE ALL ON FUNCTION public.fn_redeem_vip_points(bigint,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_redeem_vip_points(bigint,text,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_redeem_vip_points(bigint,text,text) TO service_role;
REVOKE ALL ON FUNCTION public.fn_vip_points_move_only_with_a_leg() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_vip_points_move_only_with_a_leg() TO service_role;
REVOKE ALL ON FUNCTION public.claim_lucky_wheel_spin(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_lucky_wheel_spin(uuid) TO service_role;
