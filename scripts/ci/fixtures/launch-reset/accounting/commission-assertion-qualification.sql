CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE TABLE rake_records(id uuid,created_at timestamptz,is_tournament boolean DEFAULT false,tournament_id uuid);
CREATE TABLE accounting_tournament_fee_sources(rake_record_id uuid,player_id uuid,club_id uuid,charged_at timestamptz);
CREATE TABLE rake_attributions(id uuid,club_id uuid,player_id uuid,rake_amount numeric,created_at timestamptz,rake_record_id uuid);
CREATE TABLE ca_club_rake_daily_user(club_id uuid,day date,user_id uuid,rake_cents bigint,hands bigint,updated_at timestamptz,PRIMARY KEY(club_id,day,user_id));
CREATE TABLE club_rake_daily_user(club_id uuid,day date,user_id uuid,rake_amount numeric,hands bigint,PRIMARY KEY(club_id,day,user_id));
CREATE TABLE club_rake_rollup_complete(club_id uuid,day date,rows_written int,computed_at timestamptz,PRIMARY KEY(club_id,day));
-- Owner-directed launch waiver. Historical evidence is retained, never called paid.
-- Component of the qualified reset; installation alone activates no boundary.
CREATE TABLE public.ca_launch_accounting_boundaries (
  scope_kind text NOT NULL CHECK(scope_kind IN ('club','union')),
  scope_id uuid NOT NULL,
  operation_id uuid NOT NULL,
  cutoff_at timestamptz NOT NULL CHECK(isfinite(cutoff_at)),
  activated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  waiver_reason text NOT NULL DEFAULT 'Owner Directed Launch Reset: No Prelaunch Obligations Remain Payable',
  undone_at timestamptz,
  PRIMARY KEY(scope_kind,scope_id,operation_id)
);
CREATE UNIQUE INDEX ca_launch_accounting_one_active ON public.ca_launch_accounting_boundaries(scope_kind,scope_id) WHERE undone_at IS NULL;
ALTER TABLE public.ca_launch_accounting_boundaries ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ca_launch_accounting_boundaries FROM PUBLIC,anon,authenticated,service_role;
CREATE TABLE public.ca_launch_accounting_archives (
  operation_id uuid NOT NULL,
  relation_name text NOT NULL,
  row_key text NOT NULL,
  before_image jsonb NOT NULL,
  row_sha256 text NOT NULL,
  captured_at timestamptz NOT NULL,
  PRIMARY KEY(operation_id,relation_name,row_key)
);
ALTER TABLE public.ca_launch_accounting_archives ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ca_launch_accounting_archives FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.fn_ca_launch_accounting_cutoff(p_kind text,p_id uuid) RETURNS timestamptz
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT cutoff_at FROM public.ca_launch_accounting_boundaries WHERE scope_kind=p_kind AND scope_id=p_id AND undone_at IS NULL
$$;
CREATE FUNCTION public.fn_ca_launch_accounting_start(p_kind text,p_id uuid,p_start timestamptz) RETURNS timestamptz
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT CASE WHEN p_start IS NULL OR NOT isfinite(p_start) THEN p_start ELSE GREATEST(p_start,public.fn_ca_launch_accounting_cutoff(p_kind,p_id)) END
$$;
CREATE FUNCTION public.fn_ca_launch_accounting_accepts(p_club_id uuid,p_earned_at timestamptz) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT CASE WHEN b.cutoff IS NULL THEN true ELSE p_earned_at IS NOT NULL AND isfinite(p_earned_at) AND p_earned_at>=b.cutoff END
 FROM (SELECT public.fn_ca_launch_accounting_cutoff('club',p_club_id) cutoff)b
$$;
CREATE FUNCTION public.fn_ca_launch_accounting_waived(p_kind text,p_id uuid,p_end timestamptz) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT COALESCE(isfinite(p_end) AND p_end<=public.fn_ca_launch_accounting_cutoff(p_kind,p_id),false)
$$;
REVOKE ALL ON FUNCTION public.fn_ca_launch_accounting_cutoff(text,uuid),public.fn_ca_launch_accounting_start(text,uuid,timestamptz),public.fn_ca_launch_accounting_accepts(uuid,timestamptz),public.fn_ca_launch_accounting_waived(text,uuid,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_ca_launch_accounting_cutoff(text,uuid),public.fn_ca_launch_accounting_start(text,uuid,timestamptz),public.fn_ca_launch_accounting_accepts(uuid,timestamptz),public.fn_ca_launch_accounting_waived(text,uuid,timestamptz) TO authenticated,service_role;
COMMENT ON TABLE public.ca_launch_accounting_archives IS 'Immutable launch preimages retained online for seven years; owner-directed waiver is not payment, certification or deletion of original journal/hand history.';
CREATE FUNCTION public.fn_ca_launch_accounting_archive_immutable() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN RAISE EXCEPTION 'launch_accounting_archive_is_immutable' USING ERRCODE='23514'; END $$;
REVOKE ALL ON FUNCTION public.fn_ca_launch_accounting_archive_immutable() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER launch_accounting_archive_immutable BEFORE UPDATE OR DELETE ON public.ca_launch_accounting_archives
 FOR EACH ROW EXECUTE FUNCTION public.fn_ca_launch_accounting_archive_immutable();
CREATE TABLE public.ca_launch_profile_hand_baselines (
 operation_id uuid NOT NULL,
 user_id uuid NOT NULL,
 hand_offset bigint NOT NULL,
 captured_total_hands bigint NOT NULL,
 remaining_club_hands bigint NOT NULL,
 restored_scope_hands bigint NOT NULL,
 captured_at timestamptz NOT NULL,
 PRIMARY KEY(operation_id,user_id)
);
ALTER TABLE public.ca_launch_profile_hand_baselines ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ca_launch_profile_hand_baselines FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER launch_profile_hand_baseline_immutable BEFORE UPDATE OR DELETE ON public.ca_launch_profile_hand_baselines
 FOR EACH ROW EXECUTE FUNCTION public.fn_ca_launch_accounting_archive_immutable();
CREATE FUNCTION public.fn_ca_launch_accounting_actor(p_club_id uuid) RETURNS boolean
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE v_operation uuid;
BEGIN
 IF public.fn_caller_is_engine() IS NOT TRUE OR public.fn_platform_frozen() IS NOT TRUE THEN RETURN false; END IF;
 v_operation:=NULLIF(current_setting('app.launch_reset_operation',true),'')::uuid;
 RETURN EXISTS(SELECT 1 FROM public.ca_launch_reset_operations o WHERE o.operation_id=v_operation
   AND o.state IN('captured','executed') AND p_club_id=ANY(o.scoped_club_ids));
EXCEPTION WHEN invalid_text_representation THEN RETURN false;
END $$;
REVOKE ALL ON FUNCTION public.fn_ca_launch_accounting_actor(uuid) FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.fn_ca_launch_accounting_invoice_transition(p_old jsonb,p_new jsonb) RETURNS boolean
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE v_operation uuid;v_state text;v_before jsonb;
BEGIN
 IF NOT public.fn_ca_launch_accounting_actor((p_old->>'club_id')::uuid) THEN RETURN false; END IF;
 v_operation:=NULLIF(current_setting('app.launch_reset_operation',true),'')::uuid;
 SELECT o.state INTO v_state FROM public.ca_launch_reset_operations o WHERE o.operation_id=v_operation;
 SELECT a.before_image INTO v_before FROM public.ca_launch_accounting_archives a
  WHERE a.operation_id=v_operation AND a.relation_name='settlement_invoices' AND a.before_image->>'id'=p_old->>'id';
 IF v_before IS NULL OR (p_old-ARRAY['status','updated_at']) IS DISTINCT FROM (p_new-ARRAY['status','updated_at']) THEN RETURN false; END IF;
 RETURN (v_state='captured' AND v_before=p_old AND p_old->>'status' IN('pending','generated','overdue','disputed') AND p_new->>'status'='cancelled')
  OR (v_state='executed' AND p_old->>'status'='cancelled' AND p_new=v_before);
END $$;
REVOKE ALL ON FUNCTION public.fn_ca_launch_accounting_invoice_transition(jsonb,jsonb) FROM PUBLIC,anon,authenticated,service_role;
-- Scope and cutoff testimony cannot be rewritten. Undo marks only its own frozen operation.
CREATE FUNCTION public.fn_ca_launch_accounting_boundary_immutable() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'launch_boundary_delete_forbidden' USING ERRCODE='23514'; END IF;
 IF (to_jsonb(NEW)-'undone_at') IS DISTINCT FROM (to_jsonb(OLD)-'undone_at') OR OLD.undone_at IS NOT NULL OR NEW.undone_at IS NULL OR NOT isfinite(NEW.undone_at) THEN RAISE EXCEPTION 'launch_boundary_immutable' USING ERRCODE='23514'; END IF;
 IF public.fn_ca_launch_accounting_actor(OLD.scope_id) IS NOT TRUE OR NOT EXISTS(SELECT 1 FROM public.ca_launch_reset_operations o WHERE o.operation_id=OLD.operation_id AND o.state='executed' AND o.operation_id::text=current_setting('app.launch_reset_operation',true)) THEN RAISE EXCEPTION 'launch_boundary_undo_actor_invalid' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.fn_ca_launch_accounting_boundary_immutable() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER launch_accounting_boundary_immutable BEFORE UPDATE OR DELETE ON public.ca_launch_accounting_boundaries FOR EACH ROW EXECUTE FUNCTION public.fn_ca_launch_accounting_boundary_immutable();



CREATE FUNCTION public.fn_ca_club_rake_daily_user_apply(p_ids uuid[]) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  IF p_ids IS NULL OR array_length(p_ids, 1) IS NULL THEN
    RETURN;
  END IF;

  INSERT INTO public.ca_club_rake_daily_user (club_id, day, user_id, rake_cents, hands, updated_at)
  SELECT ra.club_id,
         (ra.created_at AT TIME ZONE 'UTC')::date,
         ra.player_id,
         SUM(round(ra.rake_amount * 100))::bigint,
         count(*)::bigint,
         now()
    FROM public.rake_attributions ra
   WHERE ra.id = ANY (p_ids)
     AND ra.club_id IS NOT NULL
     AND ra.player_id IS NOT NULL
     AND ra.rake_amount > 0
   GROUP BY 1, 2, 3
  ON CONFLICT (club_id, day, user_id) DO UPDATE
     SET rake_cents = public.ca_club_rake_daily_user.rake_cents + EXCLUDED.rake_cents,
         hands      = public.ca_club_rake_daily_user.hands + EXCLUDED.hands,
         updated_at = now();
END;
$$;
CREATE FUNCTION public.fn_ca_club_rake_daily_user_rebuild_day(p_club_id uuid, p_day date, p_user_id uuid DEFAULT NULL::uuid) RETURNS bigint
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE v_rows bigint := 0;
BEGIN
  IF p_club_id IS NULL OR p_day IS NULL THEN
    RETURN 0;
  END IF;

  DELETE FROM public.ca_club_rake_daily_user d
   WHERE d.club_id = p_club_id AND d.day = p_day
     AND (p_user_id IS NULL OR d.user_id = p_user_id);

  INSERT INTO public.ca_club_rake_daily_user (club_id, day, user_id, rake_cents, hands, updated_at)
  SELECT ra.club_id,
         p_day,
         ra.player_id,
         SUM(round(ra.rake_amount * 100))::bigint,
         count(*)::bigint,
         now()
    FROM public.rake_attributions ra
   WHERE ra.club_id = p_club_id
     AND ra.created_at >= p_day::timestamptz
     AND ra.created_at <  (p_day + 1)::timestamptz
     AND ra.player_id IS NOT NULL
     AND ra.rake_amount > 0
     AND (p_user_id IS NULL OR ra.player_id = p_user_id)
   GROUP BY 1, 3;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows;
END;
$$;
CREATE FUNCTION public.fn_club_rake_rollup_day(p_club_id uuid, p_day date) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_start timestamptz := p_day::timestamptz;
  v_end   timestamptz := (p_day + 1)::timestamptz;
  v_rows  integer := 0;
BEGIN
  IF v_end > date_trunc('day', now()) THEN
    RAISE EXCEPTION 'club rake rollup: day % is not complete', p_day;
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('club_rake_rollup:' || p_club_id::text || ':' || p_day::text, 42));

  DELETE FROM club_rake_daily_user WHERE club_id = p_club_id AND day = p_day;

  WITH split AS (
    SELECT a.player_id AS user_id, round(a.rake_amount * 100)::bigint AS cents
      FROM rake_attributions a
     WHERE a.club_id = p_club_id
       AND a.created_at >= v_start AND a.created_at < v_end
       AND a.rake_amount > 0
  ), ins AS (
    INSERT INTO club_rake_daily_user (club_id, day, user_id, rake_amount, hands)
    SELECT p_club_id, p_day, s.user_id, SUM(s.cents)::numeric / 100, count(*)
      FROM split s GROUP BY s.user_id
    RETURNING 1
  )
  SELECT count(*) INTO v_rows FROM ins;

  INSERT INTO club_rake_rollup_complete (club_id, day, rows_written, computed_at)
  VALUES (p_club_id, p_day, v_rows, now())
  ON CONFLICT (club_id, day) DO UPDATE
    SET rows_written = EXCLUDED.rows_written, computed_at = EXCLUDED.computed_at;

  RETURN v_rows;
