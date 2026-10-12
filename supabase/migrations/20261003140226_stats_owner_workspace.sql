-- 20261003140226_stats_owner_workspace
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-10-03 14:02:26 UTC.
--
-- CLAUDE.md 10.9: the reasoning goes in this header, not just the SQL.
-- Say what was wrong, what this changes, and what you measured. A
-- migration whose header is its own filename is the next agent's mystery.
--
-- Phase 8 needs durable player-owned analysis, leak follow-through, goals,
-- study collections, dashboard preferences and alert rules. None of those
-- belong in localStorage, and the existing rule-derived LeakPanel was not a
-- model execution channel. This migration therefore stores only explicitly
-- player-authored or rule-derived reports and names that provenance on every
-- row. It reuses ca_hand_notes by linking study items to hand ids; it creates
-- no duplicate note or tag column.
--
-- Privacy is database-owned: every table has owner-only RLS. Browser writes
-- go through narrow SECURITY DEFINER functions that always take the actor
-- from auth.uid(); no function accepts a user id. Reports are idempotent per
-- (user_id, idempotency_key); an exact replay returns the first id, while the
-- same key with a different SHA-256 request hash is refused. A study item is accepted only when the caller
-- owns a canonical fact or an existing private note for that hand. Alert
-- rules are preferences evaluated on an explicit Stats refresh, not a cron,
-- watcher, polling loop or claim of background delivery.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

CREATE TABLE public.ca_stats_workspace_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  title text NOT NULL,
  source_kind text NOT NULL,
  source_version text NOT NULL,
  body jsonb NOT NULL DEFAULT '{}'::jsonb,
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  club_id uuid,
  range_days integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ca_stats_workspace_reports_identity UNIQUE (user_id, idempotency_key),
  CONSTRAINT ca_stats_workspace_reports_key_len CHECK (char_length(idempotency_key) BETWEEN 1 AND 128),
  CONSTRAINT ca_stats_workspace_reports_hash_len CHECK (char_length(request_hash) = 64),
  CONSTRAINT ca_stats_workspace_reports_title_len CHECK (char_length(title) BETWEEN 1 AND 160),
  CONSTRAINT ca_stats_workspace_reports_source CHECK (source_kind IN ('player_authored', 'rule_derived')),
  CONSTRAINT ca_stats_workspace_reports_source_version_len CHECK (char_length(source_version) BETWEEN 1 AND 80),
  CONSTRAINT ca_stats_workspace_reports_body_object CHECK (jsonb_typeof(body) = 'object'),
  CONSTRAINT ca_stats_workspace_reports_evidence_array CHECK (jsonb_typeof(evidence) = 'array'),
  CONSTRAINT ca_stats_workspace_reports_range CHECK (range_days IS NULL OR range_days BETWEEN 1 AND 3650)
);

CREATE INDEX ca_stats_workspace_reports_owner_updated_idx
  ON public.ca_stats_workspace_reports (user_id, updated_at DESC);

CREATE TABLE public.ca_stats_workspace_leaks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  report_id uuid REFERENCES public.ca_stats_workspace_reports(id) ON DELETE SET NULL,
  leak_key text NOT NULL,
  title text NOT NULL,
  severity text NOT NULL,
  status text NOT NULL DEFAULT 'open',
  snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  evidence_hand_ids uuid[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  CONSTRAINT ca_stats_workspace_leaks_identity UNIQUE (user_id, leak_key),
  CONSTRAINT ca_stats_workspace_leaks_key_len CHECK (char_length(leak_key) BETWEEN 1 AND 128),
  CONSTRAINT ca_stats_workspace_leaks_title_len CHECK (char_length(title) BETWEEN 1 AND 160),
  CONSTRAINT ca_stats_workspace_leaks_severity CHECK (severity IN ('high', 'medium', 'low')),
  CONSTRAINT ca_stats_workspace_leaks_status CHECK (status IN ('open', 'practicing', 'resolved', 'dismissed')),
  CONSTRAINT ca_stats_workspace_leaks_snapshot_object CHECK (jsonb_typeof(snapshot) = 'object'),
  CONSTRAINT ca_stats_workspace_leaks_evidence_cap CHECK (coalesce(array_length(evidence_hand_ids, 1), 0) <= 100)
);

