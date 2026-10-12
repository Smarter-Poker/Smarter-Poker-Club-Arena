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

ALTER TABLE club_members ADD COLUMN joined_at timestamptz DEFAULT now();
ALTER TABLE tables ADD COLUMN IF NOT EXISTS id uuid; ALTER TABLE tables ADD COLUMN union_id uuid; ALTER TABLE tables ADD COLUMN tournament_id uuid;
ALTER TABLE rake_records ADD COLUMN table_id uuid; ALTER TABLE rake_records ADD COLUMN club_id uuid; ALTER TABLE rake_records ADD COLUMN rake_amount numeric DEFAULT 0; ALTER TABLE rake_records ADD COLUMN metadata jsonb DEFAULT '{}'; ALTER TABLE rake_records ADD COLUMN player_contributions jsonb;
ALTER TABLE tournament_players ADD COLUMN registered_at timestamptz; ALTER TABLE tournament_players ADD COLUMN club_id uuid;
ALTER TABLE accounting_tournament_fee_sources ADD COLUMN rake_credit numeric DEFAULT 0;
CREATE TABLE wallet_transactions(id uuid DEFAULT gen_random_uuid(),user_id uuid,table_id uuid,related_entity_id uuid,created_at timestamptz,category text,type text,amount numeric);
CREATE TABLE public.ca_club_player_daily (
    club_id uuid NOT NULL,
    user_id uuid NOT NULL,
    stat_date date NOT NULL,
    cash_net numeric DEFAULT 0 NOT NULL,
    tournament_net numeric DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE public.ca_club_tournament_daily (
    club_id uuid NOT NULL,
    tournament_id uuid NOT NULL,
    stat_date date NOT NULL,
    fee numeric DEFAULT 0 NOT NULL,
    winnings numeric DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
)
WITH (autovacuum_vacuum_scale_factor='0.0', autovacuum_vacuum_threshold='5000', autovacuum_vacuum_insert_scale_factor='0.0', autovacuum_vacuum_insert_threshold='20000', autovacuum_analyze_scale_factor='0.0', autovacuum_analyze_threshold='5000');
CREATE TABLE public.ca_club_tournament_player_daily (
    club_id uuid NOT NULL,
    tournament_id uuid NOT NULL,
    user_id uuid NOT NULL,
    stat_date date NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE public.club_table_daily (
    club_id uuid NOT NULL,
    table_id uuid NOT NULL,
    stat_date date NOT NULL,
    union_id uuid,
    rake numeric DEFAULT 0 NOT NULL,
    hands integer DEFAULT 0 NOT NULL,
    players integer DEFAULT 0 NOT NULL,
    buyins numeric DEFAULT 0 NOT NULL,
    cashouts numeric DEFAULT 0 NOT NULL,
    net numeric DEFAULT 0 NOT NULL,
    source_rows integer DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);
ALTER TABLE ca_club_player_daily ADD PRIMARY KEY(club_id,user_id,stat_date);
ALTER TABLE ca_club_tournament_daily ADD PRIMARY KEY(club_id,tournament_id,stat_date);
ALTER TABLE ca_club_tournament_player_daily ADD PRIMARY KEY(club_id,tournament_id,user_id,stat_date);
ALTER TABLE club_table_daily ADD PRIMARY KEY(club_id,table_id,stat_date);
CREATE FUNCTION public.ca_reporting_tournament_clubs_for_user(p_user_id uuid) RETURNS TABLE(club_id uuid)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT h.club_id
    FROM (
      SELECT DISTINCT ON (uc.union_id) cm.club_id, uc.union_id
        FROM public.club_members cm
        JOIN public.union_clubs uc ON uc.club_id = cm.club_id
       WHERE cm.user_id = p_user_id
       ORDER BY uc.union_id, cm.joined_at ASC NULLS LAST, cm.club_id
    ) h
  UNION
  SELECT cm.club_id
    FROM public.club_members cm
   WHERE cm.user_id = p_user_id
     AND NOT EXISTS (
       SELECT 1 FROM public.union_clubs uc WHERE uc.club_id = cm.club_id
     );
$$;
-- Reporting uses original charge evidence, including the producer manifest before the fee source rows exist.
CREATE FUNCTION public.fn_ca_launch_reporting_fee_credit(p_club uuid,p_record uuid,p_at timestamptz,p_metadata jsonb,p_amount numeric,p_legacy numeric) RETURNS numeric
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE c timestamptz;v_credit numeric;v_total numeric;v_floors numeric;v_cents bigint;v_manifest jsonb;
BEGIN
 c:=public.fn_ca_launch_accounting_cutoff('club',p_club);
 IF c IS NULL THEN RETURN p_legacy; END IF;
 IF public.fn_ca_launch_accounting_accepts(p_club,p_at) IS NOT TRUE THEN RETURN 0; END IF;
 IF EXISTS(SELECT 1 FROM public.accounting_tournament_fee_sources f WHERE f.rake_record_id=p_record) THEN
  SELECT COALESCE(sum(f.rake_credit),0) INTO v_credit FROM public.accounting_tournament_fee_sources f WHERE f.rake_record_id=p_record AND f.club_id=p_club AND public.fn_ca_launch_accounting_accepts(p_club,f.charged_at);
  RETURN v_credit;
 END IF;
 v_manifest:=p_metadata->'accounting_fee_source'->'contributors';
 IF p_metadata->>'accounting_source_version' IS DISTINCT FROM '2' OR jsonb_typeof(v_manifest) IS DISTINCT FROM 'array' OR jsonb_array_length(v_manifest)=0 THEN RETURN 0; END IF;
 -- This is the original producer's largest-remainder allocation, read-only; its financial transaction still validates every contributor.
 v_cents:=(p_amount*100)::bigint;
 SELECT sum((x->>'weight')::numeric) INTO v_total FROM jsonb_array_elements(v_manifest)x;
 IF v_total IS NULL OR v_total<=0 THEN RETURN 0; END IF;
 SELECT sum(floor(v_cents*(x->>'weight')::numeric/v_total)) INTO v_floors FROM jsonb_array_elements(v_manifest)x;
 SELECT COALESCE(sum(cents)/100.0,0) INTO v_credit FROM (
  SELECT x,floor(v_cents*(x->>'weight')::numeric/v_total)+CASE WHEN row_number() OVER(ORDER BY v_cents*(x->>'weight')::numeric/v_total-floor(v_cents*(x->>'weight')::numeric/v_total) DESC,x->>'player_id')<=v_cents-v_floors THEN 1 ELSE 0 END cents FROM jsonb_array_elements(v_manifest)x
 )q WHERE (x->>'club_id')::uuid=p_club AND public.fn_ca_launch_accounting_accepts(p_club,(x->>'charged_at')::timestamptz);
 RETURN v_credit;
END $$;
REVOKE ALL ON FUNCTION public.fn_ca_launch_reporting_fee_credit(uuid,uuid,timestamptz,jsonb,numeric,numeric) FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.fn_ca_launch_reporting_wallet_accepts(p_club uuid,p_at timestamptz,p_category text,p_tournament uuid,p_user uuid) RETURNS boolean
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF public.fn_ca_launch_accounting_cutoff('club',p_club) IS NULL THEN RETURN true; END IF;
 IF public.fn_ca_launch_accounting_accepts(p_club,p_at) IS NOT TRUE THEN RETURN false; END IF;
 IF p_tournament IS NOT NULL AND p_category IN('prize','bounty','prize_reversal','refund') THEN
  RETURN EXISTS(SELECT 1 FROM public.tournaments t WHERE t.id=p_tournament AND public.fn_ca_launch_accounting_accepts(p_club,t.started_at)) OR (p_category='refund' AND EXISTS(SELECT 1 FROM public.tournament_players tp WHERE tp.tournament_id=p_tournament AND tp.user_id=p_user AND public.fn_ca_launch_accounting_accepts(p_club,tp.registered_at)));
 END IF;
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.fn_ca_launch_reporting_wallet_accepts(uuid,timestamptz,text,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.ca_refresh_reporting_rollups_base(p_start date, p_end date) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_start date := LEAST(p_start, p_end);
  v_end date := GREATEST(p_start, p_end);
  v_from timestamptz;
  v_to timestamptz;
  v_players bigint;
  v_tournaments bigint;
  v_participants bigint;
BEGIN
  IF v_start IS NULL OR v_end IS NULL OR v_end - v_start > 400 THEN
    RAISE EXCEPTION 'reporting refresh requires a 0-400 day range';
  END IF;
  PERFORM pg_advisory_xact_lock(918273645);
  v_from := v_start::timestamp AT TIME ZONE 'UTC';
  v_to := (v_end + 1)::timestamp AT TIME ZONE 'UTC';

  DELETE FROM public.ca_club_player_daily WHERE stat_date BETWEEN v_start AND v_end;
  DELETE FROM public.ca_club_tournament_daily WHERE stat_date BETWEEN v_start AND v_end;
  DELETE FROM public.ca_club_tournament_player_daily WHERE stat_date BETWEEN v_start AND v_end;

  WITH home AS MATERIALIZED (
    SELECT DISTINCT ON (uc.union_id, cm.user_id)
           uc.union_id, cm.user_id, cm.club_id
      FROM public.club_members cm
      JOIN public.union_clubs uc ON uc.club_id = cm.club_id
     ORDER BY uc.union_id, cm.user_id, cm.joined_at ASC NULLS LAST, cm.club_id
  ), standalone AS MATERIALIZED (
    SELECT cm.user_id, cm.club_id
      FROM public.club_members cm
     WHERE NOT EXISTS (SELECT 1 FROM public.union_clubs uc WHERE uc.club_id=cm.club_id)
  ), affiliations AS MATERIALIZED (
    SELECT user_id, club_id FROM home
    UNION
    SELECT user_id, club_id FROM standalone
  ), mapped AS MATERIALIZED (
    -- 2026-09-04: cash rows are the ones with a table (buy-in, cash-out,
    -- add-on, rebuy, refund); tournament rows have a tournament and no table
    -- (buy-in, add-on, rebuy, refund, prize, bounty, prize reversal). The sign
    -- is the row's type. This read buy-in/cash-out and buy-in/prize/bounty.
    SELECT 'cash'::text AS kind,wt.user_id,(wt.created_at AT TIME ZONE 'UTC')::date AS stat_date,
           h.club_id,wt.category,wt.type,wt.amount,wt.related_entity_id AS tournament_id
      FROM public.wallet_transactions wt
      JOIN public.tables tb ON tb.id=wt.table_id AND tb.union_id IS NOT NULL
       AND tb.tournament_id IS NULL
      JOIN home h ON h.union_id=tb.union_id AND h.user_id=wt.user_id
     WHERE wt.created_at>=v_from AND wt.created_at<v_to
       AND wt.category IN ('buyin','cashout','addon','rebuy','refund') AND wt.table_id IS NOT NULL
    UNION ALL
    -- standalone tables, which this rollup never read.
    SELECT 'cash',wt.user_id,(wt.created_at AT TIME ZONE 'UTC')::date,
           tb.club_id,wt.category,wt.type,wt.amount,wt.related_entity_id
      FROM public.wallet_transactions wt
      JOIN public.tables tb ON tb.id=wt.table_id AND tb.union_id IS NULL
       AND tb.tournament_id IS NULL AND tb.club_id IS NOT NULL
     WHERE wt.created_at>=v_from AND wt.created_at<v_to
       AND wt.category IN ('buyin','cashout','addon','rebuy','refund') AND wt.table_id IS NOT NULL
    UNION ALL
    SELECT 'tournament',wt.user_id,(wt.created_at AT TIME ZONE 'UTC')::date,
           a.club_id,wt.category,wt.type,wt.amount,wt.related_entity_id
      FROM public.wallet_transactions wt
      JOIN affiliations a ON a.user_id=wt.user_id
     WHERE wt.created_at>=v_from AND wt.created_at<v_to
       AND wt.category IN ('tournament_buyin','prize','bounty','addon','rebuy','refund','prize_reversal')
       AND wt.related_entity_id IS NOT NULL AND wt.table_id IS NULL
  )
  INSERT INTO public.ca_club_player_daily
    (club_id,user_id,stat_date,cash_net,tournament_net,updated_at)
  SELECT m.club_id,m.user_id,m.stat_date,
         SUM(CASE WHEN m.kind='cash'
                  THEN CASE WHEN m.type='credit' THEN m.amount
                            WHEN m.type='debit' THEN -m.amount ELSE 0 END ELSE 0 END),
         SUM(CASE WHEN m.kind='tournament'
                  THEN CASE WHEN m.type='credit' THEN m.amount
                            WHEN m.type='debit' THEN -m.amount ELSE 0 END ELSE 0 END),now()
    FROM mapped m GROUP BY 1,2,3;

  WITH home AS MATERIALIZED (
    SELECT DISTINCT ON (uc.union_id,cm.user_id)
           uc.union_id,cm.user_id,cm.club_id
      FROM public.club_members cm JOIN public.union_clubs uc ON uc.club_id=cm.club_id
     ORDER BY uc.union_id,cm.user_id,cm.joined_at ASC NULLS LAST,cm.club_id
  ), standalone AS MATERIALIZED (
    SELECT cm.user_id,cm.club_id FROM public.club_members cm
     WHERE NOT EXISTS (SELECT 1 FROM public.union_clubs uc WHERE uc.club_id=cm.club_id)
  ), affiliations AS MATERIALIZED (
    SELECT user_id,club_id FROM home UNION SELECT user_id,club_id FROM standalone
  ), wallet_mapped AS MATERIALIZED (
    SELECT a.club_id,wt.related_entity_id AS tournament_id,wt.user_id,
           (wt.created_at AT TIME ZONE 'UTC')::date AS stat_date,
           CASE WHEN wt.type='credit' THEN wt.amount
                WHEN wt.type='debit' THEN -wt.amount ELSE 0 END AS winnings
      FROM public.wallet_transactions wt JOIN affiliations a ON a.user_id=wt.user_id
     WHERE wt.created_at>=v_from AND wt.created_at<v_to
       AND wt.category IN ('tournament_buyin','prize','bounty','addon','rebuy','refund','prize_reversal')
       AND wt.related_entity_id IS NOT NULL AND wt.table_id IS NULL
  ), entrant_totals AS MATERIALIZED (
    SELECT tp.tournament_id,count(*)::numeric AS total_players
      FROM public.tournament_players tp GROUP BY tp.tournament_id
  ), entrant_clubs AS MATERIALIZED (
    SELECT tp.tournament_id,a.club_id,count(*)::numeric AS club_players
      FROM public.tournament_players tp JOIN affiliations a ON a.user_id=tp.user_id
     GROUP BY tp.tournament_id,a.club_id
  ), rake_mapped AS MATERIALIZED (
    SELECT r.tournament_id,(r.created_at AT TIME ZONE 'UTC')::date AS stat_date,
           CASE WHEN r.metadata ? 'user_id' THEN a.club_id ELSE ec.club_id END AS club_id,
           CASE WHEN r.metadata ? 'user_id' THEN r.rake_amount
                ELSE r.rake_amount*ec.club_players/NULLIF(et.total_players,0) END AS fee
      FROM public.rake_records r
      LEFT JOIN affiliations a ON r.metadata ? 'user_id'
       AND a.user_id::text=r.metadata->>'user_id'
      LEFT JOIN entrant_clubs ec ON NOT (r.metadata ? 'user_id')
       AND ec.tournament_id=r.tournament_id
      LEFT JOIN entrant_totals et ON et.tournament_id=r.tournament_id
     WHERE r.created_at>=v_from AND r.created_at<v_to AND r.is_tournament
       AND r.tournament_id IS NOT NULL AND r.rake_amount<>0
  ), combined AS (
    SELECT wm.club_id,wm.tournament_id,wm.stat_date,0::numeric AS fee,
           sum(wm.winnings) AS winnings FROM wallet_mapped wm GROUP BY 1,2,3
    UNION ALL
    SELECT rm.club_id,rm.tournament_id,rm.stat_date,sum(rm.fee),0::numeric
      FROM rake_mapped rm WHERE rm.club_id IS NOT NULL GROUP BY 1,2,3
  )
  INSERT INTO public.ca_club_tournament_daily
    (club_id,tournament_id,stat_date,fee,winnings,updated_at)
  SELECT club_id,tournament_id,stat_date,sum(fee),sum(winnings),now()
    FROM combined GROUP BY 1,2,3;

  WITH home AS MATERIALIZED (
    SELECT DISTINCT ON (uc.union_id,cm.user_id) uc.union_id,cm.user_id,cm.club_id
      FROM public.club_members cm JOIN public.union_clubs uc ON uc.club_id=cm.club_id
     ORDER BY uc.union_id,cm.user_id,cm.joined_at ASC NULLS LAST,cm.club_id
  ), standalone AS MATERIALIZED (
    SELECT cm.user_id,cm.club_id FROM public.club_members cm
     WHERE NOT EXISTS (SELECT 1 FROM public.union_clubs uc WHERE uc.club_id=cm.club_id)
  ), affiliations AS MATERIALIZED (
    SELECT user_id,club_id FROM home UNION SELECT user_id,club_id FROM standalone
  )
  INSERT INTO public.ca_club_tournament_player_daily
    (club_id,tournament_id,user_id,stat_date,updated_at)
  SELECT DISTINCT a.club_id,wt.related_entity_id,wt.user_id,
         (wt.created_at AT TIME ZONE 'UTC')::date,now()
    FROM public.wallet_transactions wt JOIN affiliations a ON a.user_id=wt.user_id
   WHERE wt.created_at>=v_from AND wt.created_at<v_to
     AND wt.category IN ('tournament_buyin','prize','bounty','addon','rebuy','refund','prize_reversal')
     AND wt.related_entity_id IS NOT NULL AND wt.table_id IS NULL;

  SELECT count(*) INTO v_players FROM public.ca_club_player_daily
   WHERE stat_date BETWEEN v_start AND v_end;
  SELECT count(*) INTO v_tournaments FROM public.ca_club_tournament_daily
   WHERE stat_date BETWEEN v_start AND v_end;
  SELECT count(*) INTO v_participants FROM public.ca_club_tournament_player_daily
   WHERE stat_date BETWEEN v_start AND v_end;
  RETURN jsonb_build_object('start',v_start,'end',v_end,'player_facts',v_players,
    'tournament_facts',v_tournaments,'participant_facts',v_participants,
    'refreshed_at',now());
END;
$$;
CREATE FUNCTION public.fn_club_table_daily_refresh_day(p_day date) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $_$
DECLARE
  v_from timestamptz := (p_day::timestamp AT TIME ZONE 'UTC');
  v_to   timestamptz := ((p_day + 1)::timestamp AT TIME ZONE 'UTC');
  v_rows int;
BEGIN
  IF p_day IS NULL OR p_day > (now() AT TIME ZONE 'UTC')::date THEN
    RETURN jsonb_build_object('success', false, 'error', 'day_out_of_range');
  END IF;

  DELETE FROM club_table_daily WHERE stat_date = p_day;

  WITH att AS (
    SELECT DISTINCT ON (cm.user_id, uc.union_id)
           uc.union_id, cm.user_id, cm.club_id
      FROM club_members cm
      JOIN union_clubs uc ON uc.club_id = cm.club_id
     ORDER BY cm.user_id, uc.union_id, cm.joined_at ASC NULLS LAST, cm.club_id
  ),
  rr AS (
    SELECT r.id, r.table_id, r.rake_amount, t.union_id, t.club_id AS table_club,
           e.key AS uid, (e.value)::numeric AS contrib,
           SUM((e.value)::numeric) OVER (PARTITION BY r.id) AS tot
      FROM rake_records r
      JOIN tables t ON t.id = r.table_id AND t.tournament_id IS NULL
      CROSS JOIN LATERAL jsonb_each_text(r.player_contributions) e(key, value)
     WHERE r.created_at >= v_from AND r.created_at < v_to
       AND r.player_contributions IS NOT NULL
       AND r.rake_amount > 0
       AND e.key ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
       AND EXISTS (
         SELECT 1
           FROM jsonb_each_text(CASE WHEN jsonb_typeof(r.player_contributions) = 'object'
                                     THEN r.player_contributions ELSE '{}'::jsonb END) x
          WHERE x.key ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
            AND (CASE WHEN x.value ~ '^-?[0-9]+(\.[0-9]+)?$' THEN x.value::numeric ELSE 0 END) > 0)
    UNION ALL
    -- 2026-09-04: a raked hand with no usable contribution (none recorded,
    -- not an object, no uuid keys, nothing positive) used to vanish from this
    -- rollup: 109 rows and 173.38 chips on the reference club's three days.
    -- It is the table's club's rake and it goes there whole, as one synthetic
    -- row of weight 1 and no player.
    SELECT r.id, r.table_id, r.rake_amount, t.union_id, t.club_id,
           NULL::text, 1::numeric, 1::numeric
      FROM rake_records r
      JOIN tables t ON t.id = r.table_id AND t.tournament_id IS NULL
     WHERE r.created_at >= v_from AND r.created_at < v_to
       AND r.rake_amount > 0
       AND NOT EXISTS (
         SELECT 1
           FROM jsonb_each_text(CASE WHEN jsonb_typeof(r.player_contributions) = 'object'
                                     THEN r.player_contributions ELSE '{}'::jsonb END) e
          WHERE e.key ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
            AND (CASE WHEN e.value ~ '^-?[0-9]+(\.[0-9]+)?$' THEN e.value::numeric ELSE 0 END) > 0)
  ),
  raked AS (
    SELECT COALESCE(a.club_id, rr.table_club) AS club_id,
           rr.table_id,
           rr.union_id,
           SUM(rr.rake_amount * rr.contrib / rr.tot) AS rake,
           COUNT(DISTINCT rr.id)  AS hands,
           COUNT(DISTINCT rr.uid) AS players,
           COUNT(*)               AS src
      FROM rr
      LEFT JOIN att a ON a.user_id::text = rr.uid AND a.union_id IS NOT DISTINCT FROM rr.union_id
     WHERE rr.tot > 0
     GROUP BY 1, 2, 3
  ),
  -- 2026-09-04: a table add-on (a top-up, 'addon'), a rebuy and a refund are
  -- buy-in money too; this read 'buyin' and 'cashout' alone and so put every
  -- top-up (1.76M chips across the platform in 30 days) on the players' side
  -- of the table net. Debits are money onto the table, credits money off it.
  wal AS (
    SELECT COALESCE(a.club_id, t.club_id) AS club_id,
           wt.table_id,
           t.union_id,
           SUM(CASE WHEN wt.type = 'debit'  THEN wt.amount ELSE 0 END) AS buyins,
           SUM(CASE WHEN wt.type = 'credit' THEN wt.amount ELSE 0 END) AS cashouts
      FROM wallet_transactions wt
      JOIN tables t ON t.id = wt.table_id AND t.tournament_id IS NULL
      LEFT JOIN att a ON a.user_id = wt.user_id AND a.union_id IS NOT DISTINCT FROM t.union_id
     WHERE wt.created_at >= v_from AND wt.created_at < v_to
       AND wt.category IN ('buyin', 'cashout', 'addon', 'rebuy', 'refund')
     GROUP BY 1, 2, 3
  ),
  merged AS (
    SELECT COALESCE(k.club_id,  w.club_id)  AS club_id,
           COALESCE(k.table_id, w.table_id) AS table_id,
           COALESCE(k.union_id, w.union_id) AS union_id,
           COALESCE(k.rake, 0)     AS rake,
           COALESCE(k.hands, 0)    AS hands,
           COALESCE(k.players, 0)  AS players,
           COALESCE(k.src, 0)      AS src,
           COALESCE(w.buyins, 0)   AS buyins,
           COALESCE(w.cashouts, 0) AS cashouts
      FROM raked k
      FULL OUTER JOIN wal w
        ON w.club_id = k.club_id AND w.table_id = k.table_id
  )
  INSERT INTO club_table_daily (club_id, table_id, stat_date, union_id,
                                rake, hands, players, buyins, cashouts, net,
                                source_rows, updated_at)
  SELECT m.club_id, m.table_id, p_day, m.union_id,
         round(m.rake, 4), m.hands, m.players,
         round(m.buyins, 2), round(m.cashouts, 2),
         round(m.cashouts - m.buyins, 2),
         m.src, now()
    FROM merged m
   WHERE m.club_id IS NOT NULL AND m.table_id IS NOT NULL;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN jsonb_build_object('success', true, 'day', p_day, 'rows', v_rows);
END;
$_$;
CREATE FUNCTION public.trg_ca_reporting_rake_insert() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE v_day date; r record;
BEGIN
  IF NOT NEW.is_tournament OR NEW.tournament_id IS NULL OR NEW.rake_amount=0
    THEN RETURN NULL; END IF;
  /* SHARED, not exclusive - see trg_ca_reporting_wallet_insert and
     20260906152215. */
  PERFORM pg_advisory_xact_lock_shared(918273645);
  v_day:=(NEW.created_at AT TIME ZONE 'UTC')::date;
  IF NEW.metadata ? 'user_id' THEN
    FOR r IN
      SELECT c.club_id FROM public.tournament_players tp
      CROSS JOIN LATERAL public.ca_reporting_tournament_clubs_for_user(tp.user_id) c
      WHERE tp.tournament_id=NEW.tournament_id
        AND tp.user_id::text=NEW.metadata->>'user_id'
      ORDER BY c.club_id
    LOOP
      INSERT INTO public.ca_club_tournament_daily AS d
        (club_id,tournament_id,stat_date,fee,updated_at)
      VALUES(r.club_id,NEW.tournament_id,v_day,NEW.rake_amount,now())
      ON CONFLICT(club_id,tournament_id,stat_date) DO UPDATE
       SET fee=d.fee+EXCLUDED.fee,updated_at=now();
    END LOOP;
  ELSE
    FOR r IN
      WITH total AS (SELECT count(*)::numeric n FROM public.tournament_players
                      WHERE tournament_id=NEW.tournament_id), mapped AS (
        SELECT c.club_id FROM public.tournament_players tp
        CROSS JOIN LATERAL public.ca_reporting_tournament_clubs_for_user(tp.user_id) c
        WHERE tp.tournament_id=NEW.tournament_id)
      SELECT m.club_id,count(*)::numeric AS club_players,t.n AS total_players
        FROM mapped m CROSS JOIN total t GROUP BY m.club_id,t.n
       ORDER BY m.club_id
    LOOP
      INSERT INTO public.ca_club_tournament_daily AS d
        (club_id,tournament_id,stat_date,fee,updated_at)
      VALUES(r.club_id,NEW.tournament_id,v_day,
             NEW.rake_amount*r.club_players/NULLIF(r.total_players,0),now())
      ON CONFLICT(club_id,tournament_id,stat_date) DO UPDATE
       SET fee=d.fee+EXCLUDED.fee,updated_at=now();
    END LOOP;
  END IF;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Club Data rake rollup failed for row %: %',NEW.id,SQLERRM;
  RETURN NULL;
END;
$$;
CREATE FUNCTION public.trg_ca_reporting_wallet_insert() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_club uuid; v_union uuid; v_table_club uuid; v_is_tournament_table boolean; v_day date;
  v_cash numeric:=0; v_tournament numeric:=0; r record;
BEGIN
  -- 2026-09-04: a table add-on (top-up), a rebuy and a refund move cash-table
  -- money too, and a tournament add-on, rebuy, refund or prize reversal moves
  -- tournament money; this knew buy-in, cash-out, tournament buy-in, prize
  -- and bounty alone. A row with a table is cash; a row with a tournament and
  -- no table is tournament. The sign is the row's own type, never its name.
  IF NOT ((NEW.category IN('buyin','cashout','addon','rebuy','refund') AND NEW.table_id IS NOT NULL)
    OR (NEW.category IN('tournament_buyin','prize','bounty','addon','rebuy','refund','prize_reversal')
        AND NEW.related_entity_id IS NOT NULL AND NEW.table_id IS NULL))
    THEN RETURN NULL; END IF;
  /* SHARED, not exclusive (20260906152215). The exclusive form serialised
     every chip movement on the platform behind one lock and held it to
     commit: 2,731 waits over a second in one day, 2,916 statement timeouts,
     and the deadlock cycles that failed prize credits. Shared holders never
     block each other; only the range rebuilds take the exclusive lock, and
     they still wait for every in-flight trigger before they delete a day. */
  PERFORM pg_advisory_xact_lock_shared(918273645);
  v_day:=(NEW.created_at AT TIME ZONE 'UTC')::date;
  IF NEW.table_id IS NOT NULL THEN
    SELECT t.union_id,t.club_id,(t.tournament_id IS NOT NULL)
      INTO v_union,v_table_club,v_is_tournament_table
      FROM public.tables t WHERE t.id=NEW.table_id;
    IF v_is_tournament_table THEN RETURN NULL; END IF;
    IF v_union IS NULL THEN
      -- A standalone table: the club is the table's club.
      v_club:=v_table_club;
    ELSE
      SELECT cm.club_id INTO v_club FROM public.club_members cm
        JOIN public.union_clubs uc ON uc.club_id=cm.club_id AND uc.union_id=v_union
       WHERE cm.user_id=NEW.user_id
       ORDER BY cm.joined_at ASC NULLS LAST,cm.club_id LIMIT 1;
    END IF;
    v_cash:=CASE WHEN NEW.type='credit' THEN NEW.amount
                 WHEN NEW.type='debit' THEN -NEW.amount ELSE 0 END;
    IF v_club IS NOT NULL THEN
      INSERT INTO public.ca_club_player_daily AS d
        (club_id,user_id,stat_date,cash_net,tournament_net,updated_at)
      VALUES(v_club,NEW.user_id,v_day,v_cash,0,now())
      ON CONFLICT(club_id,user_id,stat_date) DO UPDATE
       SET cash_net=d.cash_net+EXCLUDED.cash_net,updated_at=now();
    END IF;
  ELSE
    v_tournament:=CASE WHEN NEW.type='credit' THEN NEW.amount
                       WHEN NEW.type='debit' THEN -NEW.amount ELSE 0 END;
    /* ORDER BY club_id: two credits to players of the same event upsert the
       shared ca_club_tournament_daily rows in one order, so they wait on each
       other instead of cycling. */
    FOR r IN SELECT c.club_id FROM public.ca_reporting_tournament_clubs_for_user(NEW.user_id) c
              ORDER BY c.club_id LOOP
      INSERT INTO public.ca_club_player_daily AS d
        (club_id,user_id,stat_date,cash_net,tournament_net,updated_at)
      VALUES(r.club_id,NEW.user_id,v_day,0,v_tournament,now())
      ON CONFLICT(club_id,user_id,stat_date) DO UPDATE
       SET tournament_net=d.tournament_net+EXCLUDED.tournament_net,updated_at=now();
      INSERT INTO public.ca_club_tournament_daily AS d
        (club_id,tournament_id,stat_date,winnings,updated_at)
      VALUES(r.club_id,NEW.related_entity_id,v_day,v_tournament,now())
      ON CONFLICT(club_id,tournament_id,stat_date) DO UPDATE
       SET winnings=d.winnings+EXCLUDED.winnings,updated_at=now();
      INSERT INTO public.ca_club_tournament_player_daily
        (club_id,tournament_id,user_id,stat_date,updated_at)
      VALUES(r.club_id,NEW.related_entity_id,NEW.user_id,v_day,now())
      ON CONFLICT(club_id,tournament_id,user_id,stat_date) DO UPDATE SET updated_at=now();
    END LOOP;
  END IF;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Club Data wallet rollup failed for tx %: %',NEW.id,SQLERRM;
  RETURN NULL;
END;
$$;
CREATE FUNCTION public.fn_agent_downline_rake(p_agent_user_id uuid DEFAULT NULL::uuid, p_club_id uuid DEFAULT NULL::uuid, p_since timestamp with time zone DEFAULT NULL::timestamp with time zone, p_until timestamp with time zone DEFAULT NULL::timestamp with time zone, p_search text DEFAULT NULL::text, p_limit integer DEFAULT 500) RETURNS TABLE(player_id uuid, username text, club_id uuid, club_name text, role text, depth integer, upline_user_id uuid, upline_name text, rake_generated numeric, hands bigint, last_hand_at timestamp with time zone, downline_players integer, downline_rake numeric)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
#variable_conflict use_column
DECLARE
  v_root uuid := COALESCE(p_agent_user_id, auth.uid());
  v_from timestamptz := COALESCE(p_since, public.fn_union_week_start(now()));
  v_to   timestamptz := COALESCE(p_until, now());
  v_caller uuid := auth.uid();
  v_today  timestamptz := date_trunc('day', now());
  v_day_lo date;
  v_day_hi date;
  v_head_end   timestamptz;
  v_tail_start timestamptz;
  v_overseer_clubs uuid[];
BEGIN
  IF v_root IS NULL THEN RAISE EXCEPTION 'no_agent'; END IF;

  IF NOT EXISTS (SELECT 1 FROM agents a
                  WHERE a.user_id = v_root AND a.status='active'
                    AND a.role IN ('super_agent','agent','sub_agent')
                    AND (p_club_id IS NULL OR a.club_id = p_club_id)) THEN
    RAISE EXCEPTION 'not_an_agent';
  END IF;

  IF v_caller IS NOT NULL
     AND v_caller <> v_root
     AND NOT public.fn_is_agent_ancestor(v_caller, v_root, p_club_id)
     AND NOT (p_club_id IS NOT NULL AND public.fn_is_club_admin_uid(p_club_id))
  THEN
    -- Only the overseer alternative is scoped here; retain self, ancestor,
    -- explicit club-admin and existing null-caller service behavior above.
    SELECT array_agg(DISTINCT a.club_id) INTO v_overseer_clubs
      FROM agents a
      JOIN union_clubs uc ON uc.club_id = a.club_id
     WHERE a.user_id = v_root AND a.status = 'active'
       AND a.role IN ('super_agent','agent','sub_agent')
       AND (p_club_id IS NULL OR a.club_id = p_club_id)
       AND public.fn_is_union_overseer(uc.union_id, v_caller);
    IF COALESCE(cardinality(v_overseer_clubs), 0) = 0 THEN
      RAISE EXCEPTION 'not_authorised';
    END IF;
  END IF;

  v_day_lo := date_trunc('day', v_from)::date;
  IF date_trunc('day', v_from) < v_from THEN v_day_lo := v_day_lo + 1; END IF;
  v_day_hi := LEAST(date_trunc('day', v_to), v_today)::date;
  IF v_day_hi < v_day_lo THEN v_day_hi := v_day_lo; END IF;

  v_head_end   := LEAST(v_day_lo::timestamptz, v_to);
  v_tail_start := GREATEST(v_day_hi::timestamptz, v_from);

  RETURN QUERY
  WITH RECURSIVE chain AS (
    SELECT a.id, a.user_id, a.club_id, a.role, a.parent_agent_id, 0 AS depth
      FROM agents a
     WHERE a.user_id = v_root AND a.status = 'active'
       AND (p_club_id IS NULL OR a.club_id = p_club_id)
       AND (v_overseer_clubs IS NULL OR a.club_id = ANY(v_overseer_clubs))
    UNION ALL
    SELECT c.id, c.user_id, c.club_id, c.role, c.parent_agent_id, ch.depth + 1
      FROM agents c JOIN chain ch ON c.parent_agent_id = ch.id
     WHERE c.status = 'active'
       AND (v_overseer_clubs IS NULL OR c.club_id = ANY(v_overseer_clubs))
  ),
  roster AS (
    SELECT DISTINCT cm.user_id AS player_id, cm.club_id, cm.agent_id AS upline_user_id,
           ch.depth + 1 AS depth
      FROM club_members cm
      JOIN chain ch ON ch.user_id = cm.agent_id AND ch.club_id = cm.club_id
     WHERE cm.agent_id IS NOT NULL
  ),
  everyone AS MATERIALIZED (
    SELECT player_id, club_id, upline_user_id, depth FROM roster
    UNION
    SELECT ch.user_id, ch.club_id,
           (SELECT p.user_id FROM agents p WHERE p.id = ch.parent_agent_id),
           ch.depth
      FROM chain ch WHERE ch.depth > 0
  ),
  in_scope_clubs AS MATERIALIZED (SELECT DISTINCT club_id FROM everyone),
  ok_days AS MATERIALIZED (
    SELECT rc.club_id, rc.day
      FROM club_rake_rollup_complete rc
      JOIN in_scope_clubs c ON c.club_id = rc.club_id
     WHERE rc.day >= v_day_lo AND rc.day < v_day_hi
  ),
  gap_days AS MATERIALIZED (
    SELECT c.club_id, g::date AS day
      FROM in_scope_clubs c
      CROSS JOIN generate_series(v_day_lo, v_day_hi - 1, interval '1 day') g
     WHERE v_day_hi > v_day_lo
       AND NOT EXISTS (SELECT 1 FROM ok_days o
                        WHERE o.club_id = c.club_id AND o.day = g::date)
  ),
  from_rollup AS (
    SELECT rd.user_id, rd.club_id,
           SUM(rd.rake_amount) AS rake,
           SUM(rd.hands)::bigint AS hands,
           MAX((rd.day + 1)::timestamptz) AS last_at
      FROM club_rake_daily_user rd
      JOIN ok_days o  ON o.club_id = rd.club_id AND o.day = rd.day
      JOIN everyone e ON e.player_id = rd.user_id AND e.club_id = rd.club_id
     GROUP BY rd.user_id, rd.club_id
  ),
  edge_hands AS MATERIALIZED (
    SELECT r.id, r.hand_id, r.club_id, r.created_at, r.rake_amount, r.player_contributions, r.rake_method
      FROM rake_records r
     WHERE r.created_at >= v_from AND r.created_at < v_head_end
       AND r.rake_amount > 0 AND r.player_contributions IS NOT NULL
       AND (p_club_id IS NULL OR r.club_id = p_club_id)
    UNION ALL
    SELECT r.id, r.hand_id, r.club_id, r.created_at, r.rake_amount, r.player_contributions, r.rake_method
      FROM rake_records r
     WHERE r.created_at >= v_tail_start AND r.created_at < v_to
       AND r.rake_amount > 0 AND r.player_contributions IS NOT NULL
       AND (p_club_id IS NULL OR r.club_id = p_club_id)
    UNION ALL
    SELECT r.id, r.hand_id, r.club_id, r.created_at, r.rake_amount, r.player_contributions, r.rake_method
      FROM gap_days gd
      JOIN rake_records r
        ON r.club_id = gd.club_id
       AND r.created_at >= gd.day::timestamptz
       AND r.created_at <  (gd.day + 1)::timestamptz
     WHERE r.rake_amount > 0 AND r.player_contributions IS NOT NULL
  ),
  -- LEDGER-READ (2026-08-29): stored per-player credits when present, the
  -- canonical allocator when not.
  edge_split AS MATERIALIZED (
    SELECT s.user_id, eh.club_id, eh.created_at,
           round(s.credit * 100)::bigint AS cents
      FROM edge_hands eh
      CROSS JOIN LATERAL public.fn_rake_shares_for_record(
        eh.hand_id, eh.rake_amount, eh.player_contributions, COALESCE(eh.rake_method, 'DEALT_EQUAL')
      ) s
  ),
  from_live AS (
    SELECT s.user_id, s.club_id,
           SUM(s.cents)::numeric / 100 AS rake,
           count(*)::bigint AS hands,
           max(s.created_at) AS last_at
      FROM edge_split s
      JOIN everyone e ON e.player_id = s.user_id AND e.club_id = s.club_id
     GROUP BY s.user_id, s.club_id
  ),
  earned AS MATERIALIZED (
    SELECT COALESCE(a.user_id, b.user_id) AS user_id,
           COALESCE(a.club_id, b.club_id) AS club_id,
           COALESCE(a.rake,0) + COALESCE(b.rake,0)   AS rake,
           COALESCE(a.hands,0) + COALESCE(b.hands,0) AS hands,
           GREATEST(COALESCE(a.last_at,'-infinity'::timestamptz),
                    COALESCE(b.last_at,'-infinity'::timestamptz)) AS last_at
      FROM from_rollup a
      FULL OUTER JOIN from_live b ON b.user_id = a.user_id AND b.club_id = a.club_id
  ),
  downline_agg AS MATERIALIZED (
    SELECT cm.agent_id AS upline, cm.club_id, SUM(ea.rake) AS rake
      FROM earned ea
      JOIN club_members cm ON cm.user_id = ea.user_id AND cm.club_id = ea.club_id
     WHERE cm.agent_id IS NOT NULL
     GROUP BY cm.agent_id, cm.club_id
  ),
  downline_cnt AS MATERIALIZED (
    SELECT cm.agent_id AS upline, cm.club_id, count(*)::int AS players
      FROM club_members cm
     WHERE cm.agent_id IN (SELECT player_id FROM everyone)
     GROUP BY cm.agent_id, cm.club_id
  )
  SELECT e.player_id,
         COALESCE(public.fn_arena_name(pr.alias, pr.username, pr.display_name, pr.first_name, pr.last_name, pr.full_name), pr.username, left(e.player_id::text, 8)),
         e.club_id, cl.name,
         COALESCE(ag.role, 'player'),
         e.depth, e.upline_user_id,
         COALESCE(public.fn_arena_name(up.alias, up.username, up.display_name, up.first_name, up.last_name, up.full_name), up.username),
         COALESCE(ea.rake, 0), COALESCE(ea.hands, 0),
         NULLIF(ea.last_at, '-infinity'::timestamptz),
         COALESCE(dc.players, 0), COALESCE(da.rake, 0)
    FROM everyone e
    LEFT JOIN earned ea       ON ea.user_id = e.player_id AND ea.club_id = e.club_id
    LEFT JOIN downline_agg da ON da.upline  = e.player_id AND da.club_id = e.club_id
    LEFT JOIN downline_cnt dc ON dc.upline  = e.player_id AND dc.club_id = e.club_id
    LEFT JOIN profiles pr ON pr.id = e.player_id
    LEFT JOIN profiles up ON up.id = e.upline_user_id
    LEFT JOIN clubs cl    ON cl.id = e.club_id
    LEFT JOIN agents ag   ON ag.user_id = e.player_id AND ag.club_id = e.club_id
                         AND ag.status = 'active'
   WHERE (p_search IS NULL OR p_search = ''
          OR COALESCE(public.fn_arena_name(pr.alias, pr.username, pr.display_name, pr.first_name, pr.last_name, pr.full_name), pr.username, '') ILIKE '%' || p_search || '%')
   ORDER BY COALESCE(ea.rake, 0) DESC
   LIMIT GREATEST(COALESCE(p_limit, 500), 1);
END $$;
CREATE FUNCTION public.fn_ca_rake_by_agent(p_club_id uuid, p_start date, p_end date, p_limit integer, p_offset integer DEFAULT 0, p_search text DEFAULT NULL::text, p_sort text DEFAULT 'rake'::text) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_now  timestamptz := now();
  v_from timestamptz := p_start::timestamptz;
  v_to   timestamptz := LEAST((p_end + 1)::timestamptz, v_now);
  v_uid  uuid    := auth.uid();
  v_cost boolean := public.fn_is_club_admin_uid(p_club_id);
  v_over boolean := EXISTS (SELECT 1 FROM public.union_clubs uc
                             WHERE uc.club_id = p_club_id
                               AND public.fn_is_union_overseer(uc.union_id, v_uid));
  v_q    text := NULLIF(btrim(COALESCE(p_search,'')),'');
  v_sort text := lower(COALESCE(NULLIF(btrim(p_sort),''),'rake'));
  v_out  jsonb;
BEGIN
  IF v_to <= v_from THEN
    RETURN jsonb_build_object('rows','[]'::jsonb,'total',0,'total_direct',0,'total_commission',NULL);
  END IF;

  WITH RECURSIVE ok_days AS MATERIALIZED (
    SELECT rc.day FROM public.club_rake_rollup_complete rc
     WHERE rc.club_id = p_club_id
       AND rc.day >= date_trunc('day', v_from)::date
       AND rc.day <  date_trunc('day', v_to)::date
  ), from_rollup AS (
    SELECT rd.user_id, SUM(rd.rake_amount) AS rake, SUM(rd.hands)::bigint AS hands
      FROM public.club_rake_daily_user rd
      JOIN ok_days o ON o.day = rd.day
     WHERE rd.club_id = p_club_id
     GROUP BY rd.user_id
  ), from_live AS (
    -- THE DAYS NOT YET SEALED, read from the incremental rollup the triggers
    -- on rake_attributions keep exact. This used to scan the attributions
    -- themselves, which is fine at 04:00 and a third of a million rows by
    -- midnight - the panel healed every morning and failed every evening.
    -- Same cents, same rounding, same source table as the sealed days.
    SELECT du.user_id,
           du.rake_cents::numeric / 100 AS rake,
           du.hands
      FROM public.ca_club_rake_daily_user du
     WHERE du.club_id = p_club_id
       AND du.day >= date_trunc('day', v_from)::date
       -- A DAY IS IN RANGE WHEN ITS OWN MIDNIGHT IS BEFORE THE EXCLUSIVE END,
       -- never `<= date_trunc('day', v_to)`. v_to is either a midnight (ask
       -- for a range ending yesterday and it is TODAY's midnight) or now()
       -- itself (ask for a range ending today). The inclusive form got the
       -- second case right and the first case wrong, and put TODAY's rake into
       -- a report for YESTERDAY. Caught by comparing old against new under one
       -- snapshot before this shipped; four ranges agreed and that one did not.
       AND du.day::timestamptz < v_to
       AND NOT EXISTS (SELECT 1 FROM ok_days o WHERE o.day = du.day)
  ), earned AS MATERIALIZED (
    SELECT COALESCE(a.user_id,b.user_id) AS user_id,
           COALESCE(a.rake,0)+COALESCE(b.rake,0)   AS rake,
           COALESCE(a.hands,0)+COALESCE(b.hands,0) AS hands
      FROM from_rollup a FULL OUTER JOIN from_live b ON b.user_id = a.user_id
  ), paid_cut AS MATERIALIZED (
    -- EVERY INSTANT IN [v_from, v_to) AT WHICH "PAID" CAN CHANGE, AND v_from.
    -- fn_agent_commission_paid_by_period is SELECT EXISTS (...), and a SQL
    -- body with a sublink is never inlined, so asking it inside the FILTERs
    -- below made it a function call, twice for every open commission row in
    -- the range: 4,024,562 calls and 42 s for SHARK CLUB's month. For any
    -- agent the answer can only change where one of this club's paid periods
    -- starts or ends. Between two consecutive cuts it is constant, so it is
    -- asked once per stretch, at the stretch's first instant.
    SELECT v_from AS cut
    UNION
    SELECT s.period_start FROM public.agent_commission_settlements s
     WHERE s.club_id = p_club_id AND s.period_start > v_from AND s.period_start < v_to
    UNION
    SELECT s.period_end FROM public.agent_commission_settlements s
     WHERE s.club_id = p_club_id AND s.period_end > v_from AND s.period_end < v_to
  ), stretch AS MATERIALIZED (
    -- [lo, hi) stretches that tile [v_from, v_to) exactly: no gap, no overlap.
    SELECT c.cut AS lo, COALESCE(lead(c.cut) OVER (ORDER BY c.cut), v_to) AS hi
      FROM paid_cut c
  ), commission_part AS (
    -- One range read of idx_agent_commissions_club_created per stretch, summed
    -- per (agent, own settled_at set or not). No function call per row. The
    -- half-open window of fn_club_commission_accrued (>= since, < until) is
    -- stated outright as well: the stretches tile it exactly, so it removes
    -- nothing, and no stretch can ever widen what is summed.
    SELECT st.lo, x.user_id, x.open, x.amount
      FROM stretch st
      CROSS JOIN LATERAL (
        SELECT ac.user_id, ac.settled_at IS NULL AS open, SUM(ac.amount) AS amount
          FROM public.agent_commissions ac
         WHERE ac.club_id = p_club_id
           AND ac.created_at >= v_from AND ac.created_at < v_to
           AND ac.created_at >= st.lo AND ac.created_at < st.hi
         GROUP BY ac.user_id, ac.settled_at IS NULL) x
  ), commission AS (
    -- The same predicate and the same two FILTERs, asked once per stretch.
    -- Every sum covers exactly the rows it did (numeric addition is exact and
    -- keeps the largest input scale), and is NULL exactly when it was.
    SELECT cp.user_id,
           SUM(cp.amount)                                          AS earned,
           SUM(cp.amount) FILTER (WHERE cp.open AND NOT public.fn_agent_commission_paid_by_period(p_club_id, cp.user_id, cp.lo)) AS outstanding,
           SUM(cp.amount) FILTER (WHERE NOT cp.open OR public.fn_agent_commission_paid_by_period(p_club_id, cp.user_id, cp.lo)) AS settled
      FROM commission_part cp
     GROUP BY cp.user_id
  ), club_agents AS (
    SELECT a.id, a.user_id, a.parent_agent_id, a.role, a.commission_rate
      FROM public.agents a WHERE a.club_id = p_club_id AND a.status='active'
  ), direct AS (
    SELECT cm.agent_id, COUNT(*) AS players,
           COUNT(*) FILTER (WHERE COALESCE(e.rake,0) <> 0) AS active,
           COALESCE(SUM(e.rake),0) AS rake, COALESCE(SUM(e.hands),0)::bigint AS hands
      FROM public.club_members cm
      LEFT JOIN earned e ON e.user_id = cm.user_id
     WHERE cm.club_id = p_club_id
     GROUP BY cm.agent_id
  ), tree AS (
    SELECT ca.id AS root_id, ca.id AS node_id, 0 AS depth FROM club_agents ca
    UNION ALL
    SELECT t.root_id, c.id, t.depth+1
      FROM tree t JOIN club_agents c ON c.parent_agent_id = t.node_id
     WHERE t.depth < 12
  ), network AS (
    SELECT t.root_id, COALESCE(SUM(d.rake),0) AS rake,
           COALESCE(SUM(d.players),0) AS players,
           COUNT(*) FILTER (WHERE t.node_id <> t.root_id) AS sub_agents
      FROM (SELECT DISTINCT root_id, node_id FROM tree) t
      JOIN club_agents n ON n.id = t.node_id
      LEFT JOIN direct d ON d.agent_id = n.user_id
     GROUP BY t.root_id
  ), unlisted AS (
    SELECT SUM(cs.earned) AS earned, SUM(cs.outstanding) AS outstanding,
           SUM(cs.settled) AS settled, count(*)::int AS recipients
      FROM commission cs
     WHERE NOT EXISTS (SELECT 1 FROM club_agents ca WHERE ca.user_id = cs.user_id)
  ), listed AS (
    SELECT ca.user_id AS agent_user_id,
           COALESCE(public.fn_arena_name(pr.alias, pr.username, pr.display_name,
                                         pr.first_name, pr.last_name, pr.full_name),
                    pr.username, 'Agent') AS name,
           pr.avatar_url, ca.role, ca.commission_rate,
           COALESCE(dr.players,0) AS direct_players,
           COALESCE(dr.active,0)  AS direct_active,
           round(COALESCE(dr.rake,0),2) AS direct_rake,
           COALESCE(dr.hands,0) AS direct_hands,
           COALESCE(nw.players,0) AS network_players,
           round(COALESCE(nw.rake,0),2) AS network_rake,
           COALESCE(nw.sub_agents,0) AS sub_agents,
           CASE WHEN v_cost THEN round(COALESCE(cs.earned,0),2)      END AS commission_earned,
           CASE WHEN v_cost THEN round(COALESCE(cs.outstanding,0),2) END AS commission_outstanding,
           CASE WHEN v_cost THEN round(COALESCE(cs.settled,0),2)     END AS commission_settled,
           -- The same three conditions the downline walker enforces.
           (v_cost OR v_over OR ca.user_id = v_uid
            OR public.fn_is_agent_ancestor(v_uid, ca.user_id, p_club_id)) AS can_drill,
           false AS is_unassigned, false AS is_residual
      FROM club_agents ca
      LEFT JOIN direct dr ON dr.agent_id = ca.user_id
      LEFT JOIN network nw ON nw.root_id = ca.id
      LEFT JOIN commission cs ON cs.user_id = ca.user_id
      LEFT JOIN public.profiles pr ON pr.id = ca.user_id
    UNION ALL
    SELECT NULL,'Unassigned',NULL,'none',NULL,
           d.players,d.active,round(d.rake,2),d.hands,
           d.players,round(d.rake,2),0,
           CASE WHEN v_cost THEN 0::numeric END,
           CASE WHEN v_cost THEN 0::numeric END,
           CASE WHEN v_cost THEN 0::numeric END,
           false, true, false
      FROM direct d WHERE d.agent_id IS NULL AND d.players > 0
    UNION ALL
    SELECT NULL,'Unlisted Recipients',NULL,'none',NULL,
           0,0,0::numeric,0::bigint,
           u.recipients,0::numeric,0,
           round(u.earned,2), round(u.outstanding,2), round(u.settled,2),
           false, true, true
      FROM unlisted u
     WHERE v_cost AND COALESCE(u.earned,0) <> 0
  ), totals AS (
    -- Before the filter. The denominator is the club, not the search result.
    SELECT COALESCE(SUM(l.direct_rake),0) AS total_direct,
           SUM(l.commission_earned)       AS total_commission
      FROM listed l
  ), filtered AS (
    SELECT l.* FROM listed l
     WHERE v_q IS NULL OR l.name ILIKE '%' || public.fn_like_escape(v_q) || '%' ESCAPE '\'
  ), ranked AS (
    SELECT f.*, row_number() OVER (
             ORDER BY f.is_unassigned,
               CASE WHEN v_sort = 'name'    THEN f.name END ASC,
               CASE WHEN v_sort = 'cost'    THEN f.commission_earned END DESC NULLS LAST,
               CASE WHEN v_sort = 'players' THEN f.network_players END DESC,
               CASE WHEN v_sort NOT IN ('name','cost','players')
                    THEN f.network_rake END DESC NULLS LAST,
               f.name ASC,
               f.agent_user_id::text ASC NULLS LAST) AS rn
      FROM filtered f
  ), sliced AS (
    SELECT r.* FROM ranked r ORDER BY r.rn
     OFFSET GREATEST(COALESCE(p_offset,0),0)
      LIMIT GREATEST(LEAST(COALESCE(p_limit,50),200),1)
  )
  SELECT jsonb_build_object(
    'rows', COALESCE((SELECT jsonb_agg((to_jsonb(s) - 'rn') ORDER BY s.rn) FROM sliced s), '[]'::jsonb),
    -- Counted, not taken from a window over the page: ask for an offset past
    -- the end and a windowed count would answer "nothing matches".
    'total', (SELECT count(*) FROM filtered),
    'total_direct', (SELECT t.total_direct FROM totals t),
    'total_commission', (SELECT t.total_commission FROM totals t))
    INTO v_out;

  RETURN COALESCE(v_out,
    jsonb_build_object('rows','[]'::jsonb,'total',0,'total_direct',0,'total_commission',NULL));
END;
$$;
DO $guard$ BEGIN IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='ca_refresh_reporting_rollups_base' AND md5(p.prosrc)='40937321494caccce9d2b73da6f04aa4')<>1 THEN RAISE EXCEPTION 'launch_boundary_source_changed: ca_refresh_reporting_rollups_base'; END IF; END $guard$;
CREATE OR REPLACE FUNCTION public.ca_refresh_reporting_rollups_base(p_start date, p_end date) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_start date := LEAST(p_start, p_end);
  v_end date := GREATEST(p_start, p_end);
  v_from timestamptz;
  v_to timestamptz;
  v_players bigint;
  v_tournaments bigint;
  v_participants bigint;
BEGIN
  IF v_start IS NULL OR v_end IS NULL OR v_end - v_start > 400 THEN
    RAISE EXCEPTION 'reporting refresh requires a 0-400 day range';
  END IF;
  PERFORM pg_advisory_xact_lock(918273645);
  v_from := v_start::timestamp AT TIME ZONE 'UTC';
  v_to := (v_end + 1)::timestamp AT TIME ZONE 'UTC';

  DELETE FROM public.ca_club_player_daily WHERE stat_date BETWEEN v_start AND v_end;
  DELETE FROM public.ca_club_tournament_daily WHERE stat_date BETWEEN v_start AND v_end;
  DELETE FROM public.ca_club_tournament_player_daily WHERE stat_date BETWEEN v_start AND v_end;

  WITH home AS MATERIALIZED (
    SELECT DISTINCT ON (uc.union_id, cm.user_id)
           uc.union_id, cm.user_id, cm.club_id
      FROM public.club_members cm
      JOIN public.union_clubs uc ON uc.club_id = cm.club_id
     ORDER BY uc.union_id, cm.user_id, cm.joined_at ASC NULLS LAST, cm.club_id
  ), standalone AS MATERIALIZED (
    SELECT cm.user_id, cm.club_id
      FROM public.club_members cm
     WHERE NOT EXISTS (SELECT 1 FROM public.union_clubs uc WHERE uc.club_id=cm.club_id)
  ), affiliations AS MATERIALIZED (
    SELECT user_id, club_id FROM home
    UNION
    SELECT user_id, club_id FROM standalone
  ), mapped AS MATERIALIZED (
    -- 2026-09-04: cash rows are the ones with a table (buy-in, cash-out,
    -- add-on, rebuy, refund); tournament rows have a tournament and no table
    -- (buy-in, add-on, rebuy, refund, prize, bounty, prize reversal). The sign
    -- is the row's type. This read buy-in/cash-out and buy-in/prize/bounty.
    SELECT 'cash'::text AS kind,wt.user_id,(wt.created_at AT TIME ZONE 'UTC')::date AS stat_date,
           h.club_id,wt.category,wt.type,wt.amount,wt.related_entity_id AS tournament_id
      FROM public.wallet_transactions wt
      JOIN public.tables tb ON tb.id=wt.table_id AND tb.union_id IS NOT NULL
       AND tb.tournament_id IS NULL
      JOIN home h ON h.union_id=tb.union_id AND h.user_id=wt.user_id
     WHERE wt.created_at>=v_from AND wt.created_at<v_to
       AND public.fn_ca_launch_reporting_wallet_accepts(h.club_id,wt.created_at,wt.category,NULL,wt.user_id)
       AND wt.category IN ('buyin','cashout','addon','rebuy','refund') AND wt.table_id IS NOT NULL
    UNION ALL
    -- standalone tables, which this rollup never read.
    SELECT 'cash',wt.user_id,(wt.created_at AT TIME ZONE 'UTC')::date,
           tb.club_id,wt.category,wt.type,wt.amount,wt.related_entity_id
      FROM public.wallet_transactions wt
      JOIN public.tables tb ON tb.id=wt.table_id AND tb.union_id IS NULL
       AND tb.tournament_id IS NULL AND tb.club_id IS NOT NULL
     WHERE wt.created_at>=v_from AND wt.created_at<v_to
       AND public.fn_ca_launch_reporting_wallet_accepts(tb.club_id,wt.created_at,wt.category,NULL,wt.user_id)
       AND wt.category IN ('buyin','cashout','addon','rebuy','refund') AND wt.table_id IS NOT NULL
    UNION ALL
    SELECT 'tournament',wt.user_id,(wt.created_at AT TIME ZONE 'UTC')::date,
           a.club_id,wt.category,wt.type,wt.amount,wt.related_entity_id
      FROM public.wallet_transactions wt
      JOIN affiliations a ON a.user_id=wt.user_id
     WHERE wt.created_at>=v_from AND wt.created_at<v_to
       AND public.fn_ca_launch_reporting_wallet_accepts(a.club_id,wt.created_at,wt.category,wt.related_entity_id,wt.user_id)
       AND wt.category IN ('tournament_buyin','prize','bounty','addon','rebuy','refund','prize_reversal')
       AND wt.related_entity_id IS NOT NULL AND wt.table_id IS NULL
  )
  INSERT INTO public.ca_club_player_daily
    (club_id,user_id,stat_date,cash_net,tournament_net,updated_at)
  SELECT m.club_id,m.user_id,m.stat_date,
         SUM(CASE WHEN m.kind='cash'
                  THEN CASE WHEN m.type='credit' THEN m.amount
                            WHEN m.type='debit' THEN -m.amount ELSE 0 END ELSE 0 END),
         SUM(CASE WHEN m.kind='tournament'
                  THEN CASE WHEN m.type='credit' THEN m.amount
                            WHEN m.type='debit' THEN -m.amount ELSE 0 END ELSE 0 END),now()
    FROM mapped m GROUP BY 1,2,3;

  WITH home AS MATERIALIZED (
    SELECT DISTINCT ON (uc.union_id,cm.user_id)
           uc.union_id,cm.user_id,cm.club_id
      FROM public.club_members cm JOIN public.union_clubs uc ON uc.club_id=cm.club_id
     ORDER BY uc.union_id,cm.user_id,cm.joined_at ASC NULLS LAST,cm.club_id
  ), standalone AS MATERIALIZED (
    SELECT cm.user_id,cm.club_id FROM public.club_members cm
     WHERE NOT EXISTS (SELECT 1 FROM public.union_clubs uc WHERE uc.club_id=cm.club_id)
  ), affiliations AS MATERIALIZED (
    SELECT user_id,club_id FROM home UNION SELECT user_id,club_id FROM standalone
  ), wallet_mapped AS MATERIALIZED (
    SELECT a.club_id,wt.related_entity_id AS tournament_id,wt.user_id,
           (wt.created_at AT TIME ZONE 'UTC')::date AS stat_date,
           CASE WHEN wt.type='credit' THEN wt.amount
                WHEN wt.type='debit' THEN -wt.amount ELSE 0 END AS winnings
      FROM public.wallet_transactions wt JOIN affiliations a ON a.user_id=wt.user_id
     WHERE wt.created_at>=v_from AND wt.created_at<v_to
       AND public.fn_ca_launch_reporting_wallet_accepts(a.club_id,wt.created_at,wt.category,wt.related_entity_id,wt.user_id)
       AND wt.category IN ('tournament_buyin','prize','bounty','addon','rebuy','refund','prize_reversal')
       AND wt.related_entity_id IS NOT NULL AND wt.table_id IS NULL
  ), entrant_totals AS MATERIALIZED (
    SELECT tp.tournament_id,count(*)::numeric AS total_players
      FROM public.tournament_players tp GROUP BY tp.tournament_id
  ), entrant_clubs AS MATERIALIZED (
    SELECT tp.tournament_id,a.club_id,count(*)::numeric AS club_players
      FROM public.tournament_players tp JOIN affiliations a ON a.user_id=tp.user_id
     GROUP BY tp.tournament_id,a.club_id
  ), rake_mapped AS MATERIALIZED (
    SELECT r.tournament_id,(r.created_at AT TIME ZONE 'UTC')::date AS stat_date,
           CASE WHEN r.metadata ? 'user_id' THEN a.club_id ELSE ec.club_id END AS club_id,
           public.fn_ca_launch_reporting_fee_credit(CASE WHEN r.metadata ? 'user_id' THEN a.club_id ELSE ec.club_id END,r.id,r.created_at,r.metadata,r.rake_amount,CASE WHEN r.metadata ? 'user_id' THEN r.rake_amount ELSE r.rake_amount*ec.club_players/NULLIF(et.total_players,0) END) AS fee
      FROM public.rake_records r
      LEFT JOIN affiliations a ON r.metadata ? 'user_id'
       AND a.user_id::text=r.metadata->>'user_id'
      LEFT JOIN entrant_clubs ec ON NOT (r.metadata ? 'user_id')
       AND ec.tournament_id=r.tournament_id
      LEFT JOIN entrant_totals et ON et.tournament_id=r.tournament_id
     WHERE r.created_at>=v_from AND r.created_at<v_to AND r.is_tournament
       AND r.tournament_id IS NOT NULL AND r.rake_amount<>0
  ), combined AS (
    SELECT wm.club_id,wm.tournament_id,wm.stat_date,0::numeric AS fee,
           sum(wm.winnings) AS winnings FROM wallet_mapped wm GROUP BY 1,2,3
    UNION ALL
    SELECT rm.club_id,rm.tournament_id,rm.stat_date,sum(rm.fee),0::numeric
      FROM rake_mapped rm WHERE rm.club_id IS NOT NULL AND rm.fee<>0 GROUP BY 1,2,3
  )
  INSERT INTO public.ca_club_tournament_daily
    (club_id,tournament_id,stat_date,fee,winnings,updated_at)
  SELECT club_id,tournament_id,stat_date,sum(fee),sum(winnings),now()
    FROM combined GROUP BY 1,2,3;

  WITH home AS MATERIALIZED (
    SELECT DISTINCT ON (uc.union_id,cm.user_id) uc.union_id,cm.user_id,cm.club_id
      FROM public.club_members cm JOIN public.union_clubs uc ON uc.club_id=cm.club_id
     ORDER BY uc.union_id,cm.user_id,cm.joined_at ASC NULLS LAST,cm.club_id
  ), standalone AS MATERIALIZED (
    SELECT cm.user_id,cm.club_id FROM public.club_members cm
     WHERE NOT EXISTS (SELECT 1 FROM public.union_clubs uc WHERE uc.club_id=cm.club_id)
  ), affiliations AS MATERIALIZED (
    SELECT user_id,club_id FROM home UNION SELECT user_id,club_id FROM standalone
  )
  INSERT INTO public.ca_club_tournament_player_daily
    (club_id,tournament_id,user_id,stat_date,updated_at)
  SELECT DISTINCT a.club_id,wt.related_entity_id,wt.user_id,
         (wt.created_at AT TIME ZONE 'UTC')::date,now()
    FROM public.wallet_transactions wt JOIN affiliations a ON a.user_id=wt.user_id
   WHERE wt.created_at>=v_from AND wt.created_at<v_to
     AND public.fn_ca_launch_reporting_wallet_accepts(a.club_id,wt.created_at,wt.category,wt.related_entity_id,wt.user_id)
       AND wt.category IN ('tournament_buyin','prize','bounty','addon','rebuy','refund','prize_reversal')
     AND wt.related_entity_id IS NOT NULL AND wt.table_id IS NULL;

  SELECT count(*) INTO v_players FROM public.ca_club_player_daily
   WHERE stat_date BETWEEN v_start AND v_end;
  SELECT count(*) INTO v_tournaments FROM public.ca_club_tournament_daily
   WHERE stat_date BETWEEN v_start AND v_end;
  SELECT count(*) INTO v_participants FROM public.ca_club_tournament_player_daily
   WHERE stat_date BETWEEN v_start AND v_end;
  RETURN jsonb_build_object('start',v_start,'end',v_end,'player_facts',v_players,
    'tournament_facts',v_tournaments,'participant_facts',v_participants,
    'refreshed_at',now());
END;
$$;

DO $guard$ BEGIN IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='fn_club_table_daily_refresh_day' AND md5(p.prosrc)='4290ee1bfda7de2b6b5dda5ebdfef561')<>1 THEN RAISE EXCEPTION 'launch_boundary_source_changed: fn_club_table_daily_refresh_day'; END IF; END $guard$;
CREATE OR REPLACE FUNCTION public.fn_club_table_daily_refresh_day(p_day date) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $_$
DECLARE
  v_from timestamptz := (p_day::timestamp AT TIME ZONE 'UTC');
  v_to   timestamptz := ((p_day + 1)::timestamp AT TIME ZONE 'UTC');
  v_rows int;
BEGIN
  IF p_day IS NULL OR p_day > (now() AT TIME ZONE 'UTC')::date THEN
    RETURN jsonb_build_object('success', false, 'error', 'day_out_of_range');
  END IF;

  DELETE FROM club_table_daily WHERE stat_date = p_day;

  WITH att AS (
    SELECT DISTINCT ON (cm.user_id, uc.union_id)
           uc.union_id, cm.user_id, cm.club_id
      FROM club_members cm
      JOIN union_clubs uc ON uc.club_id = cm.club_id
     ORDER BY cm.user_id, uc.union_id, cm.joined_at ASC NULLS LAST, cm.club_id
  ),
  rr AS (
    SELECT r.id, r.table_id, r.rake_amount, r.created_at, t.union_id, t.club_id AS table_club,
           e.key AS uid, (e.value)::numeric AS contrib,
           SUM((e.value)::numeric) OVER (PARTITION BY r.id) AS tot
      FROM rake_records r
      JOIN tables t ON t.id = r.table_id AND t.tournament_id IS NULL
      CROSS JOIN LATERAL jsonb_each_text(r.player_contributions) e(key, value)
     WHERE r.created_at >= v_from AND r.created_at < v_to
       AND r.player_contributions IS NOT NULL
       AND r.rake_amount > 0
       AND e.key ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
       AND EXISTS (
         SELECT 1
           FROM jsonb_each_text(CASE WHEN jsonb_typeof(r.player_contributions) = 'object'
                                     THEN r.player_contributions ELSE '{}'::jsonb END) x
          WHERE x.key ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
            AND (CASE WHEN x.value ~ '^-?[0-9]+(\.[0-9]+)?$' THEN x.value::numeric ELSE 0 END) > 0)
    UNION ALL
    -- 2026-09-04: a raked hand with no usable contribution (none recorded,
    -- not an object, no uuid keys, nothing positive) used to vanish from this
    -- rollup: 109 rows and 173.38 chips on the reference club's three days.
    -- It is the table's club's rake and it goes there whole, as one synthetic
    -- row of weight 1 and no player.
    SELECT r.id, r.table_id, r.rake_amount, r.created_at, t.union_id, t.club_id,
           NULL::text, 1::numeric, 1::numeric
      FROM rake_records r
      JOIN tables t ON t.id = r.table_id AND t.tournament_id IS NULL
     WHERE r.created_at >= v_from AND r.created_at < v_to
       AND r.rake_amount > 0
       AND NOT EXISTS (
         SELECT 1
           FROM jsonb_each_text(CASE WHEN jsonb_typeof(r.player_contributions) = 'object'
                                     THEN r.player_contributions ELSE '{}'::jsonb END) e
          WHERE e.key ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
            AND (CASE WHEN e.value ~ '^-?[0-9]+(\.[0-9]+)?$' THEN e.value::numeric ELSE 0 END) > 0)
  ),
  raked AS (
    SELECT COALESCE(a.club_id, rr.table_club) AS club_id,
           rr.table_id,
           rr.union_id,
           SUM(rr.rake_amount * rr.contrib / rr.tot) AS rake,
           COUNT(DISTINCT rr.id)  AS hands,
           COUNT(DISTINCT rr.uid) AS players,
           COUNT(*)               AS src
      FROM rr
      LEFT JOIN att a ON a.user_id::text = rr.uid AND a.union_id IS NOT DISTINCT FROM rr.union_id
     WHERE rr.tot > 0 AND public.fn_ca_launch_accounting_accepts(COALESCE(a.club_id,rr.table_club),rr.created_at)
     GROUP BY 1, 2, 3
  ),
  -- 2026-09-04: a table add-on (a top-up, 'addon'), a rebuy and a refund are
  -- buy-in money too; this read 'buyin' and 'cashout' alone and so put every
  -- top-up (1.76M chips across the platform in 30 days) on the players' side
  -- of the table net. Debits are money onto the table, credits money off it.
  wal AS (
    SELECT COALESCE(a.club_id, t.club_id) AS club_id,
           wt.table_id,
           t.union_id,
           SUM(CASE WHEN wt.type = 'debit'  THEN wt.amount ELSE 0 END) AS buyins,
           SUM(CASE WHEN wt.type = 'credit' THEN wt.amount ELSE 0 END) AS cashouts
      FROM wallet_transactions wt
      JOIN tables t ON t.id = wt.table_id AND t.tournament_id IS NULL
      LEFT JOIN att a ON a.user_id = wt.user_id AND a.union_id IS NOT DISTINCT FROM t.union_id
     WHERE wt.created_at >= v_from AND wt.created_at < v_to
       AND public.fn_ca_launch_reporting_wallet_accepts(COALESCE(a.club_id,t.club_id),wt.created_at,wt.category,NULL,wt.user_id)
       AND wt.category IN ('buyin', 'cashout', 'addon', 'rebuy', 'refund')
     GROUP BY 1, 2, 3
  ),
  merged AS (
    SELECT COALESCE(k.club_id,  w.club_id)  AS club_id,
           COALESCE(k.table_id, w.table_id) AS table_id,
           COALESCE(k.union_id, w.union_id) AS union_id,
           COALESCE(k.rake, 0)     AS rake,
           COALESCE(k.hands, 0)    AS hands,
           COALESCE(k.players, 0)  AS players,
           COALESCE(k.src, 0)      AS src,
           COALESCE(w.buyins, 0)   AS buyins,
           COALESCE(w.cashouts, 0) AS cashouts
      FROM raked k
      FULL OUTER JOIN wal w
        ON w.club_id = k.club_id AND w.table_id = k.table_id
  )
  INSERT INTO club_table_daily (club_id, table_id, stat_date, union_id,
                                rake, hands, players, buyins, cashouts, net,
                                source_rows, updated_at)
  SELECT m.club_id, m.table_id, p_day, m.union_id,
         round(m.rake, 4), m.hands, m.players,
         round(m.buyins, 2), round(m.cashouts, 2),
         round(m.cashouts - m.buyins, 2),
         m.src, now()
    FROM merged m
   WHERE m.club_id IS NOT NULL AND m.table_id IS NOT NULL;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN jsonb_build_object('success', true, 'day', p_day, 'rows', v_rows);
END;
$_$;

DO $guard$ BEGIN IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='trg_ca_reporting_rake_insert' AND md5(p.prosrc)='8a7f9c06565d8c99c66dcaadf69995c1')<>1 THEN RAISE EXCEPTION 'launch_boundary_source_changed: trg_ca_reporting_rake_insert'; END IF; END $guard$;
CREATE OR REPLACE FUNCTION public.trg_ca_reporting_rake_insert() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE v_day date; r record; v_fee numeric;
BEGIN
  IF NOT NEW.is_tournament OR NEW.tournament_id IS NULL OR NEW.rake_amount=0
    THEN RETURN NULL; END IF;
  /* SHARED, not exclusive - see trg_ca_reporting_wallet_insert and
     20260906152215. */
  PERFORM pg_advisory_xact_lock_shared(918273645);
  v_day:=(NEW.created_at AT TIME ZONE 'UTC')::date;
  IF NEW.metadata ? 'user_id' THEN
    FOR r IN
      SELECT c.club_id FROM public.tournament_players tp
      CROSS JOIN LATERAL public.ca_reporting_tournament_clubs_for_user(tp.user_id) c
      WHERE tp.tournament_id=NEW.tournament_id
        AND tp.user_id::text=NEW.metadata->>'user_id'
      ORDER BY c.club_id
    LOOP
      v_fee:=public.fn_ca_launch_reporting_fee_credit(r.club_id,NEW.id,NEW.created_at,NEW.metadata,NEW.rake_amount,NEW.rake_amount);
      IF v_fee=0 THEN CONTINUE; END IF;
      INSERT INTO public.ca_club_tournament_daily AS d
        (club_id,tournament_id,stat_date,fee,updated_at)
      VALUES(r.club_id,NEW.tournament_id,v_day,v_fee,now())
      ON CONFLICT(club_id,tournament_id,stat_date) DO UPDATE
       SET fee=d.fee+EXCLUDED.fee,updated_at=now();
    END LOOP;
  ELSE
    FOR r IN
      WITH total AS (SELECT count(*)::numeric n FROM public.tournament_players
                      WHERE tournament_id=NEW.tournament_id), mapped AS (
        SELECT c.club_id FROM public.tournament_players tp
        CROSS JOIN LATERAL public.ca_reporting_tournament_clubs_for_user(tp.user_id) c
        WHERE tp.tournament_id=NEW.tournament_id)
      SELECT m.club_id,count(*)::numeric AS club_players,t.n AS total_players
        FROM mapped m CROSS JOIN total t GROUP BY m.club_id,t.n
       ORDER BY m.club_id
    LOOP
      v_fee:=public.fn_ca_launch_reporting_fee_credit(r.club_id,NEW.id,NEW.created_at,NEW.metadata,NEW.rake_amount,NEW.rake_amount*r.club_players/NULLIF(r.total_players,0));
      IF v_fee=0 THEN CONTINUE; END IF;
      INSERT INTO public.ca_club_tournament_daily AS d
        (club_id,tournament_id,stat_date,fee,updated_at)
      VALUES(r.club_id,NEW.tournament_id,v_day,
             v_fee,now())
      ON CONFLICT(club_id,tournament_id,stat_date) DO UPDATE
       SET fee=d.fee+EXCLUDED.fee,updated_at=now();
    END LOOP;
  END IF;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Club Data rake rollup failed for row %: %',NEW.id,SQLERRM;
  RETURN NULL;
END;
$$;

DO $guard$ BEGIN IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='trg_ca_reporting_wallet_insert' AND md5(p.prosrc)='05cff3cd3111a01271fa5b74d1dc18d3')<>1 THEN RAISE EXCEPTION 'launch_boundary_source_changed: trg_ca_reporting_wallet_insert'; END IF; END $guard$;
CREATE OR REPLACE FUNCTION public.trg_ca_reporting_wallet_insert() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_club uuid; v_union uuid; v_table_club uuid; v_is_tournament_table boolean; v_day date;
  v_cash numeric:=0; v_tournament numeric:=0; r record;
