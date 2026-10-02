-- ============================================================================
-- A PERSON CAN REVIEW A DIAMOND INCIDENT
-- ============================================================================
--
-- Phase 10 of the Diamond Arena programme, line 4 ("Add staff-only game
-- configuration, incident review and audited adjustments"), the incident
-- review piece: item 3 of the ordered build list in
-- docs/DIAMOND-PHASE-10-AUDIT-2026-09-21.md, every fact read again live on
-- 2026-09-29.
--
-- MEASURED IN PRODUCTION 2026-09-29 20:47 UTC. ca_diamond_incidents holds
-- 73,678 rows. 23,059 are open: 20 critical (DR0:health_critical, filed every
-- hour since 00:35 UTC because the "horse claims" health area reads critical),
-- 7,060 warning (6,999 of them older than seven days) and 15,979 info. Row
-- security is on with no policy, only the service role holds grants, and no
-- function a signed-in account can call reads or closes a row. No row has
-- ever carried a resolution a person wrote: 53 were closed by the watches
-- with an "auto:" note, the seven-day info sweep closes info rows with no
-- note, and 7,596 warning and critical rows were closed between 2026-09-03
-- and 2026-09-08 with no note at all.
--
-- WHAT THIS ADDS
--
--   1. THE TRAIL. ca_diamond_incident_events, in the shape of
--      ca_incident_events (incident, at, kind, actor, actor_label, detail)
--      and append-only like it. It names its incident by id and holds no
--      foreign key on purpose: fn_ca_diamond_prune_history deletes resolved
--      warning and info rows after 30 days and the trial balance watch deletes
--      resolved info rows after 30 days, so the trail outlives the row it
--      describes. A key would make those deletes fail, and the trial balance
--      watch would roll its whole hourly tick back. Every event carries the
--      rule and severity it was about.
--   2. THE ROW NAMES ITS REVIEWER. ca_diamond_incidents gains acknowledged_at,
--      acknowledged_by, resolved_by, reopened_at and reopened_by. resolved_by
--      is NULL when a watch closed the row.
--   3. A PERSON AND THE WATCHES DO NOT FIGHT. The health watch closes the
--      DR0:health_critical rows it filed once their areas clear
--      (20260919223032); the trial balance watch closes DR11 and DR12 rows and
--      sweeps info rows after seven days. Every one of those closing
--      statements carries resolved_at IS NULL, so a row a person resolved is
--      never closed a second time, and none of them sets resolved_at back to
--      NULL. A row a watch closes records "auto: ..." exactly as today, with
--      resolved_by NULL. One trigger makes the rest structural, whatever a
--      watch does in future: outside the review door nothing changes a
--      resolution a person wrote, and a row a person reopened is not closed
--      again by a watch. It waits for a person.
--   4. FOUR PLATFORM-STAFF DOORS. Staff is fn_is_platform_admin() (profiles.role
--      admin, superadmin or god), the database side of PlatformStaffGuard.
--      Each door is SECURITY DEFINER, granted to authenticated and the service
--      role and never to anon, and refuses every other signed-in account by
--      name. The review and family doors also refuse a call with no person
--      behind it, because a review names its reviewer.
--        fn_ca_diamond_incident_board(p_status, p_rule, p_severity, p_before_id, p_limit)
--        fn_ca_diamond_incident_trail(p_incident_id)
--        fn_ca_diamond_incident_review(p_incident_id, p_action, p_note)
--        fn_ca_diamond_incident_resolve_family(p_family, p_severity, p_filed_before, p_reason)
--      A rule family is the part of a rule before its colon (DR7 holds
--      DR7:user_over_daily_cap and DR7:engine_over_budget). Wherever a door
--      takes a family it also takes one whole rule.
--
-- Nothing is closed or acknowledged here: who reviews, and whether the
-- week-old DR2, DR5 and DR7 warnings are closed in one act, is Dan's
-- decision 5. No existing function is changed and neither switch is touched.
-- Applied once to kuklfnapbkmacvwxktbh.
-- ============================================================================

BEGIN;
SET LOCAL lock_timeout = '3s';

DO $m$
BEGIN
  IF EXISTS (SELECT 1 FROM public.ca_arena_settings WHERE tournaments_enabled OR cash_games_enabled) THEN
    RAISE EXCEPTION 'a Diamond switch is open; this migration expects both closed';
  END IF;
  IF to_regclass('public.ca_diamond_incident_events') IS NOT NULL THEN
    RAISE EXCEPTION 'ca_diamond_incident_events already exists';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'ca_diamond_incidents'
                AND column_name IN ('acknowledged_at', 'acknowledged_by', 'resolved_by', 'reopened_at', 'reopened_by')) THEN
    RAISE EXCEPTION 'ca_diamond_incidents already has a reviewer column';
  END IF;
  -- The identity is read here, before the lock on ca_diamond_incidents is
  -- taken, and not at the end: it takes seconds, and money-path triggers file
  -- into that table. Nothing below writes a money table, so it cannot move.
  IF (SELECT difference FROM public.fn_ca_diamond_register_vs_supply()) <> 0 THEN
    RAISE EXCEPTION 'the Diamond identity is not whole';
  END IF;
