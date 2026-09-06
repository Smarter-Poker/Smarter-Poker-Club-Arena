-- 20260906144315_phase_4_realtime_access_and_health_recertified.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
BEGIN;

SET LOCAL lock_timeout = '30s';
SET LOCAL statement_timeout = '10min';

-- Refuse to install the bounded health reader on top of an absent or failed
-- concurrent index build. An invalid concurrent index is worse than no index:
-- its name exists, IF NOT EXISTS skips it, and the old full scan survives.
DO $index_ready$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_index
     WHERE indexrelid = 'public.idx_game_management_events_scope_created_cover'::regclass
       AND indisvalid
       AND indisready
  ) THEN
    RAISE EXCEPTION 'idx_game_management_events_scope_created_cover is not valid and ready';
  END IF;
END;
$index_ready$;

-- Access rows can be reassigned by privileged workflows. The original
-- emitter used COALESCE(NEW, OLD), which notified only the new user/scope and
-- left the old operator's already-open page and hamburger link stale. Emit
-- both sides when identity moves, and ignore balance-only membership writes.
CREATE OR REPLACE FUNCTION public.fn_emit_management_access_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_recipient uuid;
  v_club uuid;
  v_union uuid;
  v_operation text := lower(TG_OP);
BEGIN
  IF TG_TABLE_NAME = 'club_members' THEN
    IF TG_OP = 'UPDATE'
       AND NEW.role IS NOT DISTINCT FROM OLD.role
       AND NEW.user_id IS NOT DISTINCT FROM OLD.user_id
       AND NEW.club_id IS NOT DISTINCT FROM OLD.club_id
       AND NEW.status IS NOT DISTINCT FROM OLD.status
       AND NEW.is_active IS NOT DISTINCT FROM OLD.is_active THEN
      RETURN NULL;
    END IF;

    IF TG_OP IN ('UPDATE', 'DELETE') THEN
      PERFORM public.fn_emit_game_management_event(
        'management_access_changed', OLD.club_id, NULL, OLD.user_id,
        'club', OLD.club_id, NULL,
        jsonb_build_object('operation', v_operation, 'side', 'before'));
    END IF;
    IF TG_OP IN ('UPDATE', 'INSERT')
       AND (TG_OP = 'INSERT'
            OR NEW.user_id IS DISTINCT FROM OLD.user_id
            OR NEW.club_id IS DISTINCT FROM OLD.club_id
            OR NEW.role IS DISTINCT FROM OLD.role
            OR NEW.status IS DISTINCT FROM OLD.status
            OR NEW.is_active IS DISTINCT FROM OLD.is_active) THEN
      -- When the row identity did not move, one after-event is sufficient.
      IF TG_OP = 'INSERT'
         OR NEW.user_id IS DISTINCT FROM OLD.user_id
         OR NEW.club_id IS DISTINCT FROM OLD.club_id THEN
        PERFORM public.fn_emit_game_management_event(
          'management_access_changed', NEW.club_id, NULL, NEW.user_id,
          'club', NEW.club_id, NULL,
          jsonb_build_object('operation', v_operation, 'side', 'after'));
      END IF;
    END IF;

  ELSIF TG_TABLE_NAME = 'union_admins' THEN
    IF TG_OP = 'UPDATE'
       AND NEW.user_id IS NOT DISTINCT FROM OLD.user_id
       AND NEW.union_id IS NOT DISTINCT FROM OLD.union_id
       AND NEW.role IS NOT DISTINCT FROM OLD.role THEN
      RETURN NULL;
    END IF;

    IF TG_OP IN ('UPDATE', 'DELETE') THEN
      PERFORM public.fn_emit_game_management_event(
        'management_access_changed', NULL, OLD.union_id, OLD.user_id,
        'union', OLD.union_id, NULL,
        jsonb_build_object('operation', v_operation, 'side', 'before'));
    END IF;
    IF TG_OP = 'INSERT'
       OR (TG_OP = 'UPDATE' AND (
         NEW.user_id IS DISTINCT FROM OLD.user_id
         OR NEW.union_id IS DISTINCT FROM OLD.union_id)) THEN
      PERFORM public.fn_emit_game_management_event(
        'management_access_changed', NULL, NEW.union_id, NEW.user_id,
        'union', NEW.union_id, NULL,
        jsonb_build_object('operation', v_operation, 'side', 'after'));
    END IF;

  ELSE
    -- union_clubs. UPDATE was omitted from the original trigger entirely.
    -- Each side gets its own recipient set and its own union scope.
    IF TG_OP IN ('UPDATE', 'DELETE') THEN
      v_club := OLD.club_id;
      v_union := OLD.union_id;
      FOR v_recipient IN
        SELECT c.owner_id FROM public.clubs c WHERE c.id = v_club
        UNION SELECT m.user_id FROM public.club_members m
          WHERE m.club_id = v_club
            AND m.role IN ('owner','co_owner','admin')
            AND m.status IN ('active','approved')
            AND COALESCE(m.is_active, true)
        UNION SELECT u.owner_id FROM public.unions u WHERE u.id = v_union
        UNION SELECT a.user_id FROM public.union_admins a WHERE a.union_id = v_union
      LOOP
        PERFORM public.fn_emit_game_management_event(
          'management_access_changed', v_club, v_union, v_recipient,
          'club', v_club, NULL,
          jsonb_build_object('operation', v_operation, 'side', 'before'));
      END LOOP;
    END IF;

    IF TG_OP IN ('UPDATE', 'INSERT') THEN
      v_club := NEW.club_id;
      v_union := NEW.union_id;
      FOR v_recipient IN
        SELECT c.owner_id FROM public.clubs c WHERE c.id = v_club
        UNION SELECT m.user_id FROM public.club_members m
          WHERE m.club_id = v_club
            AND m.role IN ('owner','co_owner','admin')
            AND m.status IN ('active','approved')
            AND COALESCE(m.is_active, true)
        UNION SELECT u.owner_id FROM public.unions u WHERE u.id = v_union
        UNION SELECT a.user_id FROM public.union_admins a WHERE a.union_id = v_union
      LOOP
        PERFORM public.fn_emit_game_management_event(
          'management_access_changed', v_club, v_union, v_recipient,
          'club', v_club, NULL,
          jsonb_build_object('operation', v_operation, 'side', 'after'));
      END LOOP;
    END IF;
  END IF;
  RETURN NULL;