BEGIN
  -- 2026-09-04: a table add-on (top-up), a rebuy and a refund move cash-table
  -- money too, and a tournament add-on, rebuy, refund or prize reversal moves
  -- tournament money; this knew buy-in, cash-out, tournament buy-in, prize
  -- and bounty alone. A row with a table is cash; a row with a tournament and
  -- no table is tournament. The sign is the row's own type, never its name.
  IF NOT ((NEW.category IN('buyin','cashout','addon','rebuy','refund') AND NEW.table_id IS NOT NULL)
    OR (NEW.category IN('tournament_buyin','prize','bounty','addon','rebuy','refund','prize_reversal')
        AND NEW.related_entity_id IS NOT NULL AND NEW.table_id IS NULL))
    THEN RETURN NULL; END IF;
  /* SHARED, not exclusive (20260906152215). The exclusive form serialised
     every chip movement on the platform behind one lock and held it to
     commit: 2,731 waits over a second in one day, 2,916 statement timeouts,
     and the deadlock cycles that failed prize credits. Shared holders never
     block each other; only the range rebuilds take the exclusive lock, and
     they still wait for every in-flight trigger before they delete a day. */
  PERFORM pg_advisory_xact_lock_shared(918273645);
  v_day:=(NEW.created_at AT TIME ZONE 'UTC')::date;
  IF NEW.table_id IS NOT NULL THEN
    SELECT t.union_id,t.club_id,(t.tournament_id IS NOT NULL)
      INTO v_union,v_table_club,v_is_tournament_table
      FROM public.tables t WHERE t.id=NEW.table_id;
    IF v_is_tournament_table THEN RETURN NULL; END IF;
    IF v_union IS NULL THEN
      -- A standalone table: the club is the table's club.
      v_club:=v_table_club;
    ELSE
      SELECT cm.club_id INTO v_club FROM public.club_members cm
        JOIN public.union_clubs uc ON uc.club_id=cm.club_id AND uc.union_id=v_union
       WHERE cm.user_id=NEW.user_id
       ORDER BY cm.joined_at ASC NULLS LAST,cm.club_id LIMIT 1;
    END IF;
    v_cash:=CASE WHEN NEW.type='credit' THEN NEW.amount
                 WHEN NEW.type='debit' THEN -NEW.amount ELSE 0 END;
    IF v_club IS NOT NULL AND public.fn_ca_launch_reporting_wallet_accepts(v_club,NEW.created_at,NEW.category,NULL,NEW.user_id) THEN
      INSERT INTO public.ca_club_player_daily AS d
        (club_id,user_id,stat_date,cash_net,tournament_net,updated_at)
      VALUES(v_club,NEW.user_id,v_day,v_cash,0,now())
      ON CONFLICT(club_id,user_id,stat_date) DO UPDATE
       SET cash_net=d.cash_net+EXCLUDED.cash_net,updated_at=now();
    END IF;
  ELSE
    v_tournament:=CASE WHEN NEW.type='credit' THEN NEW.amount
                       WHEN NEW.type='debit' THEN -NEW.amount ELSE 0 END;
    /* ORDER BY club_id: two credits to players of the same event upsert the
       shared ca_club_tournament_daily rows in one order, so they wait on each
       other instead of cycling. */
    FOR r IN SELECT c.club_id FROM public.ca_reporting_tournament_clubs_for_user(NEW.user_id) c
              ORDER BY c.club_id LOOP
      IF NOT public.fn_ca_launch_reporting_wallet_accepts(r.club_id,NEW.created_at,NEW.category,NEW.related_entity_id,NEW.user_id) THEN CONTINUE; END IF;
      INSERT INTO public.ca_club_player_daily AS d
        (club_id,user_id,stat_date,cash_net,tournament_net,updated_at)
      VALUES(r.club_id,NEW.user_id,v_day,0,v_tournament,now())
      ON CONFLICT(club_id,user_id,stat_date) DO UPDATE
       SET tournament_net=d.tournament_net+EXCLUDED.tournament_net,updated_at=now();
      INSERT INTO public.ca_club_tournament_daily AS d
        (club_id,tournament_id,stat_date,winnings,updated_at)
      VALUES(r.club_id,NEW.related_entity_id,v_day,v_tournament,now())
      ON CONFLICT(club_id,tournament_id,stat_date) DO UPDATE
       SET winnings=d.winnings+EXCLUDED.winnings,updated_at=now();
      INSERT INTO public.ca_club_tournament_player_daily
        (club_id,tournament_id,user_id,stat_date,updated_at)
      VALUES(r.club_id,NEW.related_entity_id,NEW.user_id,v_day,now())
      ON CONFLICT(club_id,tournament_id,user_id,stat_date) DO UPDATE SET updated_at=now();
    END LOOP;
  END IF;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Club Data wallet rollup failed for tx %: %',NEW.id,SQLERRM;
  RETURN NULL;