END $$;
INSERT INTO ca_launch_accounting_boundaries(scope_kind,scope_id,operation_id,cutoff_at) VALUES('club','a0000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','2026-10-12 12:00Z');
INSERT INTO rake_attributions VALUES('10000000-0000-0000-0000-000000000011','a0000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000012',3,'2026-10-12 12:05Z','10000000-0000-0000-0000-000000000021'),('10000000-0000-0000-0000-000000000013','a0000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000012',5,'2026-10-12 12:00Z','10000000-0000-0000-0000-000000000023'),('10000000-0000-0000-0000-000000000014','a0000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000012',7,'2026-10-12 11:59Z','10000000-0000-0000-0000-000000000024');
INSERT INTO rake_records(id,created_at) VALUES('10000000-0000-0000-0000-000000000021','2026-10-12 11:59Z'),('10000000-0000-0000-0000-000000000023','2026-10-12 12:00Z'),('10000000-0000-0000-0000-000000000024','2026-10-12 11:59Z');
SELECT fn_ca_club_rake_daily_user_apply(ARRAY(SELECT id FROM rake_attributions));
DO $$ BEGIN IF (SELECT SUM(rake_cents) FROM ca_club_rake_daily_user WHERE club_id='a0000000-0000-0000-0000-000000000001')<>800 THEN RAISE EXCEPTION 'old source reproduction failed'; END IF; END $$;
TRUNCATE ca_club_rake_daily_user;
DO $guard$ BEGIN IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='fn_ca_club_rake_daily_user_apply' AND md5(p.prosrc)='764e982b48283abe0f9b7537f38364e2')<>1 THEN RAISE EXCEPTION 'launch_boundary_source_changed: fn_ca_club_rake_daily_user_apply'; END IF; END $guard$;
CREATE OR REPLACE FUNCTION public.fn_ca_club_rake_daily_user_apply(p_ids uuid[]) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  IF p_ids IS NULL OR array_length(p_ids, 1) IS NULL THEN
    RETURN;
  END IF;

  INSERT INTO public.ca_club_rake_daily_user (club_id, day, user_id, rake_cents, hands, updated_at)
  SELECT ra.club_id,
         (ra.created_at AT TIME ZONE 'UTC')::date,
         ra.player_id,
         SUM(round(ra.rake_amount * 100))::bigint,
         count(*)::bigint,
         now()
    FROM public.rake_attributions ra
   WHERE ra.id = ANY (p_ids)
     AND ra.club_id IS NOT NULL
     AND ra.player_id IS NOT NULL
     AND ra.rake_amount > 0
     AND public.fn_ca_launch_accounting_accepts(ra.club_id,(SELECT rr.created_at FROM public.rake_records rr WHERE rr.id=ra.rake_record_id))
   GROUP BY 1, 2, 3
  ON CONFLICT (club_id, day, user_id) DO UPDATE
     SET rake_cents = public.ca_club_rake_daily_user.rake_cents + EXCLUDED.rake_cents,
         hands      = public.ca_club_rake_daily_user.hands + EXCLUDED.hands,
         updated_at = now();
END;
$$;


DO $guard$ BEGIN IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='fn_ca_club_rake_daily_user_rebuild_day' AND md5(p.prosrc)='272a2d51a7673cc5fea0cb613e254464')<>1 THEN RAISE EXCEPTION 'launch_boundary_source_changed: fn_ca_club_rake_daily_user_rebuild_day'; END IF; END $guard$;
CREATE OR REPLACE FUNCTION public.fn_ca_club_rake_daily_user_rebuild_day(p_club_id uuid, p_day date, p_user_id uuid DEFAULT NULL::uuid) RETURNS bigint
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE v_rows bigint := 0;
BEGIN
  IF p_club_id IS NULL OR p_day IS NULL THEN
    RETURN 0;
  END IF;

  DELETE FROM public.ca_club_rake_daily_user d
   WHERE d.club_id = p_club_id AND d.day = p_day
     AND (p_user_id IS NULL OR d.user_id = p_user_id);

  INSERT INTO public.ca_club_rake_daily_user (club_id, day, user_id, rake_cents, hands, updated_at)
  SELECT ra.club_id,
         p_day,
         ra.player_id,
         SUM(round(ra.rake_amount * 100))::bigint,
         count(*)::bigint,
         now()
    FROM public.rake_attributions ra
   WHERE ra.club_id = p_club_id
     AND ra.created_at >= p_day::timestamptz
     AND ra.created_at <  (p_day + 1)::timestamptz
     AND ra.player_id IS NOT NULL
     AND ra.rake_amount > 0
     AND public.fn_ca_launch_accounting_accepts(ra.club_id,(SELECT rr.created_at FROM public.rake_records rr WHERE rr.id=ra.rake_record_id))
     AND (p_user_id IS NULL OR ra.player_id = p_user_id)
   GROUP BY 1, 3;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows;
END;
$$;


DO $guard$ BEGIN IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='fn_club_rake_rollup_day' AND md5(p.prosrc)='65727eb0a34be7db566dd971d6030144')<>1 THEN RAISE EXCEPTION 'launch_boundary_source_changed: fn_club_rake_rollup_day'; END IF; END $guard$;
CREATE OR REPLACE FUNCTION public.fn_club_rake_rollup_day(p_club_id uuid, p_day date) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_start timestamptz := p_day::timestamptz;
  v_end   timestamptz := (p_day + 1)::timestamptz;
  v_rows  integer := 0;
BEGIN
  IF v_end > date_trunc('day', now()) THEN
    RAISE EXCEPTION 'club rake rollup: day % is not complete', p_day;
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('club_rake_rollup:' || p_club_id::text || ':' || p_day::text, 42));

  DELETE FROM club_rake_daily_user WHERE club_id = p_club_id AND day = p_day;

  WITH split AS (
    SELECT a.player_id AS user_id, round(a.rake_amount * 100)::bigint AS cents
      FROM rake_attributions a
     WHERE a.club_id = p_club_id
       AND a.created_at >= v_start AND a.created_at < v_end
       AND a.rake_amount > 0
       AND public.fn_ca_launch_accounting_accepts(a.club_id,(SELECT rr.created_at FROM public.rake_records rr WHERE rr.id=a.rake_record_id))
  ), ins AS (
    INSERT INTO club_rake_daily_user (club_id, day, user_id, rake_amount, hands)
    SELECT p_club_id, p_day, s.user_id, SUM(s.cents)::numeric / 100, count(*)
      FROM split s GROUP BY s.user_id
    RETURNING 1
  )
  SELECT count(*) INTO v_rows FROM ins;

  INSERT INTO club_rake_rollup_complete (club_id, day, rows_written, computed_at)
  VALUES (p_club_id, p_day, v_rows, now())
  ON CONFLICT (club_id, day) DO UPDATE
    SET rows_written = EXCLUDED.rows_written, computed_at = EXCLUDED.computed_at;

  RETURN v_rows;
END $$;


SELECT fn_ca_club_rake_daily_user_apply(ARRAY(SELECT id FROM rake_attributions));
DO $$ BEGIN IF (SELECT SUM(rake_cents) FROM ca_club_rake_daily_user WHERE club_id='a0000000-0000-0000-0000-000000000001')<>500 OR (SELECT SUM(rake_cents) FROM ca_club_rake_daily_user WHERE club_id='a0000000-0000-0000-0000-000000000002')<>700 THEN RAISE EXCEPTION 'postboundary scope failed'; END IF; END $$;
SELECT fn_ca_club_rake_daily_user_rebuild_day('a0000000-0000-0000-0000-000000000001','2026-10-12');
SELECT fn_ca_club_rake_daily_user_rebuild_day('a0000000-0000-0000-0000-000000000001','2026-10-12');
DO $$ BEGIN IF (SELECT SUM(rake_cents) FROM ca_club_rake_daily_user WHERE club_id='a0000000-0000-0000-0000-000000000001')<>500 THEN RAISE EXCEPTION 'rebuild resurrects old or duplicates'; END IF; END $$;
DO $$ BEGIN IF public.fn_ca_launch_accounting_accepts('a0000000-0000-0000-0000-000000000001',NULL) OR NOT public.fn_ca_launch_accounting_waived('club','a0000000-0000-0000-0000-000000000001','2026-10-12 11:59Z') OR public.fn_ca_launch_accounting_waived('club','a0000000-0000-0000-0000-000000000001','2026-10-12 12:01Z') THEN RAISE EXCEPTION 'boundaries failed'; END IF; END $$;
CREATE TABLE unions(id uuid,settings jsonb); CREATE TABLE union_clubs(union_id uuid,club_id uuid);
CREATE TABLE union_club_terms(union_id uuid,club_id uuid,stop_loss_limit numeric,status text,stakes_cap_bb numeric);
CREATE TABLE union_eco_ledger(union_id uuid,period_start timestamptz);
CREATE TABLE accounting_close_gates(scope_kind text,scope_id uuid,period_start timestamptz,period_end timestamptz,gate_until timestamptz);
CREATE TABLE union_accounting_runs(scope_kind text,scope_id uuid,period_start timestamptz,period_end timestamptz,status text);
CREATE TABLE clubs(id uuid,name text); CREATE TABLE tables(club_id uuid,big_blind numeric,is_deleted boolean,status text);
CREATE FUNCTION fn_union_club_exposure(uuid) RETURNS TABLE(club_name text,exposure numeric,stop_loss_limit numeric,breached boolean,status text) LANGUAGE sql AS $$ SELECT NULL::text,NULL::numeric,NULL::numeric,false,NULL::text WHERE false $$;
CREATE FUNCTION fn_anon_exposure_check() RETURNS TABLE(invariant text,severity text,offenders bigint,detail text) LANGUAGE sql AS $$ SELECT NULL::text,NULL::text,NULL::bigint,NULL::text WHERE false $$;
CREATE FUNCTION fn_union_week_start() RETURNS timestamptz LANGUAGE sql AS $$ SELECT '2026-10-12 07:00Z'::timestamptz $$;
CREATE FUNCTION fn_union_accounting_run_at(timestamptz) RETURNS timestamptz LANGUAGE sql AS $$ SELECT $1 $$;
INSERT INTO unions VALUES('fade0000-0000-0000-0000-000000000001','{"eco_enabled":true}'),('fade0000-0000-0000-0000-000000000002','{"eco_enabled":true}');
INSERT INTO union_clubs SELECT id,'a0000000-0000-0000-0000-000000000001'::uuid FROM unions;
CREATE FUNCTION public.fn_union_credit_risk_check() RETURNS TABLE(invariant text, severity text, offenders bigint, detail text)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT 'union_club_no_terms', 'warning', count(*),
         'Member clubs with no union_club_terms row: no security deposit and '
         || 'no stop loss on file, so their losses are carried unsecured'
    FROM union_clubs uc
   WHERE NOT EXISTS (SELECT 1 FROM union_club_terms t
                      WHERE t.union_id = uc.union_id AND t.club_id = uc.club_id)
  HAVING count(*) > 0

  UNION ALL
  SELECT 'union_club_stop_loss_breached', 'critical', count(*),
         'Clubs past their weekly stop loss and still active: '
         || COALESCE(string_agg(x.club_name || ' (exposure ' || x.exposure || ' vs limit '
                                || x.stop_loss_limit || ')', '; '), '')
    FROM (
      SELECT e.club_name, e.exposure, e.stop_loss_limit
        FROM (SELECT DISTINCT t.union_id
                FROM union_club_terms t
               WHERE t.stop_loss_limit IS NOT NULL
                 AND t.status <> 'suspended') u
        CROSS JOIN LATERAL fn_union_club_exposure(u.union_id) e
       WHERE e.breached AND e.status <> 'suspended'
    ) x
  HAVING count(*) > 0

  UNION ALL
  SELECT 'union_eco_not_recorded', 'warning', count(*),
         'Unions with ECO enabled and no union_eco_ledger row for the settlement '
         || 'week that has CLOSED: that week''s win tax / loss rebate is not reproducible. '
         || 'The ledger is written at close, so the week in progress is not asked about'
    FROM unions un
   WHERE COALESCE((un.settings->>'eco_enabled')::boolean, false)
     AND EXISTS (SELECT 1 FROM union_clubs uc WHERE uc.union_id = un.id)
     AND NOT EXISTS (SELECT 1 FROM union_eco_ledger l
                      WHERE l.union_id = un.id
                        AND l.period_start >= fn_union_week_start() - interval '7 days')
     -- A WEEK'S ECO ROW IS WRITTEN AT ITS CLOSE, SO IT IS ASKED FOR ONCE THE
     -- CLOSE IS OWED (2026-10-05). Before the close's run time
     -- (fn_union_accounting_run_at), while an accounting_close_gates row holds
     -- the first attempt for a quiet hour, and while the close is running, the
     -- row cannot exist yet. On 2026-10-05 this filed two ledger_imbalance
     -- incidents at 07:52 for a close gated until 2026-10-06 13:00 by the
     -- coordinator decision of 2026-10-03. A close that is owed and has not
     -- written the row - past its run time, no gate holding it, nothing
     -- running - is still found, and so is a finished close without one.
     -- Migration 20261005113359.
     AND NOT (now() < fn_union_accounting_run_at(fn_union_week_start())
              OR EXISTS (SELECT 1 FROM accounting_close_gates g
                          WHERE g.scope_kind = 'union' AND g.scope_id = un.id
                            AND g.period_end = fn_union_week_start()
                            AND g.gate_until > now()
                            AND NOT EXISTS (SELECT 1 FROM union_accounting_runs r
                                             WHERE r.scope_kind = 'union' AND r.scope_id = un.id
                                               AND r.period_start = g.period_start
                                               AND r.period_end = g.period_end))
              OR EXISTS (SELECT 1 FROM union_accounting_runs q
                          WHERE q.scope_kind = 'union' AND q.scope_id = un.id
                            AND q.period_end = fn_union_week_start()
                            AND q.status = 'running'))
  HAVING count(*) > 0

  UNION ALL
  SELECT 'union_club_stakes_above_cap', 'warning', count(*),
         'Live tables above the club''s agreed stakes cap: '
         || COALESCE(string_agg(y.club_name || ' bb=' || y.big_blind
                                || ' cap=' || y.stakes_cap_bb, '; '), '')
    FROM (
      SELECT c.name AS club_name, tb.big_blind, t.stakes_cap_bb
        FROM union_club_terms t
        JOIN clubs c ON c.id = t.club_id
        JOIN tables tb ON tb.club_id = t.club_id
       WHERE t.stakes_cap_bb IS NOT NULL
         AND tb.big_blind > t.stakes_cap_bb
         AND COALESCE(tb.is_deleted, false) = false
         AND tb.status NOT IN ('closed','deleted')
    ) y
  HAVING count(*) > 0

  UNION ALL
  SELECT * FROM fn_anon_exposure_check();