CREATE TABLE public.ca_stats_workspace_goals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  title text NOT NULL,
  metric_key text NOT NULL,
  direction text NOT NULL,
  baseline numeric NOT NULL,
  target numeric NOT NULL,
  status text NOT NULL DEFAULT 'active',
  starts_at timestamptz NOT NULL DEFAULT now(),
  ends_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ca_stats_workspace_goals_title_len CHECK (char_length(title) BETWEEN 1 AND 160),
  CONSTRAINT ca_stats_workspace_goals_metric_len CHECK (char_length(metric_key) BETWEEN 1 AND 80),
  CONSTRAINT ca_stats_workspace_goals_direction CHECK (direction IN ('increase', 'decrease', 'maintain')),
  CONSTRAINT ca_stats_workspace_goals_status CHECK (status IN ('active', 'completed', 'paused', 'archived')),
  CONSTRAINT ca_stats_workspace_goals_window CHECK (ends_at IS NULL OR ends_at > starts_at)
);

CREATE INDEX ca_stats_workspace_goals_owner_status_idx
  ON public.ca_stats_workspace_goals (user_id, status, updated_at DESC);

CREATE TABLE public.ca_stats_workspace_goal_progress (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  goal_id uuid NOT NULL REFERENCES public.ca_stats_workspace_goals(id) ON DELETE CASCADE,
  measured_value numeric NOT NULL,
  measured_at timestamptz NOT NULL DEFAULT now(),
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT ca_stats_workspace_goal_progress_evidence CHECK (jsonb_typeof(evidence) = 'object')
);

CREATE INDEX ca_stats_workspace_goal_progress_owner_goal_idx
  ON public.ca_stats_workspace_goal_progress (user_id, goal_id, measured_at DESC);

CREATE TABLE public.ca_stats_workspace_collections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ca_stats_workspace_collections_name_len CHECK (char_length(name) BETWEEN 1 AND 100),
  CONSTRAINT ca_stats_workspace_collections_description_len CHECK (char_length(description) <= 500)
);

CREATE INDEX ca_stats_workspace_collections_owner_updated_idx
  ON public.ca_stats_workspace_collections (user_id, updated_at DESC);

CREATE TABLE public.ca_stats_workspace_collection_hands (
  user_id uuid NOT NULL,
  collection_id uuid NOT NULL REFERENCES public.ca_stats_workspace_collections(id) ON DELETE CASCADE,
  hand_id uuid NOT NULL,
  added_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ca_stats_workspace_collection_hands_pkey PRIMARY KEY (collection_id, hand_id)
);

CREATE INDEX ca_stats_workspace_collection_hands_owner_idx
  ON public.ca_stats_workspace_collection_hands (user_id, added_at DESC);

CREATE TABLE public.ca_stats_workspace_preferences (
  user_id uuid PRIMARY KEY,
  dashboard_layout jsonb NOT NULL DEFAULT '[]'::jsonb,
  privacy_presentation_mode boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ca_stats_workspace_preferences_layout_array CHECK (jsonb_typeof(dashboard_layout) = 'array'),
  CONSTRAINT ca_stats_workspace_preferences_layout_cap CHECK (jsonb_array_length(dashboard_layout) <= 40)
);

CREATE TABLE public.ca_stats_workspace_alert_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  name text NOT NULL,
  metric_key text NOT NULL,
  comparator text NOT NULL,
  threshold numeric NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  cooldown_minutes integer NOT NULL DEFAULT 1440,
  evaluation_mode text NOT NULL DEFAULT 'on_stats_refresh',
  last_evaluated_at timestamptz,
  last_value numeric,
  last_triggered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ca_stats_workspace_alert_rules_name_len CHECK (char_length(name) BETWEEN 1 AND 100),
  CONSTRAINT ca_stats_workspace_alert_rules_metric_len CHECK (char_length(metric_key) BETWEEN 1 AND 80),
  CONSTRAINT ca_stats_workspace_alert_rules_comparator CHECK (comparator IN ('lt', 'lte', 'gt', 'gte')),
  CONSTRAINT ca_stats_workspace_alert_rules_cooldown CHECK (cooldown_minutes BETWEEN 60 AND 525600),
  CONSTRAINT ca_stats_workspace_alert_rules_mode CHECK (evaluation_mode = 'on_stats_refresh')
);