END $m$;

-- ---------------------------------------------------------------------------
-- 1. THE TRAIL
-- ---------------------------------------------------------------------------
CREATE TABLE public.ca_diamond_incident_events (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  incident_id bigint NOT NULL,
  at          timestamptz NOT NULL DEFAULT now(),
  kind        text NOT NULL CHECK (kind IN ('acknowledged', 'comment', 'resolved', 'reopened')),
  actor       uuid NOT NULL,
  actor_label text,
  detail      jsonb NOT NULL DEFAULT '{}'::jsonb
);
COMMENT ON TABLE public.ca_diamond_incident_events IS
  'The review trail of ca_diamond_incidents: who acknowledged, commented on, resolved or reopened a row, and why. Append-only. No foreign key on purpose: the prune deletes resolved rows after 30 days and the trail outlives them.';
CREATE INDEX ix_ca_diamond_incident_events_incident ON public.ca_diamond_incident_events (incident_id, at);

CREATE FUNCTION public.fn_ca_diamond_incident_events_append_only() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'ca_diamond_incident_events is append-only (the Diamond incident review trail)'
    USING ERRCODE = '42501';
END $$;
CREATE TRIGGER trg_ca_diamond_incident_events_append_only
  BEFORE UPDATE OR DELETE ON public.ca_diamond_incident_events
  FOR EACH ROW EXECUTE FUNCTION public.fn_ca_diamond_incident_events_append_only();
CREATE TRIGGER trg_ca_diamond_incident_events_no_truncate
  BEFORE TRUNCATE ON public.ca_diamond_incident_events
  FOR EACH STATEMENT EXECUTE FUNCTION public.fn_ca_diamond_incident_events_append_only();

ALTER TABLE public.ca_diamond_incident_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.ca_diamond_incident_events FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON SEQUENCE public.ca_diamond_incident_events_id_seq FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.ca_diamond_incident_events TO service_role;

-- ---------------------------------------------------------------------------
-- 2. THE ROW NAMES ITS REVIEWER
-- ---------------------------------------------------------------------------
ALTER TABLE public.ca_diamond_incidents
  ADD COLUMN acknowledged_at timestamptz,
  ADD COLUMN acknowledged_by uuid,
  ADD COLUMN resolved_by uuid,
  ADD COLUMN reopened_at timestamptz,
  ADD COLUMN reopened_by uuid;
COMMENT ON COLUMN public.ca_diamond_incidents.resolved_by IS
  'The person who resolved the row through fn_ca_diamond_incident_review or fn_ca_diamond_incident_resolve_family. NULL when a watch closed it.';
COMMENT ON COLUMN public.ca_diamond_incidents.reopened_by IS
  'The person who last reopened the row. While it is open again no watch closes it: it waits for a person.';

-- ---------------------------------------------------------------------------
-- 3. A PERSON AND THE WATCHES DO NOT FIGHT
-- ---------------------------------------------------------------------------
-- The review doors raise ca.diamond_incident_review for the length of their
-- own UPDATE and lower it straight after, so a watch that runs later in the
-- same transaction is still a machine. Anything else that updates a row a
-- person has touched (every watch, any sweep, a service call) passes through
-- this trigger, which skips the row, rather than raising, when the update
-- would change a resolution a person wrote or close a row a person reopened.
-- A raise would abort the watch's whole tick, and the health watch has no
-- handler for one. Rows no person has touched never reach the function.
CREATE FUNCTION public.fn_ca_diamond_incident_person_hold() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF current_setting('ca.diamond_incident_review', true) = 'person' THEN
    RETURN NEW;
  END IF;
  -- A resolution a person wrote stands: nothing but the review door re-opens,
  -- re-closes or rewrites it.
  IF OLD.resolved_by IS NOT NULL
     AND (NEW.resolved_at, NEW.resolved_by, NEW.resolution)
         IS DISTINCT FROM (OLD.resolved_at, OLD.resolved_by, OLD.resolution) THEN
    RETURN NULL;
  END IF;
  -- A row a person reopened is closed by a person.
  IF OLD.resolved_at IS NULL AND OLD.reopened_by IS NOT NULL AND NEW.resolved_at IS NOT NULL THEN
    RETURN NULL;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_ca_diamond_incident_person_hold
  BEFORE UPDATE ON public.ca_diamond_incidents
  FOR EACH ROW WHEN (OLD.resolved_by IS NOT NULL OR OLD.reopened_by IS NOT NULL)
  EXECUTE FUNCTION public.fn_ca_diamond_incident_person_hold();