$$;
DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM fn_union_credit_risk_check() WHERE invariant='union_eco_not_recorded' AND offenders=2) THEN RAISE EXCEPTION 'priorclosed ECO reproduction missing'; END IF; END $$;
INSERT INTO ca_launch_accounting_boundaries(scope_kind,scope_id,operation_id,cutoff_at) VALUES('union','fade0000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','2026-10-12 12:00Z');
DO $guard$ BEGIN IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='fn_union_credit_risk_check' AND md5(p.prosrc)='dfd4be7dcfcb05621538c354cf2d18c0')<>1 THEN RAISE EXCEPTION 'launch_boundary_source_changed: fn_union_credit_risk_check'; END IF; END $guard$;
CREATE OR REPLACE FUNCTION public.fn_union_credit_risk_check() RETURNS TABLE(invariant text, severity text, offenders bigint, detail text)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT 'union_club_no_terms', 'warning', count(*),
         'Member clubs with no union_club_terms row: no security deposit and '
         || 'no stop loss on file, so their losses are carried unsecured'
    FROM union_clubs uc
   WHERE NOT EXISTS (SELECT 1 FROM union_club_terms t
                      WHERE t.union_id = uc.union_id AND t.club_id = uc.club_id)
  HAVING count(*) > 0

  UNION ALL
  SELECT 'union_club_stop_loss_breached', 'critical', count(*),
         'Clubs past their weekly stop loss and still active: '
         || COALESCE(string_agg(x.club_name || ' (exposure ' || x.exposure || ' vs limit '
                                || x.stop_loss_limit || ')', '; '), '')
    FROM (
      SELECT e.club_name, e.exposure, e.stop_loss_limit
        FROM (SELECT DISTINCT t.union_id
                FROM union_club_terms t
               WHERE t.stop_loss_limit IS NOT NULL
                 AND t.status <> 'suspended') u
        CROSS JOIN LATERAL fn_union_club_exposure(u.union_id) e
       WHERE e.breached AND e.status <> 'suspended'
    ) x
  HAVING count(*) > 0

  UNION ALL
  SELECT 'union_eco_not_recorded', 'warning', count(*),
         'Unions with ECO enabled and no union_eco_ledger row for the settlement '
         || 'week that has CLOSED: that week''s win tax / loss rebate is not reproducible. '
         || 'The ledger is written at close, so the week in progress is not asked about'
    FROM unions un
   WHERE COALESCE((un.settings->>'eco_enabled')::boolean, false)
     AND NOT public.fn_ca_launch_accounting_waived('union',un.id,public.fn_union_week_start())
     AND EXISTS (SELECT 1 FROM union_clubs uc WHERE uc.union_id = un.id)
     AND NOT EXISTS (SELECT 1 FROM union_eco_ledger l
                      WHERE l.union_id = un.id
                        AND l.period_start >= fn_union_week_start() - interval '7 days')
     -- A WEEK'S ECO ROW IS WRITTEN AT ITS CLOSE, SO IT IS ASKED FOR ONCE THE
     -- CLOSE IS OWED (2026-10-05). Before the close's run time
     -- (fn_union_accounting_run_at), while an accounting_close_gates row holds
     -- the first attempt for a quiet hour, and while the close is running, the
     -- row cannot exist yet. On 2026-10-05 this filed two ledger_imbalance
     -- incidents at 07:52 for a close gated until 2026-10-06 13:00 by the
     -- coordinator decision of 2026-10-03. A close that is owed and has not
     -- written the row - past its run time, no gate holding it, nothing
     -- running - is still found, and so is a finished close without one.
     -- Migration 20261005113359.
     AND NOT (now() < fn_union_accounting_run_at(fn_union_week_start())
              OR EXISTS (SELECT 1 FROM accounting_close_gates g
                          WHERE g.scope_kind = 'union' AND g.scope_id = un.id
                            AND g.period_end = fn_union_week_start()
                            AND g.gate_until > now()
                            AND NOT EXISTS (SELECT 1 FROM union_accounting_runs r
                                             WHERE r.scope_kind = 'union' AND r.scope_id = un.id
                                               AND r.period_start = g.period_start
                                               AND r.period_end = g.period_end))
              OR EXISTS (SELECT 1 FROM union_accounting_runs q
                          WHERE q.scope_kind = 'union' AND q.scope_id = un.id
                            AND q.period_end = fn_union_week_start()
                            AND q.status = 'running'))
  HAVING count(*) > 0

  UNION ALL
  SELECT 'union_club_stakes_above_cap', 'warning', count(*),
         'Live tables above the club''s agreed stakes cap: '
         || COALESCE(string_agg(y.club_name || ' bb=' || y.big_blind
                                || ' cap=' || y.stakes_cap_bb, '; '), '')
    FROM (
      SELECT c.name AS club_name, tb.big_blind, t.stakes_cap_bb
        FROM union_club_terms t
        JOIN clubs c ON c.id = t.club_id
        JOIN tables tb ON tb.club_id = t.club_id
       WHERE t.stakes_cap_bb IS NOT NULL
         AND tb.big_blind > t.stakes_cap_bb
         AND COALESCE(tb.is_deleted, false) = false
         AND tb.status NOT IN ('closed','deleted')
    ) y
  HAVING count(*) > 0

  UNION ALL
  SELECT * FROM fn_anon_exposure_check();
