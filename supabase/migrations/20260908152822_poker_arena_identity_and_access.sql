-- Phase 2 access rollout. No Diamond custody or gameplay is enabled.
SET lock_timeout = '5s';
SET statement_timeout = '30s';

CREATE OR REPLACE FUNCTION public.fn_poker_arena_context(p_club_key text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp AS $function$
DECLARE v_uid uuid := auth.uid(); v_club public.clubs%ROWTYPE; v_role text; v_member boolean;
BEGIN
  IF v_uid IS NULL OR NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = v_uid) THEN
    RAISE EXCEPTION 'Authentication Required' USING ERRCODE = '28000';
  END IF;
  SELECT c.* INTO v_club FROM public.clubs c
  WHERE c.id::text = btrim(p_club_key) OR c.club_id::text = btrim(p_club_key)
     OR lower(c.slug) = lower(btrim(p_club_key))
  ORDER BY (c.id::text = btrim(p_club_key)) DESC LIMIT 1;
  IF NOT FOUND OR v_club.lifecycle_status = 'retired' THEN RETURN NULL; END IF;
  IF v_club.asset = 'diamonds' THEN
    IF v_club.is_platform IS DISTINCT FROM true OR v_club.union_id IS NOT NULL
       OR NOT EXISTS (SELECT 1 FROM public.ca_arena_settings WHERE club_id = v_club.id) THEN
      RAISE EXCEPTION 'Invalid Diamond Arena Identity' USING ERRCODE = '23514';
    END IF;
    v_member := true; v_role := 'player';
  ELSIF v_club.asset = 'chips' AND v_club.is_platform = false THEN
    SELECT m.role INTO v_role FROM public.club_members m
      WHERE m.club_id = v_club.id AND m.user_id = v_uid AND m.status IN ('active','approved');
    v_member := FOUND;
  ELSE RAISE EXCEPTION 'Invalid Arena Asset' USING ERRCODE = '23514';
  END IF;
  RETURN jsonb_build_object('arena',jsonb_build_object('id',v_club.id,'asset',v_club.asset,
    'is_platform',v_club.is_platform,'union_id',v_club.union_id), 'member',v_member,'role',v_role);