END;
$function$;

-- A club ownership transfer changes Table Management authority even when no
-- club_members row changes. The old trigger watched only union_id. Notify the
-- old and new owners, and both unions' operators when the club moves.
CREATE OR REPLACE FUNCTION public.fn_emit_club_union_access_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_recipient uuid;
  v_union uuid;
  v_side text;
BEGIN
  IF NEW.owner_id IS DISTINCT FROM OLD.owner_id THEN
    PERFORM public.fn_emit_game_management_event(
      'management_access_changed', NEW.id, NEW.union_id, OLD.owner_id,
      'club', NEW.id, NULL,
      jsonb_build_object('operation', 'owner_changed', 'side', 'before'));
    PERFORM public.fn_emit_game_management_event(
      'management_access_changed', NEW.id, NEW.union_id, NEW.owner_id,
      'club', NEW.id, NULL,
      jsonb_build_object('operation', 'owner_changed', 'side', 'after'));
  END IF;

  IF NEW.union_id IS DISTINCT FROM OLD.union_id THEN
    FOR v_union, v_side IN
      SELECT OLD.union_id, 'before' WHERE OLD.union_id IS NOT NULL
      UNION ALL
      SELECT NEW.union_id, 'after' WHERE NEW.union_id IS NOT NULL
    LOOP
      FOR v_recipient IN
        SELECT OLD.owner_id
        UNION SELECT NEW.owner_id
        UNION SELECT m.user_id FROM public.club_members m
          WHERE m.club_id = NEW.id
            AND m.role IN ('owner','co_owner','admin')
            AND m.status IN ('active','approved')
            AND COALESCE(m.is_active, true)
        UNION SELECT u.owner_id FROM public.unions u WHERE u.id = v_union
        UNION SELECT a.user_id FROM public.union_admins a WHERE a.union_id = v_union
      LOOP
        PERFORM public.fn_emit_game_management_event(
          'management_access_changed', NEW.id, v_union, v_recipient,
          'club', NEW.id, NULL,
          jsonb_build_object('operation', 'union_changed', 'side', v_side));
      END LOOP;
    END LOOP;

    -- Leaving a union has a new standalone scope. Its operators still need an
    -- authoritative refresh even though there is no new union recipient set.
    IF NEW.union_id IS NULL THEN
      FOR v_recipient IN
        SELECT NEW.owner_id
        UNION SELECT m.user_id FROM public.club_members m
          WHERE m.club_id = NEW.id
            AND m.role IN ('owner','co_owner','admin')
            AND m.status IN ('active','approved')
            AND COALESCE(m.is_active, true)
      LOOP
        PERFORM public.fn_emit_game_management_event(
          'management_access_changed', NEW.id, NULL, v_recipient,
          'club', NEW.id, NULL,
          jsonb_build_object('operation', 'union_changed', 'side', 'after'));
      END LOOP;
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