-- ---------------------------------------------------------------------------
-- 4. WHAT A ROW SAYS TO STAFF
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.fn_ca_diamond_incident_actor_label(p_uid uuid) RETURNS text
LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT COALESCE(NULLIF(btrim(p.username), ''), NULLIF(btrim(p.display_name), ''))
    FROM public.profiles p WHERE p.id = p_uid;
$$;

-- closed_by: person, a reviewer closed it; watch, a watch closed it and wrote
-- what it read ("auto: ..."); unrecorded, it was closed with no note (the
-- seven-day info sweep writes none, and neither did the bulk closures of
-- 2026-09-03 to 2026-09-08). held: a person reopened it and no watch will
-- close it.
CREATE FUNCTION public.fn_ca_diamond_incident_json(p public.ca_diamond_incidents) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object(
    'id', p.id, 'occurred_at', p.occurred_at, 'rule', p.rule, 'family', split_part(p.rule, ':', 1),
    'severity', p.severity, 'user_id', p.user_id, 'amount', p.amount, 'writer', p.writer,
    'db_role', p.db_role, 'app_name', p.app_name, 'detail', p.detail,
    'status', CASE WHEN p.resolved_at IS NOT NULL THEN 'resolved'
                   WHEN p.acknowledged_at IS NOT NULL THEN 'acknowledged'
                   ELSE 'open' END,
    'acknowledged_at', p.acknowledged_at, 'acknowledged_by', p.acknowledged_by,
    'acknowledged_by_label', public.fn_ca_diamond_incident_actor_label(p.acknowledged_by),
    'resolved_at', p.resolved_at, 'resolved_by', p.resolved_by,
    'resolved_by_label', public.fn_ca_diamond_incident_actor_label(p.resolved_by),
    'resolution', p.resolution,
    'closed_by', CASE WHEN p.resolved_at IS NULL THEN NULL
                      WHEN p.resolved_by IS NOT NULL THEN 'person'
                      WHEN p.resolution LIKE 'auto:%' THEN 'watch'
                      ELSE 'unrecorded' END,
    'reopened_at', p.reopened_at, 'reopened_by', p.reopened_by,
    'reopened_by_label', public.fn_ca_diamond_incident_actor_label(p.reopened_by),
    'held', p.resolved_at IS NULL AND p.reopened_by IS NOT NULL);
$$;