END $function$;
REVOKE ALL ON FUNCTION public.fn_poker_arena_context(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_poker_arena_context(text) TO authenticated;

-- RLS helper checks the caller's own membership; no arbitrary user-id parameter.
CREATE OR REPLACE FUNCTION public.fn_poker_can_read_games(p_club_id uuid)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp AS $function$
DECLARE v_uid uuid := auth.uid(); v_club public.clubs%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN RETURN false; END IF;
  SELECT * INTO v_club FROM public.clubs WHERE id=p_club_id;
  IF NOT FOUND OR v_club.lifecycle_status = 'retired' THEN RETURN false; END IF;
  IF v_club.asset = 'diamonds' THEN
    RETURN v_club.is_platform AND v_club.union_id IS NULL
      AND EXISTS (SELECT 1 FROM public.ca_arena_settings WHERE club_id=v_club.id)
      AND EXISTS (SELECT 1 FROM public.profiles WHERE id=v_uid);
  END IF;
  IF v_club.asset IS DISTINCT FROM 'chips' OR v_club.is_platform THEN RETURN false; END IF;
  RETURN EXISTS (SELECT 1 FROM public.club_members m
    WHERE m.club_id=ANY(public.fn_club_scope_ids(p_club_id))
      AND m.user_id=v_uid AND m.status IN ('active','approved'))
    OR public.fn_union_oversees_club(p_club_id,v_uid);
END $function$;
REVOKE ALL ON FUNCTION public.fn_poker_can_read_games(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_poker_can_read_games(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.fn_poker_guard_arena_structure()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $function$
DECLARE v_asset text;
BEGIN
  IF TG_TABLE_NAME='clubs' THEN
    IF TG_OP='UPDATE' AND (NEW.asset,NEW.is_platform) IS DISTINCT FROM (OLD.asset,OLD.is_platform) THEN
      RAISE EXCEPTION 'Arena Asset Is Immutable' USING ERRCODE='23514';
    END IF;
    IF NEW.asset='diamonds' AND auth.uid() IS NOT NULL AND coalesce(auth.jwt()->>'role','') <> 'service_role'
       AND NOT coalesce(public.fn_is_platform_admin(),false) THEN
      RAISE EXCEPTION 'Diamond Arena Requires Platform Operations' USING ERRCODE='42501';
    END IF;
    RETURN NEW;
  END IF;
  SELECT asset INTO v_asset FROM public.clubs WHERE id=NEW.club_id;
  IF TG_TABLE_NAME='club_members' AND TG_OP='UPDATE' AND NEW.club_id IS DISTINCT FROM OLD.club_id
     AND EXISTS (SELECT 1 FROM public.clubs WHERE id=OLD.club_id AND asset='diamonds') THEN
    RAISE EXCEPTION 'Diamond Participation Cannot Become A Chip Membership' USING ERRCODE='23514';
  END IF;
  -- Branch before resolving fields: membership rows do not have union_id.
  IF TG_TABLE_NAME IN ('tables','tournaments') THEN
    IF TG_OP='UPDATE' AND NEW.club_id IS DISTINCT FROM OLD.club_id
       AND (EXISTS (SELECT 1 FROM public.clubs WHERE id=OLD.club_id AND asset IS DISTINCT FROM v_asset)
         OR (OLD.club_id IS NULL AND OLD.union_id IS NOT NULL AND v_asset='diamonds')) THEN
      RAISE EXCEPTION 'Game Asset Is Immutable' USING ERRCODE='23514';
    END IF;
  END IF;
  IF v_asset='diamonds' THEN
    IF TG_TABLE_NAME='club_members' THEN
      IF TG_OP='INSERT' OR NEW.role IS DISTINCT FROM 'player' OR NEW.status IS DISTINCT FROM 'automatic'
         OR NEW.agent_id IS NOT NULL OR NEW.parent_agent_id IS NOT NULL
         OR coalesce(NEW.chip_balance,0)<>0 OR coalesce(NEW.credit_limit,0)<>0
         OR coalesce(NEW.credit_used,0)<>0 OR coalesce(NEW.promo_balance,0)<>0
         OR coalesce(NEW.held_chips,0)<>0 THEN
        RAISE EXCEPTION 'Diamond Membership Is Automatic And Has No Chip Wallet Or Hierarchy' USING ERRCODE='23514';
      END IF;
    ELSIF TG_TABLE_NAME='union_clubs' THEN
      RAISE EXCEPTION 'Diamond Arena Cannot Join A Union' USING ERRCODE='23514';
    ELSIF auth.uid() IS NOT NULL AND coalesce(auth.jwt()->>'role','') <> 'service_role'
       AND NOT coalesce(public.fn_is_platform_admin(),false) THEN
      RAISE EXCEPTION 'Diamond Games Require Platform Operations' USING ERRCODE='42501';
    ELSIF NEW.union_id IS NOT NULL THEN
      RAISE EXCEPTION 'Diamond Games Cannot Belong To A Union' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $function$;
REVOKE ALL ON FUNCTION public.fn_poker_guard_arena_structure() FROM PUBLIC, anon, authenticated;
CREATE OR REPLACE FUNCTION public.fn_poker_guard_chip_seat()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $function$
BEGIN
  IF EXISTS (SELECT 1 FROM public.tables t JOIN public.clubs c ON c.id=t.club_id
      WHERE t.id=NEW.table_id AND c.asset='diamonds') THEN
    RAISE EXCEPTION 'Diamond Seats Require Dedicated Diamond Custody' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $function$;
REVOKE ALL ON FUNCTION public.fn_poker_guard_chip_seat() FROM PUBLIC, anon, authenticated;
CREATE OR REPLACE FUNCTION public.fn_poker_reject_diamond_hierarchy()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $function$
BEGIN
  IF EXISTS (SELECT 1 FROM public.clubs WHERE id=NEW.club_id AND asset='diamonds') THEN
    RAISE EXCEPTION 'Diamond Arena Has No Agents Or Commissions' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $function$;
REVOKE ALL ON FUNCTION public.fn_poker_reject_diamond_hierarchy() FROM PUBLIC, anon, authenticated;
-- Club owner/agent permissions never confer Diamond management rights.
DO $definition$
DECLARE v_def text; v_next text; v_signature text;
BEGIN
  FOREACH v_signature IN ARRAY ARRAY[
    'public.fn_can_create_games(uuid,uuid)', 'public.is_club_admin(uuid,uuid)'
  ] LOOP
    SELECT pg_get_functiondef(v_signature::regprocedure) INTO v_def;
    v_next := regexp_replace(v_def, E'BEGIN\n', $patch$BEGIN
  IF EXISTS (SELECT 1 FROM public.clubs WHERE id=p_club_id AND asset='diamonds') THEN RETURN false; END IF;
$patch$);
    IF v_next=v_def THEN RAISE EXCEPTION '% source changed; inspect before applying',v_signature; END IF;
    EXECUTE v_next;
  END LOOP;
END $definition$;

-- The aggregate lobby RPC must not expose member fields before entry authorization.
-- Preserve its current chip implementation and signature, including invoker security.
DO $lobby$
DECLARE v_def text; v_next text;
BEGIN
 SELECT pg_get_functiondef('public.get_club_home(text)'::regprocedure) INTO v_def;
 v_next := regexp_replace(v_def, E'BEGIN\n', $patch$BEGIN
  DECLARE v_access jsonb;
  BEGIN
    IF auth.uid() IS NULL THEN RETURN jsonb_build_object('found',false,'reason','authentication_required'); END IF;
    v_access := public.fn_poker_arena_context(p_club_key);
    IF v_access IS NULL THEN RETURN jsonb_build_object('found',false); END IF;
    IF v_access->'arena'->>'asset'='diamonds' THEN
      RETURN jsonb_build_object('found',true,'access_only',true,'arena_context',v_access);
    END IF;
    IF NOT coalesce((v_access->>'member')::boolean,false) THEN
      RETURN jsonb_build_object('found',false,'reason','membership_required');
    END IF;
  END;
$patch$);
 IF v_next=v_def THEN RAISE EXCEPTION 'get_club_home source changed; inspect before applying'; END IF;
 EXECUTE v_next;
END $lobby$;