END;
$$;

DO $guard$ BEGIN IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='fn_agent_downline_rake' AND md5(p.prosrc)='eea1a3fd9804401d32ad31ea0fb19f91')<>1 THEN RAISE EXCEPTION 'launch_boundary_source_changed: fn_agent_downline_rake'; END IF; END $guard$;
CREATE OR REPLACE FUNCTION public.fn_agent_downline_rake(p_agent_user_id uuid DEFAULT NULL::uuid, p_club_id uuid DEFAULT NULL::uuid, p_since timestamp with time zone DEFAULT NULL::timestamp with time zone, p_until timestamp with time zone DEFAULT NULL::timestamp with time zone, p_search text DEFAULT NULL::text, p_limit integer DEFAULT 500) RETURNS TABLE(player_id uuid, username text, club_id uuid, club_name text, role text, depth integer, upline_user_id uuid, upline_name text, rake_generated numeric, hands bigint, last_hand_at timestamp with time zone, downline_players integer, downline_rake numeric)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
#variable_conflict use_column
DECLARE
  v_root uuid := COALESCE(p_agent_user_id, auth.uid());
  v_from timestamptz := COALESCE(p_since, public.fn_union_week_start(now()));
  v_to   timestamptz := COALESCE(p_until, now());
  v_caller uuid := auth.uid();
  v_today  timestamptz := date_trunc('day', now());
  v_day_lo date;
  v_day_hi date;
  v_head_end   timestamptz;
  v_tail_start timestamptz;
  v_overseer_clubs uuid[];
