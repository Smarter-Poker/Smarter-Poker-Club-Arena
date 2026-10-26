CREATE OR REPLACE FUNCTION public.fn_join_club_atomic(p_identifier text, p_request_id uuid, p_referral_code text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_uid uuid := auth.uid(); v_value text := btrim(COALESCE(p_identifier,''));
  v_ref text := NULLIF(btrim(COALESCE(p_referral_code,'')),'');
  v_club record; v_cached jsonb; v_membership jsonb; v_redeem jsonb; v_result jsonb; v_attempts integer;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE='28000'; END IF;
  IF p_request_id IS NULL THEN RAISE EXCEPTION 'A join request ID is required' USING ERRCODE='22023'; END IF;
  IF EXISTS (
    SELECT 1 FROM public.club_entry_feature_flags f WHERE f.key='join_club'
      AND (NOT f.enabled OR ((hashtextextended(v_uid::text || ':' || f.key,44119) & 9223372036854775807) % 100) >= f.rollout_percent)
  ) THEN RAISE EXCEPTION 'Club joining is temporarily unavailable.' USING ERRCODE='P0001'; END IF;

  SELECT result INTO v_cached FROM public.club_join_idempotency
   WHERE user_id=v_uid AND request_id=p_request_id;
  IF FOUND THEN RETURN v_cached; END IF;

  -- Eight code/invite attempts per rolling ten minutes. Record failed lookups
  -- too, because enumeration is the abuse this protects against.
  SELECT count(*) INTO v_attempts FROM public.rate_limits
   WHERE user_id=v_uid AND action='club_join' AND created_at>now()-interval '10 minutes';
  IF v_attempts>=8 THEN
    RAISE EXCEPTION 'Too many join attempts. Please wait a few minutes.' USING ERRCODE='P0001';
  END IF;
  INSERT INTO public.rate_limits(user_id,action) VALUES(v_uid,'club_join');

  SELECT c.* INTO v_club FROM public.clubs c
   WHERE (v_value ~ '^[0-9]{5,6}$' AND c.club_id=v_value::integer)
      OR (v_value ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' AND c.id=v_value::uuid)
      OR lower(COALESCE(c.slug,''))=lower(v_value)
   LIMIT 1;
  IF NOT FOUND THEN
    v_result := jsonb_build_object('success',false,'code','not_found','error','Club not found');
    INSERT INTO public.club_join_idempotency(user_id,request_id,club_id,result)
    VALUES(v_uid,p_request_id,NULL,v_result);
    RETURN v_result;
  END IF;

  -- Serialize every membership-consuming operation for this user, including
  -- creates and simultaneous joins into different clubs. A user+club lock
  -- lets two distinct clubs both observe the fourth slot as available.
  PERFORM pg_advisory_xact_lock(hashtextextended(v_uid::text, 77431));

  SELECT result INTO v_cached FROM public.club_join_idempotency
   WHERE user_id=v_uid AND request_id=p_request_id;
  IF FOUND THEN RETURN v_cached; END IF;

  BEGIN
    -- fn_join_club owns role, approval status, membership limit, zero-balance,
    -- and conflict handling. This exception block is a subtransaction: an
    -- invalid referral rolls its new membership back while preserving the
    -- rate-limit and idempotency records outside the block.
    v_membership := public.fn_join_club(v_club.id);
    IF COALESCE(v_membership->>'status','') NOT IN ('active','approved','pending') THEN
      RAISE EXCEPTION 'This membership cannot be activated' USING ERRCODE='P0004';
    END IF;

    IF v_ref IS NOT NULL THEN
      v_redeem := public.fn_redeem_club_invite_code(v_club.id,v_uid,v_ref);
      IF COALESCE((v_redeem->>'success')::boolean,false) IS NOT TRUE THEN
        RAISE EXCEPTION '%', COALESCE(v_redeem->>'error','Invalid invitation') USING ERRCODE='P0003';
      END IF;
      SELECT to_jsonb(cm) INTO v_membership FROM public.club_members cm
       WHERE cm.club_id=v_club.id AND cm.user_id=v_uid;
    END IF;

    v_result := jsonb_build_object(
      'success',true,
      'club',jsonb_build_object('id',v_club.id,'club_id',v_club.club_id,'slug',v_club.slug,
        'name',v_club.name,'logo_url',COALESCE(v_club.logo_url,v_club.avatar_url)),
      'membership',v_membership,
      'status',v_membership->>'status',
      'invitation_redeemed',v_ref IS NOT NULL
    );
  EXCEPTION
    WHEN SQLSTATE 'P0003' THEN
      v_result := jsonb_build_object('success',false,'code','invalid_invitation',
        'error',COALESCE(v_redeem->>'error','Invalid invitation'));
    WHEN SQLSTATE 'P0004' THEN
      v_result := jsonb_build_object('success',false,'code','membership_blocked',
        'error','This membership cannot be activated');
  END;
  INSERT INTO public.club_join_idempotency(user_id,request_id,club_id,result)
  VALUES(v_uid,p_request_id,v_club.id,v_result);
  RETURN v_result;
END $function$
