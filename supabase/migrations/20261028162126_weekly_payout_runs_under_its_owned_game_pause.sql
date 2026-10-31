-- Original global-owner wiring qualified in isolated native PostgreSQL.
-- Protected installation, production capacity and runtime proof remain separate.
-- Monday financial cascade uses one owned, bounded gameplay pause.
-- No new scheduler, payer, release worker, rate rewrite, or historical replay.
BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='5s';

CREATE TABLE public.weekly_accounting_payout_pauses (
 run_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 ownership_token uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
 period_start timestamptz NOT NULL,
 period_end timestamptz NOT NULL,
 announced_at timestamptz NOT NULL,
 money_starts_at timestamptz NOT NULL,
 money_deadline_at timestamptz NOT NULL,
 expires_at timestamptz NOT NULL,
 scope_plan jsonb NOT NULL,
 scope_fingerprint text GENERATED ALWAYS AS (md5(scope_plan::text)) STORED,
 phase text NOT NULL DEFAULT 'draining' CHECK(phase IN('draining','ready','paying','released')),
 instance_id text,
 lease_claims jsonb,
 acknowledged_at timestamptz,
 result jsonb,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(period_start,period_end),
 CHECK(isfinite(period_start) AND isfinite(period_end) AND period_start<period_end),
 CHECK(period_start=public.fn_union_prev_week_start(period_end)),
 CHECK(money_starts_at=public.fn_union_accounting_run_at(period_end)),
 CHECK(announced_at=money_starts_at-interval '2 minutes'),
 CHECK(money_deadline_at=money_starts_at+interval '240 seconds'),
 CHECK(expires_at=money_starts_at+interval '5 minutes'),
 CHECK(jsonb_typeof(scope_plan)='array' AND jsonb_array_length(scope_plan)>0)
);
ALTER TABLE public.weekly_accounting_payout_pauses ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.weekly_accounting_payout_pauses FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON TABLE public.weekly_accounting_payout_pauses TO service_role;
CREATE POLICY weekly_payout_engine_observes ON public.weekly_accounting_payout_pauses
 FOR SELECT TO service_role USING(true);

-- Existing engine subscription is a wake only; no new poller owns progress.
ALTER PUBLICATION supabase_realtime ADD TABLE public.weekly_accounting_payout_pauses;

CREATE FUNCTION smarter_private.weekly_payout_clock() RETURNS timestamptz
LANGUAGE sql VOLATILE SET search_path=pg_catalog AS $f$SELECT clock_timestamp()$f$;
REVOKE ALL ON FUNCTION smarter_private.weekly_payout_clock() FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION smarter_private.weekly_payout_pause_json(p_row public.weekly_accounting_payout_pauses)
RETURNS jsonb LANGUAGE sql VOLATILE SET search_path=pg_catalog,public AS $f$
 SELECT jsonb_build_object('contract','weekly-payout-owned-phase-v1',
  'observed_at',smarter_private.weekly_payout_clock(),
  'boundary',CASE WHEN p_row.run_id IS NULL THEN NULL ELSE jsonb_build_object(
   'run_id',p_row.run_id,'ownership_token',p_row.ownership_token,
   'scope_kind','global','scope_id',p_row.run_id,
   'period_start',p_row.period_start,'period_end',p_row.period_end,
   'announced_at',p_row.announced_at,'money_starts_at',p_row.money_starts_at,
   'money_deadline_at',p_row.money_deadline_at,'expires_at',p_row.expires_at,
   'phase',CASE WHEN smarter_private.weekly_payout_clock()>=p_row.expires_at THEN 'released' ELSE p_row.phase END
  )END)