BEGIN
  IF v_root IS NULL THEN RAISE EXCEPTION 'no_agent'; END IF;

  IF NOT EXISTS (SELECT 1 FROM agents a
                  WHERE a.user_id = v_root AND a.status='active'
                    AND a.role IN ('super_agent','agent','sub_agent')
                    AND (p_club_id IS NULL OR a.club_id = p_club_id)) THEN
    RAISE EXCEPTION 'not_an_agent';
  END IF;

  IF v_caller IS NOT NULL
     AND v_caller <> v_root
     AND NOT public.fn_is_agent_ancestor(v_caller, v_root, p_club_id)
     AND NOT (p_club_id IS NOT NULL AND public.fn_is_club_admin_uid(p_club_id))
  THEN
    -- Only the overseer alternative is scoped here; retain self, ancestor,
    -- explicit club-admin and existing null-caller service behavior above.
    SELECT array_agg(DISTINCT a.club_id) INTO v_overseer_clubs
      FROM agents a
      JOIN union_clubs uc ON uc.club_id = a.club_id
     WHERE a.user_id = v_root AND a.status = 'active'
       AND a.role IN ('super_agent','agent','sub_agent')
       AND (p_club_id IS NULL OR a.club_id = p_club_id)
       AND public.fn_is_union_overseer(uc.union_id, v_caller);
    IF COALESCE(cardinality(v_overseer_clubs), 0) = 0 THEN
      RAISE EXCEPTION 'not_authorised';
    END IF;
  END IF;

  v_day_lo := date_trunc('day', v_from)::date;
  IF date_trunc('day', v_from) < v_from THEN v_day_lo := v_day_lo + 1; END IF;
  v_day_hi := LEAST(date_trunc('day', v_to), v_today)::date;
  IF v_day_hi < v_day_lo THEN v_day_hi := v_day_lo; END IF;

  v_head_end   := LEAST(v_day_lo::timestamptz, v_to);
  v_tail_start := GREATEST(v_day_hi::timestamptz, v_from);

  RETURN QUERY
  WITH RECURSIVE chain AS (
    SELECT a.id, a.user_id, a.club_id, a.role, a.parent_agent_id, 0 AS depth
      FROM agents a
     WHERE a.user_id = v_root AND a.status = 'active'
       AND (p_club_id IS NULL OR a.club_id = p_club_id)
       AND (v_overseer_clubs IS NULL OR a.club_id = ANY(v_overseer_clubs))
    UNION ALL
    SELECT c.id, c.user_id, c.club_id, c.role, c.parent_agent_id, ch.depth + 1
      FROM agents c JOIN chain ch ON c.parent_agent_id = ch.id
     WHERE c.status = 'active'
       AND (v_overseer_clubs IS NULL OR c.club_id = ANY(v_overseer_clubs))
  ),
  roster AS (
    SELECT DISTINCT cm.user_id AS player_id, cm.club_id, cm.agent_id AS upline_user_id,
           ch.depth + 1 AS depth
      FROM club_members cm
      JOIN chain ch ON ch.user_id = cm.agent_id AND ch.club_id = cm.club_id
     WHERE cm.agent_id IS NOT NULL
  ),
  everyone AS MATERIALIZED (
    SELECT player_id, club_id, upline_user_id, depth FROM roster
    UNION
    SELECT ch.user_id, ch.club_id,
           (SELECT p.user_id FROM agents p WHERE p.id = ch.parent_agent_id),
           ch.depth
      FROM chain ch WHERE ch.depth > 0
  ),
  in_scope_clubs AS MATERIALIZED (SELECT DISTINCT club_id FROM everyone),
  ok_days AS MATERIALIZED (
    SELECT rc.club_id, rc.day
      FROM club_rake_rollup_complete rc
      JOIN in_scope_clubs c ON c.club_id = rc.club_id
     WHERE rc.day >= v_day_lo AND rc.day < v_day_hi
  ),
  gap_days AS MATERIALIZED (
    SELECT c.club_id, g::date AS day
      FROM in_scope_clubs c
      CROSS JOIN generate_series(v_day_lo, v_day_hi - 1, interval '1 day') g
     WHERE v_day_hi > v_day_lo
       AND NOT EXISTS (SELECT 1 FROM ok_days o
                        WHERE o.club_id = c.club_id AND o.day = g::date)
  ),
  from_rollup AS (
    SELECT rd.user_id, rd.club_id,
           SUM(rd.rake_amount) AS rake,
           SUM(rd.hands)::bigint AS hands,
           MAX((rd.day + 1)::timestamptz) AS last_at
      FROM club_rake_daily_user rd
      JOIN ok_days o  ON o.club_id = rd.club_id AND o.day = rd.day
      JOIN everyone e ON e.player_id = rd.user_id AND e.club_id = rd.club_id
     GROUP BY rd.user_id, rd.club_id
  ),
  edge_hands AS MATERIALIZED (
    SELECT r.id, r.hand_id, r.club_id, r.created_at, r.rake_amount, r.player_contributions, r.rake_method
      FROM rake_records r
     WHERE public.fn_ca_launch_accounting_accepts(r.club_id,r.created_at) AND r.created_at >= v_from AND r.created_at < v_head_end
       AND r.rake_amount > 0 AND r.player_contributions IS NOT NULL
       AND (p_club_id IS NULL OR r.club_id = p_club_id)
    UNION ALL
    SELECT r.id, r.hand_id, r.club_id, r.created_at, r.rake_amount, r.player_contributions, r.rake_method
      FROM rake_records r
     WHERE r.created_at >= v_tail_start AND r.created_at < v_to
       AND r.rake_amount > 0 AND r.player_contributions IS NOT NULL
       AND (p_club_id IS NULL OR r.club_id = p_club_id)
    UNION ALL
    SELECT r.id, r.hand_id, r.club_id, r.created_at, r.rake_amount, r.player_contributions, r.rake_method
      FROM gap_days gd
      JOIN rake_records r
        ON r.club_id = gd.club_id
       AND r.created_at >= gd.day::timestamptz
       AND r.created_at <  (gd.day + 1)::timestamptz
     WHERE public.fn_ca_launch_accounting_accepts(r.club_id,r.created_at) AND r.rake_amount > 0 AND r.player_contributions IS NOT NULL
  ),
  -- LEDGER-READ (2026-08-29): stored per-player credits when present, the
  -- canonical allocator when not.
  edge_split AS MATERIALIZED (
    SELECT s.user_id, eh.club_id, eh.created_at,
           round(s.credit * 100)::bigint AS cents
      FROM edge_hands eh
      CROSS JOIN LATERAL public.fn_rake_shares_for_record(
        eh.hand_id, eh.rake_amount, eh.player_contributions, COALESCE(eh.rake_method, 'DEALT_EQUAL')
      ) s
  ),
  from_live AS (
    SELECT s.user_id, s.club_id,
           SUM(s.cents)::numeric / 100 AS rake,
           count(*)::bigint AS hands,
           max(s.created_at) AS last_at
      FROM edge_split s
      JOIN everyone e ON e.player_id = s.user_id AND e.club_id = s.club_id
     GROUP BY s.user_id, s.club_id
  ),
  earned AS MATERIALIZED (
    SELECT COALESCE(a.user_id, b.user_id) AS user_id,
           COALESCE(a.club_id, b.club_id) AS club_id,
           COALESCE(a.rake,0) + COALESCE(b.rake,0)   AS rake,
           COALESCE(a.hands,0) + COALESCE(b.hands,0) AS hands,
           GREATEST(COALESCE(a.last_at,'-infinity'::timestamptz),
                    COALESCE(b.last_at,'-infinity'::timestamptz)) AS last_at
      FROM from_rollup a
      FULL OUTER JOIN from_live b ON b.user_id = a.user_id AND b.club_id = a.club_id
  ),
  downline_agg AS MATERIALIZED (
    SELECT cm.agent_id AS upline, cm.club_id, SUM(ea.rake) AS rake
      FROM earned ea
      JOIN club_members cm ON cm.user_id = ea.user_id AND cm.club_id = ea.club_id
     WHERE cm.agent_id IS NOT NULL
     GROUP BY cm.agent_id, cm.club_id
  ),
  downline_cnt AS MATERIALIZED (
    SELECT cm.agent_id AS upline, cm.club_id, count(*)::int AS players
      FROM club_members cm
     WHERE cm.agent_id IN (SELECT player_id FROM everyone)
     GROUP BY cm.agent_id, cm.club_id
  )
  SELECT e.player_id,
         COALESCE(public.fn_arena_name(pr.alias, pr.username, pr.display_name, pr.first_name, pr.last_name, pr.full_name), pr.username, left(e.player_id::text, 8)),
         e.club_id, cl.name,
         COALESCE(ag.role, 'player'),
         e.depth, e.upline_user_id,
         COALESCE(public.fn_arena_name(up.alias, up.username, up.display_name, up.first_name, up.last_name, up.full_name), up.username),
         COALESCE(ea.rake, 0), COALESCE(ea.hands, 0),
         NULLIF(ea.last_at, '-infinity'::timestamptz),
         COALESCE(dc.players, 0), COALESCE(da.rake, 0)
    FROM everyone e
    LEFT JOIN earned ea       ON ea.user_id = e.player_id AND ea.club_id = e.club_id
    LEFT JOIN downline_agg da ON da.upline  = e.player_id AND da.club_id = e.club_id
    LEFT JOIN downline_cnt dc ON dc.upline  = e.player_id AND dc.club_id = e.club_id
    LEFT JOIN profiles pr ON pr.id = e.player_id
    LEFT JOIN profiles up ON up.id = e.upline_user_id
    LEFT JOIN clubs cl    ON cl.id = e.club_id
    LEFT JOIN agents ag   ON ag.user_id = e.player_id AND ag.club_id = e.club_id
                         AND ag.status = 'active'
   WHERE (p_search IS NULL OR p_search = ''
          OR COALESCE(public.fn_arena_name(pr.alias, pr.username, pr.display_name, pr.first_name, pr.last_name, pr.full_name), pr.username, '') ILIKE '%' || p_search || '%')
   ORDER BY COALESCE(ea.rake, 0) DESC
   LIMIT GREATEST(COALESCE(p_limit, 500), 1);