-- Metadata clocks and revision bumps are not visible content. Do not produce
-- an event/audit row unless a value the operator or player can see changed.
CREATE OR REPLACE FUNCTION public.fn_emit_management_content_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_club uuid; v_union uuid; v_type text; v_id uuid; v_role text := 'host';
  v_before jsonb; v_after jsonb;
BEGIN
  IF TG_TABLE_NAME = 'game_ticker_settings' THEN
    IF TG_OP = 'UPDATE'
       AND (to_jsonb(NEW) - ARRAY['updated_at','revision'])
           IS NOT DISTINCT FROM (to_jsonb(OLD) - ARRAY['updated_at','revision']) THEN
      RETURN NULL;
    END IF;
    v_club := COALESCE(NEW.club_id, OLD.club_id);
    v_union := COALESCE(NEW.union_id, OLD.union_id);
    v_type := 'ticker_settings_changed'; v_id := COALESCE(NEW.id, OLD.id);
    v_before := CASE WHEN TG_OP='INSERT' THEN NULL ELSE jsonb_build_object('settings',OLD.settings) END;
    v_after := CASE WHEN TG_OP='DELETE' THEN NULL ELSE jsonb_build_object('settings',NEW.settings) END;
  ELSIF TG_TABLE_NAME = 'clubs' THEN
    IF NEW.tagline IS NOT DISTINCT FROM OLD.tagline
       AND NEW.lobby_message IS NOT DISTINCT FROM OLD.lobby_message
       AND NEW.description IS NOT DISTINCT FROM OLD.description THEN
      RETURN NULL;
    END IF;
    v_club := NEW.id; v_type := 'club_identity_changed'; v_id := NEW.id;
    v_before := jsonb_build_object('tagline',OLD.tagline,'lobby_message',OLD.lobby_message,'description',OLD.description);
    v_after := jsonb_build_object('tagline',NEW.tagline,'lobby_message',NEW.lobby_message,'description',NEW.description);
  ELSE
    IF TG_OP = 'UPDATE'
       AND (to_jsonb(NEW) - ARRAY['updated_at','management_revision'])
           IS NOT DISTINCT FROM (to_jsonb(OLD) - ARRAY['updated_at','management_revision']) THEN
      RETURN NULL;
    END IF;
    v_club := COALESCE(NEW.club_id,OLD.club_id);
    v_type := 'announcement_changed'; v_id := COALESCE(NEW.id,OLD.id);
    v_before := CASE WHEN TG_OP='INSERT' THEN NULL ELSE jsonb_build_object(
      'title',OLD.title,'content',OLD.content,'is_pinned',OLD.is_pinned,'is_active',OLD.is_active) END;
    v_after := CASE WHEN TG_OP='DELETE' THEN NULL ELSE jsonb_build_object(
      'title',NEW.title,'content',NEW.content,'is_pinned',NEW.is_pinned,'is_active',NEW.is_active) END;
  END IF;

  PERFORM public.fn_emit_game_management_event(
    v_type,v_club,v_union,NULL,TG_TABLE_NAME,v_id,NULL,
    jsonb_build_object('operation',lower(TG_OP)));

  IF auth.uid() IS NOT NULL THEN
    IF v_union IS NOT NULL OR EXISTS (
      SELECT 1 FROM public.union_clubs WHERE club_id=v_club) THEN
      v_role := 'union_admin';
    ELSE
      SELECT CASE WHEN c.owner_id=auth.uid() THEN 'owner'
                  WHEN m.role='co_owner' THEN 'co_owner'
                  WHEN m.role='admin' THEN 'admin' ELSE 'host' END
        INTO v_role FROM public.clubs c
        LEFT JOIN public.club_members m
          ON m.club_id=c.id AND m.user_id=auth.uid()
       WHERE c.id=v_club;
    END IF;
    INSERT INTO public.audit_trail(
      actor_id,actor_role,action,target_type,target_id,club_id,before_state,after_state
    ) VALUES (
      auth.uid(),COALESCE(v_role,'host'),v_type,TG_TABLE_NAME,v_id,v_club,v_before,v_after);
  END IF;
  RETURN NULL;
END;
$function$;

