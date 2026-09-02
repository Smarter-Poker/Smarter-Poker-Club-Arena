-- Compact, authorized realtime for the complete Table Management surface.
-- Raw tables/tournaments subscriptions are intentionally avoided: they once
-- fanned every platform mutation to every client. This stream contains only
-- the minimum identifiers needed to trigger an authoritative scoped refresh.

BEGIN;

-- Fail cleanly instead of waiting indefinitely if a busy gameplay transaction
-- temporarily owns a trigger target. The migration is idempotent and can be
-- retried without pre-locking multiple live game tables in a conflicting order.
SET LOCAL lock_timeout = '30s';
SET LOCAL statement_timeout = '10min';

CREATE TABLE IF NOT EXISTS public.game_management_events (
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  event_type text NOT NULL CHECK (event_type IN (
    'game_changed','game_command_succeeded','game_command_rejected',
    'ticker_settings_changed','club_identity_changed','announcement_changed',
    'management_access_changed'
  )),
  scope_kind text CHECK (scope_kind IN ('club','union')),
  scope_id uuid,
  club_id uuid REFERENCES public.clubs(id) ON DELETE CASCADE,
  union_id uuid REFERENCES public.unions(id) ON DELETE CASCADE,
  recipient_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  entity_type text,
  entity_id uuid,
  command_id uuid,
  actor_id uuid,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (scope_id IS NOT NULL OR recipient_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_game_management_events_scope
  ON public.game_management_events(scope_id, sequence DESC);
CREATE INDEX IF NOT EXISTS idx_game_management_events_recipient
  ON public.game_management_events(recipient_id, sequence DESC)
  WHERE recipient_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_game_management_events_created
  ON public.game_management_events(created_at DESC);

ALTER TABLE public.game_management_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.game_management_events FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.game_management_events TO authenticated;

DROP POLICY IF EXISTS game_management_events_authorized_read
  ON public.game_management_events;
CREATE POLICY game_management_events_authorized_read
  ON public.game_management_events FOR SELECT TO authenticated
  USING (
    recipient_id = auth.uid()
    OR (scope_kind = 'club' AND public.fn_can_create_games(scope_id, auth.uid()))
    OR (scope_kind = 'union' AND public.fn_is_union_operator(scope_id, auth.uid()))
  );

CREATE OR REPLACE FUNCTION public.fn_guard_game_management_event()
RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public' AS $function$
BEGIN
  RAISE EXCEPTION 'Game management events are append-only' USING ERRCODE='55000';
END;
$function$;
DROP TRIGGER IF EXISTS trg_game_management_events_append_only
  ON public.game_management_events;
CREATE TRIGGER trg_game_management_events_append_only
BEFORE UPDATE OR DELETE ON public.game_management_events
FOR EACH ROW EXECUTE FUNCTION public.fn_guard_game_management_event();

CREATE OR REPLACE FUNCTION public.fn_game_management_scope(p_club_id uuid)
RETURNS TABLE(scope_kind text, scope_id uuid, union_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $function$
  SELECT CASE WHEN x.union_id IS NULL THEN 'club' ELSE 'union' END,
         COALESCE(x.union_id, p_club_id), x.union_id
  FROM (
    SELECT COALESCE(c.union_id, uc.union_id) AS union_id
    FROM public.clubs c
    LEFT JOIN public.union_clubs uc ON uc.club_id=c.id
    WHERE c.id=p_club_id
    ORDER BY uc.joined_at DESC NULLS LAST
    LIMIT 1
  ) x
$function$;

CREATE OR REPLACE FUNCTION public.fn_emit_game_management_event(
  p_event_type text,
  p_club_id uuid DEFAULT NULL,
  p_union_id uuid DEFAULT NULL,
  p_recipient_id uuid DEFAULT NULL,
  p_entity_type text DEFAULT NULL,
  p_entity_id uuid DEFAULT NULL,
  p_command_id uuid DEFAULT NULL,
  p_payload jsonb DEFAULT '{}'::jsonb
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE v_scope_kind text; v_scope_id uuid; v_union_id uuid;
BEGIN
  IF p_union_id IS NOT NULL THEN
    v_scope_kind := 'union'; v_scope_id := p_union_id; v_union_id := p_union_id;
  ELSIF p_club_id IS NOT NULL THEN
    SELECT s.scope_kind,s.scope_id,s.union_id
      INTO v_scope_kind,v_scope_id,v_union_id
      FROM public.fn_game_management_scope(p_club_id) s;
  END IF;
  INSERT INTO public.game_management_events(
    event_type,scope_kind,scope_id,club_id,union_id,recipient_id,
    entity_type,entity_id,command_id,actor_id,payload
  ) VALUES (
    p_event_type,v_scope_kind,v_scope_id,p_club_id,v_union_id,p_recipient_id,
    p_entity_type,p_entity_id,p_command_id,auth.uid(),COALESCE(p_payload,'{}'::jsonb)
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_emit_managed_game_row_event()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE v_club uuid := COALESCE(NEW.club_id,OLD.club_id); v_id uuid := COALESCE(NEW.id,OLD.id);
BEGIN
  -- Tournament backing tables are represented by the tournament event itself.
  IF TG_TABLE_NAME='tables' AND COALESCE(NEW.tournament_id,OLD.tournament_id) IS NOT NULL THEN
    RETURN NULL;
  END IF;
  PERFORM public.fn_emit_game_management_event(
    'game_changed',v_club,NULL,NULL,
    CASE WHEN TG_TABLE_NAME='tables' THEN 'table' ELSE 'tournament' END,
    v_id,NULL,jsonb_build_object('operation',lower(TG_OP))
  );
  RETURN NULL;
END;
$function$;
DROP TRIGGER IF EXISTS trg_tables_emit_game_management_event ON public.tables;
CREATE TRIGGER trg_tables_emit_game_management_event
AFTER INSERT OR UPDATE OR DELETE ON public.tables
FOR EACH ROW EXECUTE FUNCTION public.fn_emit_managed_game_row_event();
DROP TRIGGER IF EXISTS trg_tournaments_emit_game_management_event ON public.tournaments;
CREATE TRIGGER trg_tournaments_emit_game_management_event
AFTER INSERT OR UPDATE OR DELETE ON public.tournaments
FOR EACH ROW EXECUTE FUNCTION public.fn_emit_managed_game_row_event();

CREATE OR REPLACE FUNCTION public.fn_emit_managed_command_event()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE v_club uuid; v_role text := 'host';
BEGIN
  IF OLD.status='processing' AND NEW.status IN ('succeeded','rejected') THEN
    IF NEW.game_kind='table' THEN
      SELECT club_id INTO v_club FROM public.tables WHERE id=NEW.game_id;
    ELSE
      SELECT club_id INTO v_club FROM public.tournaments WHERE id=NEW.game_id;
    END IF;
    PERFORM public.fn_emit_game_management_event(
      'game_command_'||NEW.status,v_club,NULL,NULL,NEW.game_kind,NEW.game_id,
      NEW.command_id,jsonb_build_object('action',NEW.command_action,'status',NEW.status)
    );
    IF EXISTS (SELECT 1 FROM public.union_clubs WHERE club_id=v_club) THEN
      v_role := 'union_admin';
    ELSE
      SELECT CASE WHEN c.owner_id=NEW.actor_id THEN 'owner'
                  WHEN m.role='co_owner' THEN 'co_owner' ELSE 'host' END
        INTO v_role FROM public.clubs c
        LEFT JOIN public.club_members m ON m.club_id=c.id AND m.user_id=NEW.actor_id
       WHERE c.id=v_club;
    END IF;
    INSERT INTO public.audit_trail(
      actor_id,actor_role,action,target_type,target_id,club_id,
      before_state,after_state,reason,request_id
    ) VALUES (
      NEW.actor_id,COALESCE(v_role,'host'),'managed_game_'||NEW.command_action||'_'||NEW.status,
      NEW.game_kind,NEW.game_id,v_club,
      jsonb_build_object('contract_version',NEW.contract_version_before),
      jsonb_build_object('contract_version',NEW.contract_version_after,'result',NEW.result),
      NEW.result->>'reason',NEW.command_id::text
    );
  END IF;
  RETURN NEW;
END;
$function$;
DROP TRIGGER IF EXISTS trg_managed_command_emit_event
  ON public.managed_game_command_receipts;
CREATE TRIGGER trg_managed_command_emit_event
AFTER UPDATE ON public.managed_game_command_receipts
FOR EACH ROW EXECUTE FUNCTION public.fn_emit_managed_command_event();

CREATE OR REPLACE FUNCTION public.fn_emit_management_content_event()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  v_club uuid; v_union uuid; v_type text; v_id uuid; v_role text := 'host';
  v_before jsonb; v_after jsonb;
BEGIN
  IF TG_TABLE_NAME='game_ticker_settings' THEN
    v_club:=COALESCE(NEW.club_id,OLD.club_id); v_union:=COALESCE(NEW.union_id,OLD.union_id);
    v_type:='ticker_settings_changed'; v_id:=COALESCE(NEW.id,OLD.id);
    v_before:=CASE WHEN TG_OP='INSERT' THEN NULL ELSE jsonb_build_object('settings',OLD.settings) END;
    v_after:=CASE WHEN TG_OP='DELETE' THEN NULL ELSE jsonb_build_object('settings',NEW.settings) END;
  ELSIF TG_TABLE_NAME='clubs' THEN
    v_club:=COALESCE(NEW.id,OLD.id); v_type:='club_identity_changed'; v_id:=v_club;
    v_before:=jsonb_build_object('tagline',OLD.tagline,'lobby_message',OLD.lobby_message,'description',OLD.description);
    v_after:=jsonb_build_object('tagline',NEW.tagline,'lobby_message',NEW.lobby_message,'description',NEW.description);
  ELSE
    v_club:=COALESCE(NEW.club_id,OLD.club_id); v_type:='announcement_changed';
    v_id:=COALESCE(NEW.id,OLD.id);
    v_before:=CASE WHEN TG_OP='INSERT' THEN NULL ELSE jsonb_build_object(
      'title',OLD.title,'content',OLD.content,'is_pinned',OLD.is_pinned,'is_active',OLD.is_active) END;
    v_after:=CASE WHEN TG_OP='DELETE' THEN NULL ELSE jsonb_build_object(
      'title',NEW.title,'content',NEW.content,'is_pinned',NEW.is_pinned,'is_active',NEW.is_active) END;
  END IF;
  PERFORM public.fn_emit_game_management_event(
    v_type,v_club,v_union,NULL,TG_TABLE_NAME,v_id,NULL,
    jsonb_build_object('operation',lower(TG_OP))
  );
  IF auth.uid() IS NOT NULL THEN
    IF v_union IS NOT NULL OR EXISTS (SELECT 1 FROM public.union_clubs WHERE club_id=v_club) THEN
      v_role:='union_admin';
    ELSE
      SELECT CASE WHEN c.owner_id=auth.uid() THEN 'owner'
                  WHEN m.role='co_owner' THEN 'co_owner' ELSE 'host' END
        INTO v_role FROM public.clubs c
        LEFT JOIN public.club_members m ON m.club_id=c.id AND m.user_id=auth.uid()
       WHERE c.id=v_club;
    END IF;
    INSERT INTO public.audit_trail(
      actor_id,actor_role,action,target_type,target_id,club_id,before_state,after_state
    ) VALUES (
      auth.uid(),COALESCE(v_role,'host'),v_type,TG_TABLE_NAME,v_id,v_club,v_before,v_after
    );
  END IF;
  RETURN NULL;
END;
$function$;
DROP TRIGGER IF EXISTS trg_ticker_emit_management_event ON public.game_ticker_settings;
CREATE TRIGGER trg_ticker_emit_management_event AFTER INSERT OR UPDATE OR DELETE
ON public.game_ticker_settings FOR EACH ROW EXECUTE FUNCTION public.fn_emit_management_content_event();
DROP TRIGGER IF EXISTS trg_club_identity_emit_management_event ON public.clubs;
CREATE TRIGGER trg_club_identity_emit_management_event
AFTER UPDATE OF tagline,lobby_message,description ON public.clubs
FOR EACH ROW EXECUTE FUNCTION public.fn_emit_management_content_event();
DROP TRIGGER IF EXISTS trg_announcements_emit_management_event ON public.club_announcements;
CREATE TRIGGER trg_announcements_emit_management_event AFTER INSERT OR UPDATE OR DELETE
ON public.club_announcements FOR EACH ROW EXECUTE FUNCTION public.fn_emit_management_content_event();

CREATE OR REPLACE FUNCTION public.fn_emit_management_access_event()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE v_recipient uuid; v_club uuid; v_union uuid;
BEGIN
  IF TG_TABLE_NAME='club_members' THEN
    v_recipient:=COALESCE(NEW.user_id,OLD.user_id); v_club:=COALESCE(NEW.club_id,OLD.club_id);
    PERFORM public.fn_emit_game_management_event(
      'management_access_changed',v_club,NULL,v_recipient,'club',v_club,NULL,
      jsonb_build_object('operation',lower(TG_OP))
    );
  ELSIF TG_TABLE_NAME='union_admins' THEN
    v_recipient:=COALESCE(NEW.user_id,OLD.user_id); v_union:=COALESCE(NEW.union_id,OLD.union_id);
    PERFORM public.fn_emit_game_management_event(
      'management_access_changed',NULL,v_union,v_recipient,'union',v_union,NULL,
      jsonb_build_object('operation',lower(TG_OP))
    );
  ELSE
    v_club:=COALESCE(NEW.club_id,OLD.club_id); v_union:=COALESCE(NEW.union_id,OLD.union_id);
    FOR v_recipient IN
      SELECT c.owner_id FROM public.clubs c WHERE c.id=v_club
      UNION SELECT m.user_id FROM public.club_members m
        WHERE m.club_id=v_club AND m.role IN ('owner','co_owner','admin','host')
      UNION SELECT u.owner_id FROM public.unions u WHERE u.id=v_union
      UNION SELECT a.user_id FROM public.union_admins a WHERE a.union_id=v_union
    LOOP
      PERFORM public.fn_emit_game_management_event(
        'management_access_changed',v_club,v_union,v_recipient,'club',v_club,NULL,
        jsonb_build_object('operation',lower(TG_OP))
      );
    END LOOP;
  END IF;
  RETURN NULL;
END;
$function$;
DROP TRIGGER IF EXISTS trg_club_members_emit_management_access ON public.club_members;
CREATE TRIGGER trg_club_members_emit_management_access AFTER INSERT OR UPDATE OR DELETE
ON public.club_members FOR EACH ROW EXECUTE FUNCTION public.fn_emit_management_access_event();
DROP TRIGGER IF EXISTS trg_union_admins_emit_management_access ON public.union_admins;
CREATE TRIGGER trg_union_admins_emit_management_access AFTER INSERT OR UPDATE OR DELETE
ON public.union_admins FOR EACH ROW EXECUTE FUNCTION public.fn_emit_management_access_event();
DROP TRIGGER IF EXISTS trg_union_clubs_emit_management_access ON public.union_clubs;
CREATE TRIGGER trg_union_clubs_emit_management_access AFTER INSERT OR DELETE
ON public.union_clubs FOR EACH ROW EXECUTE FUNCTION public.fn_emit_management_access_event();

CREATE OR REPLACE FUNCTION public.fn_emit_club_union_access_event()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE v_recipient uuid;
BEGIN
  IF NEW.union_id IS DISTINCT FROM OLD.union_id THEN
    FOR v_recipient IN
      SELECT NEW.owner_id
      UNION SELECT m.user_id FROM public.club_members m
        WHERE m.club_id=NEW.id AND m.role IN ('owner','co_owner','admin','host')
      UNION SELECT u.owner_id FROM public.unions u WHERE u.id IN (OLD.union_id,NEW.union_id)
      UNION SELECT a.user_id FROM public.union_admins a WHERE a.union_id IN (OLD.union_id,NEW.union_id)
    LOOP
      PERFORM public.fn_emit_game_management_event(
        'management_access_changed',NEW.id,COALESCE(NEW.union_id,OLD.union_id),
        v_recipient,'club',NEW.id,NULL,
        jsonb_build_object('operation','union_changed')
      );
    END LOOP;
  END IF;
  RETURN NEW;
END;
$function$;
DROP TRIGGER IF EXISTS trg_club_union_emit_management_access ON public.clubs;
CREATE TRIGGER trg_club_union_emit_management_access AFTER UPDATE OF union_id
ON public.clubs FOR EACH ROW EXECUTE FUNCTION public.fn_emit_club_union_access_event();

CREATE OR REPLACE FUNCTION public.fn_emit_union_owner_access_event()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
BEGIN
  IF NEW.owner_id IS DISTINCT FROM OLD.owner_id THEN
    PERFORM public.fn_emit_game_management_event(
      'management_access_changed',NULL,NEW.id,OLD.owner_id,'union',NEW.id,NULL,
      jsonb_build_object('operation','owner_changed')
    );
    PERFORM public.fn_emit_game_management_event(
      'management_access_changed',NULL,NEW.id,NEW.owner_id,'union',NEW.id,NULL,
      jsonb_build_object('operation','owner_changed')
    );
  END IF;
  RETURN NEW;
END;
$function$;
DROP TRIGGER IF EXISTS trg_union_owner_emit_management_access ON public.unions;
CREATE TRIGGER trg_union_owner_emit_management_access AFTER UPDATE OF owner_id
ON public.unions FOR EACH ROW EXECUTE FUNCTION public.fn_emit_union_owner_access_event();

CREATE OR REPLACE FUNCTION public.fn_get_game_management_health(p_scope text,p_scope_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE v_authorized boolean; v_result jsonb; v_access jsonb;
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
  SELECT jsonb_build_object(
    'ok',true,
    'latest_event_sequence',COALESCE(max(e.sequence),0),
    'last_event_at',max(e.created_at),
    'events_last_hour',count(*) FILTER (WHERE e.created_at>=now()-interval '1 hour'),
    'commands_last_24h',count(*) FILTER (
      WHERE e.event_type LIKE 'game_command_%' AND e.created_at>=now()-interval '24 hours'),
    'rejected_last_24h',count(*) FILTER (
      WHERE e.event_type='game_command_rejected' AND e.created_at>=now()-interval '24 hours'),
    'integrity_alerts',(
      SELECT count(*) FROM public.managed_game_command_receipts r
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
        )
    )
  ) INTO v_result FROM public.game_management_events e
  WHERE e.scope_kind=p_scope AND e.scope_id=p_scope_id;
  RETURN v_result;
END;
$function$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname='supabase_realtime' AND schemaname='public'
      AND tablename='game_management_events'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.game_management_events;
  END IF;
END;
$do$;

REVOKE ALL ON FUNCTION public.fn_emit_game_management_event(text,uuid,uuid,uuid,text,uuid,uuid,jsonb)
  FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.fn_game_management_scope(uuid)
  FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.fn_emit_managed_game_row_event()
  FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.fn_emit_managed_command_event()
  FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.fn_emit_management_content_event()
  FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.fn_emit_management_access_event()
  FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.fn_emit_club_union_access_event()
  FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.fn_emit_union_owner_access_event()
  FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.fn_get_game_management_health(text,uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.fn_get_game_management_health(text,uuid)
  TO authenticated,service_role;

COMMENT ON TABLE public.game_management_events IS
  'Append-only, compact realtime invalidation feed for authorized Table Management clients.';

COMMIT;