$$;
DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM fn_union_credit_risk_check() WHERE invariant='union_eco_not_recorded' AND offenders=1) THEN RAISE EXCEPTION 'waiver incorrectly masks unrelatedunion or retains oldweek'; END IF; END $$;
CREATE OR REPLACE FUNCTION fn_union_week_start() RETURNS timestamptz LANGUAGE sql AS $$ SELECT '2026-10-19 07:00Z'::timestamptz $$;
CREATE OR REPLACE FUNCTION fn_union_accounting_run_at(timestamptz) RETURNS timestamptz LANGUAGE sql AS $$ SELECT '2026-10-12 07:00Z'::timestamptz $$;
DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM fn_union_credit_risk_check() WHERE invariant='union_eco_not_recorded' AND offenders=2) THEN RAISE EXCEPTION 'waiver masks newclosedweek'; END IF; END $$;
ALTER TABLE tables ADD COLUMN id uuid;
INSERT INTO tables(id,club_id) VALUES('20000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000001');
CREATE TABLE profiles(id uuid);
INSERT INTO profiles VALUES('10000000-0000-0000-0000-000000000012');
CREATE TABLE player_stats(id uuid DEFAULT gen_random_uuid(),user_id uuid,club_id uuid,hands_dealt int DEFAULT 0,sum_big_blind numeric DEFAULT 0,total_winnings numeric DEFAULT 0,updated_at timestamptz,hands_played int DEFAULT 0,total_rake numeric DEFAULT 0,total_losses numeric DEFAULT 0,vpip numeric,pfr numeric,tournaments_played int,tournaments_won int,PRIMARY KEY(user_id,club_id));
CREATE TABLE rakeback_stats_applied(rake_record_id uuid,user_id uuid,hands int,rake numeric,PRIMARY KEY(rake_record_id,user_id));
CREATE TABLE hand_history(id uuid DEFAULT gen_random_uuid(),table_id uuid,tournament_id uuid,players jsonb,winners jsonb,big_blind numeric,created_at timestamptz);
CREATE FUNCTION public.fn_fold_hand_winnings() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $_$
DECLARE v_club uuid; v_bb numeric;
BEGIN
  IF coalesce(current_setting('app.atomic_hand_commit',true),'')='on' THEN RETURN NEW; END IF;
  IF NEW.tournament_id IS NOT NULL OR NEW.players IS NULL
     OR jsonb_typeof(NEW.players)<>'array' OR jsonb_array_length(NEW.players)=0 THEN
    RETURN NEW;
  END IF;
  SELECT t.club_id INTO v_club FROM public.tables t WHERE t.id=NEW.table_id;
  IF v_club IS NULL THEN RETURN NEW; END IF;
  v_bb := greatest(coalesce(NEW.big_blind,0),0);
  WITH seated AS (
    SELECT DISTINCT (pl->>'userId') AS uid
      FROM jsonb_array_elements(NEW.players) pl
     WHERE (pl->>'userId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ), won AS (
    SELECT (w->>'userId') AS uid,sum((w->>'amount')::numeric) AS amt
      FROM jsonb_array_elements(CASE WHEN jsonb_typeof(NEW.winners)='array'
        THEN NEW.winners ELSE '[]'::jsonb END) w
     WHERE (w->>'userId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       AND coalesce((w->>'amount')::numeric,0)>0
     GROUP BY 1
  )
  INSERT INTO public.player_stats
    (id,user_id,club_id,hands_dealt,sum_big_blind,total_winnings,updated_at)
  SELECT gen_random_uuid(),s.uid::uuid,v_club,1,v_bb,coalesce(wo.amt,0),now()
    FROM seated s LEFT JOIN won wo ON wo.uid=s.uid
   WHERE EXISTS (SELECT 1 FROM public.profiles p WHERE p.id=s.uid::uuid)
  ON CONFLICT (user_id,club_id) DO UPDATE SET
    hands_dealt=player_stats.hands_dealt+EXCLUDED.hands_dealt,
    sum_big_blind=player_stats.sum_big_blind+EXCLUDED.sum_big_blind,
    total_winnings=player_stats.total_winnings+EXCLUDED.total_winnings,
    updated_at=now();
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN RETURN NEW;
END;
$_$;CREATE FUNCTION public.apply_rakeback_player_stats(p_rake_record_id uuid, p_user_id uuid, p_club_id uuid, p_hands integer, p_rake numeric) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_inserted integer;
BEGIN
  IF p_rake_record_id IS NULL OR p_user_id IS NULL OR p_club_id IS NULL THEN
    RETURN false;
  END IF;

  INSERT INTO public.rakeback_stats_applied (rake_record_id, user_id, hands, rake)
  VALUES (p_rake_record_id, p_user_id, p_hands, p_rake)
  ON CONFLICT (rake_record_id, user_id) DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  IF v_inserted = 0 THEN
    RETURN false;
  END IF;

  INSERT INTO public.player_stats (
    user_id, club_id, hands_played, total_rake,
    total_winnings, total_losses, vpip, pfr, tournaments_played, tournaments_won
  ) VALUES (
    p_user_id, p_club_id, COALESCE(p_hands, 0), COALESCE(p_rake, 0),
    0, 0, 0, 0, 0, 0
  )
  ON CONFLICT (user_id, club_id) DO UPDATE SET
    hands_played = public.player_stats.hands_played + EXCLUDED.hands_played,
    total_rake   = ROUND((public.player_stats.total_rake + EXCLUDED.total_rake) * 100) / 100,
    updated_at   = NOW();

  RETURN true;
END;
$$;
CREATE TRIGGER folded AFTER INSERT ON hand_history FOR EACH ROW EXECUTE FUNCTION fn_fold_hand_winnings();
INSERT INTO hand_history(table_id,players,winners,big_blind,created_at) VALUES('20000000-0000-0000-0000-000000000001','[{"userId":"10000000-0000-0000-0000-000000000012"}]','[]',20,'2026-10-12 11:59Z');
DO $$ BEGIN IF (SELECT hands_dealt FROM player_stats LIMIT 1)<>1 THEN RAISE EXCEPTION 'oldhand reproduction missing'; END IF; END $$;
TRUNCATE player_stats;
DO $guard$ BEGIN IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='fn_fold_hand_winnings' AND md5(p.prosrc)='743b74f6f7740500a46cf95d51f9ebbf')<>1 THEN RAISE EXCEPTION 'launch_boundary_source_changed: fn_fold_hand_winnings'; END IF; END $guard$;
CREATE OR REPLACE FUNCTION public.fn_fold_hand_winnings() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $_$
DECLARE v_club uuid; v_bb numeric;
BEGIN
  IF coalesce(current_setting('app.atomic_hand_commit',true),'')='on' THEN RETURN NEW; END IF;
  IF NEW.tournament_id IS NOT NULL OR NEW.players IS NULL
     OR jsonb_typeof(NEW.players)<>'array' OR jsonb_array_length(NEW.players)=0 THEN
    RETURN NEW;
  END IF;
  SELECT t.club_id INTO v_club FROM public.tables t WHERE t.id=NEW.table_id;
  IF v_club IS NULL THEN RETURN NEW; END IF;
  IF NOT public.fn_ca_launch_accounting_accepts(v_club,NEW.created_at) THEN RETURN NEW; END IF;
  v_bb := greatest(coalesce(NEW.big_blind,0),0);
  WITH seated AS (
    SELECT DISTINCT (pl->>'userId') AS uid
      FROM jsonb_array_elements(NEW.players) pl
     WHERE (pl->>'userId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ), won AS (
    SELECT (w->>'userId') AS uid,sum((w->>'amount')::numeric) AS amt
      FROM jsonb_array_elements(CASE WHEN jsonb_typeof(NEW.winners)='array'
        THEN NEW.winners ELSE '[]'::jsonb END) w
     WHERE (w->>'userId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       AND coalesce((w->>'amount')::numeric,0)>0
     GROUP BY 1
  )
  INSERT INTO public.player_stats
    (id,user_id,club_id,hands_dealt,sum_big_blind,total_winnings,updated_at)
  SELECT gen_random_uuid(),s.uid::uuid,v_club,1,v_bb,coalesce(wo.amt,0),now()
    FROM seated s LEFT JOIN won wo ON wo.uid=s.uid
   WHERE EXISTS (SELECT 1 FROM public.profiles p WHERE p.id=s.uid::uuid)
  ON CONFLICT (user_id,club_id) DO UPDATE SET
    hands_dealt=player_stats.hands_dealt+EXCLUDED.hands_dealt,
    sum_big_blind=player_stats.sum_big_blind+EXCLUDED.sum_big_blind,
    total_winnings=player_stats.total_winnings+EXCLUDED.total_winnings,
    updated_at=now();
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN RETURN NEW;
END;
$_$;


DO $guard$ BEGIN IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='apply_rakeback_player_stats' AND md5(p.prosrc)='92c5fa0e39ba4ffcaa1befee86623b8c')<>1 THEN RAISE EXCEPTION 'launch_boundary_source_changed: apply_rakeback_player_stats'; END IF; END $guard$;
CREATE OR REPLACE FUNCTION public.apply_rakeback_player_stats(p_rake_record_id uuid, p_user_id uuid, p_club_id uuid, p_hands integer, p_rake numeric) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_inserted integer;
BEGIN
  IF p_rake_record_id IS NULL OR p_user_id IS NULL OR p_club_id IS NULL THEN
    RETURN false;
  END IF;

  IF public.fn_ca_launch_accounting_cutoff('club',p_club_id) IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.rake_records r WHERE r.id=p_rake_record_id AND public.fn_ca_launch_accounting_accepts(p_club_id,r.created_at) AND ((r.is_tournament IS NOT TRUE AND r.tournament_id IS NULL) OR EXISTS(SELECT 1 FROM public.accounting_tournament_fee_sources f WHERE f.rake_record_id=r.id AND f.player_id=p_user_id AND f.club_id=p_club_id AND public.fn_ca_launch_accounting_accepts(p_club_id,f.charged_at)))) THEN RETURN false; END IF;

  INSERT INTO public.rakeback_stats_applied (rake_record_id, user_id, hands, rake)
  VALUES (p_rake_record_id, p_user_id, p_hands, p_rake)
  ON CONFLICT (rake_record_id, user_id) DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  IF v_inserted = 0 THEN
    RETURN false;
  END IF;

  INSERT INTO public.player_stats (
    user_id, club_id, hands_played, total_rake,
    total_winnings, total_losses, vpip, pfr, tournaments_played, tournaments_won
  ) VALUES (
    p_user_id, p_club_id, COALESCE(p_hands, 0), COALESCE(p_rake, 0),
    0, 0, 0, 0, 0, 0
  )
  ON CONFLICT (user_id, club_id) DO UPDATE SET
    hands_played = public.player_stats.hands_played + EXCLUDED.hands_played,
    total_rake   = ROUND((public.player_stats.total_rake + EXCLUDED.total_rake) * 100) / 100,
    updated_at   = NOW();

  RETURN true;
END;
$$;


INSERT INTO hand_history(table_id,players,winners,big_blind,created_at) VALUES('20000000-0000-0000-0000-000000000001','[{"userId":"10000000-0000-0000-0000-000000000012"}]','[]',20,'2026-10-12 11:59Z');
DO $$ BEGIN IF EXISTS(SELECT 1 FROM player_stats) THEN RAISE EXCEPTION 'lateoldhand recreatedclubstats'; END IF; IF(SELECT count(*) FROM hand_history)<>2 THEN RAISE EXCEPTION 'retainedhistory lost'; END IF; END $$;
INSERT INTO hand_history(table_id,players,winners,big_blind,created_at) VALUES('20000000-0000-0000-0000-000000000001','[{"userId":"10000000-0000-0000-0000-000000000012"}]','[]',20,'2026-10-12 12:00Z');
DO $$ BEGIN IF (SELECT hands_dealt FROM player_stats LIMIT 1)<>1 THEN RAISE EXCEPTION 'newhand missing'; END IF; IF apply_rakeback_player_stats('10000000-0000-0000-0000-000000000021','10000000-0000-0000-0000-000000000012','a0000000-0000-0000-0000-000000000001',1,3) THEN RAISE EXCEPTION 'lateoldrake recreatedstats'; END IF; IF NOT apply_rakeback_player_stats('10000000-0000-0000-0000-000000000023','10000000-0000-0000-0000-000000000012','a0000000-0000-0000-0000-000000000001',1,5) THEN RAISE EXCEPTION 'newrake missing'; END IF; IF apply_rakeback_player_stats('10000000-0000-0000-0000-000000000023','10000000-0000-0000-0000-000000000012','a0000000-0000-0000-0000-000000000001',1,5) THEN RAISE EXCEPTION 'newrake duplicated'; END IF; END $$;

INSERT INTO ca_launch_accounting_archives VALUES('10000000-0000-0000-0000-000000000001','fixture','one','{"kept":true}','fixture-sha',now());
DO $$ BEGIN BEGIN DELETE FROM ca_launch_accounting_archives; RAISE EXCEPTION 'archive deletion succeeded'; EXCEPTION WHEN check_violation THEN NULL; END; BEGIN UPDATE ca_launch_accounting_archives SET before_image='{}'; RAISE EXCEPTION 'archive rewrite succeeded'; EXCEPTION WHEN check_violation THEN NULL; END; END $$;

CREATE TABLE ca_hand_facts(id int,club_id uuid,user_id uuid,tournament_id uuid,played_at timestamptz,rake_paid numeric,net numeric);
CREATE TABLE club_member_play_totals(club_id uuid,user_id uuid,hands bigint,mtt_hands bigint,fees numeric,mtt_fees numeric,net numeric,mtt_net numeric,PRIMARY KEY(club_id,user_id));
CREATE FUNCTION public.fn_club_member_play_totals_insert() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
BEGIN
  INSERT INTO public.club_member_play_totals AS totals(club_id,user_id,hands,mtt_hands,fees,mtt_fees,net,mtt_net)
  SELECT club_id,user_id,sum(hands)::bigint,sum(mtt_hands)::bigint,sum(fees),sum(mtt_fees),sum(net),sum(mtt_net)
  FROM (SELECT club_id,user_id,CASE WHEN tournament_id IS NULL THEN 1 ELSE 0 END AS hands,CASE WHEN tournament_id IS NOT NULL THEN 1 ELSE 0 END AS mtt_hands,CASE WHEN tournament_id IS NULL THEN rake_paid ELSE 0 END AS fees,CASE WHEN tournament_id IS NOT NULL THEN rake_paid ELSE 0 END AS mtt_fees,CASE WHEN tournament_id IS NULL THEN coalesce(net,0) ELSE 0 END AS net,CASE WHEN tournament_id IS NOT NULL THEN coalesce(net,0) ELSE 0 END AS mtt_net FROM new_facts) changes
  WHERE club_id IS NOT NULL GROUP BY club_id,user_id
  HAVING sum(hands)<>0 OR sum(mtt_hands)<>0 OR sum(fees)<>0 OR sum(mtt_fees)<>0 OR sum(net)<>0 OR sum(mtt_net)<>0
  ORDER BY club_id,user_id
  ON CONFLICT(club_id,user_id) DO UPDATE SET
    hands=totals.hands+EXCLUDED.hands,mtt_hands=totals.mtt_hands+EXCLUDED.mtt_hands,fees=totals.fees+EXCLUDED.fees,mtt_fees=totals.mtt_fees+EXCLUDED.mtt_fees,net=totals.net+EXCLUDED.net,mtt_net=totals.mtt_net+EXCLUDED.mtt_net;
  RETURN NULL;
END;
$$;CREATE FUNCTION public.fn_club_member_play_totals_update() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
BEGIN
  INSERT INTO public.club_member_play_totals AS totals(club_id,user_id,hands,mtt_hands,fees,mtt_fees,net,mtt_net)
  SELECT club_id,user_id,sum(hands)::bigint,sum(mtt_hands)::bigint,sum(fees),sum(mtt_fees),sum(net),sum(mtt_net)
  FROM (SELECT club_id,user_id,CASE WHEN tournament_id IS NULL THEN 1 ELSE 0 END AS hands,CASE WHEN tournament_id IS NOT NULL THEN 1 ELSE 0 END AS mtt_hands,CASE WHEN tournament_id IS NULL THEN rake_paid ELSE 0 END AS fees,CASE WHEN tournament_id IS NOT NULL THEN rake_paid ELSE 0 END AS mtt_fees,CASE WHEN tournament_id IS NULL THEN coalesce(net,0) ELSE 0 END AS net,CASE WHEN tournament_id IS NOT NULL THEN coalesce(net,0) ELSE 0 END AS mtt_net FROM new_facts UNION ALL SELECT club_id,user_id,-(CASE WHEN tournament_id IS NULL THEN 1 ELSE 0 END) AS hands,-(CASE WHEN tournament_id IS NOT NULL THEN 1 ELSE 0 END) AS mtt_hands,-(CASE WHEN tournament_id IS NULL THEN rake_paid ELSE 0 END) AS fees,-(CASE WHEN tournament_id IS NOT NULL THEN rake_paid ELSE 0 END) AS mtt_fees,-(CASE WHEN tournament_id IS NULL THEN coalesce(net,0) ELSE 0 END) AS net,-(CASE WHEN tournament_id IS NOT NULL THEN coalesce(net,0) ELSE 0 END) AS mtt_net FROM old_facts) changes
  WHERE club_id IS NOT NULL GROUP BY club_id,user_id
  HAVING sum(hands)<>0 OR sum(mtt_hands)<>0 OR sum(fees)<>0 OR sum(mtt_fees)<>0 OR sum(net)<>0 OR sum(mtt_net)<>0
  ORDER BY club_id,user_id
  ON CONFLICT(club_id,user_id) DO UPDATE SET
    hands=totals.hands+EXCLUDED.hands,mtt_hands=totals.mtt_hands+EXCLUDED.mtt_hands,fees=totals.fees+EXCLUDED.fees,mtt_fees=totals.mtt_fees+EXCLUDED.mtt_fees,net=totals.net+EXCLUDED.net,mtt_net=totals.mtt_net+EXCLUDED.mtt_net;
  RETURN NULL;
END;
$$;CREATE FUNCTION public.fn_club_member_play_totals_delete() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
BEGIN
  INSERT INTO public.club_member_play_totals AS totals(club_id,user_id,hands,mtt_hands,fees,mtt_fees,net,mtt_net)
  SELECT club_id,user_id,sum(hands)::bigint,sum(mtt_hands)::bigint,sum(fees),sum(mtt_fees),sum(net),sum(mtt_net)
  FROM (SELECT club_id,user_id,-(CASE WHEN tournament_id IS NULL THEN 1 ELSE 0 END) AS hands,-(CASE WHEN tournament_id IS NOT NULL THEN 1 ELSE 0 END) AS mtt_hands,-(CASE WHEN tournament_id IS NULL THEN rake_paid ELSE 0 END) AS fees,-(CASE WHEN tournament_id IS NOT NULL THEN rake_paid ELSE 0 END) AS mtt_fees,-(CASE WHEN tournament_id IS NULL THEN coalesce(net,0) ELSE 0 END) AS net,-(CASE WHEN tournament_id IS NOT NULL THEN coalesce(net,0) ELSE 0 END) AS mtt_net FROM old_facts) changes
  WHERE club_id IS NOT NULL GROUP BY club_id,user_id
  HAVING sum(hands)<>0 OR sum(mtt_hands)<>0 OR sum(fees)<>0 OR sum(mtt_fees)<>0 OR sum(net)<>0 OR sum(mtt_net)<>0
  ORDER BY club_id,user_id
  ON CONFLICT(club_id,user_id) DO UPDATE SET
    hands=totals.hands+EXCLUDED.hands,mtt_hands=totals.mtt_hands+EXCLUDED.mtt_hands,fees=totals.fees+EXCLUDED.fees,mtt_fees=totals.mtt_fees+EXCLUDED.mtt_fees,net=totals.net+EXCLUDED.net,mtt_net=totals.mtt_net+EXCLUDED.mtt_net;
  RETURN NULL;
END;
$$;
CREATE TRIGGER fact_insert AFTER INSERT ON ca_hand_facts REFERENCING NEW TABLE AS new_facts FOR EACH STATEMENT EXECUTE FUNCTION fn_club_member_play_totals_insert();
CREATE TRIGGER fact_update AFTER UPDATE ON ca_hand_facts REFERENCING OLD TABLE AS old_facts NEW TABLE AS new_facts FOR EACH STATEMENT EXECUTE FUNCTION fn_club_member_play_totals_update();
CREATE TRIGGER fact_delete AFTER DELETE ON ca_hand_facts REFERENCING OLD TABLE AS old_facts FOR EACH STATEMENT EXECUTE FUNCTION fn_club_member_play_totals_delete();
INSERT INTO ca_hand_facts VALUES(1,'a0000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000012',NULL,'2026-10-12 11:59Z',3,9);
DO $$ BEGIN IF (SELECT hands FROM club_member_play_totals LIMIT 1)<>1 THEN RAISE EXCEPTION 'oldfact repro missing'; END IF; END $$;
TRUNCATE club_member_play_totals;
DO $guard$ BEGIN IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='fn_club_member_play_totals_insert' AND md5(p.prosrc)='ea2f75bd25c52d9e0ac3edb8966add70')<>1 THEN RAISE EXCEPTION 'launch_boundary_source_changed: fn_club_member_play_totals_insert'; END IF; END $guard$;
CREATE OR REPLACE FUNCTION public.fn_club_member_play_totals_insert() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
BEGIN
  INSERT INTO public.club_member_play_totals AS totals(club_id,user_id,hands,mtt_hands,fees,mtt_fees,net,mtt_net)
  SELECT club_id,user_id,sum(hands)::bigint,sum(mtt_hands)::bigint,sum(fees),sum(mtt_fees),sum(net),sum(mtt_net)
  FROM (SELECT club_id,user_id,CASE WHEN tournament_id IS NULL THEN 1 ELSE 0 END AS hands,CASE WHEN tournament_id IS NOT NULL THEN 1 ELSE 0 END AS mtt_hands,CASE WHEN tournament_id IS NULL THEN rake_paid ELSE 0 END AS fees,CASE WHEN tournament_id IS NOT NULL THEN rake_paid ELSE 0 END AS mtt_fees,CASE WHEN tournament_id IS NULL THEN coalesce(net,0) ELSE 0 END AS net,CASE WHEN tournament_id IS NOT NULL THEN coalesce(net,0) ELSE 0 END AS mtt_net FROM new_facts WHERE public.fn_ca_launch_accounting_accepts(club_id,played_at)) changes
  WHERE club_id IS NOT NULL GROUP BY club_id,user_id
  HAVING sum(hands)<>0 OR sum(mtt_hands)<>0 OR sum(fees)<>0 OR sum(mtt_fees)<>0 OR sum(net)<>0 OR sum(mtt_net)<>0
  ORDER BY club_id,user_id
  ON CONFLICT(club_id,user_id) DO UPDATE SET
    hands=totals.hands+EXCLUDED.hands,mtt_hands=totals.mtt_hands+EXCLUDED.mtt_hands,fees=totals.fees+EXCLUDED.fees,mtt_fees=totals.mtt_fees+EXCLUDED.mtt_fees,net=totals.net+EXCLUDED.net,mtt_net=totals.mtt_net+EXCLUDED.mtt_net;
  RETURN NULL;