-- ---------------------------------------------------------------------------
-- 5. THE BOARD: rows by status, rule and severity, newest first, a page at a
--    time, with every open row counted per rule family
-- ---------------------------------------------------------------------------
-- p_status: NULL or 'all', 'unresolved' (open or acknowledged), 'open' (not
-- yet acknowledged), 'acknowledged', 'resolved'. p_rule: NULL, one family
-- (DR7) or one rule (DR7:user_over_daily_cap). p_severity: NULL, 'info',
-- 'warning' or 'critical'. p_before_id: the next_before_id of the page before,
-- NULL for the first page. p_limit: 1 to 200.
CREATE FUNCTION public.fn_ca_diamond_incident_board(
  p_status text DEFAULT 'unresolved', p_rule text DEFAULT NULL, p_severity text DEFAULT NULL,
  p_before_id bigint DEFAULT NULL, p_limit integer DEFAULT 50) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_status text := COALESCE(NULLIF(btrim(COALESCE(p_status, '')), ''), 'all');
  v_rule text := NULLIF(btrim(COALESCE(p_rule, '')), '');
  v_limit integer := GREATEST(1, LEAST(COALESCE(p_limit, 50), 200));
  v_rows jsonb;
  v_more boolean;
  v_last bigint;
  v_families jsonb;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' AND NOT public.fn_is_platform_admin() THEN
    RETURN jsonb_build_object('success', false, 'error', 'staff_required');
  END IF;
  IF v_status NOT IN ('all', 'unresolved', 'open', 'acknowledged', 'resolved') THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_status');
  END IF;
  IF p_severity IS NOT NULL AND p_severity NOT IN ('info', 'warning', 'critical') THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_severity');
  END IF;

  SELECT COALESCE(jsonb_agg(public.fn_ca_diamond_incident_json(x.r) ORDER BY (x.r).id DESC)
                    FILTER (WHERE x.n <= v_limit), '[]'::jsonb),
         COALESCE(bool_or(x.n > v_limit), false),
         min((x.r).id) FILTER (WHERE x.n <= v_limit)
    INTO v_rows, v_more, v_last
    FROM (SELECT i AS r, row_number() OVER (ORDER BY i.id DESC) AS n
            FROM public.ca_diamond_incidents i
           WHERE (p_before_id IS NULL OR i.id < p_before_id)
             AND (v_rule IS NULL OR i.rule = v_rule
                  OR (strpos(v_rule, ':') = 0 AND split_part(i.rule, ':', 1) = v_rule))
             AND (p_severity IS NULL OR i.severity = p_severity)
             AND CASE v_status
                   WHEN 'unresolved' THEN i.resolved_at IS NULL
                   WHEN 'open' THEN i.resolved_at IS NULL AND i.acknowledged_at IS NULL
                   WHEN 'acknowledged' THEN i.resolved_at IS NULL AND i.acknowledged_at IS NOT NULL
                   WHEN 'resolved' THEN i.resolved_at IS NOT NULL
                   ELSE true
                 END
           ORDER BY i.id DESC
           LIMIT v_limit + 1) x;

  SELECT COALESCE(jsonb_agg(fam.j ORDER BY fam.family), '[]'::jsonb)
    INTO v_families
    FROM (SELECT r.family,
                 jsonb_build_object(
                   'family', r.family, 'open', sum(r.n_open), 'critical', sum(r.n_critical),
                   'warning', sum(r.n_warning), 'info', sum(r.n_info),
                   'acknowledged', sum(r.n_acknowledged), 'held', sum(r.n_held),
                   'older_than_7_days', sum(r.n_old), 'oldest', min(r.oldest), 'newest', max(r.newest),
                   'rules', jsonb_agg(jsonb_build_object(
                     'rule', r.rule, 'open', r.n_open, 'critical', r.n_critical,
                     'warning', r.n_warning, 'info', r.n_info, 'acknowledged', r.n_acknowledged,
                     'held', r.n_held, 'older_than_7_days', r.n_old,
                     'oldest', r.oldest, 'newest', r.newest) ORDER BY r.rule)) AS j
            FROM (SELECT split_part(i.rule, ':', 1) AS family, i.rule,
                         count(*) AS n_open,
                         count(*) FILTER (WHERE i.severity = 'critical') AS n_critical,
                         count(*) FILTER (WHERE i.severity = 'warning') AS n_warning,
                         count(*) FILTER (WHERE i.severity = 'info') AS n_info,
                         count(*) FILTER (WHERE i.acknowledged_at IS NOT NULL) AS n_acknowledged,
                         count(*) FILTER (WHERE i.reopened_by IS NOT NULL) AS n_held,
                         count(*) FILTER (WHERE i.occurred_at < now() - interval '7 days') AS n_old,
                         min(i.occurred_at) AS oldest, max(i.occurred_at) AS newest
                    FROM public.ca_diamond_incidents i
                   WHERE i.resolved_at IS NULL
                   GROUP BY 1, 2) r
           GROUP BY r.family) fam;

  RETURN jsonb_build_object('success', true, 'incidents', v_rows,
    'next_before_id', CASE WHEN v_more THEN v_last END,
    'families', v_families, 'as_of', now());
END $$;