CREATE INDEX ca_stats_workspace_alert_rules_owner_idx
  ON public.ca_stats_workspace_alert_rules (user_id, enabled, updated_at DESC);

ALTER TABLE public.ca_stats_workspace_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ca_stats_workspace_leaks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ca_stats_workspace_goals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ca_stats_workspace_goal_progress ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ca_stats_workspace_collections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ca_stats_workspace_collection_hands ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ca_stats_workspace_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ca_stats_workspace_alert_rules ENABLE ROW LEVEL SECURITY;

CREATE POLICY ca_stats_workspace_reports_own ON public.ca_stats_workspace_reports
  FOR ALL TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
CREATE POLICY ca_stats_workspace_leaks_own ON public.ca_stats_workspace_leaks
  FOR ALL TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
CREATE POLICY ca_stats_workspace_goals_own ON public.ca_stats_workspace_goals
  FOR ALL TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
CREATE POLICY ca_stats_workspace_goal_progress_own ON public.ca_stats_workspace_goal_progress
  FOR ALL TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
CREATE POLICY ca_stats_workspace_collections_own ON public.ca_stats_workspace_collections
  FOR ALL TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
CREATE POLICY ca_stats_workspace_collection_hands_own ON public.ca_stats_workspace_collection_hands
  FOR ALL TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
CREATE POLICY ca_stats_workspace_preferences_own ON public.ca_stats_workspace_preferences
  FOR ALL TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
CREATE POLICY ca_stats_workspace_alert_rules_own ON public.ca_stats_workspace_alert_rules
  FOR ALL TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

REVOKE ALL ON public.ca_stats_workspace_reports,
  public.ca_stats_workspace_leaks,
  public.ca_stats_workspace_goals,
  public.ca_stats_workspace_goal_progress,
  public.ca_stats_workspace_collections,
  public.ca_stats_workspace_collection_hands,
  public.ca_stats_workspace_preferences,
  public.ca_stats_workspace_alert_rules FROM PUBLIC, anon;
GRANT SELECT, DELETE ON public.ca_stats_workspace_reports TO authenticated;
GRANT SELECT ON public.ca_stats_workspace_leaks,
  public.ca_stats_workspace_goals,
  public.ca_stats_workspace_goal_progress,
  public.ca_stats_workspace_collections,
  public.ca_stats_workspace_collection_hands,
  public.ca_stats_workspace_preferences,
  public.ca_stats_workspace_alert_rules TO authenticated;