-- Split the latest marker from the time-window counters. The old aggregate
-- mixed them in one scan and therefore read every historical row. The event
-- counters now touch no row older than 24 hours; latest uses the existing
-- scope/sequence index.
CREATE OR REPLACE FUNCTION public.fn_get_game_management_health(p_scope text,p_scope_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_authorized boolean;
  v_access jsonb;
  v_latest_sequence bigint := 0;
  v_last_event_at timestamptz;
  v_events_last_hour bigint := 0;
  v_commands_last_24h bigint := 0;
  v_rejected_last_24h bigint := 0;
  v_integrity_alerts bigint := 0;
BEGIN
  IF p_scope='club' THEN
    v_access:=public.fn_game_creation_access(p_scope_id);
    v_authorized:=COALESCE((v_access->>'allowed')::boolean,false)
      AND v_access->>'union_id' IS NULL;
  ELSIF p_scope='union' THEN
    v_authorized:=public.fn_is_union_operator(p_scope_id,auth.uid());
  ELSE
    v_authorized:=false;
  END IF;
  IF NOT COALESCE(v_authorized,false) THEN
    RETURN jsonb_build_object('ok',false,'reason','not_authorized');
  END IF;

  SELECT e.sequence, e.created_at
    INTO v_latest_sequence, v_last_event_at
    FROM public.game_management_events e
   WHERE e.scope_kind=p_scope AND e.scope_id=p_scope_id
   ORDER BY e.sequence DESC
   LIMIT 1;

  SELECT
    count(*) FILTER (WHERE e.created_at>=now()-interval '1 hour'),
    count(*) FILTER (WHERE e.event_type LIKE 'game_command_%'),
    count(*) FILTER (WHERE e.event_type='game_command_rejected')
    INTO v_events_last_hour,v_commands_last_24h,v_rejected_last_24h
    FROM public.game_management_events e
   WHERE e.scope_kind=p_scope
     AND e.scope_id=p_scope_id
     AND e.created_at>=now()-interval '24 hours';

  SELECT count(*) INTO v_integrity_alerts
    FROM public.managed_game_command_receipts r
   WHERE (
       (r.status='processing' AND r.created_at<now()-interval '5 minutes')
       OR (r.status='succeeded' AND r.contract_version_after IS NULL)
     )
     AND (
       r.game_kind='table' AND EXISTS (
         SELECT 1 FROM public.tables t WHERE t.id=r.game_id AND (
           (p_scope='club' AND t.club_id=p_scope_id AND t.union_id IS NULL)
           OR (p_scope='union' AND (t.union_id=p_scope_id OR t.club_id=p_scope_id
             OR EXISTS (SELECT 1 FROM public.union_clubs uc
               WHERE uc.club_id=t.club_id AND uc.union_id=p_scope_id)
             OR EXISTS (SELECT 1 FROM public.clubs c
               WHERE c.id=t.club_id AND c.union_id=p_scope_id)))
         )
       )
       OR r.game_kind='tournament' AND EXISTS (
         SELECT 1 FROM public.tournaments t WHERE t.id=r.game_id AND (
           (p_scope='club' AND t.club_id=p_scope_id AND t.union_id IS NULL)
           OR (p_scope='union' AND (t.union_id=p_scope_id OR t.club_id=p_scope_id
             OR EXISTS (SELECT 1 FROM public.union_clubs uc
               WHERE uc.club_id=t.club_id AND uc.union_id=p_scope_id)
             OR EXISTS (SELECT 1 FROM public.clubs c
               WHERE c.id=t.club_id AND c.union_id=p_scope_id)))
         )
       )
     );

  RETURN jsonb_build_object(
    'ok',true,
    'latest_event_sequence',COALESCE(v_latest_sequence,0),
    'last_event_at',v_last_event_at,
    'events_last_hour',COALESCE(v_events_last_hour,0),
    'commands_last_24h',COALESCE(v_commands_last_24h,0),
    'rejected_last_24h',COALESCE(v_rejected_last_24h,0),
    'integrity_alerts',COALESCE(v_integrity_alerts,0));
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_emit_management_access_event() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.fn_emit_club_union_access_event() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.fn_emit_management_content_event() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.fn_get_game_management_health(text,uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.fn_get_game_management_health(text,uuid) TO authenticated,service_role;

DO $assert$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.proname='fn_get_game_management_health'
       AND p.prosecdef
       AND p.prosrc LIKE '%created_at>=%interval%24 hours%'
       AND p.prosrc NOT LIKE '%INTO v_result FROM public.game_management_events%'
  ) THEN
    RAISE EXCEPTION 'health reader is not the bounded Phase 4 definition';
  END IF;
END;
$assert$;

COMMIT;