-- ---------------------------------------------------------------------------
-- 6. THE TRAIL OF ONE ROW
-- ---------------------------------------------------------------------------
-- A row the prune has deleted keeps its trail: incident is null and the
-- events stand.
CREATE FUNCTION public.fn_ca_diamond_incident_trail(p_incident_id bigint) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_row public.ca_diamond_incidents;
  v_found boolean;
  v_events jsonb;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' AND NOT public.fn_is_platform_admin() THEN
    RETURN jsonb_build_object('success', false, 'error', 'staff_required');
  END IF;
  SELECT * INTO v_row FROM public.ca_diamond_incidents WHERE id = p_incident_id;
  v_found := FOUND;
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'id', e.id, 'incident_id', e.incident_id, 'at', e.at, 'kind', e.kind,
           'actor', e.actor, 'actor_label', e.actor_label, 'detail', e.detail) ORDER BY e.at, e.id), '[]'::jsonb)
    INTO v_events
    FROM public.ca_diamond_incident_events e
   WHERE e.incident_id = p_incident_id;
  IF NOT v_found AND v_events = '[]'::jsonb THEN
    RETURN jsonb_build_object('success', false, 'error', 'incident_not_found');
  END IF;
  RETURN jsonb_build_object('success', true,
    'incident', CASE WHEN v_found THEN public.fn_ca_diamond_incident_json(v_row) END,
    'events', v_events);
END $$;

-- ---------------------------------------------------------------------------
-- 7. THE REVIEW DOOR: acknowledge, comment, resolve with a written reason,
--    reopen with a written reason. Each act writes one trail event naming
--    the reviewer.
-- ---------------------------------------------------------------------------
-- A reason is at least 10 characters and a note at most 2,000. A comment
-- needs text and changes nothing on the row. Reopening clears the resolution
-- and the acknowledgement; the reopened event keeps what the row said before.
CREATE FUNCTION public.fn_ca_diamond_incident_review(
  p_incident_id bigint, p_action text, p_note text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_note text := NULLIF(btrim(COALESCE(p_note, '')), '');
  v_row public.ca_diamond_incidents;
  v_label text;
  v_event bigint;
  v_previous jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'authentication_required');
  END IF;
  IF NOT public.fn_is_platform_admin() THEN
    RETURN jsonb_build_object('success', false, 'error', 'staff_required');
  END IF;
  IF p_action IS NULL OR p_action NOT IN ('acknowledge', 'comment', 'resolve', 'reopen') THEN
    RETURN jsonb_build_object('success', false, 'error', 'unknown_action');
  END IF;
  IF length(v_note) > 2000 THEN
    RETURN jsonb_build_object('success', false, 'error', 'note_too_long');
  END IF;
  IF p_action = 'comment' AND v_note IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'note_required');
  END IF;
  IF p_action IN ('resolve', 'reopen') AND COALESCE(length(v_note), 0) < 10 THEN
    RETURN jsonb_build_object('success', false, 'error', 'reason_required');
  END IF;

  SELECT * INTO v_row FROM public.ca_diamond_incidents WHERE id = p_incident_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'incident_not_found');
  END IF;
  v_label := public.fn_ca_diamond_incident_actor_label(v_uid);

  IF p_action = 'acknowledge' THEN
    IF v_row.resolved_at IS NOT NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'already_resolved',
                                'incident', public.fn_ca_diamond_incident_json(v_row));
    END IF;
    IF v_row.acknowledged_at IS NOT NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'already_acknowledged',
                                'incident', public.fn_ca_diamond_incident_json(v_row));
    END IF;
    PERFORM set_config('ca.diamond_incident_review', 'person', true);
    UPDATE public.ca_diamond_incidents
       SET acknowledged_at = now(), acknowledged_by = v_uid
     WHERE id = p_incident_id
    RETURNING * INTO v_row;
    PERFORM set_config('ca.diamond_incident_review', '', true);
  ELSIF p_action = 'resolve' THEN
    IF v_row.resolved_at IS NOT NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'already_resolved',
                                'incident', public.fn_ca_diamond_incident_json(v_row));
    END IF;
    PERFORM set_config('ca.diamond_incident_review', 'person', true);
    UPDATE public.ca_diamond_incidents
       SET resolved_at = now(), resolved_by = v_uid, resolution = v_note
     WHERE id = p_incident_id
    RETURNING * INTO v_row;
    PERFORM set_config('ca.diamond_incident_review', '', true);
  ELSIF p_action = 'reopen' THEN
    IF v_row.resolved_at IS NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'not_resolved',
                                'incident', public.fn_ca_diamond_incident_json(v_row));
    END IF;
    v_previous := jsonb_build_object(
      'resolved_at', v_row.resolved_at, 'resolved_by', v_row.resolved_by,
      'resolution', v_row.resolution,
      'closed_by', public.fn_ca_diamond_incident_json(v_row) -> 'closed_by',
      'acknowledged_at', v_row.acknowledged_at, 'acknowledged_by', v_row.acknowledged_by);
    PERFORM set_config('ca.diamond_incident_review', 'person', true);
    UPDATE public.ca_diamond_incidents
       SET resolved_at = NULL, resolved_by = NULL, resolution = NULL,
           acknowledged_at = NULL, acknowledged_by = NULL,
           reopened_at = now(), reopened_by = v_uid
     WHERE id = p_incident_id
    RETURNING * INTO v_row;
    PERFORM set_config('ca.diamond_incident_review', '', true);
  END IF;

  INSERT INTO public.ca_diamond_incident_events (incident_id, kind, actor, actor_label, detail)
  VALUES (p_incident_id,
          CASE p_action WHEN 'acknowledge' THEN 'acknowledged' WHEN 'comment' THEN 'comment'
                        WHEN 'resolve' THEN 'resolved' ELSE 'reopened' END,
          v_uid, v_label,
          jsonb_build_object('note', v_note, 'rule', v_row.rule, 'severity', v_row.severity)
            || CASE WHEN v_previous IS NULL THEN '{}'::jsonb
                    ELSE jsonb_build_object('previous', v_previous) END)
  RETURNING id INTO v_event;

  RETURN jsonb_build_object('success', true, 'action', p_action, 'event_id', v_event,
                            'incident', public.fn_ca_diamond_incident_json(v_row));