END;
$$;

DO $guard$ BEGIN IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='fn_club_member_play_totals_update' AND md5(p.prosrc)='75ab10fa07164f249d129f23bcfb7d3d')<>1 THEN RAISE EXCEPTION 'launch_boundary_source_changed: fn_club_member_play_totals_update'; END IF; END $guard$;
CREATE OR REPLACE FUNCTION public.fn_club_member_play_totals_update() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
BEGIN
  INSERT INTO public.club_member_play_totals AS totals(club_id,user_id,hands,mtt_hands,fees,mtt_fees,net,mtt_net)
  SELECT club_id,user_id,sum(hands)::bigint,sum(mtt_hands)::bigint,sum(fees),sum(mtt_fees),sum(net),sum(mtt_net)
  FROM (SELECT club_id,user_id,CASE WHEN tournament_id IS NULL THEN 1 ELSE 0 END AS hands,CASE WHEN tournament_id IS NOT NULL THEN 1 ELSE 0 END AS mtt_hands,CASE WHEN tournament_id IS NULL THEN rake_paid ELSE 0 END AS fees,CASE WHEN tournament_id IS NOT NULL THEN rake_paid ELSE 0 END AS mtt_fees,CASE WHEN tournament_id IS NULL THEN coalesce(net,0) ELSE 0 END AS net,CASE WHEN tournament_id IS NOT NULL THEN coalesce(net,0) ELSE 0 END AS mtt_net FROM new_facts WHERE public.fn_ca_launch_accounting_accepts(club_id,played_at) UNION ALL SELECT club_id,user_id,-(CASE WHEN tournament_id IS NULL THEN 1 ELSE 0 END) AS hands,-(CASE WHEN tournament_id IS NOT NULL THEN 1 ELSE 0 END) AS mtt_hands,-(CASE WHEN tournament_id IS NULL THEN rake_paid ELSE 0 END) AS fees,-(CASE WHEN tournament_id IS NOT NULL THEN rake_paid ELSE 0 END) AS mtt_fees,-(CASE WHEN tournament_id IS NULL THEN coalesce(net,0) ELSE 0 END) AS net,-(CASE WHEN tournament_id IS NOT NULL THEN coalesce(net,0) ELSE 0 END) AS mtt_net FROM old_facts WHERE public.fn_ca_launch_accounting_accepts(club_id,played_at)) changes
  WHERE club_id IS NOT NULL GROUP BY club_id,user_id
  HAVING sum(hands)<>0 OR sum(mtt_hands)<>0 OR sum(fees)<>0 OR sum(mtt_fees)<>0 OR sum(net)<>0 OR sum(mtt_net)<>0
  ORDER BY club_id,user_id
  ON CONFLICT(club_id,user_id) DO UPDATE SET
    hands=totals.hands+EXCLUDED.hands,mtt_hands=totals.mtt_hands+EXCLUDED.mtt_hands,fees=totals.fees+EXCLUDED.fees,mtt_fees=totals.mtt_fees+EXCLUDED.mtt_fees,net=totals.net+EXCLUDED.net,mtt_net=totals.mtt_net+EXCLUDED.mtt_net;
  RETURN NULL;
END;
$$;

DO $guard$ BEGIN IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='fn_club_member_play_totals_delete' AND md5(p.prosrc)='d6defd06bafb66eb2ea1fafc387b7e35')<>1 THEN RAISE EXCEPTION 'launch_boundary_source_changed: fn_club_member_play_totals_delete'; END IF; END $guard$;
CREATE OR REPLACE FUNCTION public.fn_club_member_play_totals_delete() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
BEGIN
  INSERT INTO public.club_member_play_totals AS totals(club_id,user_id,hands,mtt_hands,fees,mtt_fees,net,mtt_net)
  SELECT club_id,user_id,sum(hands)::bigint,sum(mtt_hands)::bigint,sum(fees),sum(mtt_fees),sum(net),sum(mtt_net)
  FROM (SELECT club_id,user_id,-(CASE WHEN tournament_id IS NULL THEN 1 ELSE 0 END) AS hands,-(CASE WHEN tournament_id IS NOT NULL THEN 1 ELSE 0 END) AS mtt_hands,-(CASE WHEN tournament_id IS NULL THEN rake_paid ELSE 0 END) AS fees,-(CASE WHEN tournament_id IS NOT NULL THEN rake_paid ELSE 0 END) AS mtt_fees,-(CASE WHEN tournament_id IS NULL THEN coalesce(net,0) ELSE 0 END) AS net,-(CASE WHEN tournament_id IS NOT NULL THEN coalesce(net,0) ELSE 0 END) AS mtt_net FROM old_facts WHERE public.fn_ca_launch_accounting_accepts(club_id,played_at)) changes
  WHERE club_id IS NOT NULL GROUP BY club_id,user_id
  HAVING sum(hands)<>0 OR sum(mtt_hands)<>0 OR sum(fees)<>0 OR sum(mtt_fees)<>0 OR sum(net)<>0 OR sum(mtt_net)<>0
  ORDER BY club_id,user_id
  ON CONFLICT(club_id,user_id) DO UPDATE SET
    hands=totals.hands+EXCLUDED.hands,mtt_hands=totals.mtt_hands+EXCLUDED.mtt_hands,fees=totals.fees+EXCLUDED.fees,mtt_fees=totals.mtt_fees+EXCLUDED.mtt_fees,net=totals.net+EXCLUDED.net,mtt_net=totals.mtt_net+EXCLUDED.mtt_net;
  RETURN NULL;