END $$;

DO $guard$ BEGIN IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='fn_ca_rake_by_agent' AND md5(p.prosrc)='ac26cdcf55b0876d0966b159695fc4a0')<>1 THEN RAISE EXCEPTION 'launch_boundary_source_changed: fn_ca_rake_by_agent'; END IF; END $guard$;
CREATE OR REPLACE FUNCTION public.fn_ca_rake_by_agent(p_club_id uuid, p_start date, p_end date, p_limit integer, p_offset integer DEFAULT 0, p_search text DEFAULT NULL::text, p_sort text DEFAULT 'rake'::text) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_now  timestamptz := now();
  v_from timestamptz := p_start::timestamptz;
  v_to   timestamptz := LEAST((p_end + 1)::timestamptz, v_now);
  v_uid  uuid    := auth.uid();
  v_cost boolean := public.fn_is_club_admin_uid(p_club_id);
  v_over boolean := EXISTS (SELECT 1 FROM public.union_clubs uc
                             WHERE uc.club_id = p_club_id
                               AND public.fn_is_union_overseer(uc.union_id, v_uid));
  v_q    text := NULLIF(btrim(COALESCE(p_search,'')),'');
  v_sort text := lower(COALESCE(NULLIF(btrim(p_sort),''),'rake'));
  v_out  jsonb;
