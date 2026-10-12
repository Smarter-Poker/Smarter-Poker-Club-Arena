-- 20261012144105_player_command_history_reads_sanitized_staff_scope.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

-- Dedicated bounded staff read; no raw journal, permission or financial write.
-- Existing raw audit consumers cannot safely expose rates, reasons or provenance.
-- @live-proof: to_regprocedure('public.ca_club_player_history(uuid,uuid,text,date,date,jsonb,integer)') IS NOT NULL
-- @live-proof: has_function_privilege('authenticated','public.ca_club_player_history(uuid,uuid,text,date,date,jsonb,integer)','EXECUTE') AND NOT has_function_privilege('anon','public.ca_club_player_history(uuid,uuid,text,date,date,jsonb,integer)','EXECUTE')
-- @live-proof: EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.audit_trail'::regclass AND tgname='player_history_changed' AND NOT tgisinternal)
-- @live-proof: EXISTS (SELECT 1 FROM pg_policy WHERE polrelid='realtime.messages'::regclass AND polname='authorized staff receive player history signals' AND polcmd='r')
BEGIN;
SET LOCAL lock_timeout = '3s';
DO $guard$ BEGIN
  IF to_regprocedure('public.ca_club_player_history(uuid,uuid,text,date,date,jsonb,integer)') IS NOT NULL THEN
    RAISE EXCEPTION 'player history reader already exists; refusing replay';
  END IF;
END $guard$;