END;
$$;

UPDATE ca_hand_facts SET net=12 WHERE id=1;
DELETE FROM ca_hand_facts WHERE id=1;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM club_member_play_totals) THEN RAISE EXCEPTION 'oldfact update/delete resurrected stats or negativebaseline'; END IF; END $$;
INSERT INTO ca_hand_facts VALUES(2,'a0000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000012',NULL,'2026-10-12 12:00Z',5,15);
UPDATE ca_hand_facts SET net=20 WHERE id=2;
DO $$ BEGIN IF (SELECT hands FROM club_member_play_totals LIMIT 1)<>1 OR (SELECT net FROM club_member_play_totals LIMIT 1)<>20 THEN RAISE EXCEPTION 'newfact update incorrect'; END IF; END $$;
DELETE FROM ca_hand_facts WHERE id=2;
DO $$ BEGIN IF (SELECT hands FROM club_member_play_totals LIMIT 1)<>0 OR (SELECT net FROM club_member_play_totals LIMIT 1)<>0 THEN RAISE EXCEPTION 'newfact delete incorrect'; END IF; END $$;

INSERT INTO rake_records(id,created_at,is_tournament,tournament_id) VALUES('30000000-0000-0000-0000-000000000001','2026-10-12 12:05Z',true,'30000000-0000-0000-0000-000000000002');
INSERT INTO accounting_tournament_fee_sources VALUES('30000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000012','a0000000-0000-0000-0000-000000000001','2026-10-12 11:59Z');
DO $$ BEGIN IF apply_rakeback_player_stats('30000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000012','a0000000-0000-0000-0000-000000000001',0,3) THEN RAISE EXCEPTION 'oldfee recognizedlate recreatedclubrake'; END IF; END $$;

CREATE TABLE tournaments(id uuid PRIMARY KEY,club_id uuid,status text,created_at timestamptz,started_at timestamptz);
CREATE TABLE tournament_players(tournament_id uuid,user_id uuid,position int,status text);
CREATE FUNCTION public.trg_tournament_completed_stats() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
BEGIN
  IF NEW.status <> 'COMPLETED' OR COALESCE(OLD.status,'') = 'COMPLETED' THEN
    RETURN NEW;
  END IF;

  INSERT INTO player_stats (user_id, club_id, tournaments_played, tournaments_won, updated_at)
  SELECT tp.user_id,
         NEW.club_id,
         1,
         CASE WHEN tp.position = 1 OR tp.status = 'winner' THEN 1 ELSE 0 END,
         now()
    FROM tournament_players tp
   WHERE tp.tournament_id = NEW.id
     AND tp.user_id IS NOT NULL
  ON CONFLICT (user_id, club_id) DO UPDATE
     SET tournaments_played = COALESCE(player_stats.tournaments_played,0)
                            + EXCLUDED.tournaments_played,
         tournaments_won    = COALESCE(player_stats.tournaments_won,0)
                            + EXCLUDED.tournaments_won,
         updated_at = now();
  RETURN NEW;
END;
$$;
DO $guard$ BEGIN IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='trg_tournament_completed_stats' AND md5(p.prosrc)='b07b73daa38b87d50f082b579be0368d')<>1 THEN RAISE EXCEPTION 'launch_boundary_source_changed: trg_tournament_completed_stats'; END IF; END $guard$;
CREATE OR REPLACE FUNCTION public.trg_tournament_completed_stats() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
BEGIN
  IF NEW.status <> 'COMPLETED' OR COALESCE(OLD.status,'') = 'COMPLETED' THEN
    RETURN NEW;
  END IF;

  IF NOT public.fn_ca_launch_accounting_accepts(NEW.club_id,NEW.started_at) THEN RETURN NEW; END IF;

  INSERT INTO player_stats (user_id, club_id, tournaments_played, tournaments_won, updated_at)
  SELECT tp.user_id,
         NEW.club_id,
         1,
         CASE WHEN tp.position = 1 OR tp.status = 'winner' THEN 1 ELSE 0 END,
         now()
    FROM tournament_players tp
   WHERE tp.tournament_id = NEW.id
     AND tp.user_id IS NOT NULL
  ON CONFLICT (user_id, club_id) DO UPDATE
     SET tournaments_played = COALESCE(player_stats.tournaments_played,0)
                            + EXCLUDED.tournaments_played,
         tournaments_won    = COALESCE(player_stats.tournaments_won,0)
                            + EXCLUDED.tournaments_won,
         updated_at = now();
  RETURN NEW;
END;
$$;


CREATE TRIGGER tourney_stats AFTER UPDATE ON tournaments FOR EACH ROW EXECUTE FUNCTION trg_tournament_completed_stats();
INSERT INTO tournaments VALUES('40000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000001','RUNNING','2026-10-11 10:00Z','2026-10-12 12:01Z'),('40000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-000000000001','RUNNING','2026-10-11 10:00Z','2026-10-12 11:59Z');
INSERT INTO tournament_players VALUES('40000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-000000000001',1,'winner'),('40000000-0000-0000-0000-000000000002','50000000-0000-0000-0000-000000000002',1,'winner');
UPDATE tournaments SET status='COMPLETED';
DO $$ BEGIN IF (SELECT tournaments_played FROM player_stats WHERE user_id='50000000-0000-0000-0000-000000000001')<>1 OR EXISTS(SELECT 1 FROM player_stats WHERE user_id='50000000-0000-0000-0000-000000000002') THEN RAISE EXCEPTION 'tournament original start boundary wrong'; END IF; END $$;
UPDATE tournaments SET status='COMPLETED';
DO $$ BEGIN IF (SELECT tournaments_played FROM player_stats WHERE user_id='50000000-0000-0000-0000-000000000001')<>1 THEN RAISE EXCEPTION 'tournament duplicate stats'; END IF; END $$;

CREATE FUNCTION public.fn_ca_launch_accounting_store_query(p_relation text,p_columns text[] DEFAULT NULL) RETURNS text
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public SET timezone='UTC' AS $$
DECLARE v_scope text;v_keys text;v_value text;
BEGIN
 CASE
 WHEN p_relation IN('club_members','agents','settlement_invoices','rakeback_periods','club_settlement_floor','player_stats','player_stats_snapshots','club_member_daily_stats','club_member_play_totals','ca_club_commission_daily','ca_club_rake_daily','ca_club_rake_daily_user','club_rake_daily_user','club_rake_rollup_complete','club_table_rake_totals','club_hand_daily_shard','accounting_rakeback_period_evidence_checkpoints','accounting_recompute_split_parts','accounting_period_recompute_requests','ca_club_player_daily','ca_club_tournament_daily','ca_club_tournament_player_daily','club_table_daily','union_rake_weekly') THEN v_scope:='t.club_id=ANY($1)';
 WHEN p_relation IN('clubs','unions') THEN v_scope:='t.id=ANY($1)';
 WHEN p_relation='union_settlement_floor' THEN v_scope:='t.union_id=ANY($1)';
 WHEN p_relation='credit_invoices' THEN v_scope:='EXISTS(SELECT 1 FROM public.agents a WHERE a.id=t.agent_id AND a.club_id=ANY($1))';
 WHEN p_relation='club_member_table_state' THEN v_scope:='EXISTS(SELECT 1 FROM public.tables x WHERE x.id=t.table_id AND x.club_id=ANY($1))';
 ELSE RAISE EXCEPTION 'launch_accounting_unknown_store: %',p_relation USING ERRCODE='22023';
 END CASE;
 SELECT string_agg(format('t.%I',a.attname),',' ORDER BY k.ord) INTO v_keys
 FROM pg_index i CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY k(attnum,ord)
 JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.attnum
 WHERE i.indrelid=format('public.%I',p_relation)::regclass AND i.indisprimary;
 IF v_keys IS NULL THEN RAISE EXCEPTION 'launch_accounting_store_has_no_primary_key: %',p_relation; END IF;
 v_value:=CASE WHEN p_columns IS NULL THEN 'to_jsonb(t)' ELSE '(SELECT jsonb_object_agg(e.key,e.value) FROM jsonb_each(to_jsonb(t))e WHERE e.key=ANY($2))' END;
 RETURN format('SELECT jsonb_build_array(%s)::text AS row_key,%s AS row_image FROM public.%I t WHERE %s',v_keys,v_value,p_relation,v_scope);
END $$;
REVOKE ALL ON FUNCTION public.fn_ca_launch_accounting_store_query(text,text[]) FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.fn_ca_launch_accounting_store_rows(p_relation text,p_clubs uuid[],p_columns text[] DEFAULT NULL) RETURNS TABLE(row_key text,row_image jsonb)
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN RETURN QUERY EXECUTE public.fn_ca_launch_accounting_store_query(p_relation,p_columns) USING p_clubs,p_columns; END $$;
REVOKE ALL ON FUNCTION public.fn_ca_launch_accounting_store_rows(text,uuid[],text[]) FROM PUBLIC,anon,authenticated,service_role;
CREATE TABLE club_members(club_id uuid,user_id uuid,credit_used numeric,display_name text,PRIMARY KEY(club_id,user_id));
INSERT INTO club_members VALUES('a0000000-0000-0000-0000-000000000001','60000000-0000-0000-0000-000000000001',23.45,'literal $() quotation'),('a0000000-0000-0000-0000-000000000002','60000000-0000-0000-0000-000000000002',99,'outside');
DO $$ BEGIN
 IF (SELECT count(*) FROM fn_ca_launch_accounting_store_rows('club_members',ARRAY['a0000000-0000-0000-0000-000000000001'::uuid],NULL))<>1 THEN RAISE EXCEPTION 'set row scope failed'; END IF;
 IF (SELECT row_image FROM fn_ca_launch_accounting_store_rows('club_members',ARRAY['a0000000-0000-0000-0000-000000000001'::uuid],ARRAY['credit_used'])) IS DISTINCT FROM '{"credit_used":23.45}'::jsonb THEN RAISE EXCEPTION 'owned field set failed'; END IF;
END $$;

DO $$ BEGIN BEGIN UPDATE ca_launch_accounting_boundaries SET cutoff_at=cutoff_at+interval '1 day'; RAISE EXCEPTION 'cutoff rewrite admitted'; EXCEPTION WHEN check_violation THEN NULL; END; BEGIN DELETE FROM ca_launch_accounting_boundaries; RAISE EXCEPTION 'boundary delete admitted'; EXCEPTION WHEN check_violation THEN NULL; END; END $$;

CREATE ROLE postgres;CREATE SCHEMA auth;
CREATE FUNCTION auth.role() RETURNS text
    LANGUAGE sql STABLE
    AS $$
  select 
  coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
  )::text
$$;
CREATE FUNCTION auth.uid() RETURNS uuid
    LANGUAGE sql STABLE
    AS $$
  select 
  coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;
CREATE TABLE public.engine_maintenance_break (
    id boolean DEFAULT true NOT NULL,
    phase text NOT NULL,
    announced_at timestamp with time zone DEFAULT now() NOT NULL,
    break_started_at timestamp with time zone,
    break_ends_at timestamp with time zone,
    reason text DEFAULT 'Scheduled Engine Maintenance'::text NOT NULL,
    declared_by text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    enforce_freeze boolean DEFAULT false NOT NULL,
    ownership_token uuid NOT NULL,
    CONSTRAINT counting_down_has_an_end CHECK (((phase <> 'counting_down'::text) OR (break_ends_at IS NOT NULL))),
    CONSTRAINT engine_maintenance_break_id_check CHECK (id),
    CONSTRAINT engine_maintenance_break_phase_check CHECK ((phase = ANY (ARRAY['last_hand'::text, 'counting_down'::text])))
);
CREATE TABLE public.engine_maintenance_thaws (
    freeze_started_at timestamp with time zone NOT NULL,
    thawed_at timestamp with time zone DEFAULT now() NOT NULL,
    frozen_seconds numeric NOT NULL,
    shifted jsonb NOT NULL,
    thawed_by text,
    announced_at timestamp with time zone,
    ownership_token uuid,
    contract_version integer,
    release_target_at timestamp with time zone,
    release_generation integer DEFAULT 0 NOT NULL
);
CREATE FUNCTION public.fn_caller_is_engine() RETURNS boolean
    LANGUAGE sql STABLE
    SET search_path TO 'pg_catalog', 'public', 'auth'
    AS $$
  -- The engine and every server-side job authenticate as service_role. A NULL
  -- means there is no PostgREST request context at all - psql, pg_cron, a
  -- migration - which is equally trusted. A browser can never produce NULL:
  -- reaching `authenticated` requires a verified JWT and PostgREST always sets
  -- request.jwt.claims from it.
  --
  -- NOT current_user. Inside a SECURITY DEFINER body current_user is the
  -- function OWNER for the browser and the engine alike, which is what made an
  -- earlier guard on club_members a silent no-op.
  SELECT COALESCE(auth.role(), 'service_role') = 'service_role';
