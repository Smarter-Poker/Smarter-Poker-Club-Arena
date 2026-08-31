-- One authoritative Club Arena join/application/invitation boundary.

CREATE TABLE IF NOT EXISTS public.club_join_idempotency (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  request_id uuid NOT NULL,
  club_id uuid REFERENCES public.clubs(id) ON DELETE CASCADE,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, request_id)
);
ALTER TABLE public.club_join_idempotency ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS club_join_idempotency_read_own ON public.club_join_idempotency;
CREATE POLICY club_join_idempotency_read_own ON public.club_join_idempotency
  FOR SELECT TO authenticated USING (user_id=auth.uid());

CREATE OR REPLACE FUNCTION public.fn_preview_club_join(p_identifier text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE v_uid uuid := auth.uid(); v_value text := btrim(COALESCE(p_identifier,'')); v_club record; v_status text; v_attempts integer;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE='28000'; END IF;
  IF v_value='' THEN RAISE EXCEPTION 'A club code is required' USING ERRCODE='22023'; END IF;
  SELECT count(*) INTO v_attempts FROM public.rate_limits
   WHERE user_id=v_uid AND action='club_join_preview' AND created_at>now()-interval '10 minutes';
  IF v_attempts>=30 THEN RAISE EXCEPTION 'Too many code lookups. Please wait a few minutes.'; END IF;
  INSERT INTO public.rate_limits(user_id,action) VALUES(v_uid,'club_join_preview');
  SELECT c.id,c.club_id,c.slug,c.name,c.description,c.logo_url,c.avatar_url,
         COALESCE(c.member_count,0) member_count,COALESCE(c.requires_approval,false) requires_approval
    INTO v_club FROM public.clubs c
     WHERE (v_value ~ '^[0-9]{5,6}$' AND c.club_id=v_value::integer)
      OR (v_value ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' AND c.id=v_value::uuid)
      OR lower(COALESCE(c.slug,''))=lower(v_value)
   LIMIT 1;
  IF NOT FOUND THEN RETURN jsonb_build_object('found',false); END IF;
  SELECT status INTO v_status FROM public.club_members WHERE club_id=v_club.id AND user_id=v_uid;
  RETURN jsonb_build_object(
    'found',true,'id',v_club.id,'club_id',v_club.club_id,'slug',v_club.slug,
    'name',v_club.name,'description',v_club.description,
    'logo_url',COALESCE(v_club.logo_url,v_club.avatar_url),
    'member_count',v_club.member_count,'requires_approval',v_club.requires_approval,
    'membership_status',v_status
  );
END $$;

CREATE OR REPLACE FUNCTION public.fn_sync_club_join_request()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.status='pending' THEN
    INSERT INTO public.club_join_requests(club_id,user_id,status,created_at)
    VALUES(NEW.club_id,NEW.user_id,'pending',now())
    ON CONFLICT(club_id,user_id) DO UPDATE SET status='pending',reviewed_by=NULL,reviewed_at=NULL;
  ELSIF NEW.status IN ('active','approved') THEN
    UPDATE public.club_join_requests SET status='approved',reviewed_at=COALESCE(reviewed_at,now())
     WHERE club_id=NEW.club_id AND user_id=NEW.user_id AND status='pending';
  ELSIF NEW.status IN ('banned','suspended','rejected','left') THEN
    UPDATE public.club_join_requests SET status='rejected',reviewed_at=COALESCE(reviewed_at,now())
     WHERE club_id=NEW.club_id AND user_id=NEW.user_id AND status='pending';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_sync_club_join_request ON public.club_members;
CREATE TRIGGER trg_sync_club_join_request
  AFTER INSERT OR UPDATE OF status ON public.club_members
  FOR EACH ROW EXECUTE FUNCTION public.fn_sync_club_join_request();

CREATE OR REPLACE FUNCTION public.fn_join_club_atomic(
  p_identifier text,
  p_request_id uuid,
  p_referral_code text DEFAULT NULL
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','extensions'
AS $$
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
END $$;

CREATE OR REPLACE FUNCTION public.fn_cancel_club_join_request(p_club_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE v_uid uuid := auth.uid(); v_deleted integer := 0;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE='28000'; END IF;
  DELETE FROM public.club_members WHERE club_id=p_club_id AND user_id=v_uid AND status='pending';
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  UPDATE public.club_join_requests SET status='rejected',reviewed_at=now()
   WHERE club_id=p_club_id AND user_id=v_uid AND status='pending';
  RETURN v_deleted > 0;
END $$;

REVOKE ALL ON FUNCTION public.fn_preview_club_join(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_join_club_atomic(text,uuid,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_cancel_club_join_request(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_preview_club_join(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_join_club_atomic(text,uuid,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_cancel_club_join_request(uuid) TO authenticated;