END $$;

-- ---------------------------------------------------------------------------
-- 8. A WHOLE FAMILY IN ONE ACT, WITH ONE WRITTEN REASON
-- ---------------------------------------------------------------------------
-- Resolves every open row of one family (or one rule), at one severity or
-- all, filed at or before p_filed_before (NULL is now): what the reviewer saw,
-- and nothing filed after it. Each row gets its own resolved event carrying
-- the same act id, so every row's trail says who closed it and why. A row a
-- person reopened is left out and counted: it waits for a person, one at a
-- time.
CREATE FUNCTION public.fn_ca_diamond_incident_resolve_family(
  p_family text, p_severity text, p_filed_before timestamptz, p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_family text := NULLIF(btrim(COALESCE(p_family, '')), '');
  v_note text := NULLIF(btrim(COALESCE(p_reason, '')), '');
  v_before timestamptz := LEAST(COALESCE(p_filed_before, now()), now());
  v_act uuid := gen_random_uuid();
  v_label text;
  v_held integer;
  v_resolved integer;
  v_by_rule jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'authentication_required');
  END IF;
  IF NOT public.fn_is_platform_admin() THEN
    RETURN jsonb_build_object('success', false, 'error', 'staff_required');
  END IF;
  IF v_family IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'family_required');
  END IF;
  IF p_severity IS NOT NULL AND p_severity NOT IN ('info', 'warning', 'critical') THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_severity');
  END IF;
  IF length(v_note) > 2000 THEN
    RETURN jsonb_build_object('success', false, 'error', 'note_too_long');
  END IF;
  IF COALESCE(length(v_note), 0) < 10 THEN
    RETURN jsonb_build_object('success', false, 'error', 'reason_required');
  END IF;
  v_label := public.fn_ca_diamond_incident_actor_label(v_uid);

  SELECT count(*) INTO v_held
    FROM public.ca_diamond_incidents i
   WHERE (i.rule = v_family OR (strpos(v_family, ':') = 0 AND split_part(i.rule, ':', 1) = v_family))
     AND (p_severity IS NULL OR i.severity = p_severity)
     AND i.resolved_at IS NULL AND i.occurred_at <= v_before
     AND i.reopened_by IS NOT NULL;

  PERFORM set_config('ca.diamond_incident_review', 'person', true);
  WITH closed AS (
    UPDATE public.ca_diamond_incidents i
       SET resolved_at = now(), resolved_by = v_uid, resolution = v_note
     WHERE (i.rule = v_family OR (strpos(v_family, ':') = 0 AND split_part(i.rule, ':', 1) = v_family))
       AND (p_severity IS NULL OR i.severity = p_severity)
       AND i.resolved_at IS NULL AND i.occurred_at <= v_before
       AND i.reopened_by IS NULL
    RETURNING i.id, i.rule, i.severity
  ), logged AS (
    INSERT INTO public.ca_diamond_incident_events (incident_id, kind, actor, actor_label, detail)
    SELECT c.id, 'resolved', v_uid, v_label,
           jsonb_build_object('note', v_note, 'rule', c.rule, 'severity', c.severity, 'act', v_act,
                              'family', v_family, 'severity_filter', p_severity,
                              'filed_before', v_before)
      FROM closed c
    RETURNING incident_id
  )
  SELECT (SELECT count(*) FROM logged),
         COALESCE((SELECT jsonb_object_agg(g.rule, g.n)
                     FROM (SELECT c.rule, count(*) AS n FROM closed c GROUP BY c.rule) g), '{}'::jsonb)
    INTO v_resolved, v_by_rule;
  PERFORM set_config('ca.diamond_incident_review', '', true);

  IF v_resolved = 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'nothing_to_resolve', 'skipped_reopened', v_held);
  END IF;
  RETURN jsonb_build_object('success', true, 'act_id', v_act, 'family', v_family,
    'severity', p_severity, 'filed_before', v_before, 'resolved', v_resolved,
    'skipped_reopened', v_held, 'by_rule', v_by_rule);