$$;
CREATE FUNCTION public.fn_active_maintenance_release_boundary() RETURNS timestamp with time zone
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'auth', 'pg_temp'
    AS $$
DECLARE
  c_required_steps CONSTANT text[] := ARRAY[
    'sit_out_at','hold_expires_at','addon_period_ends_at','reversible_until',
    'reveal_deadline_at','rebuy_prompt_until','bomb_pot_next_due_at',
    'cash_stay_last_tick_at','cash_rejoin_expires_at','level_started_at',
    'cluster_break_eligible_since','cluster_move_expires_at',
    'reconnect_presence','reconnect_snapshots'
  ];
  v_request_role text := NULLIF(btrim(COALESCE(auth.role(), '')), '');
  v_trusted_database_actor boolean;
  v_release_target timestamptz;
BEGIN
  -- supabase_auth_admin added 2026-09-10: it is GoTrue's own database role
  -- (the signup triggers run as it), never a browser. Without it every signup
  -- wallet trigger raised 42501 here (signup_errors id 9318).
  SELECT session_user IN ('postgres', 'supabase_admin', 'service_role', 'supabase_auth_admin')
         OR COALESCE(r.rolsuper, false)
         -- Supabase CLI session roles may SET ROLE postgres. Trust that
         -- catalog privilege, never a login-name prefix or a JWT workaround.
         OR pg_catalog.pg_has_role(session_user, 'postgres', 'SET')
    INTO v_trusted_database_actor
    FROM (SELECT session_user AS role_name) s
    LEFT JOIN pg_catalog.pg_roles r ON r.rolname = s.role_name;

  IF v_request_role IS NOT NULL
     AND v_request_role NOT IN ('anon', 'authenticated', 'service_role') THEN
    RAISE EXCEPTION 'MAINTENANCE_RELEASE_CERTIFICATE_CALLER_REFUSED'
      USING ERRCODE = '42501';
  END IF;
  IF v_request_role IS NULL AND NOT COALESCE(v_trusted_database_actor, false) THEN
    RAISE EXCEPTION 'MAINTENANCE_RELEASE_CERTIFICATE_CALLER_REQUIRED'
      USING ERRCODE = '42501';
  END IF;

  -- PERF (2026-09-10, swarm A): OFFSET 0 is an optimisation fence. Without it
  -- the planner evaluated `shifted ?& c_required_steps` first on every row of
  -- engine_maintenance_thaws (167 rows, 0 of them contract_version 3) on every
  -- money write that reaches fn_platform_frozen: 229 us -> 32 us per call.
  -- Same four quals, same max(); the jsonb quals now only see rows that already
  -- passed contract_version = 3 AND release_target_at > clock_timestamp().
  SELECT max(t.release_target_at) INTO v_release_target
    FROM (SELECT t.release_target_at, t.shifted
            FROM public.engine_maintenance_thaws t
           WHERE t.contract_version = 3
             AND t.release_target_at > clock_timestamp()
          OFFSET 0) t
   WHERE COALESCE((t.shifted->>'complete')::boolean, false)
     AND t.shifted ?& c_required_steps;
  RETURN v_release_target;
END;
$$;
CREATE FUNCTION public.fn_platform_frozen() RETURNS boolean
    LANGUAGE sql
    SET search_path TO 'public', 'pg_temp'
    AS $$
  SELECT EXISTS (
           SELECT 1
             FROM public.engine_maintenance_break b
            WHERE b.enforce_freeze
              AND b.announced_at < clock_timestamp() + INTERVAL '30 seconds'
              AND (
                (
                  b.phase = 'last_hand'
                  AND b.break_started_at IS NULL
                  AND b.break_ends_at IS NULL
                  AND b.announced_at + INTERVAL '2 minutes' <= clock_timestamp()
                )
                OR (
                  b.phase = 'counting_down'
                  AND b.break_started_at IS NOT NULL
                  AND b.break_ends_at IS NOT NULL
                  AND b.break_started_at >= b.announced_at
                  AND b.break_ends_at > b.break_started_at
                  AND b.break_ends_at < b.announced_at + INTERVAL '15 minutes'
                )
              )
         )
         OR COALESCE(
           public.fn_active_maintenance_release_boundary() > clock_timestamp(),
           false
         );
$$;
CREATE FUNCTION public.fn_sync_profile_total_hands() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_user uuid := COALESCE(NEW.user_id, OLD.user_id);
BEGIN
  IF v_user IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  /* A WRITE THAT LEAVES hands_played WHERE IT WAS DOES NOT TOUCH THE PROFILE
     (2026-10-01). The trigger fires for every UPDATE that names the column,
     and a tournament's rake recognition names it with +0 for every entrant
     (apply_rakeback_player_stats(..., 0, ...)): the sum below cannot move,
     but its UPDATE locked each entrant's profile row, in club order, while
     the horse claims hold profile rows in claim order - and the two
     deadlocked. The same player and the same count leave the same sum. */
  IF TG_OP = 'UPDATE' AND NEW.user_id IS NOT DISTINCT FROM OLD.user_id
     AND NEW.hands_played IS NOT DISTINCT FROM OLD.hands_played THEN
    RETURN NEW;
  END IF;

  /* Recomputed from the table rather than incremented. An increment has to be
     right on every path - insert, update, delete, and the upsert the
     achievement engine uses - and being wrong once is permanent. A SUM over a
     handful of club rows for one player is cheap and cannot drift. */
  UPDATE public.profiles p
     SET total_hands_played = COALESCE((
           SELECT sum(s.hands_played) FROM public.player_stats s WHERE s.user_id = v_user
         ), 0)
   WHERE p.id = v_user;

  RETURN COALESCE(NEW, OLD);
END;
$$;
DO $guard$ BEGIN IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='fn_sync_profile_total_hands' AND md5(p.prosrc)='854fb2b0de27d71e76146fa6dbf7213d')<>1 THEN RAISE EXCEPTION 'launch_boundary_source_changed: fn_sync_profile_total_hands'; END IF; END $guard$;
CREATE OR REPLACE FUNCTION public.fn_sync_profile_total_hands() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_user uuid := COALESCE(NEW.user_id, OLD.user_id);
BEGIN
  IF public.fn_ca_launch_accounting_actor(COALESCE(NEW.club_id,OLD.club_id)) THEN RETURN COALESCE(NEW,OLD); END IF;
  IF v_user IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  /* A WRITE THAT LEAVES hands_played WHERE IT WAS DOES NOT TOUCH THE PROFILE
     (2026-10-01). The trigger fires for every UPDATE that names the column,
     and a tournament's rake recognition names it with +0 for every entrant
     (apply_rakeback_player_stats(..., 0, ...)): the sum below cannot move,
     but its UPDATE locked each entrant's profile row, in club order, while
     the horse claims hold profile rows in claim order - and the two
     deadlocked. The same player and the same count leave the same sum. */
  IF TG_OP = 'UPDATE' AND NEW.user_id IS NOT DISTINCT FROM OLD.user_id
     AND NEW.hands_played IS NOT DISTINCT FROM OLD.hands_played THEN
    RETURN NEW;
  END IF;

  /* Recomputed from the table rather than incremented. An increment has to be
     right on every path - insert, update, delete, and the upsert the
     achievement engine uses - and being wrong once is permanent. A SUM over a
     handful of club rows for one player is cheap and cannot drift. */
  UPDATE public.profiles p
     SET total_hands_played = COALESCE((
           SELECT sum(s.hands_played) FROM public.player_stats s WHERE s.user_id = v_user
         ), 0) + COALESCE((SELECT CASE WHEN o.state='executed' THEN b.hand_offset ELSE b.hand_offset-b.restored_scope_hands END FROM public.ca_launch_profile_hand_baselines b
            JOIN public.ca_launch_reset_operations o ON o.operation_id=b.operation_id
            WHERE b.user_id=v_user AND o.state IN('executed','undone') ORDER BY b.captured_at DESC,b.operation_id DESC LIMIT 1),0)
   WHERE p.id = v_user;

  RETURN COALESCE(NEW, OLD);
END;
$$;


CREATE TABLE ca_launch_reset_operations(operation_id uuid PRIMARY KEY,scoped_club_ids uuid[] NOT NULL,captured_at timestamptz NOT NULL,state text NOT NULL);
ALTER TABLE profiles ADD COLUMN total_hands_played bigint;
CREATE TRIGGER native_profile_hand_count AFTER INSERT OR DELETE OR UPDATE OF hands_played,user_id ON player_stats FOR EACH ROW EXECUTE FUNCTION fn_sync_profile_total_hands();
INSERT INTO engine_maintenance_break(phase,announced_at,break_started_at,break_ends_at,enforce_freeze,ownership_token) VALUES('counting_down',clock_timestamp()-interval '3 minutes',clock_timestamp()-interval '1 minute',clock_timestamp()+interval '2 minutes',true,gen_random_uuid());
BEGIN;
INSERT INTO player_stats(user_id,club_id,hands_played) VALUES('f1000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000001',100),('f1000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000002',50);
INSERT INTO profiles(id,total_hands_played) VALUES('f1000000-0000-0000-0000-000000000001',200);
INSERT INTO ca_launch_reset_operations VALUES('f2000000-0000-0000-0000-000000000001',ARRAY['a0000000-0000-0000-0000-000000000001'::uuid],now(),'captured');
INSERT INTO ca_launch_profile_hand_baselines(operation_id,user_id,hand_offset,captured_total_hands,remaining_club_hands,restored_scope_hands,captured_at) VALUES('f2000000-0000-0000-0000-000000000001','f1000000-0000-0000-0000-000000000001',150,200,50,100,now());
SET LOCAL app.launch_reset_operation='f2000000-0000-0000-0000-000000000001';
DELETE FROM player_stats WHERE user_id='f1000000-0000-0000-0000-000000000001' AND club_id='a0000000-0000-0000-0000-000000000001';
DO $$ BEGIN IF (SELECT total_hands_played FROM profiles WHERE id='f1000000-0000-0000-0000-000000000001')<>200 THEN RAISE EXCEPTION 'reset changed global hands'; END IF; END $$;
UPDATE ca_launch_reset_operations SET state='executed';SET LOCAL app.launch_reset_operation='';SAVEPOINT future_play;
INSERT INTO player_stats(user_id,club_id,hands_played) VALUES('f1000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000001',1);
DO $$ BEGIN IF (SELECT total_hands_played FROM profiles WHERE id='f1000000-0000-0000-0000-000000000001')<>201 THEN RAISE EXCEPTION 'first new hand lost global history'; END IF; END $$;
UPDATE player_stats SET hands_played=2 WHERE user_id='f1000000-0000-0000-0000-000000000001' AND club_id='a0000000-0000-0000-0000-000000000001';
DO $$ BEGIN IF (SELECT total_hands_played FROM profiles WHERE id='f1000000-0000-0000-0000-000000000001')<>202 THEN RAISE EXCEPTION 'later new hand lost global history'; END IF; END $$;
ROLLBACK TO SAVEPOINT future_play;SET LOCAL app.launch_reset_operation='f2000000-0000-0000-0000-000000000001';
INSERT INTO player_stats(user_id,club_id,hands_played) VALUES('f1000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000001',100);
DO $$ BEGIN IF (SELECT total_hands_played FROM profiles WHERE id='f1000000-0000-0000-0000-000000000001')<>200 THEN RAISE EXCEPTION 'guarded restore changed global hands'; END IF; END $$;
UPDATE ca_launch_reset_operations SET state='undone';SET LOCAL app.launch_reset_operation='';
UPDATE player_stats SET hands_played=101 WHERE user_id='f1000000-0000-0000-0000-000000000001' AND club_id='a0000000-0000-0000-0000-000000000001';
DO $$ BEGIN IF (SELECT total_hands_played FROM profiles WHERE id='f1000000-0000-0000-0000-000000000001')<>201 THEN RAISE EXCEPTION 'first hand after undo lost legacy global history'; END IF; END $$;
ROLLBACK;