$f$;
REVOKE ALL ON FUNCTION smarter_private.weekly_payout_pause_json(public.weekly_accounting_payout_pauses)
 FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.fn_weekly_accounting_payout_pause_state(p_run_id uuid DEFAULT NULL,p_ownership_token uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $f$
DECLARE r public.weekly_accounting_payout_pauses%ROWTYPE;
BEGIN
 IF NOT public.fn_caller_is_engine() THEN RAISE EXCEPTION 'service_role_required' USING ERRCODE='42501';END IF;
 IF (p_run_id IS NULL) IS DISTINCT FROM(p_ownership_token IS NULL) THEN
  RAISE EXCEPTION 'weekly_payout_exact_owner_required' USING ERRCODE='22023';END IF;
 IF p_run_id IS NULL THEN
  SELECT * INTO r FROM public.weekly_accounting_payout_pauses p
   -- R0/boot discovers this closed week's precomputed boundary before the
   -- announcement. The engine owns its finite deferred edge timers; it must
   -- not depend on an unrelated maintenance announcement to discover it.
   WHERE p.period_end=public.fn_union_week_start(smarter_private.weekly_payout_clock())
    AND p.expires_at>smarter_private.weekly_payout_clock() AND p.phase<>'released'
   ORDER BY p.money_starts_at DESC LIMIT 1;
 ELSE
  SELECT * INTO r FROM public.weekly_accounting_payout_pauses p
   WHERE p.run_id=p_run_id AND p.ownership_token=p_ownership_token;
  IF NOT FOUND THEN RAISE EXCEPTION 'weekly_payout_exact_owner_unknown' USING ERRCODE='55000';END IF;
 END IF;
 RETURN smarter_private.weekly_payout_pause_json(r);
END $f$;
REVOKE ALL ON FUNCTION public.fn_weekly_accounting_payout_pause_state(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_weekly_accounting_payout_pause_state(uuid,uuid) TO service_role;

CREATE FUNCTION smarter_private.weekly_payout_claims_match(p_instance text,p_claims jsonb)
RETURNS boolean LANGUAGE plpgsql STABLE SET search_path=pg_catalog,public AS $f$
BEGIN
 IF NULLIF(btrim(p_instance),'') IS NULL OR jsonb_typeof(p_claims) IS DISTINCT FROM 'array'
  OR jsonb_array_length(p_claims)=0 THEN RETURN false;END IF;
 IF EXISTS(SELECT FROM jsonb_array_elements(p_claims) j
   WHERE j->>'scope' NOT IN('cash','tournament') OR j->>'scope' IS NULL OR j->>'lease_generation' IS NULL
    OR CASE WHEN j->>'scope'='cash' THEN j->>'table_id' IS NULL OR j->>'tournament_id' IS NOT NULL
      ELSE j->>'tournament_id' IS NULL OR j->>'table_id' IS NOT NULL END)
  OR EXISTS(SELECT FROM jsonb_array_elements(p_claims) j GROUP BY j->>'scope',COALESCE(j->>'table_id',j->>'tournament_id') HAVING count(*)<>1)
 THEN RETURN false;END IF;
 -- A single current process must account for the complete live fleet. An
 -- unknown second process is an explicit refusal, never an omitted scope.
 IF EXISTS(SELECT FROM public.engine_table_leases l
   WHERE l.heartbeat_at>=smarter_private.weekly_payout_clock()-interval '30 seconds'
    AND (l.instance_id IS DISTINCT FROM p_instance OR l.protocol_version<>2
     OR NOT EXISTS(SELECT FROM jsonb_array_elements(p_claims) j
      WHERE j->>'scope'='cash' AND (j->>'table_id')::uuid=l.table_id
       AND (j->>'lease_generation')::uuid=l.lease_generation)))
  OR EXISTS(SELECT FROM public.engine_tournament_leases l
   WHERE l.heartbeat_at>=smarter_private.weekly_payout_clock()-interval '30 seconds'
    AND (l.instance_id IS DISTINCT FROM p_instance OR l.protocol_version<>2
     OR NOT EXISTS(SELECT FROM jsonb_array_elements(p_claims) j
      WHERE j->>'scope'='tournament' AND (j->>'tournament_id')::uuid=l.tournament_id
       AND (j->>'lease_generation')::uuid=l.lease_generation)))
 THEN RETURN false;END IF;
 IF EXISTS(SELECT FROM jsonb_array_elements(p_claims) j WHERE
  CASE WHEN j->>'scope'='cash' THEN NOT EXISTS(SELECT FROM public.engine_table_leases l
    WHERE l.table_id=(j->>'table_id')::uuid AND l.instance_id=p_instance
     AND l.lease_generation=(j->>'lease_generation')::uuid AND l.protocol_version=2
     AND l.heartbeat_at>=smarter_private.weekly_payout_clock()-interval '30 seconds')
   ELSE NOT EXISTS(SELECT FROM public.engine_tournament_leases l
    WHERE l.tournament_id=(j->>'tournament_id')::uuid AND l.instance_id=p_instance
     AND l.lease_generation=(j->>'lease_generation')::uuid AND l.protocol_version=2
     AND l.heartbeat_at>=smarter_private.weekly_payout_clock()-interval '30 seconds') END)
 THEN RETURN false;END IF;
 RETURN true;
END $f$;
REVOKE ALL ON FUNCTION smarter_private.weekly_payout_claims_match(text,jsonb) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.fn_weekly_accounting_payout_pause_ack(p_run_id uuid,p_ownership_token uuid,p_instance_id text,p_claims jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET lock_timeout='1s' AS $f$
DECLARE r public.weekly_accounting_payout_pauses%ROWTYPE;
BEGIN
 IF NOT public.fn_caller_is_engine() THEN RAISE EXCEPTION 'service_role_required' USING ERRCODE='42501';END IF;
 IF NOT smarter_private.weekly_payout_claims_match(p_instance_id,p_claims) THEN
  RAISE EXCEPTION 'weekly_payout_complete_original_fleet_required' USING ERRCODE='55000';END IF;
 SELECT jsonb_agg(j ORDER BY j->>'scope',COALESCE(j->>'table_id',j->>'tournament_id'))
  INTO p_claims FROM jsonb_array_elements(p_claims)j;
 SELECT * INTO STRICT r FROM public.weekly_accounting_payout_pauses p
  WHERE p.run_id=p_run_id AND p.ownership_token=p_ownership_token FOR UPDATE;
 IF r.phase='released' THEN RETURN smarter_private.weekly_payout_pause_json(r);END IF;
 IF smarter_private.weekly_payout_clock()<r.announced_at OR smarter_private.weekly_payout_clock()>=r.money_deadline_at THEN
  RAISE EXCEPTION 'weekly_payout_ack_outside_original_deadline' USING ERRCODE='55000';END IF;
 IF r.phase NOT IN('draining','ready') OR NOT smarter_private.weekly_payout_claims_match(p_instance_id,p_claims)
 THEN RAISE EXCEPTION 'weekly_payout_complete_original_fleet_required' USING ERRCODE='55000';END IF;
 IF r.phase='ready' AND (r.instance_id IS DISTINCT FROM p_instance_id OR r.lease_claims IS DISTINCT FROM p_claims)
 THEN RAISE EXCEPTION 'weekly_payout_acknowledged_owner_changed' USING ERRCODE='55000';END IF;
 UPDATE public.weekly_accounting_payout_pauses SET phase='ready',instance_id=p_instance_id,
  lease_claims=p_claims,acknowledged_at=smarter_private.weekly_payout_clock()
  WHERE run_id=r.run_id RETURNING * INTO r;
 RETURN smarter_private.weekly_payout_pause_json(r);
END $f$;
REVOKE ALL ON FUNCTION public.fn_weekly_accounting_payout_pause_ack(uuid,uuid,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_weekly_accounting_payout_pause_ack(uuid,uuid,text,jsonb) TO service_role;

-- Original scheduler/cascade, admission fences, native qualification and
-- installation postimages follow in this SAME migration before release.

CREATE FUNCTION smarter_private.weekly_payout_eligible_scopes(p_end timestamptz,p_now timestamptz)
RETURNS TABLE(kind text,id uuid,first_week timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $f$
DECLARE v_to timestamptz:=p_end;v_now timestamptz:=p_now;v_chunked boolean:=true;
BEGIN
 IF md5(pg_get_functiondef('public.fn_process_weekly_accounting_scope(uuid,uuid)'::regprocedure))<>'aa771409420704b6dd05cfaef9d2f8dc'
 THEN RAISE EXCEPTION 'weekly_payout_original_scope_authority_changed' USING ERRCODE='55000';END IF;
 RETURN QUERY
WITH cash_clubs AS MATERIALIZED (
          SELECT DISTINCT s.club_id FROM public.accounting_cash_rake_sources s
          WHERE s.coordinator_union_id IS NULL AND s.earned_at<v_to
        ), cash_cutoffs AS MATERIALIZED (
          SELECT c.club_id,public.fn_ca_launch_accounting_cutoff('club',c.club_id) AS cutoff FROM cash_clubs c
        ), standalone_earned AS (
          SELECT s.club_id,s.earned_at FROM public.accounting_cash_rake_sources s
          LEFT JOIN cash_cutoffs c ON c.club_id=s.club_id
          WHERE s.coordinator_union_id IS NULL AND s.earned_at<v_to
            AND CASE WHEN c.cutoff IS NULL THEN true
              ELSE s.earned_at IS NOT NULL AND isfinite(s.earned_at) AND s.earned_at>=c.cutoff END
          UNION ALL
          -- STANDALONE TOURNAMENT EARNINGS ARE READ PER CLUB (20261022150614): this branch
          -- used to read the tournament_fee_accrual half of
          -- accounting_payable_earning_sources for every source row on every tick
          -- (1.7M recognition probes, 10 s warm and over 100 s cold), which spent
          -- the close attempt's own 3-minute budget before the attempt began.
          -- The predicate below is that view branch verbatim, read per club from
          -- the club's own standalone fee rows. Only eligible below reads these
          -- rows, as GREATEST(first week, the club's settlement floor) for clubs
          -- that are not unions, so a club with any such earning before its floor
          -- contributes the floor itself and is not read further; any other club
          -- contributes its earliest earning (and earliest finite one).
          SELECT tc.id AS club_id,te.earned_at FROM public.clubs tc
          CROSS JOIN LATERAL (SELECT public.fn_club_settlement_floor_week(tc.id) AS floor) tf
          CROSS JOIN LATERAL (SELECT CASE WHEN tf.floor IS NOT NULL AND EXISTS(SELECT 1
              FROM (SELECT s.id,s.tournament_id,s.club_id,s.union_id,s.charged_at,s.rake_credit FROM public.accounting_tournament_fee_sources s
                     WHERE s.club_id=tc.id AND s.coordinator_union_id IS NULL OFFSET 0) s
              JOIN public.accounting_tournament_recognized_sources rs ON rs.source_id=s.id AND rs.tournament_id=s.tournament_id
              JOIN public.accounting_tournament_fee_recognitions r ON r.tournament_id=s.tournament_id
              LEFT JOIN public.fn_ca_launch_accounting_club_cutoffs() bd(club_id,cutoff_at) ON bd.club_id=s.club_id
              WHERE (bd.cutoff_at IS NULL OR s.charged_at IS NOT NULL AND isfinite(s.charged_at) AND s.charged_at>=bd.cutoff_at)
                AND (bd.cutoff_at IS NULL OR rs.recognized_at IS NOT NULL AND isfinite(rs.recognized_at) AND rs.recognized_at>=bd.cutoff_at)
                AND rs.disposition='earned' AND r.status='recognized' AND rs.rake_credit=s.rake_credit AND rs.recognized_at=r.recognized_at
                AND NOT s.union_id IS DISTINCT FROM r.union_id AND rs.recognized_at<v_to AND rs.recognized_at<tf.floor)
            THEN tf.floor END AS clamp) tk
          CROSS JOIN LATERAL (
            SELECT tk.clamp AS earned_at WHERE tk.clamp IS NOT NULL
            UNION ALL
            SELECT tm.earned_at FROM (SELECT min(rs.recognized_at) AS m,min(rs.recognized_at) FILTER(WHERE isfinite(rs.recognized_at)) AS mf
              FROM (SELECT s.id,s.tournament_id,s.club_id,s.union_id,s.charged_at,s.rake_credit FROM public.accounting_tournament_fee_sources s
                     WHERE s.club_id=tc.id AND s.coordinator_union_id IS NULL OFFSET 0) s
              JOIN public.accounting_tournament_recognized_sources rs ON rs.source_id=s.id AND rs.tournament_id=s.tournament_id
              JOIN public.accounting_tournament_fee_recognitions r ON r.tournament_id=s.tournament_id
              LEFT JOIN public.fn_ca_launch_accounting_club_cutoffs() bd(club_id,cutoff_at) ON bd.club_id=s.club_id
              WHERE tk.clamp IS NULL AND (bd.cutoff_at IS NULL OR s.charged_at IS NOT NULL AND isfinite(s.charged_at) AND s.charged_at>=bd.cutoff_at)
                AND (bd.cutoff_at IS NULL OR rs.recognized_at IS NOT NULL AND isfinite(rs.recognized_at) AND rs.recognized_at>=bd.cutoff_at)
                AND rs.disposition='earned' AND r.status='recognized' AND rs.rake_credit=s.rake_credit AND rs.recognized_at=r.recognized_at
                AND NOT s.union_id IS DISTINCT FROM r.union_id AND rs.recognized_at<v_to) ta
            CROSS JOIN LATERAL (VALUES(ta.m),(ta.mf)) tm(earned_at) WHERE tm.earned_at IS NOT NULL) te
          WHERE tc.is_union IS NOT TRUE
        ), standalone_work AS (
          SELECT s.club_id,LEAST(public.fn_union_week_start(min(s.earned_at) FILTER(WHERE isfinite(s.earned_at))),min(s.earned_at)) AS first_week
           FROM standalone_earned s GROUP BY s.club_id
          UNION ALL SELECT q.standalone_club_id,q.period_start FROM public.union_accounting_runs q
           WHERE q.standalone_club_id IS NOT NULL AND q.status<>'complete'
          UNION ALL SELECT q.standalone_club_id,q.period_start FROM public.union_accounting_runs q
           WHERE q.standalone_club_id IS NOT NULL AND q.status='complete' AND q.period_end<v_to
            AND NOT EXISTS(SELECT 1 FROM public.union_accounting_runs later
              WHERE later.standalone_club_id=q.standalone_club_id AND later.period_end>q.period_end)
          UNION ALL SELECT rp.club_id,min(public.fn_union_week_start(rp.period_start::timestamp AT TIME ZONE 'America/Los_Angeles'))
           FROM public.rakeback_periods rp WHERE rp.status='pending' AND rp.period_end<(v_to AT TIME ZONE 'America/Los_Angeles')::date
            AND NOT EXISTS(SELECT 1 FROM public.union_clubs uc WHERE uc.club_id=rp.club_id) GROUP BY rp.club_id
          UNION ALL SELECT a.club_id,public.fn_union_prev_week_start(v_now) FROM public.agents a
           WHERE NOT COALESCE(a.is_prepaid,false) AND a.credit_used>0 AND NOT EXISTS(SELECT 1 FROM public.union_clubs uc WHERE uc.club_id=a.club_id)
        ), union_floors AS (
          SELECT u.id,f.earliest_period_start,CASE WHEN f.earliest_period_start IS NULL THEN public.fn_union_prev_week_start(v_now)
             WHEN public.fn_union_week_start(f.earliest_period_start)<f.earliest_period_start
              THEN public.fn_union_week_start(public.fn_union_week_start(f.earliest_period_start)+interval '8 days')
             ELSE public.fn_union_week_start(f.earliest_period_start) END AS first_week
           FROM public.unions u LEFT JOIN public.union_settlement_floor f ON f.union_id=u.id
        ), union_work AS (
          SELECT u.id,LEAST(u.first_week,(SELECT min(q.period_start) FROM public.union_accounting_runs q
            WHERE q.union_id=u.id
              AND (q.status<>'complete' OR (u.earliest_period_start IS NULL
                AND q.status='complete' AND q.result->>'success'='true' AND q.result->>'accounting_version'='3'))
              AND (u.earliest_period_start IS NULL OR q.period_start>=u.first_week))) AS first_week
           FROM union_floors u
        ), eligible AS (
          -- Match the exact-scope floor rounding and per-week due check. An
          -- older union backlog remains due before this Monday's new close.
          SELECT 'union'::text AS kind,w.id FROM union_work w WHERE w.first_week<v_to
           AND v_now>=CASE WHEN v_chunked THEN public.fn_union_week_start(w.first_week+interval '8 days') ELSE public.fn_union_accounting_run_at(public.fn_union_week_start(w.first_week+interval '8 days')) END
          UNION ALL SELECT 'club',w.club_id FROM standalone_work w JOIN public.clubs c ON c.id=w.club_id
           WHERE c.is_union IS NOT TRUE AND GREATEST(w.first_week,public.fn_club_settlement_floor_week(w.club_id))<v_to
            AND v_now>=CASE WHEN v_chunked THEN public.fn_union_week_start(GREATEST(w.first_week,public.fn_club_settlement_floor_week(w.club_id))+interval '8 days') ELSE public.fn_union_accounting_run_at(public.fn_union_week_start(GREATEST(w.first_week,public.fn_club_settlement_floor_week(w.club_id))+interval '8 days')) END GROUP BY w.club_id
        )
 SELECT e.kind,e.id,CASE WHEN e.kind='union' THEN (SELECT min(w.first_week) FROM union_work w WHERE w.id=e.id)
  ELSE (SELECT min(GREATEST(w.first_week,public.fn_club_settlement_floor_week(w.club_id))) FROM standalone_work w WHERE w.club_id=e.id) END
 FROM eligible e ORDER BY (e.kind='union') DESC,e.id;
END $f$;
REVOKE ALL ON FUNCTION smarter_private.weekly_payout_eligible_scopes(timestamptz,timestamptz)
 FROM PUBLIC,anon,authenticated,service_role;


CREATE TABLE smarter_private.weekly_payout_phase_configuration (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 cutover_period_end timestamptz NOT NULL,
 installed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO smarter_private.weekly_payout_phase_configuration(singleton,cutover_period_end)
 SELECT true,CASE WHEN clock_timestamp()<public.fn_union_accounting_run_at(public.fn_union_week_start(clock_timestamp()))
  THEN public.fn_union_week_start(clock_timestamp()) ELSE public.fn_union_week_start(clock_timestamp()+interval '8 days') END;
REVOKE ALL ON TABLE smarter_private.weekly_payout_phase_configuration FROM PUBLIC,anon,authenticated,service_role;
CREATE TABLE smarter_private.weekly_payout_financial_receipts (
 scope_kind text NOT NULL CHECK(scope_kind IN('union','club')),
 scope_id uuid NOT NULL,period_start timestamptz NOT NULL,period_end timestamptz NOT NULL,
 run_id uuid NOT NULL REFERENCES public.weekly_accounting_payout_pauses(run_id),
 original_round_receipts jsonb NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(scope_kind,scope_id,period_start,period_end)
);
REVOKE ALL ON TABLE smarter_private.weekly_payout_financial_receipts FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION smarter_private.weekly_payout_scope_plan(p_end timestamptz,p_now timestamptz)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $f$
DECLARE c timestamptz;sc record;ws timestamptz;we timestamptz;result jsonb:='[]'::jsonb;
BEGIN
 SELECT cutover_period_end INTO STRICT c FROM smarter_private.weekly_payout_phase_configuration WHERE singleton;
 FOR sc IN SELECT * FROM smarter_private.weekly_payout_eligible_scopes(p_end,p_now) LOOP
  ws:=GREATEST(sc.first_week,public.fn_union_prev_week_start(c));
  IF ws IS NULL OR NOT isfinite(ws) OR ws<>public.fn_union_week_start(ws)
  THEN RAISE EXCEPTION 'weekly_payout_scope_calendar_unproven' USING ERRCODE='55000';END IF;
  WHILE ws<p_end LOOP
   we:=public.fn_union_week_start(ws+interval '8 days');
   IF we>p_end OR we<=ws THEN RAISE EXCEPTION 'weekly_payout_scope_calendar_invalid';END IF;
   IF NOT EXISTS(SELECT FROM smarter_private.weekly_payout_financial_receipts r
    WHERE r.scope_kind=sc.kind AND r.scope_id=sc.id AND r.period_start=ws AND r.period_end=we)
    AND NOT EXISTS(SELECT FROM public.union_accounting_runs q
     WHERE q.scope_kind=sc.kind AND q.scope_id=sc.id AND q.period_start=ws AND q.period_end=we
      AND q.status='complete' AND q.result->>'success'='true' AND q.result->>'accounting_version'='3') THEN
    result:=result||jsonb_build_array(jsonb_build_object('kind',sc.kind,'id',sc.id,'period_start',ws,'period_end',we));
   END IF;
   ws:=we;
  END LOOP;
 END LOOP;
 RETURN (SELECT COALESCE(jsonb_agg(j ORDER BY (j->>'period_start')::timestamptz,(j->>'kind'='union') DESC,j->>'id'),'[]'::jsonb)FROM jsonb_array_elements(result)j);
END $f$;
REVOKE ALL ON FUNCTION smarter_private.weekly_payout_scope_plan(timestamptz,timestamptz) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION smarter_private.weekly_payout_prepare_due()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $f$
DECLARE n timestamptz:=smarter_private.weekly_payout_clock();e timestamptz:=public.fn_union_week_start(n);
 due timestamptz:=public.fn_union_accounting_run_at(e);cutover timestamptz;plan jsonb;item jsonb;preparation jsonb;
 problems jsonb:='[]'::jsonb;had_windows boolean;began timestamptz:=clock_timestamp();r public.weekly_accounting_payout_pauses%ROWTYPE;
BEGIN
 IF NOT public.fn_caller_is_engine() THEN RAISE EXCEPTION 'service_role_required' USING ERRCODE='42501';END IF;
 SELECT cutover_period_end INTO STRICT cutover FROM smarter_private.weekly_payout_phase_configuration WHERE singleton;
 IF e<cutover OR n<e OR n>=due THEN RETURN NULL;END IF;
 IF COALESCE(current_setting('app.weekly_accounting_chunked',true),'')<>'on'
  OR current_setting('statement_timeout')::interval IS DISTINCT FROM interval '240 seconds'
 THEN RAISE EXCEPTION 'weekly_payout_original_bounded_tick_required' USING ERRCODE='55000';END IF;
 plan:=smarter_private.weekly_payout_scope_plan(e,n);
 IF jsonb_array_length(plan)=0 THEN RETURN NULL;END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(plan) LOOP
  IF clock_timestamp()-began>interval '30 seconds' THEN
   problems:=problems||jsonb_build_array(jsonb_build_object('reason','preparation_budget','scope',item));EXIT;
  END IF;
  PERFORM public.fn_weekly_accounting_attempt_begin(item->>'kind'='union');
  BEGIN
   preparation:=public.fn_prepare_accounting_week(CASE WHEN item->>'kind'='union' THEN (item->>'id')::uuid END,
    CASE WHEN item->>'kind'='club' THEN (item->>'id')::uuid END,(item->>'period_start')::timestamptz,(item->>'period_end')::timestamptz);
   had_windows:=false;
   IF preparation->>'success'='true' THEN
    had_windows:=public.fn_accounting_close_windows_pending(CASE WHEN item->>'kind'='union' THEN (item->>'id')::uuid END,
     CASE WHEN item->>'kind'='club' THEN (item->>'id')::uuid END,(item->>'period_start')::timestamptz,(item->>'period_end')::timestamptz);
   END IF;
   IF preparation->>'success' IS DISTINCT FROM 'true' OR had_windows THEN
    problems:=problems||jsonb_build_array(jsonb_build_object('scope',item,'preparation',preparation,'windows_pending',had_windows));
   END IF;
  EXCEPTION WHEN OTHERS THEN
   problems:=problems||jsonb_build_array(jsonb_build_object('scope',item,'error',SQLERRM,'sqlstate',SQLSTATE));
  END;
  PERFORM public.fn_weekly_accounting_attempt_end();
 END LOOP;
 IF jsonb_array_length(problems)>0 THEN
  RETURN jsonb_build_object('success',false,'owns_tick',true,'advanced',true,'stage','weekly_payout_preparing','problems',problems);
 END IF;
 INSERT INTO public.weekly_accounting_payout_pauses(period_start,period_end,announced_at,money_starts_at,money_deadline_at,expires_at,scope_plan)
 VALUES(public.fn_union_prev_week_start(e),e,due-interval '2 minutes',due,due+interval '240 seconds',due+interval '5 minutes',plan)
 ON CONFLICT(period_start,period_end)DO NOTHING;
 SELECT * INTO STRICT r FROM public.weekly_accounting_payout_pauses p WHERE p.period_end=e;
 IF r.scope_plan IS DISTINCT FROM plan THEN RAISE EXCEPTION 'weekly_payout_prepared_scope_changed' USING ERRCODE='55000';END IF;
 RETURN jsonb_build_object('success',false,'owns_tick',true,'advanced',true,'stage','weekly_payout_prepared','run_id',r.run_id);
END $f$;
REVOKE ALL ON FUNCTION smarter_private.weekly_payout_prepare_due() FROM PUBLIC,anon,authenticated,service_role;

-- This private capability is minted only inside the original DUE transaction.
-- Neither an RPC parameter, a user-set GUC, nor a gameplay freeze bit grants
-- permission to move chips. Rollback removes it; successful completion removes
-- it before returning to any post-money book work.
CREATE TABLE smarter_private.weekly_payout_owned_transactions (
 backend_pid integer NOT NULL,transaction_id bigint NOT NULL,
 run_id uuid NOT NULL REFERENCES public.weekly_accounting_payout_pauses(run_id),
 scope_kind text NOT NULL CHECK(scope_kind IN('union','club')),
 scope_id uuid NOT NULL,period_start timestamptz NOT NULL,period_end timestamptz NOT NULL,
 round_no integer NOT NULL CHECK(round_no BETWEEN 1 AND 3),
 PRIMARY KEY(backend_pid,transaction_id)
);
REVOKE ALL ON TABLE smarter_private.weekly_payout_owned_transactions FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION smarter_private.weekly_payout_owns_round(p_kind text,p_id uuid,p_from timestamptz,p_to timestamptz,p_round integer)
RETURNS boolean LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public AS $f$
 SELECT EXISTS(SELECT FROM smarter_private.weekly_payout_owned_transactions c
  JOIN public.weekly_accounting_payout_pauses r ON r.run_id=c.run_id
  WHERE c.backend_pid=pg_backend_pid() AND c.transaction_id=txid_current()
   AND c.scope_kind=p_kind AND c.scope_id=p_id AND c.period_start=p_from AND c.period_end=p_to AND c.round_no=p_round
   AND r.phase='paying' AND r.acknowledged_at>=r.announced_at AND r.acknowledged_at<r.money_deadline_at
   AND smarter_private.weekly_payout_clock()>=r.money_starts_at
   AND smarter_private.weekly_payout_clock()<r.money_deadline_at
   AND EXISTS(SELECT FROM jsonb_array_elements(r.scope_plan) j WHERE j->>'kind'=p_kind AND (j->>'id')::uuid=p_id
    AND (j->>'period_start')::timestamptz=p_from AND (j->>'period_end')::timestamptz=p_to))
$f$;
REVOKE ALL ON FUNCTION smarter_private.weekly_payout_owns_round(text,uuid,timestamptz,timestamptz,integer) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION smarter_private.weekly_payout_require_round(p_kind text,p_id uuid,p_from timestamptz,p_to timestamptz,p_round integer)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $f$
BEGIN
 -- This change never reinterprets an old paid contract or the incident week.
 IF p_to<(SELECT cutover_period_end FROM smarter_private.weekly_payout_phase_configuration WHERE singleton) THEN RETURN;END IF;
 IF NOT smarter_private.weekly_payout_owns_round(p_kind,p_id,p_from,p_to,p_round) THEN
  RAISE EXCEPTION 'weekly_payout_original_owned_phase_required' USING ERRCODE='55000';END IF;
 PERFORM public.fn_weekly_accounting_deadline_check();
END $f$;
REVOKE ALL ON FUNCTION smarter_private.weekly_payout_require_round(text,uuid,timestamptz,timestamptz,integer) FROM PUBLIC,anon,authenticated,service_role;

-- One original business invocation owns all financial passes. The run, scope
-- and round capability never survives this transaction. Full original earning
-- and payer checks remain in each financial owner; P&L/docs are not called.
CREATE FUNCTION smarter_private.weekly_payout_execute(p_run uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET lock_timeout='1s' AS $f$
DECLARE r public.weekly_accounting_payout_pauses%ROWTYPE;item jsonb;res jsonb;prep jsonb;
 round integer;k text;id uuid;ws timestamptz;we timestamptz;receipts jsonb:='[]'::jsonb;
 began timestamptz:=smarter_private.weekly_payout_clock();
BEGIN
 IF NOT public.fn_caller_is_engine() THEN RAISE EXCEPTION 'service_role_required' USING ERRCODE='42501';END IF;
 IF current_setting('statement_timeout')::interval IS DISTINCT FROM interval '240 seconds'
  OR COALESCE(current_setting('app.weekly_accounting_chunked',true),'')<>'on'
 THEN RAISE EXCEPTION 'weekly_payout_original_240s_tick_required' USING ERRCODE='55000';END IF;
 SELECT * INTO STRICT r FROM public.weekly_accounting_payout_pauses WHERE run_id=p_run;
 -- The original 04:00 invocation waits for its own physical fleet barrier.
 -- Do not lock the row before ACK: that would block the engine transaction
 -- needed to release this very wait. This bounded wait is part of the SAME
 -- original DUE statement, never a repair worker, new payer or renewed lease.
 WHILE r.phase='draining' AND smarter_private.weekly_payout_clock()>=r.money_starts_at
  AND smarter_private.weekly_payout_clock()+interval '180 seconds'<r.money_deadline_at LOOP
  PERFORM pg_sleep(0.05);
  SELECT * INTO STRICT r FROM public.weekly_accounting_payout_pauses WHERE run_id=p_run;
 END LOOP;
 SELECT * INTO STRICT r FROM public.weekly_accounting_payout_pauses WHERE run_id=p_run FOR UPDATE;
 began:=smarter_private.weekly_payout_clock();
 IF r.phase='released' THEN RETURN r.result||jsonb_build_object('duplicate',true);END IF;
 -- The original 180s scope must fit before the absolute money deadline and
 -- the original 240s statement must fit before the gameplay lease. Admission
 -- never renews either clock. Actual start time is retained rather than
 -- calling a late cron invocation an on-time four-o'clock payout.
 IF r.phase<>'ready' OR r.acknowledged_at>=r.money_deadline_at OR r.acknowledged_at IS NULL
  OR began<r.money_starts_at OR began+interval '180 seconds'>=r.money_deadline_at
  OR statement_timestamp()+interval '240 seconds'>=r.expires_at
  OR NOT smarter_private.weekly_payout_claims_match(r.instance_id,r.lease_claims)
 THEN RAISE EXCEPTION 'weekly_payout_not_prepared_and_parked_at_four' USING ERRCODE='55000';END IF;
 IF r.scope_plan IS DISTINCT FROM smarter_private.weekly_payout_scope_plan(r.period_end,began)
 THEN RAISE EXCEPTION 'weekly_payout_prepared_scope_changed' USING ERRCODE='55000';END IF;
 PERFORM public.fn_weekly_accounting_attempt_begin(true);
 -- Revalidate original prepared earning/certificate owners immediately before
 -- any financial capability exists. Changed applicable source evidence must
 -- refuse or be admitted by its original producer, never by a current-rate
 -- rewrite here. No old paid JSON, timestamps or fingerprints are retagged.
 FOR item IN SELECT value FROM jsonb_array_elements(r.scope_plan) LOOP
  PERFORM public.fn_weekly_accounting_deadline_check();
  prep:=public.fn_prepare_accounting_week(CASE WHEN item->>'kind'='union' THEN (item->>'id')::uuid END,
   CASE WHEN item->>'kind'='club' THEN (item->>'id')::uuid END,(item->>'period_start')::timestamptz,(item->>'period_end')::timestamptz);
  IF prep->>'success' IS DISTINCT FROM 'true' THEN
   RAISE EXCEPTION 'weekly_payout_precommit_preparation_changed' USING ERRCODE='55000',DETAIL=prep::text;END IF;
 END LOOP;
 UPDATE public.weekly_accounting_payout_pauses SET phase='paying' WHERE run_id=r.run_id;
 -- This outer order is deliberate: ALL club funding, then ALL agent gross
 -- pass-downs, and only then ANY player/horse secondary payment.
 FOR round IN 1..3 LOOP
  FOR item IN SELECT value FROM jsonb_array_elements(r.scope_plan) LOOP
   k:=item->>'kind';id:=(item->>'id')::uuid;ws:=(item->>'period_start')::timestamptz;we:=(item->>'period_end')::timestamptz;
   PERFORM public.fn_weekly_accounting_deadline_check();
   IF smarter_private.weekly_payout_clock()>=r.money_deadline_at THEN
    RAISE EXCEPTION 'weekly_payout_absolute_money_deadline' USING ERRCODE='57014';END IF;
   INSERT INTO smarter_private.weekly_payout_owned_transactions(backend_pid,transaction_id,run_id,scope_kind,scope_id,period_start,period_end,round_no)
   VALUES(pg_backend_pid(),txid_current(),r.run_id,k,id,ws,we,round)
   ON CONFLICT(backend_pid,transaction_id)DO UPDATE SET scope_kind=EXCLUDED.scope_kind,scope_id=EXCLUDED.scope_id,
    period_start=EXCLUDED.period_start,period_end=EXCLUDED.period_end,round_no=EXCLUDED.round_no;
   IF round=1 THEN
    -- The original R1 closes and posts its own treasury debit; there is no
    -- transaction-local debit deferred until slow post-money documents.
    PERFORM set_config('app.union_close_defer_rake_debit','',true);
    IF k='union' THEN
     res:=public.fn_union_weekly_rakeback_close(id,ws,we);
     IF res->>'success' IS DISTINCT FROM 'true' AND res->>'error' IS DISTINCT FROM 'already_executed' THEN
      RAISE EXCEPTION 'weekly_payout_original_round1_refused' USING DETAIL=res::text;END IF;
    ELSE
     res:=public.fn_bank_standalone_week_rake(id,ws,we);
     IF res->>'ok' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'weekly_payout_original_club_bank_refused' USING DETAIL=res::text;END IF;
    END IF;
   ELSIF round=2 THEN
    res:=public.fn_settle_accounting_commission_stage(k,id,ws,we);
   ELSE
    res:=public.fn_settle_accounting_rakeback_stage(k,id,ws,we);
   END IF;
   IF round IN(2,3) AND (res->>'success' IS DISTINCT FROM 'true' OR res->>'routing_version' IS DISTINCT FROM '3'
    OR res->>'source_version' IS DISTINCT FROM '2' OR COALESCE((res->>'shortfalls')::integer,0)<>0
    OR res->>'batch_committed'='true' OR NOT EXISTS(SELECT FROM public.accounting_routed_settlement_runs x
     WHERE x.scope_kind=k AND x.scope_id=id AND x.period_start=ws AND x.period_end=we AND x.round_no=round AND x.result=(res-'duplicate')))
   THEN RAISE EXCEPTION 'weekly_payout_original_financial_receipt_required' USING ERRCODE='23514',DETAIL=res::text;END IF;
   IF k='union' THEN
    INSERT INTO public.union_settlement_rounds(union_id,period_start,period_end,round_no,round_name,payers,payees,amount,shortfalls,detail)
    VALUES(id,ws,we,round,CASE round WHEN 1 THEN 'union_to_clubs' WHEN 2 THEN 'club_to_agents' ELSE 'agents_to_players' END,
     CASE WHEN round=1 THEN 1 END,COALESCE((res->>'payees')::integer,(res->>'clubs_paid')::integer,0),
     COALESCE((res->>'amount')::numeric,(res->>'total_rakeback')::numeric,0),COALESCE((res->>'shortfalls')::integer,0),res)
    ON CONFLICT(union_id,period_start,period_end,round_no)DO NOTHING;
   END IF;
   receipts:=receipts||jsonb_build_array(jsonb_build_object('scope',item,'round',round,'receipt',res));
  END LOOP;
 END LOOP;
 PERFORM public.fn_weekly_accounting_deadline_check();
 IF smarter_private.weekly_payout_clock()>=r.money_deadline_at THEN
  RAISE EXCEPTION 'weekly_payout_absolute_money_deadline' USING ERRCODE='57014';END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(r.scope_plan) LOOP
  INSERT INTO smarter_private.weekly_payout_financial_receipts(scope_kind,scope_id,period_start,period_end,run_id,original_round_receipts)
  VALUES(item->>'kind',(item->>'id')::uuid,(item->>'period_start')::timestamptz,(item->>'period_end')::timestamptz,r.run_id,
   (SELECT jsonb_agg(j ORDER BY (j->>'round')::int) FROM jsonb_array_elements(receipts)j WHERE j->'scope'=item));
 END LOOP;
 DELETE FROM smarter_private.weekly_payout_owned_transactions WHERE backend_pid=pg_backend_pid() AND transaction_id=txid_current();
 PERFORM public.fn_weekly_accounting_attempt_end();
 res:=jsonb_build_object('success',true,'owns_tick',true,'advanced',true,'stage','weekly_payout_financial_complete',
  'run_id',r.run_id,'scheduled_for',r.money_starts_at,'financial_started_at',began,
  'financial_finished_at',smarter_private.weekly_payout_clock(),'books_complete',false,'original_receipts',receipts);
 UPDATE public.weekly_accounting_payout_pauses SET phase='released',result=res WHERE run_id=r.run_id;
 RETURN res;
END $f$;
REVOKE ALL ON FUNCTION smarter_private.weekly_payout_execute(uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION smarter_private.weekly_payout_due()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $f$
DECLARE n timestamptz:=smarter_private.weekly_payout_clock();e timestamptz:=public.fn_union_week_start(n);
 due timestamptz:=public.fn_union_accounting_run_at(e);c timestamptz;r public.weekly_accounting_payout_pauses%ROWTYPE;answer jsonb;
BEGIN
 SELECT cutover_period_end INTO STRICT c FROM smarter_private.weekly_payout_phase_configuration WHERE singleton;
 IF e<c THEN RETURN NULL;END IF;
 IF NOT pg_try_advisory_xact_lock(hashtextextended('union-accounting-scheduler',0)) THEN
  RETURN jsonb_build_object('success',false,'owns_tick',true,'advanced',false,'stage','weekly_payout_original_scheduler_owned');END IF;
 IF n<due THEN RETURN smarter_private.weekly_payout_prepare_due();END IF;
 SELECT * INTO r FROM public.weekly_accounting_payout_pauses p WHERE p.period_end=e;
 IF NOT FOUND THEN
  IF jsonb_array_length(smarter_private.weekly_payout_scope_plan(e,n))=0 THEN RETURN NULL;END IF;
  RETURN jsonb_build_object('success',false,'owns_tick',true,'advanced',false,'stage','weekly_payout_late_unprepared',
   'scheduled_for',due,'observed_at',n,'paid',false);
 END IF;
 IF r.phase='released' THEN
  -- The original post-money scope owner continues P&L/docs on later ticks;
  -- it reads the original financial receipts and never pays them again.
  IF r.result->>'success'='true' THEN RETURN NULL;END IF;
  RETURN r.result;
 END IF;
 BEGIN
  answer:=smarter_private.weekly_payout_execute(r.run_id);
 EXCEPTION WHEN OTHERS THEN
  -- This subtransaction rolled back every financial pass, context capability
  -- and receipt together. A network-unknown outcome is read from this SAME
  -- durable run; this handler never starts another payer or extends the pause.
  answer:=jsonb_build_object('success',false,'owns_tick',true,'advanced',false,'stage','weekly_payout_financial_refused',
   'run_id',r.run_id,'sqlstate',SQLSTATE,'reason',SQLERRM,'paid',false,'scheduled_for',r.money_starts_at,'observed_at',smarter_private.weekly_payout_clock());
  UPDATE public.weekly_accounting_payout_pauses SET phase='released',result=answer WHERE run_id=r.run_id;
 END;
 RETURN answer;
END $f$;
REVOKE ALL ON FUNCTION smarter_private.weekly_payout_due() FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION smarter_private.weekly_payout_owned_money_write(p_table text)
RETURNS boolean LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public AS $f$
 SELECT p_table=ANY(ARRAY['clubs','agents','club_members','chip_ledger','chip_transactions','wallet_transactions','union_wallets','wallets'])
 AND EXISTS(SELECT FROM smarter_private.weekly_payout_owned_transactions c
  WHERE c.backend_pid=pg_backend_pid() AND c.transaction_id=txid_current()
   AND smarter_private.weekly_payout_owns_round(c.scope_kind,c.scope_id,c.period_start,c.period_end,c.round_no))
$f$;
REVOKE ALL ON FUNCTION smarter_private.weekly_payout_owned_money_write(text) FROM PUBLIC,anon,authenticated,service_role;

-- Exact original owners: only admission/wiring and the owned full-round
-- deadline change. All rate/owner retention/payer/conservation math is retained.
DO $install_owned_phase$
DECLARE p record;d text;before_meta jsonb;pair jsonb;
BEGIN
 FOR p IN SELECT * FROM jsonb_to_recordset($patches$[{"signature":"public.fn_union_weekly_rakeback_close(uuid,timestamp with time zone,timestamp with time zone)","preimage":"89fd1a7dddbdd86b9dc55ac46e02fd71","postimage":"64c4c5191e1263399cf63e63b1a7b46b","replacements":[{"old":"  -- settlement walk: one row per (union, period), resumable after 'failed'","new":"  PERFORM smarter_private.weekly_payout_require_round('union',p_union_id,p_period_start,p_period_end,1);\n\n  -- settlement walk: one row per (union, period), resumable after 'failed'"}],"metadata":{"proacl":["postgres=X/postgres"],"probin":null,"procost":100,"prokind":"f","proname":"fn_union_weekly_rakeback_close","prorows":0,"pronargs":3,"proconfig":["search_path=public"],"proretset":false,"prosecdef":true,"prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["p_union_id","p_period_start","p_period_end"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}},{"signature":"public.fn_settle_accounting_commission_stage(text,uuid,timestamp with time zone,timestamp with time zone)","preimage":"46cc46eac314417706523cc9bd273405","postimage":"c69a291c3347a6b27fbc62016411d7b2","replacements":[{"old":"prior_saved_context:=current_setting('app.accounting_routing_context',true);","new":"PERFORM smarter_private.weekly_payout_require_round(p_scope_kind,p_scope_id,p_period_start,p_period_end,2);\n  prior_saved_context:=current_setting('app.accounting_routing_context',true);"}],"metadata":{"proacl":["postgres=X/postgres","service_role=X/postgres"],"probin":null,"procost":100,"prokind":"f","proname":"fn_settle_accounting_commission_stage","prorows":0,"pronargs":4,"proconfig":["search_path=public"],"proretset":false,"prosecdef":true,"prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["p_scope_kind","p_scope_id","p_period_start","p_period_end"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}},{"signature":"public.fn_settle_accounting_commission_stage_v3(text,uuid,timestamp with time zone,timestamp with time zone)","preimage":"efff450311e1c001d8873b29e080e551","postimage":"5b50ed269444dfe82b2bb15782ad50c0","replacements":[{"old":"prior_saved_context:=current_setting('app.accounting_routing_context',true);","new":"PERFORM smarter_private.weekly_payout_require_round(p_scope_kind,p_scope_id,p_period_start,p_period_end,2);\n  prior_saved_context:=current_setting('app.accounting_routing_context',true);"}],"metadata":{"proacl":["postgres=X/postgres","service_role=X/postgres"],"probin":null,"procost":100,"prokind":"f","proname":"fn_settle_accounting_commission_stage_v3","prorows":0,"pronargs":4,"proconfig":["search_path=public"],"proretset":false,"prosecdef":true,"prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["p_scope_kind","p_scope_id","p_period_start","p_period_end"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}},{"signature":"public.fn_settle_accounting_rakeback_stage(text,uuid,timestamp with time zone,timestamp with time zone)","preimage":"60570d34b4704fe81ff2de7fc43ad770","postimage":"236228d068e90194a306b81d0f6c88fd","replacements":[{"old":" v_batched:=COALESCE(current_setting('app.weekly_accounting_chunked',true),'')='on'","new":"  PERFORM smarter_private.weekly_payout_require_round(p_scope_kind,p_scope_id,p_period_start,p_period_end,3);\n v_batched:=COALESCE(current_setting('app.weekly_accounting_chunked',true),'')='on'"},{"old":"  amount:=r.owed;\n  INSERT INTO public.rakeback_period_payouts","new":"   PERFORM smarter_private.weekly_payout_require_round(p_scope_kind,p_scope_id,p_period_start,p_period_end,3);\n   amount:=r.owed;\n   INSERT INTO public.rakeback_period_payouts"},{"old":"  IF v_batched AND clock_timestamp()>v_stop THEN EXIT; END IF;","new":"  IF v_batched AND clock_timestamp()>v_stop\n    AND NOT smarter_private.weekly_payout_owns_round(p_scope_kind,p_scope_id,p_period_start,p_period_end,3) THEN EXIT; END IF;"}],"metadata":{"proacl":["postgres=X/postgres","service_role=X/postgres"],"probin":null,"procost":100,"prokind":"f","proname":"fn_settle_accounting_rakeback_stage","prorows":0,"pronargs":4,"proconfig":["search_path=public"],"proretset":false,"prosecdef":true,"prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["p_scope_kind","p_scope_id","p_period_start","p_period_end"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}},{"signature":"public.fn_bank_standalone_week_rake(uuid,timestamp with time zone,timestamp with time zone)","preimage":"b42512f8ab7745caf37c7d3ace67bd6f","postimage":"b1f78d08489b0609db3bf4c354fa5b36","replacements":[{"old":"  v_res := public.fn_ca_fund_club(","new":"  IF NOT EXISTS(SELECT FROM smarter_private.weekly_payout_financial_receipts r WHERE r.scope_kind='club' AND r.scope_id=p_club_id\n   AND r.period_start=p_period_start AND r.period_end=p_period_end) THEN\n   PERFORM smarter_private.weekly_payout_require_round('club',p_club_id,p_period_start,p_period_end,1);\n  END IF;\n  v_res := public.fn_ca_fund_club("}],"metadata":{"proacl":["postgres=X/postgres"],"probin":null,"procost":100,"prokind":"f","proname":"fn_bank_standalone_week_rake","prorows":0,"pronargs":3,"proconfig":["search_path=public"],"proretset":false,"prosecdef":true,"prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["p_club_id","p_period_start","p_period_end"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}},{"signature":"public.fn_refuse_while_frozen()","preimage":"9dd363ba494c92c08988022a34831def","postimage":"a8dd811942377b0e67fa219ba039681e","replacements":[{"old":"  IF public.fn_platform_frozen() THEN","new":"  -- The original private transaction capability, never a user-set GUC.\n  -- Ordinary invoker-rights callers do not invoke this private reader.\n  IF current_user='postgres' THEN\n    IF smarter_private.weekly_payout_owned_money_write(TG_TABLE_NAME) THEN\n      RETURN COALESCE(NEW, OLD);\n    END IF;\n  END IF;\n\n  IF public.fn_platform_frozen() THEN"}],"metadata":{"proacl":["postgres=X/postgres","service_role=X/postgres"],"probin":null,"procost":100,"prokind":"f","proname":"fn_refuse_while_frozen","prorows":0,"pronargs":0,"proconfig":["search_path=public, pg_temp"],"proretset":false,"prosecdef":false,"prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":null,"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}},{"signature":"public.fn_union_settlement_cascade_due()","preimage":"9b9b4ad4bd11c9456ddf1e63509b6780","postimage":"e22a7077ab22bc2a0df56104ff2cef07","replacements":[{"old":"DECLARE v_advance jsonb; v_promo jsonb;","new":"DECLARE v_advance jsonb; v_promo jsonb; v_weekly_phase jsonb;"},{"old":" v_promo:=public.fn_midway_weekly_horse_promo_due();","new":" -- The original bounded tick prepares before four and then owns ALL R1,\n -- ALL gross R2 and ALL secondary R3 before slow post-money books.\n v_weekly_phase:=smarter_private.weekly_payout_due();\n IF v_weekly_phase IS NOT NULL THEN RETURN v_weekly_phase;END IF;\n v_promo:=public.fn_midway_weekly_horse_promo_due();"}],"metadata":{"proacl":["postgres=X/postgres","service_role=X/postgres"],"probin":null,"procost":100,"prokind":"f","proname":"fn_union_settlement_cascade_due","prorows":0,"pronargs":0,"proconfig":["search_path=public"],"proretset":false,"prosecdef":true,"prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":null,"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}}]$patches$::jsonb)
  AS x(signature text,preimage text,postimage text,replacements jsonb,metadata jsonb) LOOP
  SELECT pg_get_functiondef(oid),to_jsonb(pg_proc)-'prosrc' INTO STRICT d,before_meta
   FROM pg_proc WHERE oid=p.signature::regprocedure;
  IF md5(d) IS DISTINCT FROM p.preimage OR
   (before_meta-ARRAY['oid','proowner','prolang','pronamespace','prorettype','proargtypes']) IS DISTINCT FROM p.metadata
   OR (SELECT pg_get_userbyid(proowner)<>'postgres' FROM pg_proc WHERE oid=p.signature::regprocedure)
  THEN RAISE EXCEPTION 'weekly_payout_original_owner_authority_changed:%',p.signature USING ERRCODE='55000';END IF;
  FOR pair IN SELECT value FROM jsonb_array_elements(p.replacements) LOOP
   IF (length(d)-length(replace(d,pair->>'old','')))/length(pair->>'old')<>1 THEN
    RAISE EXCEPTION 'weekly_payout_owner_patch_not_unique:%',p.signature;END IF;
   d:=replace(d,pair->>'old',pair->>'new');
  END LOOP;
  IF md5(d) IS DISTINCT FROM p.postimage THEN RAISE EXCEPTION 'weekly_payout_original_owner_postimage_mismatch:%',p.signature;END IF;
  EXECUTE d;
  IF (SELECT to_jsonb(pg_proc)-'prosrc' FROM pg_proc WHERE oid=p.signature::regprocedure) IS DISTINCT FROM before_meta
   OR md5(pg_get_functiondef(p.signature::regprocedure)) IS DISTINCT FROM p.postimage THEN
   RAISE EXCEPTION 'weekly_payout_original_owner_metadata_changed:%',p.signature;END IF;
 END LOOP;
END $install_owned_phase$;

COMMIT;