BEGIN
  v_from:=public.fn_ca_launch_accounting_start('club',p_club_id,v_from);
  IF v_to <= v_from THEN
    RETURN jsonb_build_object('rows','[]'::jsonb,'total',0,'total_direct',0,'total_commission',NULL);
  END IF;

  WITH RECURSIVE ok_days AS MATERIALIZED (
    SELECT rc.day FROM public.club_rake_rollup_complete rc
     WHERE rc.club_id = p_club_id
       AND rc.day >= date_trunc('day', v_from)::date
       AND rc.day <  date_trunc('day', v_to)::date
  ), from_rollup AS (
    SELECT rd.user_id, SUM(rd.rake_amount) AS rake, SUM(rd.hands)::bigint AS hands
      FROM public.club_rake_daily_user rd
      JOIN ok_days o ON o.day = rd.day
     WHERE rd.club_id = p_club_id
     GROUP BY rd.user_id
  ), from_live AS (
    -- THE DAYS NOT YET SEALED, read from the incremental rollup the triggers
    -- on rake_attributions keep exact. This used to scan the attributions
    -- themselves, which is fine at 04:00 and a third of a million rows by
    -- midnight - the panel healed every morning and failed every evening.
    -- Same cents, same rounding, same source table as the sealed days.
    SELECT du.user_id,
           du.rake_cents::numeric / 100 AS rake,
           du.hands
      FROM public.ca_club_rake_daily_user du
     WHERE du.club_id = p_club_id
       AND du.day >= date_trunc('day', v_from)::date
       -- A DAY IS IN RANGE WHEN ITS OWN MIDNIGHT IS BEFORE THE EXCLUSIVE END,
       -- never `<= date_trunc('day', v_to)`. v_to is either a midnight (ask
       -- for a range ending yesterday and it is TODAY's midnight) or now()
       -- itself (ask for a range ending today). The inclusive form got the
       -- second case right and the first case wrong, and put TODAY's rake into
       -- a report for YESTERDAY. Caught by comparing old against new under one
       -- snapshot before this shipped; four ranges agreed and that one did not.
       AND du.day::timestamptz < v_to
       AND NOT EXISTS (SELECT 1 FROM ok_days o WHERE o.day = du.day)
  ), earned AS MATERIALIZED (
    SELECT COALESCE(a.user_id,b.user_id) AS user_id,
           COALESCE(a.rake,0)+COALESCE(b.rake,0)   AS rake,
           COALESCE(a.hands,0)+COALESCE(b.hands,0) AS hands
      FROM from_rollup a FULL OUTER JOIN from_live b ON b.user_id = a.user_id
  ), paid_cut AS MATERIALIZED (
    -- EVERY INSTANT IN [v_from, v_to) AT WHICH "PAID" CAN CHANGE, AND v_from.
    -- fn_agent_commission_paid_by_period is SELECT EXISTS (...), and a SQL
    -- body with a sublink is never inlined, so asking it inside the FILTERs
    -- below made it a function call, twice for every open commission row in
    -- the range: 4,024,562 calls and 42 s for SHARK CLUB's month. For any
    -- agent the answer can only change where one of this club's paid periods
    -- starts or ends. Between two consecutive cuts it is constant, so it is
    -- asked once per stretch, at the stretch's first instant.
    SELECT v_from AS cut
    UNION
    SELECT s.period_start FROM public.agent_commission_settlements s
     WHERE s.club_id = p_club_id AND s.period_start > v_from AND s.period_start < v_to
    UNION
    SELECT s.period_end FROM public.agent_commission_settlements s
     WHERE s.club_id = p_club_id AND s.period_end > v_from AND s.period_end < v_to
  ), stretch AS MATERIALIZED (
    -- [lo, hi) stretches that tile [v_from, v_to) exactly: no gap, no overlap.
    SELECT c.cut AS lo, COALESCE(lead(c.cut) OVER (ORDER BY c.cut), v_to) AS hi
      FROM paid_cut c
  ), commission_part AS (
    -- One range read of idx_agent_commissions_club_created per stretch, summed
    -- per (agent, own settled_at set or not). No function call per row. The
    -- half-open window of fn_club_commission_accrued (>= since, < until) is
    -- stated outright as well: the stretches tile it exactly, so it removes
    -- nothing, and no stretch can ever widen what is summed.
    SELECT st.lo, x.user_id, x.open, x.amount
      FROM stretch st
      CROSS JOIN LATERAL (
        SELECT ac.user_id, ac.settled_at IS NULL AS open, SUM(ac.amount) AS amount
          FROM public.agent_commissions ac
         WHERE ac.club_id = p_club_id
           AND ac.created_at >= v_from AND ac.created_at < v_to
           AND ac.created_at >= st.lo AND ac.created_at < st.hi
         GROUP BY ac.user_id, ac.settled_at IS NULL) x
  ), commission AS (
    -- The same predicate and the same two FILTERs, asked once per stretch.
    -- Every sum covers exactly the rows it did (numeric addition is exact and
    -- keeps the largest input scale), and is NULL exactly when it was.
    SELECT cp.user_id,
           SUM(cp.amount)                                          AS earned,
           SUM(cp.amount) FILTER (WHERE cp.open AND NOT public.fn_agent_commission_paid_by_period(p_club_id, cp.user_id, cp.lo)) AS outstanding,
           SUM(cp.amount) FILTER (WHERE NOT cp.open OR public.fn_agent_commission_paid_by_period(p_club_id, cp.user_id, cp.lo)) AS settled
      FROM commission_part cp
     GROUP BY cp.user_id
  ), club_agents AS (
    SELECT a.id, a.user_id, a.parent_agent_id, a.role, a.commission_rate
      FROM public.agents a WHERE a.club_id = p_club_id AND a.status='active'
  ), direct AS (
    SELECT cm.agent_id, COUNT(*) AS players,
           COUNT(*) FILTER (WHERE COALESCE(e.rake,0) <> 0) AS active,
           COALESCE(SUM(e.rake),0) AS rake, COALESCE(SUM(e.hands),0)::bigint AS hands
      FROM public.club_members cm
      LEFT JOIN earned e ON e.user_id = cm.user_id
     WHERE cm.club_id = p_club_id
     GROUP BY cm.agent_id
  ), tree AS (
    SELECT ca.id AS root_id, ca.id AS node_id, 0 AS depth FROM club_agents ca
    UNION ALL
    SELECT t.root_id, c.id, t.depth+1
      FROM tree t JOIN club_agents c ON c.parent_agent_id = t.node_id
     WHERE t.depth < 12
  ), network AS (
    SELECT t.root_id, COALESCE(SUM(d.rake),0) AS rake,
           COALESCE(SUM(d.players),0) AS players,
           COUNT(*) FILTER (WHERE t.node_id <> t.root_id) AS sub_agents
      FROM (SELECT DISTINCT root_id, node_id FROM tree) t
      JOIN club_agents n ON n.id = t.node_id
      LEFT JOIN direct d ON d.agent_id = n.user_id
     GROUP BY t.root_id
  ), unlisted AS (
    SELECT SUM(cs.earned) AS earned, SUM(cs.outstanding) AS outstanding,
           SUM(cs.settled) AS settled, count(*)::int AS recipients
      FROM commission cs
     WHERE NOT EXISTS (SELECT 1 FROM club_agents ca WHERE ca.user_id = cs.user_id)
  ), listed AS (
    SELECT ca.user_id AS agent_user_id,
           COALESCE(public.fn_arena_name(pr.alias, pr.username, pr.display_name,
                                         pr.first_name, pr.last_name, pr.full_name),
                    pr.username, 'Agent') AS name,
           pr.avatar_url, ca.role, ca.commission_rate,
           COALESCE(dr.players,0) AS direct_players,
           COALESCE(dr.active,0)  AS direct_active,
           round(COALESCE(dr.rake,0),2) AS direct_rake,
           COALESCE(dr.hands,0) AS direct_hands,
           COALESCE(nw.players,0) AS network_players,
           round(COALESCE(nw.rake,0),2) AS network_rake,
           COALESCE(nw.sub_agents,0) AS sub_agents,
           CASE WHEN v_cost THEN round(COALESCE(cs.earned,0),2)      END AS commission_earned,
           CASE WHEN v_cost THEN round(COALESCE(cs.outstanding,0),2) END AS commission_outstanding,
           CASE WHEN v_cost THEN round(COALESCE(cs.settled,0),2)     END AS commission_settled,
           -- The same three conditions the downline walker enforces.
           (v_cost OR v_over OR ca.user_id = v_uid
            OR public.fn_is_agent_ancestor(v_uid, ca.user_id, p_club_id)) AS can_drill,
           false AS is_unassigned, false AS is_residual
      FROM club_agents ca
      LEFT JOIN direct dr ON dr.agent_id = ca.user_id
      LEFT JOIN network nw ON nw.root_id = ca.id
      LEFT JOIN commission cs ON cs.user_id = ca.user_id
      LEFT JOIN public.profiles pr ON pr.id = ca.user_id
    UNION ALL
    SELECT NULL,'Unassigned',NULL,'none',NULL,
           d.players,d.active,round(d.rake,2),d.hands,
           d.players,round(d.rake,2),0,
           CASE WHEN v_cost THEN 0::numeric END,
           CASE WHEN v_cost THEN 0::numeric END,
           CASE WHEN v_cost THEN 0::numeric END,
           false, true, false
      FROM direct d WHERE d.agent_id IS NULL AND d.players > 0
    UNION ALL
    SELECT NULL,'Unlisted Recipients',NULL,'none',NULL,
           0,0,0::numeric,0::bigint,
           u.recipients,0::numeric,0,
           round(u.earned,2), round(u.outstanding,2), round(u.settled,2),
           false, true, true
      FROM unlisted u
     WHERE v_cost AND COALESCE(u.earned,0) <> 0
  ), totals AS (
    -- Before the filter. The denominator is the club, not the search result.
    SELECT COALESCE(SUM(l.direct_rake),0) AS total_direct,
           SUM(l.commission_earned)       AS total_commission
      FROM listed l
  ), filtered AS (
    SELECT l.* FROM listed l
     WHERE v_q IS NULL OR l.name ILIKE '%' || public.fn_like_escape(v_q) || '%' ESCAPE '\'
  ), ranked AS (
    SELECT f.*, row_number() OVER (
             ORDER BY f.is_unassigned,
               CASE WHEN v_sort = 'name'    THEN f.name END ASC,
               CASE WHEN v_sort = 'cost'    THEN f.commission_earned END DESC NULLS LAST,
               CASE WHEN v_sort = 'players' THEN f.network_players END DESC,
               CASE WHEN v_sort NOT IN ('name','cost','players')
                    THEN f.network_rake END DESC NULLS LAST,
               f.name ASC,
               f.agent_user_id::text ASC NULLS LAST) AS rn
      FROM filtered f
  ), sliced AS (
    SELECT r.* FROM ranked r ORDER BY r.rn
     OFFSET GREATEST(COALESCE(p_offset,0),0)
      LIMIT GREATEST(LEAST(COALESCE(p_limit,50),200),1)
  )
  SELECT jsonb_build_object(
    'rows', COALESCE((SELECT jsonb_agg((to_jsonb(s) - 'rn') ORDER BY s.rn) FROM sliced s), '[]'::jsonb),
    -- Counted, not taken from a window over the page: ask for an offset past
    -- the end and a windowed count would answer "nothing matches".
    'total', (SELECT count(*) FROM filtered),
    'total_direct', (SELECT t.total_direct FROM totals t),
    'total_commission', (SELECT t.total_commission FROM totals t))
    INTO v_out;

  RETURN COALESCE(v_out,
    jsonb_build_object('rows','[]'::jsonb,'total',0,'total_direct',0,'total_commission',NULL));
END;
$$;

CREATE TRIGGER native_reporting_rake AFTER INSERT ON rake_records FOR EACH ROW EXECUTE FUNCTION trg_ca_reporting_rake_insert();
CREATE TRIGGER native_reporting_wallet AFTER INSERT ON wallet_transactions FOR EACH ROW EXECUTE FUNCTION trg_ca_reporting_wallet_insert();
INSERT INTO club_members(club_id,user_id,credit_used,display_name) VALUES('a0000000-0000-0000-0000-000000000001','90000000-0000-0000-0000-000000000001',0,'new player');
INSERT INTO tournament_players(tournament_id,user_id,position,status,registered_at,club_id) VALUES('40000000-0000-0000-0000-000000000001','90000000-0000-0000-0000-000000000001',1,'winner','2026-10-12 12:01Z','a0000000-0000-0000-0000-000000000001'),('40000000-0000-0000-0000-000000000002','90000000-0000-0000-0000-000000000001',1,'winner','2026-10-12 11:00Z','a0000000-0000-0000-0000-000000000001');
INSERT INTO rake_records(id,created_at,is_tournament,tournament_id,rake_amount,metadata) VALUES('91000000-0000-0000-0000-000000000001','2026-10-12 12:05Z',true,'40000000-0000-0000-0000-000000000001',3,'{"user_id":"90000000-0000-0000-0000-000000000001","accounting_source_version":"2","accounting_fee_source":{"contributors":[{"player_id":"90000000-0000-0000-0000-000000000001","club_id":"a0000000-0000-0000-0000-000000000001","charged_at":"2026-10-12T12:01:00Z","weight":100}]}}');
DO $$ BEGIN IF (SELECT sum(fee) FROM ca_club_tournament_daily)<>3 THEN RAISE EXCEPTION 'new fee manifest not immediately reflected'; END IF; END $$;
INSERT INTO accounting_tournament_fee_sources(rake_record_id,player_id,club_id,charged_at,rake_credit) VALUES('92000000-0000-0000-0000-000000000001','90000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000001','2026-10-12 11:59Z',8);
INSERT INTO rake_records(id,created_at,is_tournament,tournament_id,rake_amount,metadata) VALUES('92000000-0000-0000-0000-000000000001','2026-10-12 12:05Z',true,'40000000-0000-0000-0000-000000000002',8,'{"user_id":"90000000-0000-0000-0000-000000000001"}');
DO $$ BEGIN IF (SELECT sum(fee) FROM ca_club_tournament_daily)<>3 THEN RAISE EXCEPTION 'old fee admitted when recognized late'; END IF; END $$;
INSERT INTO wallet_transactions(user_id,related_entity_id,created_at,category,type,amount) VALUES('90000000-0000-0000-0000-000000000001','40000000-0000-0000-0000-000000000001','2026-10-12 12:10Z','prize','credit',7),('90000000-0000-0000-0000-000000000001','40000000-0000-0000-0000-000000000002','2026-10-12 12:10Z','prize','credit',8);
DO $$ BEGIN IF (SELECT sum(tournament_net) FROM ca_club_player_daily)<>7 THEN RAISE EXCEPTION 'tournament earning boundary wrong'; END IF; END $$;
SELECT ca_refresh_reporting_rollups_base('2026-10-12','2026-10-12');
DO $$ BEGIN IF (SELECT sum(fee) FROM ca_club_tournament_daily)<>3 OR (SELECT sum(tournament_net) FROM ca_club_player_daily)<>7 THEN RAISE EXCEPTION 'rebuild resurrected old fees/prizes'; END IF; END $$;
INSERT INTO tables(club_id,big_blind,id) VALUES('a0000000-0000-0000-0000-000000000001',20,'93000000-0000-0000-0000-000000000001');
INSERT INTO rake_records(id,club_id,table_id,created_at,rake_amount) VALUES('94000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000001','93000000-0000-0000-0000-000000000001','2026-10-12 11:59Z',2),('94000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-000000000001','93000000-0000-0000-0000-000000000001','2026-10-12 12:01Z',4);
INSERT INTO wallet_transactions(user_id,table_id,created_at,category,type,amount) VALUES('90000000-0000-0000-0000-000000000001','93000000-0000-0000-0000-000000000001','2026-10-12 11:59Z','buyin','debit',9),('90000000-0000-0000-0000-000000000001','93000000-0000-0000-0000-000000000001','2026-10-12 12:01Z','buyin','debit',5);
SELECT fn_club_table_daily_refresh_day('2026-10-12');
DO $$ BEGIN IF (SELECT sum(rake) FROM club_table_daily)<>4 OR (SELECT sum(buyins) FROM club_table_daily)<>5 THEN RAISE EXCEPTION 'table reporting rebuild resurrected old cash'; END IF; END $$;

CREATE TABLE union_rake_weekly(union_id uuid,club_id uuid,week_start date,rake_total numeric DEFAULT 0,updated_at timestamptz,CONSTRAINT union_rake_weekly_key PRIMARY KEY(union_id,club_id,week_start));
CREATE TABLE union_wallet_transactions(id uuid DEFAULT gen_random_uuid(),union_id uuid,club_id uuid,created_at timestamptz,wallet text,direction text,tx_type text,amount numeric);
CREATE FUNCTION public.trg_union_rake_weekly() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  IF NEW.union_id IS NOT NULL
     AND NEW.wallet = 'rake_wallet'
     AND NEW.direction = 'credit'
     AND NEW.tx_type = 'rake' THEN
    INSERT INTO public.union_rake_weekly (union_id, club_id, week_start, rake_total, updated_at)
    VALUES (NEW.union_id, NEW.club_id, date_trunc('week', NEW.created_at)::date,
            COALESCE(NEW.amount, 0), now())
    ON CONFLICT ON CONSTRAINT union_rake_weekly_key DO UPDATE
      SET rake_total = public.union_rake_weekly.rake_total + EXCLUDED.rake_total,
          updated_at = now();
  END IF;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  -- Never let a display rollup block the engine banking rake. A failure here
  -- costs a stale panel; the function's fallback still reads the ledger.
  RAISE WARNING 'union_rake_weekly maintenance failed for tx %: %', NEW.id, SQLERRM;
  RETURN NULL;
END
$$;
DO $guard$ BEGIN IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='trg_union_rake_weekly' AND md5(p.prosrc)='35dbcba12e3c197de1997339e45d0276')<>1 THEN RAISE EXCEPTION 'launch_boundary_source_changed: trg_union_rake_weekly'; END IF; END $guard$;
CREATE OR REPLACE FUNCTION public.trg_union_rake_weekly() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  IF NOT public.fn_ca_launch_accounting_accepts(NEW.club_id,NEW.created_at) OR (public.fn_ca_launch_accounting_cutoff('union',NEW.union_id) IS NOT NULL AND (NEW.created_at IS NULL OR NEW.created_at<public.fn_ca_launch_accounting_cutoff('union',NEW.union_id))) THEN RETURN NULL; END IF;
  IF NEW.union_id IS NOT NULL
     AND NEW.wallet = 'rake_wallet'
     AND NEW.direction = 'credit'
     AND NEW.tx_type = 'rake' THEN
    INSERT INTO public.union_rake_weekly (union_id, club_id, week_start, rake_total, updated_at)
    VALUES (NEW.union_id, NEW.club_id, date_trunc('week', NEW.created_at)::date,
            COALESCE(NEW.amount, 0), now())
    ON CONFLICT ON CONSTRAINT union_rake_weekly_key DO UPDATE
      SET rake_total = public.union_rake_weekly.rake_total + EXCLUDED.rake_total,
          updated_at = now();
  END IF;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  -- Never let a display rollup block the engine banking rake. A failure here
  -- costs a stale panel; the function's fallback still reads the ledger.
  RAISE WARNING 'union_rake_weekly maintenance failed for tx %: %', NEW.id, SQLERRM;
  RETURN NULL;