ALTER TABLE unions ADD COLUMN owner_id uuid;ALTER TABLE clubs ADD COLUMN owner_id uuid;ALTER TABLE clubs ADD COLUMN is_union boolean DEFAULT false;
ALTER TABLE club_members ADD COLUMN role text;ALTER TABLE club_members ADD COLUMN status text;
CREATE TABLE union_admins(union_id uuid,user_id uuid);
ALTER TABLE rake_records ADD COLUMN club_id uuid;ALTER TABLE rake_records ADD COLUMN hand_id uuid;ALTER TABLE rake_records ADD COLUMN table_id uuid;ALTER TABLE rake_records ADD COLUMN metadata jsonb DEFAULT '{}';ALTER TABLE rake_records ADD COLUMN rake_amount numeric DEFAULT 0;
CREATE TABLE public.accounting_cash_accrual_batches (
    rake_record_id uuid NOT NULL,
    hand_id uuid NOT NULL,
    earned_at timestamp with time zone NOT NULL,
    source_fingerprint text NOT NULL,
    status text NOT NULL,
    plan jsonb,
    recorded_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT accounting_cash_accrual_batches_check CHECK (((status = 'accrued'::text) = (plan IS NOT NULL))),
    CONSTRAINT accounting_cash_accrual_batches_status_check CHECK ((status = ANY (ARRAY['accrued'::text, 'legacy_unverified'::text])))
);
CREATE FUNCTION public.fn_union_overseer_of_record(p_union_id uuid, p_user_id uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT p_union_id IS NOT NULL AND p_user_id IS NOT NULL AND (
       EXISTS (SELECT 1 FROM public.unions u WHERE u.id = p_union_id AND u.owner_id = p_user_id)
    OR EXISTS (SELECT 1 FROM public.union_admins a WHERE a.union_id = p_union_id AND a.user_id = p_user_id)
    OR EXISTS (SELECT 1 FROM public.clubs c
                WHERE c.id = p_union_id AND COALESCE(c.is_union, false) AND c.owner_id = p_user_id)
    OR EXISTS (SELECT 1 FROM public.club_members m
                WHERE m.club_id = p_union_id AND m.user_id = p_user_id
                  AND m.role IN ('owner','co_owner','admin')
                  AND m.status IN ('active','approved'))
  );
$$;
CREATE FUNCTION public.fn_is_union_overseer(p_union_id uuid, p_user_id uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT p_user_id IS NOT NULL
     AND (public.fn_caller_is_engine() OR auth.uid() IS NOT DISTINCT FROM p_user_id)
     AND public.fn_union_overseer_of_record(p_union_id, p_user_id);
$$;
CREATE FUNCTION public.fn_rake_record_is_ghost_twin(p_hand_id uuid, p_table_id uuid, p_metadata jsonb) RETURNS boolean
    LANGUAGE sql STABLE
    SET search_path TO 'public'
    AS $_$
  /* A null-hand rake_records row is a ghost twin when the same table carries a
     LINKED row for the same GLOBAL hand number. Hand numbers are unique only
     from 1,000,000 up (uq_hand_history_global_hand_number); below that they
     recurred per table before 2026-07-31 and a match proves nothing. */
  SELECT p_hand_id IS NULL
     AND p_table_id IS NOT NULL
     AND COALESCE(p_metadata->>'hand_number', '') ~ '^[0-9]{1,18}$'
     AND (p_metadata->>'hand_number')::bigint >= 1000000
     AND EXISTS (SELECT 1 FROM public.rake_records l
                  WHERE l.table_id = p_table_id AND l.hand_id IS NOT NULL
                    AND l.metadata->>'hand_number' = p_metadata->>'hand_number');
$_$;
CREATE FUNCTION public.fn_assert_cash_commission_period(p_union_id uuid, p_club_id uuid, p_from timestamp with time zone, p_to timestamp with time zone) RETURNS void
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
 IF NOT public.fn_caller_is_engine() AND (auth.uid() IS NULL OR p_union_id IS NULL OR NOT public.fn_is_union_overseer(p_union_id,auth.uid())) THEN RAISE EXCEPTION 'service_role_required' USING ERRCODE='42501'; END IF;
 IF (p_union_id IS NULL)=(p_club_id IS NULL) OR p_from IS NULL OR p_to IS NULL OR p_to<=p_from
 THEN RAISE EXCEPTION 'invalid_cash_commission_scope' USING ERRCODE='22023'; END IF;
 IF EXISTS(SELECT 1 FROM public.rake_records r LEFT JOIN public.accounting_cash_accrual_batches b ON b.rake_record_id=r.id
  WHERE r.created_at>=p_from AND r.created_at<p_to AND r.rake_amount>0 AND NOT COALESCE(r.is_tournament,false) AND r.tournament_id IS NULL
   AND (r.hand_id IS NOT NULL OR NOT public.fn_rake_record_is_ghost_twin(r.hand_id,r.table_id,r.metadata))
   AND ((p_club_id IS NOT NULL AND (r.club_id=p_club_id OR EXISTS(SELECT 1 FROM public.rake_attributions a WHERE a.rake_record_id=r.id AND a.club_id=p_club_id)))
     OR (p_union_id IS NOT NULL AND (r.club_id=p_union_id OR EXISTS(SELECT 1 FROM public.union_clubs c WHERE c.union_id=p_union_id AND c.club_id=r.club_id)
      OR EXISTS(SELECT 1 FROM public.rake_attributions a JOIN public.union_clubs c ON c.club_id=a.club_id WHERE a.rake_record_id=r.id AND c.union_id=p_union_id))))
   AND (b.status IS DISTINCT FROM 'accrued'))
 THEN RAISE EXCEPTION 'cash_commission_earning_evidence_requires_reconciliation' USING ERRCODE='55000'; END IF;
END $$;
INSERT INTO rake_records(id,created_at,club_id,hand_id,rake_amount) VALUES('f3000000-0000-0000-0000-000000000001','2026-10-12 11:59Z','a0000000-0000-0000-0000-000000000001','f4000000-0000-0000-0000-000000000001',3);
DO $$ BEGIN BEGIN PERFORM fn_assert_cash_commission_period(NULL,'a0000000-0000-0000-0000-000000000001','2026-10-12 00:00Z','2026-10-13 00:00Z');RAISE EXCEPTION 'old cash basis failure did not reproduce'; EXCEPTION WHEN SQLSTATE '55000' THEN IF SQLERRM<>'cash_commission_earning_evidence_requires_reconciliation' THEN RAISE;END IF; END;END $$;
DO $guard$ BEGIN IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='fn_assert_cash_commission_period' AND md5(p.prosrc)='526bd0e2919315f0b26f2d4a30e06dec')<>1 THEN RAISE EXCEPTION 'launch_boundary_source_changed: fn_assert_cash_commission_period'; END IF; END $guard$;
CREATE OR REPLACE FUNCTION public.fn_assert_cash_commission_period(p_union_id uuid, p_club_id uuid, p_from timestamp with time zone, p_to timestamp with time zone) RETURNS void
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
 IF NOT public.fn_caller_is_engine() AND (auth.uid() IS NULL OR p_union_id IS NULL OR NOT public.fn_is_union_overseer(p_union_id,auth.uid())) THEN RAISE EXCEPTION 'service_role_required' USING ERRCODE='42501'; END IF;
 IF (p_union_id IS NULL)=(p_club_id IS NULL) OR p_from IS NULL OR p_to IS NULL OR p_to<=p_from
 THEN RAISE EXCEPTION 'invalid_cash_commission_scope' USING ERRCODE='22023'; END IF;
 IF EXISTS(SELECT 1 FROM public.rake_records r LEFT JOIN public.accounting_cash_accrual_batches b ON b.rake_record_id=r.id
  WHERE r.created_at>=p_from AND r.created_at<p_to AND r.rake_amount>0 AND NOT COALESCE(r.is_tournament,false) AND r.tournament_id IS NULL
   AND (r.hand_id IS NOT NULL OR NOT public.fn_rake_record_is_ghost_twin(r.hand_id,r.table_id,r.metadata))
   AND ((p_club_id IS NOT NULL AND (r.club_id=p_club_id OR EXISTS(SELECT 1 FROM public.rake_attributions a WHERE a.rake_record_id=r.id AND a.club_id=p_club_id)))
     OR (p_union_id IS NOT NULL AND (r.club_id=p_union_id OR EXISTS(SELECT 1 FROM public.union_clubs c WHERE c.union_id=p_union_id AND c.club_id=r.club_id)
      OR EXISTS(SELECT 1 FROM public.rake_attributions a JOIN public.union_clubs c ON c.club_id=a.club_id WHERE a.rake_record_id=r.id AND c.union_id=p_union_id))))
   AND public.fn_ca_launch_accounting_accepts(r.club_id,r.created_at)
  AND (b.status IS DISTINCT FROM 'accrued'))
 THEN RAISE EXCEPTION 'cash_commission_earning_evidence_requires_reconciliation' USING ERRCODE='55000'; END IF;
END $$;


SELECT fn_assert_cash_commission_period(NULL,'a0000000-0000-0000-0000-000000000001','2026-10-12 00:00Z','2026-10-13 00:00Z');
INSERT INTO rake_records(id,created_at,club_id,hand_id,rake_amount) VALUES('f3000000-0000-0000-0000-000000000002','2026-10-12 12:01Z','a0000000-0000-0000-0000-000000000001','f4000000-0000-0000-0000-000000000002',4);
DO $$ BEGIN BEGIN PERFORM fn_assert_cash_commission_period(NULL,'a0000000-0000-0000-0000-000000000001','2026-10-12 00:00Z','2026-10-13 00:00Z');RAISE EXCEPTION 'new uncertified cash silently waived'; EXCEPTION WHEN SQLSTATE '55000' THEN IF SQLERRM<>'cash_commission_earning_evidence_requires_reconciliation' THEN RAISE;END IF; END;END $$;
INSERT INTO accounting_cash_accrual_batches(rake_record_id,hand_id,earned_at,source_fingerprint,status,plan) VALUES('f3000000-0000-0000-0000-000000000002','f4000000-0000-0000-0000-000000000002','2026-10-12 12:01Z','native original batch','accrued','{}');
SELECT fn_assert_cash_commission_period(NULL,'a0000000-0000-0000-0000-000000000001','2026-10-12 00:00Z','2026-10-13 00:00Z');

CREATE TABLE native_commission_rows(club_id uuid,created_at timestamptz);
INSERT INTO native_commission_rows VALUES('a0000000-0000-0000-0000-000000000001','2026-10-12 11:59Z');
DO $$ BEGIN IF (SELECT count(*) FROM native_commission_rows ac WHERE ac.created_at>='2026-10-12 00:00Z' AND ac.created_at<'2026-10-13 00:00Z')<>1 OR (SELECT count(*) FROM native_commission_rows ac WHERE ac.created_at>=public.fn_ca_launch_accounting_start('club',ac.club_id,'2026-10-12 00:00Z') AND ac.created_at<'2026-10-13 00:00Z')<>0 THEN RAISE EXCEPTION 'old commission orphan predicate mismatch'; END IF;END $$;
INSERT INTO native_commission_rows VALUES('a0000000-0000-0000-0000-000000000001','2026-10-12 12:01Z');
DO $$ BEGIN IF (SELECT count(*) FROM native_commission_rows ac WHERE ac.created_at>=public.fn_ca_launch_accounting_start('club',ac.club_id,'2026-10-12 00:00Z') AND ac.created_at<'2026-10-13 00:00Z')<>1 THEN RAISE EXCEPTION 'new orphan commission silently waived'; END IF;END $$;

DO $$ BEGIN IF fn_ca_launch_accounting_start('club','a0000000-0000-0000-0000-000000000001',NULL) IS NOT NULL OR fn_ca_launch_accounting_start('club','a0000000-0000-0000-0000-000000000001','-infinity') IS DISTINCT FROM '-infinity'::timestamptz OR fn_ca_launch_accounting_waived('club','a0000000-0000-0000-0000-000000000001','-infinity') THEN RAISE EXCEPTION 'invalid time was converted into launch waiver'; END IF; END $$;