CREATE OR REPLACE FUNCTION public.fn_ca_stats_workspace_report_save(
  p_idempotency_key text,
  p_title text,
  p_source_kind text,
  p_source_version text,
  p_body jsonb DEFAULT '{}'::jsonb,
  p_evidence jsonb DEFAULT '[]'::jsonb,
  p_club_id uuid DEFAULT NULL,
  p_range_days integer DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_user uuid := auth.uid();
  v_id uuid;
  v_request_hash text;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'authentication_required' USING ERRCODE = '42501'; END IF;
  v_request_hash := encode(extensions.digest(convert_to(jsonb_build_object(
    'title', trim(p_title),
    'source_kind', p_source_kind,
    'source_version', trim(p_source_version),
    'body', coalesce(p_body, '{}'::jsonb),
    'evidence', coalesce(p_evidence, '[]'::jsonb),
    'club_id', p_club_id,
    'range_days', p_range_days
  )::text, 'UTF8'), 'sha256'), 'hex');
  INSERT INTO public.ca_stats_workspace_reports
    (user_id, idempotency_key, request_hash, title, source_kind, source_version, body, evidence, club_id, range_days)
  VALUES
    (v_user, trim(p_idempotency_key), v_request_hash, trim(p_title), p_source_kind, trim(p_source_version),
     coalesce(p_body, '{}'::jsonb), coalesce(p_evidence, '[]'::jsonb), p_club_id, p_range_days)
  ON CONFLICT (user_id, idempotency_key) DO UPDATE SET
    updated_at = ca_stats_workspace_reports.updated_at
  WHERE ca_stats_workspace_reports.request_hash = EXCLUDED.request_hash
  RETURNING id INTO v_id;
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE = '23505';
  END IF;
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_ca_stats_workspace_leak_save(
  p_leak_key text, p_title text, p_severity text, p_status text,
  p_snapshot jsonb DEFAULT '{}'::jsonb, p_evidence_hand_ids uuid[] DEFAULT '{}',
  p_report_id uuid DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE v_user uuid := auth.uid(); v_id uuid;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'authentication_required' USING ERRCODE = '42501'; END IF;
  IF p_report_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.ca_stats_workspace_reports WHERE id = p_report_id AND user_id = v_user
  ) THEN RAISE EXCEPTION 'report_not_owned' USING ERRCODE = '42501'; END IF;
  IF EXISTS (
    SELECT 1 FROM unnest(coalesce(p_evidence_hand_ids, '{}')) AS evidence(hand_id)
    WHERE NOT EXISTS (
      SELECT 1 FROM public.ca_hand_facts f WHERE f.hand_id = evidence.hand_id AND f.user_id = v_user
    ) AND NOT EXISTS (
      SELECT 1 FROM public.ca_hand_notes n WHERE n.hand_id = evidence.hand_id AND n.user_id = v_user
    )
  ) THEN RAISE EXCEPTION 'hand_not_owned' USING ERRCODE = '42501'; END IF;
  INSERT INTO public.ca_stats_workspace_leaks
    (user_id, report_id, leak_key, title, severity, status, snapshot, evidence_hand_ids, resolved_at)
  VALUES
    (v_user, p_report_id, trim(p_leak_key), trim(p_title), p_severity, p_status,
     coalesce(p_snapshot, '{}'::jsonb), coalesce(p_evidence_hand_ids, '{}'),
     CASE WHEN p_status = 'resolved' THEN now() ELSE NULL END)
  ON CONFLICT (user_id, leak_key) DO UPDATE SET
    report_id = EXCLUDED.report_id, title = EXCLUDED.title, severity = EXCLUDED.severity,
    status = EXCLUDED.status, snapshot = EXCLUDED.snapshot,
    evidence_hand_ids = EXCLUDED.evidence_hand_ids, updated_at = now(),
    resolved_at = CASE WHEN EXCLUDED.status = 'resolved' THEN coalesce(ca_stats_workspace_leaks.resolved_at, now()) ELSE NULL END
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_ca_stats_workspace_goal_save(
  p_goal_id uuid, p_title text, p_metric_key text, p_direction text,
  p_baseline numeric, p_target numeric, p_status text DEFAULT 'active',
  p_ends_at timestamptz DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_user uuid := auth.uid();
  v_target_id uuid := coalesce(p_goal_id, gen_random_uuid());
  v_saved_id uuid;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'authentication_required' USING ERRCODE = '42501'; END IF;
  INSERT INTO public.ca_stats_workspace_goals
    (id, user_id, title, metric_key, direction, baseline, target, status, ends_at)
  VALUES (v_target_id, v_user, trim(p_title), trim(p_metric_key), p_direction, p_baseline, p_target, p_status, p_ends_at)
  ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title, metric_key = EXCLUDED.metric_key,
    direction = EXCLUDED.direction, baseline = EXCLUDED.baseline, target = EXCLUDED.target,
    status = EXCLUDED.status, ends_at = EXCLUDED.ends_at, updated_at = now()
  WHERE ca_stats_workspace_goals.user_id = v_user
  RETURNING id INTO v_saved_id;
  IF v_saved_id IS NULL THEN RAISE EXCEPTION 'goal_not_owned' USING ERRCODE = '42501'; END IF;
  RETURN v_saved_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_ca_stats_workspace_goal_progress_add(
  p_goal_id uuid, p_measured_value numeric, p_evidence jsonb DEFAULT '{}'::jsonb,
  p_measured_at timestamptz DEFAULT now()
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE v_user uuid := auth.uid(); v_id uuid;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'authentication_required' USING ERRCODE = '42501'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.ca_stats_workspace_goals WHERE id = p_goal_id AND user_id = v_user)
  THEN RAISE EXCEPTION 'goal_not_owned' USING ERRCODE = '42501'; END IF;
  INSERT INTO public.ca_stats_workspace_goal_progress
    (user_id, goal_id, measured_value, measured_at, evidence)
  VALUES (v_user, p_goal_id, p_measured_value, p_measured_at, coalesce(p_evidence, '{}'::jsonb))
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_ca_stats_workspace_collection_save(
  p_collection_id uuid, p_name text, p_description text DEFAULT ''
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_user uuid := auth.uid();
  v_target_id uuid := coalesce(p_collection_id, gen_random_uuid());
  v_saved_id uuid;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'authentication_required' USING ERRCODE = '42501'; END IF;
  INSERT INTO public.ca_stats_workspace_collections (id, user_id, name, description)
  VALUES (v_target_id, v_user, trim(p_name), coalesce(p_description, ''))
  ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description, updated_at = now()
  WHERE ca_stats_workspace_collections.user_id = v_user
  RETURNING id INTO v_saved_id;
  IF v_saved_id IS NULL THEN RAISE EXCEPTION 'collection_not_owned' USING ERRCODE = '42501'; END IF;
  RETURN v_saved_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_ca_stats_workspace_study_add(
  p_collection_id uuid, p_hand_id uuid
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE v_user uuid := auth.uid();
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'authentication_required' USING ERRCODE = '42501'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.ca_stats_workspace_collections WHERE id = p_collection_id AND user_id = v_user)
  THEN RAISE EXCEPTION 'collection_not_owned' USING ERRCODE = '42501'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.ca_hand_facts WHERE hand_id = p_hand_id AND user_id = v_user)
     AND NOT EXISTS (SELECT 1 FROM public.ca_hand_notes WHERE hand_id = p_hand_id AND user_id = v_user)
  THEN RAISE EXCEPTION 'hand_not_owned' USING ERRCODE = '42501'; END IF;
  INSERT INTO public.ca_stats_workspace_collection_hands (user_id, collection_id, hand_id)
  VALUES (v_user, p_collection_id, p_hand_id)
  ON CONFLICT (collection_id, hand_id) DO NOTHING;
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_ca_stats_workspace_preferences_save(
  p_dashboard_layout jsonb DEFAULT '[]'::jsonb,
  p_privacy_presentation_mode boolean DEFAULT false
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE v_user uuid := auth.uid();
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'authentication_required' USING ERRCODE = '42501'; END IF;
  INSERT INTO public.ca_stats_workspace_preferences
    (user_id, dashboard_layout, privacy_presentation_mode)
  VALUES (v_user, coalesce(p_dashboard_layout, '[]'::jsonb), coalesce(p_privacy_presentation_mode, false))
  ON CONFLICT (user_id) DO UPDATE SET dashboard_layout = EXCLUDED.dashboard_layout,
    privacy_presentation_mode = EXCLUDED.privacy_presentation_mode, updated_at = now();
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_ca_stats_workspace_alert_rule_save(
  p_rule_id uuid, p_name text, p_metric_key text, p_comparator text,
  p_threshold numeric, p_enabled boolean DEFAULT true, p_cooldown_minutes integer DEFAULT 1440
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_user uuid := auth.uid();
  v_target_id uuid := coalesce(p_rule_id, gen_random_uuid());
  v_saved_id uuid;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'authentication_required' USING ERRCODE = '42501'; END IF;
  INSERT INTO public.ca_stats_workspace_alert_rules
    (id, user_id, name, metric_key, comparator, threshold, enabled, cooldown_minutes)
  VALUES (v_target_id, v_user, trim(p_name), trim(p_metric_key), p_comparator, p_threshold,
          coalesce(p_enabled, true), p_cooldown_minutes)
  ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, metric_key = EXCLUDED.metric_key,
    comparator = EXCLUDED.comparator, threshold = EXCLUDED.threshold,
    enabled = EXCLUDED.enabled, cooldown_minutes = EXCLUDED.cooldown_minutes, updated_at = now()
  WHERE ca_stats_workspace_alert_rules.user_id = v_user
  RETURNING id INTO v_saved_id;
  IF v_saved_id IS NULL THEN RAISE EXCEPTION 'alert_rule_not_owned' USING ERRCODE = '42501'; END IF;
  RETURN v_saved_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_ca_stats_workspace_alerts_evaluate(
  p_metric_values jsonb
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE v_user uuid := auth.uid(); v_updated integer;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'authentication_required' USING ERRCODE = '42501'; END IF;
  IF jsonb_typeof(p_metric_values) <> 'object' THEN
    RAISE EXCEPTION 'metric_values_must_be_object' USING ERRCODE = '22023';
  END IF;
  UPDATE public.ca_stats_workspace_alert_rules a
  SET last_evaluated_at = now(),
      last_value = (p_metric_values ->> a.metric_key)::numeric,
      last_triggered_at = CASE
        WHEN ((a.comparator = 'lt' AND (p_metric_values ->> a.metric_key)::numeric < a.threshold)
          OR (a.comparator = 'lte' AND (p_metric_values ->> a.metric_key)::numeric <= a.threshold)
          OR (a.comparator = 'gt' AND (p_metric_values ->> a.metric_key)::numeric > a.threshold)
          OR (a.comparator = 'gte' AND (p_metric_values ->> a.metric_key)::numeric >= a.threshold))
          AND (a.last_triggered_at IS NULL
            OR a.last_triggered_at <= now() - make_interval(mins => a.cooldown_minutes))
        THEN now() ELSE a.last_triggered_at END,
      updated_at = now()
  WHERE a.user_id = v_user AND a.enabled AND p_metric_values ? a.metric_key
    AND jsonb_typeof(p_metric_values -> a.metric_key) = 'number';
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_ca_stats_workspace_report_save(text,text,text,text,jsonb,jsonb,uuid,integer),
  public.fn_ca_stats_workspace_leak_save(text,text,text,text,jsonb,uuid[],uuid),
  public.fn_ca_stats_workspace_goal_save(uuid,text,text,text,numeric,numeric,text,timestamptz),
  public.fn_ca_stats_workspace_goal_progress_add(uuid,numeric,jsonb,timestamptz),
  public.fn_ca_stats_workspace_collection_save(uuid,text,text),
  public.fn_ca_stats_workspace_study_add(uuid,uuid),
  public.fn_ca_stats_workspace_preferences_save(jsonb,boolean),
  public.fn_ca_stats_workspace_alert_rule_save(uuid,text,text,text,numeric,boolean,integer),
  public.fn_ca_stats_workspace_alerts_evaluate(jsonb)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_ca_stats_workspace_report_save(text,text,text,text,jsonb,jsonb,uuid,integer),
  public.fn_ca_stats_workspace_leak_save(text,text,text,text,jsonb,uuid[],uuid),
  public.fn_ca_stats_workspace_goal_save(uuid,text,text,text,numeric,numeric,text,timestamptz),
  public.fn_ca_stats_workspace_goal_progress_add(uuid,numeric,jsonb,timestamptz),
  public.fn_ca_stats_workspace_collection_save(uuid,text,text),
  public.fn_ca_stats_workspace_study_add(uuid,uuid),
  public.fn_ca_stats_workspace_preferences_save(jsonb,boolean),
  public.fn_ca_stats_workspace_alert_rule_save(uuid,text,text,text,numeric,boolean,integer),
  public.fn_ca_stats_workspace_alerts_evaluate(jsonb)
  TO authenticated;

COMMIT;