END
$$;

CREATE TRIGGER native_union_rake AFTER INSERT ON union_wallet_transactions FOR EACH ROW EXECUTE FUNCTION trg_union_rake_weekly();
INSERT INTO union_wallet_transactions(union_id,club_id,created_at,wallet,direction,tx_type,amount) VALUES('fade0000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000001','2026-10-12 11:59Z','rake_wallet','credit','rake',10),('fade0000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000001','2026-10-12 12:01Z','rake_wallet','credit','rake',20),('a0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-000000000002','2026-10-12 11:59Z','rake_wallet','credit','rake',11);
DO $$ BEGIN IF (SELECT sum(rake_total) FROM union_rake_weekly WHERE club_id='a0000000-0000-0000-0000-000000000001')<>20 OR (SELECT sum(rake_total) FROM union_rake_weekly WHERE club_id='a0000000-0000-0000-0000-000000000002')<>11 THEN RAISE EXCEPTION 'union current generation reporting changed outside scope or resurrected old'; END IF; END $$;

DO $$ BEGIN IF fn_ca_launch_accounting_start('club','a0000000-0000-0000-0000-000000000001',NULL) IS NOT NULL OR fn_ca_launch_accounting_start('club','a0000000-0000-0000-0000-000000000001','-infinity') IS DISTINCT FROM '-infinity'::timestamptz OR fn_ca_launch_accounting_waived('club','a0000000-0000-0000-0000-000000000001','-infinity') THEN RAISE EXCEPTION 'invalid time was converted into launch waiver'; END IF; END $$;