END $$;

-- ---------------------------------------------------------------------------
-- 9. GRANTS. The four doors ask for staff themselves; the helpers and the
--    trigger functions are private. A REVOKE names every role.
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION
  public.fn_ca_diamond_incident_events_append_only(),
  public.fn_ca_diamond_incident_person_hold(),
  public.fn_ca_diamond_incident_actor_label(uuid),
  public.fn_ca_diamond_incident_json(public.ca_diamond_incidents),
  public.fn_ca_diamond_incident_board(text, text, text, bigint, integer),
  public.fn_ca_diamond_incident_trail(bigint),
  public.fn_ca_diamond_incident_review(bigint, text, text),
  public.fn_ca_diamond_incident_resolve_family(text, text, timestamptz, text)
FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION
  public.fn_ca_diamond_incident_board(text, text, text, bigint, integer),
  public.fn_ca_diamond_incident_trail(bigint),
  public.fn_ca_diamond_incident_review(bigint, text, text),
  public.fn_ca_diamond_incident_resolve_family(text, text, timestamptz, text)
TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 10. EVERY PIECE IS IN PLACE, AND THE ESTATE IS AS IT WAS
-- ---------------------------------------------------------------------------
DO $m$
DECLARE r record; v_n integer := 0; v_bad text;
BEGIN
  -- The trail: row security on, no foreign key, append-only, read by the
  -- service role and written only through the doors.
  IF NOT (SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = 'public.ca_diamond_incident_events'::regclass) THEN
    RAISE EXCEPTION 'the trail has no row security';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conrelid = 'public.ca_diamond_incident_events'::regclass AND contype = 'f') THEN
    RAISE EXCEPTION 'the trail holds a foreign key; the prune deletes the rows it describes';
  END IF;
  IF (SELECT count(*) FROM pg_trigger
       WHERE tgrelid = 'public.ca_diamond_incident_events'::regclass AND NOT tgisinternal
         AND tgname IN ('trg_ca_diamond_incident_events_append_only', 'trg_ca_diamond_incident_events_no_truncate')) <> 2 THEN
    RAISE EXCEPTION 'the trail is not append-only';
  END IF;
  IF has_table_privilege('anon', 'public.ca_diamond_incident_events', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
     OR has_table_privilege('authenticated', 'public.ca_diamond_incident_events', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
     OR has_table_privilege('service_role', 'public.ca_diamond_incident_events', 'INSERT,UPDATE,DELETE,TRUNCATE') THEN
    RAISE EXCEPTION 'the trail can be read or written outside the doors';
  END IF;

  -- The row names its reviewer, the hold is on it, and nobody reads it
  -- directly.
  IF (SELECT count(*) FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'ca_diamond_incidents'
         AND column_name IN ('acknowledged_at', 'acknowledged_by', 'resolved_by', 'reopened_at', 'reopened_by')) <> 5 THEN
    RAISE EXCEPTION 'ca_diamond_incidents does not name its reviewer';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                  WHERE tgrelid = 'public.ca_diamond_incidents'::regclass
                    AND tgname = 'trg_ca_diamond_incident_person_hold' AND tgenabled = 'O') THEN
    RAISE EXCEPTION 'the person hold is not on ca_diamond_incidents';
  END IF;
  IF has_table_privilege('anon', 'public.ca_diamond_incidents', 'SELECT,INSERT,UPDATE,DELETE')
     OR has_table_privilege('authenticated', 'public.ca_diamond_incidents', 'SELECT,INSERT,UPDATE,DELETE') THEN
    RAISE EXCEPTION 'ca_diamond_incidents is reachable outside the doors';
  END IF;

  -- Four staff doors: definer, reachable signed in, never anonymously, and
  -- each asks for platform staff itself. The helpers stay private.
  FOR r IN SELECT p.oid, p.proname, p.prosecdef, p.prosrc FROM pg_proc p
            WHERE p.pronamespace = 'public'::regnamespace
              AND p.proname IN ('fn_ca_diamond_incident_board', 'fn_ca_diamond_incident_trail',
                                'fn_ca_diamond_incident_review', 'fn_ca_diamond_incident_resolve_family')
  LOOP
    v_n := v_n + 1;
    IF NOT r.prosecdef THEN
      RAISE EXCEPTION '% is not SECURITY DEFINER', r.proname;
    END IF;
    IF has_function_privilege('anon', r.oid, 'EXECUTE') THEN
      RAISE EXCEPTION '% is reachable without an account', r.proname;
    END IF;
    IF NOT has_function_privilege('authenticated', r.oid, 'EXECUTE') THEN
      RAISE EXCEPTION '% is not reachable by a signed-in account', r.proname;
    END IF;
    IF position('public.fn_is_platform_admin()' IN r.prosrc) = 0 OR position('''staff_required''' IN r.prosrc) = 0 THEN
      RAISE EXCEPTION '% does not ask for platform staff', r.proname;
    END IF;
  END LOOP;
  IF v_n <> 4 THEN
    RAISE EXCEPTION 'expected four review doors, found %', v_n;
  END IF;
  FOR r IN SELECT p.oid, p.proname FROM pg_proc p
            WHERE p.pronamespace = 'public'::regnamespace
              AND p.proname IN ('fn_ca_diamond_incident_actor_label', 'fn_ca_diamond_incident_json',
                                'fn_ca_diamond_incident_person_hold', 'fn_ca_diamond_incident_events_append_only')
  LOOP
    IF has_function_privilege('anon', r.oid, 'EXECUTE') OR has_function_privilege('authenticated', r.oid, 'EXECUTE') THEN
      RAISE EXCEPTION '% must stay private', r.proname;
    END IF;
  END LOOP;

  -- Nothing re-opens a Diamond incident but the review door.
  SELECT string_agg(x.proname, ', ') INTO v_bad
    FROM (SELECT p.proname, p.prosrc FROM pg_proc p
           WHERE strpos(p.prosrc, 'ca_diamond_incidents') > 0 OFFSET 0) x
   WHERE x.prosrc ~* 'UPDATE\s+(public\.)?ca_diamond_incidents\s[^;]*resolved_at\s*=\s*NULL\y'
     AND x.proname <> 'fn_ca_diamond_incident_review';
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'something besides the review door re-opens a Diamond incident: %', v_bad;
  END IF;

  -- This migration reviewed nothing.
  IF EXISTS (SELECT 1 FROM public.ca_diamond_incidents
              WHERE acknowledged_by IS NOT NULL OR resolved_by IS NOT NULL OR reopened_by IS NOT NULL)
     OR EXISTS (SELECT 1 FROM public.ca_diamond_incident_events) THEN
    RAISE EXCEPTION 'this migration must not review any incident';
  END IF;

  -- The Diamond identity was read whole at the top, before the lock.
  IF EXISTS (SELECT 1 FROM public.ca_arena_settings WHERE tournaments_enabled OR cash_games_enabled) THEN
    RAISE EXCEPTION 'this migration must not open a switch';
  END IF;
  SELECT string_agg(w.fn, ', ') INTO v_bad
    FROM unnest(public.fn_ca_guard_watchlist()) AS w(fn)
    LEFT JOIN public.ca_guard_defs d ON d.proname = w.fn
    LEFT JOIN (
      SELECT p.proname, md5(string_agg(pg_get_functiondef(p.oid), '|' ORDER BY p.oid)) AS h
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = ANY (public.fn_ca_guard_watchlist())
       GROUP BY p.proname) live ON live.proname = w.fn
   WHERE d.def_hash IS DISTINCT FROM live.h;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'watched guards off their baseline: %', v_bad;
  END IF;
  RAISE NOTICE 'a person can review a Diamond incident: four staff doors, a trail that outlives its row, a hold the watches keep; nothing reviewed, no switch opened';
END $m$;

COMMIT;
