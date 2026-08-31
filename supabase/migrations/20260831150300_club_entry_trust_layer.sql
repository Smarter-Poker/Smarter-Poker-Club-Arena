-- Privacy-safe analytics, immutable audit, rollout controls, and ops metrics.

-- audit_trail is the production canonical, append-only privileged-action log.
-- Its existing RLS grants scoped reads and service-role writes. Club Entry
-- mutations write through the SECURITY DEFINER trigger below, never directly
-- from the browser.
REVOKE INSERT, UPDATE, DELETE ON public.audit_trail FROM authenticated, anon;

CREATE TABLE IF NOT EXISTS public.club_entry_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  session_id uuid NOT NULL,
  flow text NOT NULL CHECK (flow IN ('create','find','join','action_bar')),
  event_name text NOT NULL,
  outcome text CHECK (outcome IN ('started','succeeded','failed','cancelled','viewed')),
  duration_ms integer CHECK (duration_ms IS NULL OR duration_ms BETWEEN 0 AND 3600000),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_club_entry_events_flow_created
  ON public.club_entry_events(flow,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_club_entry_events_actor_created
  ON public.club_entry_events(actor_id,created_at DESC);
ALTER TABLE public.club_entry_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.club_entry_events FROM authenticated, anon;

CREATE OR REPLACE FUNCTION public.fn_track_club_entry_event(
  p_session_id uuid,p_flow text,p_event_name text,p_outcome text DEFAULT NULL,
  p_duration_ms integer DEFAULT NULL,p_metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE v_uid uuid:=auth.uid(); v_metadata jsonb;
BEGIN
  IF v_uid IS NULL THEN RETURN; END IF;
  IF p_flow NOT IN ('create','find','join','action_bar') THEN RETURN; END IF;
  IF p_event_name NOT IN (
    'opened','closed','submitted','completed','previewed','searched','loaded_more',
    'privacy_saved','draft_restored','logo_generated','qr_imported','recovered'
  ) THEN RETURN; END IF;
  IF p_outcome IS NOT NULL AND p_outcome NOT IN ('started','succeeded','failed','cancelled','viewed') THEN RETURN; END IF;
  -- Only low-cardinality operational fields survive. Names, queries, codes,
  -- referral IDs, descriptions, and image URLs can never enter analytics.
  v_metadata := jsonb_strip_nulls(jsonb_build_object(
    'source',p_metadata->>'source','status',p_metadata->>'status',
    'error_code',p_metadata->>'error_code','result_count',p_metadata->'result_count',
    'feature_variant',p_metadata->>'feature_variant'
  ));
  INSERT INTO public.club_entry_events(actor_id,session_id,flow,event_name,outcome,duration_ms,metadata)
  VALUES(v_uid,p_session_id,p_flow,p_event_name,p_outcome,
    LEAST(GREATEST(COALESCE(p_duration_ms,0),0),3600000),v_metadata);
END $$;
REVOKE ALL ON FUNCTION public.fn_track_club_entry_event(uuid,text,text,text,integer,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_track_club_entry_event(uuid,text,text,text,integer,jsonb) TO authenticated;

CREATE TABLE IF NOT EXISTS public.club_entry_feature_flags (
  key text PRIMARY KEY CHECK (key IN ('create_club','find_player','join_club')),
  enabled boolean NOT NULL DEFAULT true,
  rollout_percent integer NOT NULL DEFAULT 100 CHECK (rollout_percent BETWEEN 0 AND 100),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL
);
ALTER TABLE public.club_entry_feature_flags ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.club_entry_feature_flags FROM authenticated, anon;
INSERT INTO public.club_entry_feature_flags(key,enabled,rollout_percent) VALUES
  ('create_club',true,100),('find_player',true,100),('join_club',true,100)
ON CONFLICT(key) DO NOTHING;

CREATE OR REPLACE FUNCTION public.fn_get_club_entry_flags()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE v_uid uuid:=auth.uid(); v_result jsonb;
BEGIN
  IF v_uid IS NULL THEN RETURN '{"create_club":false,"find_player":false,"join_club":false}'::jsonb; END IF;
  SELECT jsonb_object_agg(key, enabled AND
    ((hashtextextended(v_uid::text || ':' || key,44119) & 9223372036854775807) % 100) < rollout_percent)
    INTO v_result FROM public.club_entry_feature_flags;
  RETURN COALESCE(v_result,'{"create_club":true,"find_player":true,"join_club":true}'::jsonb);
END $$;
REVOKE ALL ON FUNCTION public.fn_get_club_entry_flags() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_get_club_entry_flags() TO authenticated;

CREATE OR REPLACE FUNCTION public.fn_audit_club_entry_mutation()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE v_action text; v_club uuid; v_target uuid; v_actor uuid; v_details jsonb;
BEGIN
  IF TG_TABLE_NAME='clubs' THEN
    v_action:='club_created'; v_club:=NEW.id; v_target:=NEW.id;
    v_actor:=COALESCE(auth.uid(),NEW.owner_id);
    v_details:=jsonb_build_object('club_code',NEW.club_id,'requires_approval',NEW.requires_approval);
  ELSIF TG_TABLE_NAME='club_members' THEN
    v_club:=NEW.club_id; v_target:=NEW.user_id;
    v_actor:=COALESCE(auth.uid(),NEW.user_id);
    v_action:=CASE WHEN TG_OP='INSERT' THEN 'club_join_'||NEW.status ELSE 'club_join_status_changed' END;
    v_details:=jsonb_build_object('status',NEW.status,'previous_status',CASE WHEN TG_OP='UPDATE' THEN OLD.status ELSE NULL END);
  ELSE
    v_action:='player_search_privacy_changed'; v_target:=NEW.user_id;
    v_actor:=COALESCE(auth.uid(),NEW.user_id);
    v_details:=jsonb_build_object('discoverable',NEW.discoverable,'show_presence',NEW.show_presence,'show_current_table',NEW.show_current_table);
  END IF;
  INSERT INTO public.audit_trail(
    club_id,actor_id,actor_role,action,target_type,target_id,after_state
  ) VALUES(
    v_club,v_actor,'system',v_action,TG_TABLE_NAME,v_target,jsonb_strip_nulls(v_details)
  );
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_audit_club_created ON public.clubs;
CREATE TRIGGER trg_audit_club_created AFTER INSERT ON public.clubs
  FOR EACH ROW EXECUTE FUNCTION public.fn_audit_club_entry_mutation();
DROP TRIGGER IF EXISTS trg_audit_club_join ON public.club_members;
CREATE TRIGGER trg_audit_club_join AFTER INSERT OR UPDATE OF status ON public.club_members
  FOR EACH ROW EXECUTE FUNCTION public.fn_audit_club_entry_mutation();
DROP TRIGGER IF EXISTS trg_audit_player_search_privacy ON public.player_search_preferences;
CREATE TRIGGER trg_audit_player_search_privacy AFTER INSERT OR UPDATE ON public.player_search_preferences
  FOR EACH ROW EXECUTE FUNCTION public.fn_audit_club_entry_mutation();

CREATE OR REPLACE VIEW public.club_entry_daily_metrics AS
SELECT date_trunc('day',created_at) AS day,flow,event_name,outcome,count(*) AS events,
       percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms) FILTER (WHERE duration_ms IS NOT NULL) AS p95_ms
  FROM public.club_entry_events GROUP BY 1,2,3,4;
REVOKE ALL ON public.club_entry_daily_metrics FROM PUBLIC,authenticated,anon;
GRANT SELECT ON public.club_entry_daily_metrics TO service_role;