CREATE FUNCTION public.ca_player_history_can_read(p_club_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
  SELECT p_club_id IS NOT NULL AND auth.uid() IS NOT NULL AND (
    EXISTS (SELECT 1 FROM public.profiles p WHERE p.id=auth.uid() AND p.is_admin IS TRUE)
    OR EXISTS (SELECT 1 FROM public.clubs c WHERE c.id=p_club_id AND c.owner_id=auth.uid())
    OR EXISTS (SELECT 1 FROM public.club_members cm WHERE cm.club_id=p_club_id
      AND cm.user_id=auth.uid() AND cm.role IN ('owner','co_owner','admin')
      AND cm.status IN ('active','approved'))
    OR public.fn_is_union_overseer(p_club_id,auth.uid())
    OR public.fn_union_oversees_club(p_club_id,auth.uid())
  );
$function$;
REVOKE ALL ON FUNCTION public.ca_player_history_can_read(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.ca_player_history_can_read(uuid) TO authenticated;

CREATE POLICY "authorized staff receive player history signals"
ON realtime.messages FOR SELECT TO authenticated
USING (extension='broadcast' AND private IS TRUE AND topic=realtime.topic() AND EXISTS (
  SELECT 1 FROM (SELECT CASE
    WHEN realtime.topic() ~ '^player-history:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    THEN split_part(realtime.topic(),':',2)::uuid ELSE NULL END AS club_id) topic
  WHERE public.ca_player_history_can_read(topic.club_id)
));

CREATE FUNCTION public.fn_publish_player_history_change()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  IF NEW.club_id IS NULL OR NOT (
    (NEW.target_type IN ('member','club_member','membership') AND NEW.action IN (
      'role_change','set_member_role','banned','unban_member','member_status_change',
      'set_member_status','kick_member','member_left','depart_club_member'))
    OR (NEW.target_type='club_member' AND NEW.action='update_member_notes')
    OR (NEW.target_type='club' AND NEW.target_id=NEW.club_id AND NEW.action='export_club_roster')
  ) THEN RETURN NEW; END IF;
  -- A failed broadcast must never roll back the underlying member/financial
  -- transaction. Explicit refresh after subscription recovery reads the journal.
  BEGIN
    PERFORM realtime.send(jsonb_build_object('club_id',NEW.club_id,
      'target_id',NEW.target_id,'action',NEW.action),
      'history_changed','player-history:'||NEW.club_id::text,true);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'Player history signal delivery failed: %',SQLERRM;
  END;
  RETURN NEW;
END $function$;
REVOKE ALL ON FUNCTION public.fn_publish_player_history_change() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER player_history_changed AFTER INSERT ON public.audit_trail
FOR EACH ROW EXECUTE FUNCTION public.fn_publish_player_history_change();
COMMENT ON FUNCTION public.fn_publish_player_history_change() IS 'Private staff history invalidation: only club/target/action identities; no raw journal state or provenance. Transport failure cannot roll back the authoritative write.';

CREATE FUNCTION public.ca_club_player_history(
  p_club_id uuid, p_target_user_id uuid DEFAULT NULL, p_kind text DEFAULT 'all',
  p_from date DEFAULT NULL, p_to date DEFAULT NULL,
  p_cursor jsonb DEFAULT NULL, p_limit integer DEFAULT 50
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp SET statement_timeout = '6s'
AS $function$
DECLARE
  v_actor uuid := auth.uid(); v_scope uuid[]; v_allowed uuid[];
  v_cursor_at timestamptz; v_cursor_id uuid; v_rows jsonb; v_more boolean;
  v_last jsonb;
BEGIN
  IF v_actor IS NULL OR p_club_id IS NULL THEN
    RAISE EXCEPTION 'History Access Denied' USING ERRCODE = '42501';
  END IF;
  v_scope := public.fn_club_scope_ids(p_club_id);
  IF v_scope IS NULL OR cardinality(v_scope) = 0 THEN
    RAISE EXCEPTION 'History Access Denied' USING ERRCODE = '42501';
  END IF;
  SELECT array_agg(c.id) INTO v_allowed FROM public.clubs c
   WHERE c.id=ANY(v_scope) AND public.ca_player_history_can_read(c.id);
  IF v_allowed IS NULL OR cardinality(v_allowed)=0 THEN
    RAISE EXCEPTION 'History Access Denied' USING ERRCODE='42501';
  END IF;
  IF p_kind IS NULL OR p_kind NOT IN ('all','roles','status','notes','exports')
     OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 50
     OR (p_from IS NOT NULL AND p_to IS NOT NULL AND p_from>p_to)
     OR (p_target_user_id IS NOT NULL AND p_kind='exports') THEN
    RAISE EXCEPTION 'Invalid History Query' USING ERRCODE='22023';
  END IF;
  IF p_cursor IS NOT NULL THEN
    IF jsonb_typeof(p_cursor)<>'object' OR NOT(p_cursor ? 'created_at' AND p_cursor ? 'id')
       OR jsonb_typeof(p_cursor->'created_at')<>'string' OR jsonb_typeof(p_cursor->'id')<>'string' THEN
      RAISE EXCEPTION 'Invalid History Cursor' USING ERRCODE='22023';
    END IF;
    BEGIN
      v_cursor_at := (p_cursor->>'created_at')::timestamptz;
      v_cursor_id := (p_cursor->>'id')::uuid;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'Invalid History Cursor' USING ERRCODE='22023';
    END;
    IF v_cursor_at IS NULL OR v_cursor_id IS NULL OR NOT isfinite(v_cursor_at) THEN
      RAISE EXCEPTION 'Invalid History Cursor' USING ERRCODE='22023';
    END IF;
  END IF;
  WITH candidates AS MATERIALIZED (
    SELECT a.*, CASE
      WHEN a.action IN ('role_change','set_member_role') THEN 'roles'
      WHEN a.action IN ('banned','unban_member','member_status_change','set_member_status','kick_member','member_left','depart_club_member') THEN 'status'
      WHEN a.action='update_member_notes' THEN 'notes'
      WHEN a.action='export_club_roster' THEN 'exports' END AS kind
    FROM public.audit_trail a
    WHERE a.club_id=ANY(v_allowed)
      AND ((a.target_type IN ('member','club_member','membership') AND a.action IN (
        'role_change','set_member_role','banned','unban_member','member_status_change','set_member_status','kick_member','member_left','depart_club_member'))
        OR (a.target_type='club_member' AND a.action='update_member_notes')
        OR (p_target_user_id IS NULL AND a.target_type='club' AND a.target_id=a.club_id AND a.action='export_club_roster'))
      AND (p_target_user_id IS NULL OR a.target_id=p_target_user_id)
      AND (p_from IS NULL OR a.created_at >= (p_from::timestamp AT TIME ZONE 'UTC'))
      AND (p_to IS NULL OR a.created_at < ((p_to+1)::timestamp AT TIME ZONE 'UTC'))
      AND (v_cursor_at IS NULL OR (a.created_at,a.id)<(v_cursor_at,v_cursor_id))
      AND (p_kind='all' OR
        (p_kind='roles' AND a.action IN ('role_change','set_member_role')) OR
        (p_kind='status' AND a.action IN ('banned','unban_member','member_status_change','set_member_status','kick_member','member_left','depart_club_member')) OR
        (p_kind='notes' AND a.action='update_member_notes') OR
        (p_kind='exports' AND a.action='export_club_roster'))
    ORDER BY a.created_at DESC,a.id DESC LIMIT p_limit+1
  ), projected AS (
    SELECT c.created_at,c.id,jsonb_build_object(
      'id',c.id,'created_at',c.created_at,'club_id',c.club_id,
      'target_user_id',CASE WHEN c.target_type IN ('member','club_member','membership') THEN c.target_id ELSE NULL END,
      'actor_id',c.actor_id,'actor_name',NULLIF(trim(p.alias),''),'actor_role',c.actor_role,'action',c.action,'kind',c.kind,
      'before',CASE c.kind
        WHEN 'roles' THEN jsonb_build_object('role',c.before_state->'role')
        WHEN 'status' THEN jsonb_build_object('status',c.before_state->'status')
        WHEN 'notes' THEN jsonb_build_object('nickname_present',c.before_state->'nickname_present','remark_present',c.before_state->'remark_present','nickname_length',c.before_state->'nickname_length','remark_length',c.before_state->'remark_length')
        ELSE '{}'::jsonb END,
      'after',CASE c.kind
        WHEN 'roles' THEN jsonb_build_object('role',c.after_state->'role')
        WHEN 'status' THEN jsonb_build_object('status',c.after_state->'status')
        WHEN 'notes' THEN jsonb_build_object('nickname_present',c.after_state->'nickname_present','remark_present',c.after_state->'remark_present','nickname_length',c.after_state->'nickname_length','remark_length',c.after_state->'remark_length')
        WHEN 'exports' THEN jsonb_build_object('row_count',c.after_state->'row_count','selected_only',c.after_state->'selected_only','selected_count',c.after_state->'selected_count','filter',c.after_state->'filter','sort',c.after_state->'sort','search_used',c.after_state->'search_used') END
    ) AS row FROM candidates c LEFT JOIN public.profiles p ON p.id=c.actor_id
    ORDER BY c.created_at DESC,c.id DESC LIMIT p_limit
  )
  SELECT coalesce(jsonb_agg(row ORDER BY created_at DESC,id DESC),'[]'::jsonb),
    (SELECT count(*)>p_limit FROM candidates) INTO v_rows,v_more FROM projected;
  v_last := v_rows->(jsonb_array_length(v_rows)-1);
  RETURN jsonb_build_object('club_id',p_club_id,'scope_club_ids',to_jsonb(v_allowed),'rows',v_rows,'has_more',v_more,'next_cursor',CASE WHEN v_more THEN
    jsonb_build_object('created_at',v_last->'created_at','id',v_last->'id') ELSE NULL END);
END $function$;
REVOKE ALL ON FUNCTION public.ca_club_player_history(uuid,uuid,text,date,date,jsonb,integer) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.ca_club_player_history(uuid,uuid,text,date,date,jsonb,integer) TO authenticated;
COMMENT ON FUNCTION public.ca_club_player_history(uuid,uuid,text,date,date,jsonb,integer) IS 'Bounded recorded member changes and club export metadata for authorized staff. No raw notes, financial terms or provenance. Historical record coverage is not asserted.';
COMMIT;
