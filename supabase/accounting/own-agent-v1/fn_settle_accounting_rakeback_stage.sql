CREATE OR REPLACE FUNCTION public.fn_settle_accounting_rakeback_stage(p_scope_kind text, p_scope_id uuid, p_period_start timestamp with time zone, p_period_end timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE prior_plan jsonb;prior_item record;prior_saved_context text;legacy_paid_cash_replay boolean:=false;scope record;p_union_id uuid;standalone_club uuid;
 r record;c public.accounting_rakeback_period_calculations%ROWTYPE;g record;
 previous public.accounting_routed_settlement_runs%ROWTYPE;fingerprint text;result jsonb;
 from_date date;to_date date;allocation_count int;matched_count int;actual_count int;
 generated numeric;unrounded numeric;display_rate numeric;amount numeric;paid numeric:=0;
 payer_before numeric;payer_after numeric;player_before numeric;player_after numeric;
 payout_id uuid;wallet_id uuid;ledger_id uuid;receipt_count int;payees int:=0;
 club_skip text;member_skip text;maintenance text;routing_context text;agent_skip text;v4_ok boolean:=false;
 v_plan jsonb;v_plan_used boolean:=false;v_batched boolean:=false;v_stop timestamptz;v_remaining bigint:=0;
 v_paid_before numeric:=0;v_payees_before int:=0;
 deleted_deferral text; v_deleted record; v_deleted_before numeric; v_deleted_held numeric; v_deleted_locked numeric;
 v_deleted_bank numeric; v_deleted_return jsonb;
BEGIN
 IF NOT public.fn_caller_is_engine() THEN RAISE EXCEPTION 'service_role_required' USING ERRCODE='42501'; END IF;
 IF p_period_start IS NULL OR p_period_end IS NULL OR NOT isfinite(p_period_start) OR NOT isfinite(p_period_end)
  OR p_period_start>=p_period_end OR p_period_end>now()-interval '5 minutes' THEN RAISE EXCEPTION 'routed_rakeback_invalid_period' USING ERRCODE='22023'; END IF;
 IF public.fn_ca_launch_accounting_waived(p_scope_kind,p_scope_id,p_period_end) THEN
  RETURN jsonb_build_object('success',true,'waived',true,'paid',false,'reason','owner_directed_launch_waiver');
 END IF;
 SELECT * INTO scope FROM public.fn_resolve_accounting_routing_scope(p_scope_kind,p_scope_id,p_period_start,p_period_end);
 p_union_id:=scope.union_id;standalone_club:=scope.standalone_club_id;
 IF p_union_id IS NOT NULL THEN PERFORM public.fn_accounting_union_earned_plan(p_union_id,p_period_start,p_period_end); END IF;
 IF EXISTS(SELECT 1 FROM public.settlement_locks WHERE lock_type='GLOBAL_SETTLEMENT_FREEZE' AND is_active) THEN RAISE EXCEPTION 'EMERGENCY_PROFIT_DRIFT_LOCK'; END IF;
 IF EXISTS(SELECT 1 FROM public.union_settlement_floor WHERE union_id=p_union_id AND p_period_start<earliest_period_start)
  OR NOT EXISTS(SELECT 1 FROM public.accounting_cash_accrual_cutover WHERE singleton AND p_period_start>=starts_at)
 THEN RAISE EXCEPTION 'routed_rakeback_historical_period_uncertified' USING ERRCODE='55000'; END IF;
 from_date:=(p_period_start AT TIME ZONE 'America/Los_Angeles')::date;
 to_date:=(p_period_end AT TIME ZONE 'America/Los_Angeles')::date-1;
 IF p_period_start IS DISTINCT FROM public.fn_union_week_start(p_period_start)
  OR p_period_end IS DISTINCT FROM public.fn_union_week_start(p_period_start+interval '8 days')
 THEN RAISE EXCEPTION 'routed_rakeback_requires_one_accounting_week' USING ERRCODE='22023'; END IF;
 PERFORM smarter_private.assert_own_agent_scope_interpreted(p_scope_kind,p_scope_id,p_period_start,p_period_end,3);
 PERFORM public.fn_lock_rakeback_payer_clubs(scope.club_ids);
 SELECT * INTO previous FROM public.accounting_routed_settlement_runs
  WHERE scope_kind=p_scope_kind AND scope_id=p_scope_id AND period_start=p_period_start AND period_end=p_period_end AND round_no=3;
 -- Only a completed cash-only run can read its original untyped allocation
 -- again. Pending certificates need explicit source types before any payment.
 legacy_paid_cash_replay:=FOUND AND previous.routing_version=3 AND previous.result->>'source_version'='2'
  AND NOT(previous.result ? 'source_contract_version');
 CREATE TEMP TABLE IF NOT EXISTS _routed_player_items(period_id uuid PRIMARY KEY,certificate_id bigint,club_id uuid,user_id uuid,
  payer_kind text,payer_user uuid,owed numeric,rake numeric,rate numeric,fingerprint text,status text) ON COMMIT DROP;
 TRUNCATE pg_temp._routed_player_items;
 -- CHUNKED CLOSE (20261003, round 3 read once): in a chunked close attempt the
 -- week's reads and allocation tests may come from the attempt that read them
 -- (fn_settle_accounting_rakeback_plan); see below for when they are used.
 v_plan:=public.fn_settle_accounting_rakeback_plan_get(p_scope_kind,p_scope_id,p_period_start,p_period_end,scope.club_ids,p_union_id,standalone_club,legacy_paid_cash_replay);
 CREATE TEMP TABLE IF NOT EXISTS _rr3_plan_nonhouse(club_id uuid,player_id uuid,PRIMARY KEY(club_id,player_id)) ON COMMIT DROP;
 TRUNCATE pg_temp._rr3_plan_nonhouse;
 CREATE TEMP TABLE IF NOT EXISTS _rr3_week_v4(source_type text,source_id uuid,club_id uuid,player_id uuid,coordinator_union_id uuid,earned_at timestamptz,
    rake_credit numeric,rake_record_id uuid,agent_text text,house_text text,PRIMARY KEY(source_type,source_id)) ON COMMIT DROP;
 -- WEEKLY CLOSE SCALE (20260928): the per-period proof, read as sets. The
 -- periods are locked in the original order; the latest certificate of each,
 -- every allocation of every certificate and this scope's sources of the week
 -- are each read once, and every original test is evaluated on them. Only a
 -- book that passes every test takes this path. Any refusal, and anything
 -- this path cannot read, runs the original per-period loop below, unchanged,
 -- which raises exactly what it always raised.
 BEGIN
  CREATE TEMP TABLE IF NOT EXISTS _rr3_periods_v4(ord bigint,LIKE public.rakeback_periods) ON COMMIT DROP;
  TRUNCATE pg_temp._rr3_periods_v4;
  -- WEEKLY CLOSE SCALE (20261003): a period of a club outside scope.club_ids
  -- is admitted when this scope earned from its player in the week. Those
  -- (club, player) pairs are read once, for exactly the clubs of such
  -- periods, in this same statement, instead of a scan of the club's whole
  -- week of sources per period (887 s in the 2026-10-01 Midway close: 382
  -- standalone periods). A period whose club is not in that set (only a row
  -- changed under EvalPlanQual) still asks the sources directly.
  INSERT INTO pg_temp._rr3_periods_v4 SELECT row_number() OVER(ORDER BY x.club_id,x.user_id,x.id),x.*
   FROM (WITH pclubs AS MATERIALIZED (SELECT DISTINCT p2.club_id FROM public.rakeback_periods p2
      WHERE p2.period_start<=to_date AND p2.period_end>=from_date AND p2.club_id IS NOT NULL AND (p2.club_id=ANY(scope.club_ids)) IS NOT TRUE),
    pairs AS MATERIALIZED (SELECT DISTINCT rs.club_id,rs.player_id FROM public.accounting_payable_earning_sources rs
      WHERE rs.club_id IN(SELECT pc.club_id FROM pclubs pc)
      AND (rs.coordinator_union_id=p_union_id OR (standalone_club IS NOT NULL AND rs.coordinator_union_id IS NULL AND rs.club_id=standalone_club)) AND rs.earned_at>=p_period_start AND rs.earned_at<p_period_end
      AND v_plan IS NULL
     UNION SELECT (e->>0)::uuid,(e->>1)::uuid FROM jsonb_array_elements(v_plan->'pairs') e
      WHERE v_plan IS NOT NULL AND (e->>0)::uuid IN(SELECT pc.club_id FROM pclubs pc))
   SELECT rp.* FROM public.rakeback_periods rp WHERE rp.period_start<=to_date AND rp.period_end>=from_date
  -- A standalone book never owns a valid Union certificate without any of
  -- its own original earning sources. Unknown certificates remain admitted
  -- to the original refusal path; any standalone source defeats exclusion.
  -- The identical certificate tests are read once per close as one set
  -- (fn_standalone_foreign_certificate_periods), never once per period.
  AND NOT(p_scope_kind='club' AND rp.club_id=standalone_club
    AND rp.period_start=from_date AND rp.period_end=to_date
    AND rp.id IN(SELECT foreign_set.period_id FROM public.fn_standalone_foreign_certificate_periods(
      p_scope_kind,standalone_club,from_date,to_date,p_period_start,p_period_end)foreign_set))
  AND (rp.club_id=ANY(scope.club_ids)
    OR CASE WHEN rp.club_id IN(SELECT pc.club_id FROM pclubs pc)
     THEN EXISTS(SELECT 1 FROM pairs q WHERE q.club_id=rp.club_id AND q.player_id=rp.user_id)
     ELSE EXISTS(SELECT 1 FROM public.accounting_payable_earning_sources rs WHERE rs.club_id=rp.club_id AND rs.player_id=rp.user_id
      AND (rs.coordinator_union_id=p_union_id OR (standalone_club IS NOT NULL AND rs.coordinator_union_id IS NULL AND rs.club_id=standalone_club)) AND rs.earned_at>=p_period_start AND rs.earned_at<p_period_end) END)
  ORDER BY rp.club_id,rp.user_id,rp.id FOR UPDATE OF rp) x;
  CREATE TEMP TABLE IF NOT EXISTS _rr3_certs_v4(period_id uuid PRIMARY KEY,id bigint,accounting_version integer,source_fingerprint text,club_id uuid,player_id uuid,
   coordinator_union_id uuid,period_start date,period_end date,rake_generated numeric,rakeback_amount numeric,display_rate numeric,payer_kind text,payer_user_id uuid) ON COMMIT DROP;
  TRUNCATE pg_temp._rr3_certs_v4;
  INSERT INTO pg_temp._rr3_certs_v4 SELECT DISTINCT ON(x.period_id) x.period_id,x.id,x.accounting_version,x.source_fingerprint,x.club_id,x.player_id,
   x.coordinator_union_id,x.period_start,x.period_end,x.rake_generated,x.rakeback_amount,x.display_rate,x.payer_kind,x.payer_user_id
   FROM public.accounting_rakeback_period_calculations x WHERE x.period_id IN(SELECT id FROM pg_temp._rr3_periods_v4) ORDER BY x.period_id,x.id DESC;
  IF (SELECT count(*) FROM pg_temp._rr3_periods_v4 pr LEFT JOIN pg_temp._rr3_certs_v4 pc ON pc.period_id=pr.id
    WHERE COALESCE(pc.id IS NULL OR pc.accounting_version<>2 OR pc.coordinator_union_id IS DISTINCT FROM p_union_id OR pr.period_start<>from_date OR pr.period_end<>to_date
   OR pc.club_id IS DISTINCT FROM pr.club_id OR pc.player_id IS DISTINCT FROM pr.user_id
   OR pc.period_start IS DISTINCT FROM pr.period_start OR pc.period_end IS DISTINCT FROM pr.period_end
   OR pc.rake_generated IS DISTINCT FROM pr.rake_generated OR pc.rake_generated IS DISTINCT FROM pr.total_rake_paid
   OR pc.rakeback_amount IS DISTINCT FROM pr.rakeback_amount OR pc.rakeback_amount IS DISTINCT FROM pr.rakeback_earned
   OR pc.display_rate IS DISTINCT FROM pr.rakeback_rate OR pc.rakeback_amount<0 OR pc.rakeback_amount<>round(pc.rakeback_amount,2)
   OR pc.rakeback_amount::text IN('NaN','Infinity','-Infinity') OR pc.payer_kind NOT IN('agent','club','split')
   OR (pc.payer_kind='agent') IS DISTINCT FROM(pc.payer_user_id IS NOT NULL) OR pc.payer_user_id=pr.user_id,false))=0 THEN
   CREATE TEMP TABLE IF NOT EXISTS _rr3_wn_v4(club_id uuid,player_id uuid,n bigint,PRIMARY KEY(club_id,player_id)) ON COMMIT DROP;
   TRUNCATE pg_temp._rr3_wn_v4;
   IF v_plan IS NOT NULL THEN
    CREATE TEMP TABLE IF NOT EXISTS _rr3_plan_alloc(period_id uuid PRIMARY KEY,cert_id bigint,club_id uuid,user_id uuid,allocation_count bigint,matched_count bigint,
     generated numeric,unrounded numeric,any_bad boolean) ON COMMIT DROP;
    TRUNCATE pg_temp._rr3_plan_alloc;
    INSERT INTO pg_temp._rr3_plan_alloc SELECT (e->>0)::uuid,(e->>1)::bigint,(e->>2)::uuid,(e->>3)::uuid,(e->>4)::bigint,(e->>5)::bigint,
     (e->>6)::numeric,(e->>7)::numeric,(e->>8)::boolean FROM jsonb_array_elements(v_plan->'alloc') e;
    IF NOT EXISTS(SELECT 1 FROM pg_temp._rr3_periods_v4 pr JOIN pg_temp._rr3_certs_v4 pc ON pc.period_id=pr.id
      WHERE NOT EXISTS(SELECT 1 FROM pg_temp._rr3_plan_alloc a WHERE a.period_id=pr.id AND a.cert_id=pc.id AND a.club_id=pr.club_id AND a.user_id=pr.user_id)) THEN
     v_plan_used:=true;
    END IF;
   END IF;
   IF NOT v_plan_used THEN
   CREATE TEMP TABLE IF NOT EXISTS _rr3_week_v4(source_type text,source_id uuid,club_id uuid,player_id uuid,coordinator_union_id uuid,earned_at timestamptz,
    rake_credit numeric,rake_record_id uuid,agent_text text,house_text text,PRIMARY KEY(source_type,source_id)) ON COMMIT DROP;
   TRUNCATE pg_temp._rr3_week_v4;
   -- house_text (20261003): the source's is_union_house as written, read in
   -- this one pass so the missing-period check below need not read the week
   -- of sources again.
   INSERT INTO pg_temp._rr3_week_v4 SELECT rs.source_type,rs.source_id,rs.club_id,rs.player_id,rs.coordinator_union_id,rs.earned_at,rs.rake_credit,rs.rake_record_id,
    (CASE WHEN (((rs.contract#>>'{membership,terms,player_rakeback_pct}')::numeric=0.70 OR rs.contract->'tiers'->0 IS NULL) AND EXISTS(SELECT 1 FROM public.clubs owner_club WHERE owner_club.id=rs.club_id AND owner_club.owner_id=NULLIF(rs.contract#>>'{membership,terms,agent_id}','')::uuid)) THEN NULL::uuid ELSE NULLIF(rs.contract#>>'{membership,terms,agent_id}','')::uuid END)::text,rs.contract->>'is_union_house'
    FROM public.accounting_payable_earning_sources rs WHERE rs.earned_at>=p_period_start AND rs.earned_at<p_period_end
     AND (rs.coordinator_union_id=p_union_id OR (standalone_club IS NOT NULL AND rs.coordinator_union_id IS NULL AND rs.club_id=standalone_club));
   ANALYZE pg_temp._rr3_week_v4;
   END IF;
   CREATE TEMP TABLE IF NOT EXISTS _rr3_alloc_v4(period_id uuid PRIMARY KEY,allocation_count bigint,matched_count bigint,generated numeric,unrounded numeric,any_bad boolean) ON COMMIT DROP;
   TRUNCATE pg_temp._rr3_alloc_v4;
   -- A source of this allocation that is not in this scope's week slice is
   -- outside the scope or the week, which the original test refuses too.
   IF v_plan_used THEN
    INSERT INTO pg_temp._rr3_alloc_v4 SELECT a.period_id,a.allocation_count,a.matched_count,a.generated,a.unrounded,a.any_bad
     FROM pg_temp._rr3_plan_alloc a JOIN pg_temp._rr3_certs_v4 pc ON pc.period_id=a.period_id AND pc.id=a.cert_id;
    INSERT INTO pg_temp._rr3_wn_v4 SELECT (e->>0)::uuid,(e->>1)::uuid,(e->>2)::bigint FROM jsonb_array_elements(v_plan->'counts') e;
    INSERT INTO pg_temp._rr3_plan_nonhouse SELECT (e->>0)::uuid,(e->>1)::uuid FROM jsonb_array_elements(v_plan->'nonhouse') e;
   ELSE
   INSERT INTO pg_temp._rr3_alloc_v4 SELECT pc.period_id,count(*),
    count(DISTINCT ROW(COALESCE(a->>'source_type',CASE WHEN legacy_paid_cash_replay THEN 'cash_rake_accrual' END),a->>'source_id')),
    sum((a->>'rake_credit')::numeric),sum((a->>'rake_credit')::numeric*(a->>'rate')::numeric),
    COALESCE(bool_or(COALESCE(a->>'source_type',CASE WHEN legacy_paid_cash_replay THEN 'cash_rake_accrual' END) IS NULL OR COALESCE(a->>'source_type',CASE WHEN legacy_paid_cash_replay THEN 'cash_rake_accrual' END) NOT IN('cash_rake_accrual','tournament_fee_accrual')
      OR rs.source_id IS NULL OR rs.club_id<>pr.club_id OR rs.player_id<>pr.user_id OR rs.coordinator_union_id IS DISTINCT FROM p_union_id
      OR rs.earned_at<p_period_start OR rs.earned_at>=p_period_end OR rs.rake_credit IS DISTINCT FROM(a->>'rake_credit')::numeric
      OR rs.rake_record_id IS DISTINCT FROM(a->>'rake_record_id')::uuid
      OR (a->>'rate')::numeric IS NULL OR (a->>'rate')::numeric<0 OR (a->>'rate')::numeric>1
      OR (a->>'rate')::numeric::text IN('NaN','Infinity','-Infinity')
      OR (pc.payer_kind<>'split' AND(a->>'payer_kind' IS DISTINCT FROM pc.payer_kind OR NULLIF(a->>'payer_user_id','')::uuid IS DISTINCT FROM pc.payer_user_id)) OR (pc.payer_kind='split' AND(a->>'payer_kind' NOT IN('agent','club') OR(a->>'payer_kind'='agent') IS DISTINCT FROM(NULLIF(a->>'payer_user_id','')IS NOT NULL)))
      OR NULLIF(rs.agent_text,'')::uuid IS DISTINCT FROM NULLIF(a->>'payer_user_id','')::uuid),false)
    FROM pg_temp._rr3_certs_v4 pc JOIN pg_temp._rr3_periods_v4 pr ON pr.id=pc.period_id
    JOIN public.accounting_rakeback_period_calculations cc ON cc.id=pc.id
    CROSS JOIN LATERAL jsonb_array_elements(cc.source_allocations) a
    LEFT JOIN pg_temp._rr3_week_v4 rs ON rs.source_type=COALESCE(a->>'source_type',CASE WHEN legacy_paid_cash_replay THEN 'cash_rake_accrual' END) AND rs.source_id=(a->>'source_id')::uuid
    GROUP BY pc.period_id;
   INSERT INTO pg_temp._rr3_wn_v4 SELECT w.club_id,w.player_id,count(*) FROM pg_temp._rr3_week_v4 w GROUP BY w.club_id,w.player_id;
   END IF;
   IF (SELECT count(*) FROM pg_temp._rr3_periods_v4 pr JOIN pg_temp._rr3_certs_v4 pc ON pc.period_id=pr.id
     LEFT JOIN pg_temp._rr3_alloc_v4 ag ON ag.period_id=pr.id
     LEFT JOIN pg_temp._rr3_wn_v4 w ON w.club_id=pr.club_id AND w.player_id=pr.user_id
     WHERE COALESCE((COALESCE(ag.allocation_count,0)=0 OR COALESCE(ag.allocation_count,0)<>COALESCE(ag.matched_count,0) OR COALESCE(ag.allocation_count,0)<>COALESCE(w.n,0)
       OR ag.generated IS DISTINCT FROM pc.rake_generated
       OR round(ag.unrounded,2) IS DISTINCT FROM pc.rakeback_amount
       OR pc.display_rate IS DISTINCT FROM (CASE WHEN ag.generated>0 THEN round(ag.unrounded/ag.generated,4) ELSE 0 END))
      OR COALESCE(ag.any_bad,false),false))=0 THEN
    INSERT INTO pg_temp._routed_player_items SELECT pr.id,pc.id,pr.club_id,pr.user_id,pc.payer_kind,pc.payer_user_id,pc.rakeback_amount,pc.rake_generated,pc.display_rate,pc.source_fingerprint,pr.status
     FROM pg_temp._rr3_periods_v4 pr JOIN pg_temp._rr3_certs_v4 pc ON pc.period_id=pr.id;
    v4_ok:=true;
   END IF;
  END IF;
 EXCEPTION WHEN OTHERS THEN v4_ok:=false;
 END;
 IF NOT v4_ok THEN
 TRUNCATE pg_temp._routed_player_items;
 FOR r IN SELECT rp.* FROM public.rakeback_periods rp WHERE rp.period_start<=to_date AND rp.period_end>=from_date
  -- A standalone book never owns a valid Union certificate without any of
  -- its own original earning sources. Unknown certificates remain admitted
  -- to the original refusal path; any standalone source defeats exclusion.
  -- The identical certificate tests are read once per close as one set
  -- (fn_standalone_foreign_certificate_periods), never once per period.
  AND NOT(p_scope_kind='club' AND rp.club_id=standalone_club
    AND rp.period_start=from_date AND rp.period_end=to_date
    AND rp.id IN(SELECT foreign_set.period_id FROM public.fn_standalone_foreign_certificate_periods(
      p_scope_kind,standalone_club,from_date,to_date,p_period_start,p_period_end)foreign_set))
  AND (rp.club_id=ANY(scope.club_ids)
    OR EXISTS(SELECT 1 FROM public.accounting_payable_earning_sources rs WHERE rs.club_id=rp.club_id AND rs.player_id=rp.user_id
      AND (rs.coordinator_union_id=p_union_id OR (standalone_club IS NOT NULL AND rs.coordinator_union_id IS NULL AND rs.club_id=standalone_club)) AND rs.earned_at>=p_period_start AND rs.earned_at<p_period_end))
  ORDER BY rp.club_id,rp.user_id,rp.id FOR UPDATE
 LOOP
  SELECT * INTO c FROM public.accounting_rakeback_period_calculations WHERE period_id=r.id ORDER BY id DESC LIMIT 1;
  IF NOT FOUND OR c.accounting_version<>2 OR c.coordinator_union_id IS DISTINCT FROM p_union_id OR r.period_start<>from_date OR r.period_end<>to_date
   OR c.club_id IS DISTINCT FROM r.club_id OR c.player_id IS DISTINCT FROM r.user_id
   OR c.period_start IS DISTINCT FROM r.period_start OR c.period_end IS DISTINCT FROM r.period_end
   OR c.rake_generated IS DISTINCT FROM r.rake_generated OR c.rake_generated IS DISTINCT FROM r.total_rake_paid
   OR c.rakeback_amount IS DISTINCT FROM r.rakeback_amount OR c.rakeback_amount IS DISTINCT FROM r.rakeback_earned
   OR c.display_rate IS DISTINCT FROM r.rakeback_rate OR c.rakeback_amount<0 OR c.rakeback_amount<>round(c.rakeback_amount,2)
   OR c.rakeback_amount::text IN('NaN','Infinity','-Infinity') OR c.payer_kind NOT IN('agent','club','split')
   OR (c.payer_kind='agent') IS DISTINCT FROM(c.payer_user_id IS NOT NULL) OR c.payer_user_id=r.user_id
  THEN RAISE EXCEPTION 'routed_rakeback_certificate_required' USING ERRCODE='55000'; END IF;
  SELECT count(*),count(DISTINCT ROW(COALESCE(a->>'source_type',CASE WHEN legacy_paid_cash_replay THEN 'cash_rake_accrual' END),a->>'source_id')),sum((a->>'rake_credit')::numeric),sum((a->>'rake_credit')::numeric*(a->>'rate')::numeric)
   INTO allocation_count,matched_count,generated,unrounded FROM jsonb_array_elements(c.source_allocations) a;
  SELECT count(*) INTO actual_count FROM public.accounting_payable_earning_sources rs WHERE rs.club_id=r.club_id AND rs.player_id=r.user_id
   AND rs.earned_at>=p_period_start AND rs.earned_at<p_period_end AND (rs.coordinator_union_id=p_union_id OR (standalone_club IS NOT NULL AND rs.coordinator_union_id IS NULL AND rs.club_id=standalone_club));
  IF allocation_count=0 OR allocation_count<>matched_count OR allocation_count<>actual_count OR generated IS DISTINCT FROM c.rake_generated
    OR round(unrounded,2) IS DISTINCT FROM c.rakeback_amount
    OR c.display_rate IS DISTINCT FROM (CASE WHEN generated>0 THEN round(unrounded/generated,4) ELSE 0 END)
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(c.source_allocations) a LEFT JOIN public.accounting_payable_earning_sources rs ON rs.source_type=COALESCE(a->>'source_type',CASE WHEN legacy_paid_cash_replay THEN 'cash_rake_accrual' END) AND rs.source_id=(a->>'source_id')::uuid
     WHERE COALESCE(a->>'source_type',CASE WHEN legacy_paid_cash_replay THEN 'cash_rake_accrual' END) IS NULL OR COALESCE(a->>'source_type',CASE WHEN legacy_paid_cash_replay THEN 'cash_rake_accrual' END) NOT IN('cash_rake_accrual','tournament_fee_accrual')
      OR rs.source_id IS NULL OR rs.club_id<>r.club_id OR rs.player_id<>r.user_id OR rs.coordinator_union_id IS DISTINCT FROM p_union_id
      OR rs.earned_at<p_period_start OR rs.earned_at>=p_period_end OR rs.rake_credit IS DISTINCT FROM(a->>'rake_credit')::numeric
      OR rs.rake_record_id IS DISTINCT FROM(a->>'rake_record_id')::uuid
      OR (a->>'rate')::numeric IS NULL OR (a->>'rate')::numeric<0 OR (a->>'rate')::numeric>1
      OR (a->>'rate')::numeric::text IN('NaN','Infinity','-Infinity')
      OR (c.payer_kind<>'split' AND(a->>'payer_kind' IS DISTINCT FROM c.payer_kind OR NULLIF(a->>'payer_user_id','')::uuid IS DISTINCT FROM c.payer_user_id)) OR (c.payer_kind='split' AND(a->>'payer_kind' NOT IN('agent','club') OR(a->>'payer_kind'='agent') IS DISTINCT FROM(NULLIF(a->>'payer_user_id','')IS NOT NULL)))
      OR (CASE WHEN (((rs.contract#>>'{membership,terms,player_rakeback_pct}')::numeric=0.70 OR rs.contract->'tiers'->0 IS NULL) AND EXISTS(SELECT 1 FROM public.clubs owner_club WHERE owner_club.id=rs.club_id AND owner_club.owner_id=NULLIF(rs.contract#>>'{membership,terms,agent_id}','')::uuid)) THEN NULL::uuid ELSE NULLIF(rs.contract#>>'{membership,terms,agent_id}','')::uuid END) IS DISTINCT FROM NULLIF(a->>'payer_user_id','')::uuid)
  THEN RAISE EXCEPTION 'routed_rakeback_sources_disagree_with_certificate' USING ERRCODE='23514'; END IF;
  INSERT INTO pg_temp._routed_player_items VALUES(r.id,c.id,r.club_id,r.user_id,c.payer_kind,c.payer_user_id,c.rakeback_amount,c.rake_generated,c.display_rate,c.source_fingerprint,r.status);
 END LOOP;
 END IF;
 -- Missing periods are obligations too: every source player in this scope must
 -- have an admitted certificate, including zero-entitlement players.
 -- 20261003: when the set path admitted the book, _rr3_week_v4 holds exactly
 -- these rows (same predicate, read under this scope's week lock, which every
 -- accrual of the week shares), so they are not read a second time.
 PERFORM set_config('app.accounting_round3_plan_used',CASE WHEN v4_ok AND v_plan_used THEN 'on' ELSE '' END,true);
 IF (CASE WHEN v4_ok AND v_plan_used THEN EXISTS(SELECT 1 FROM pg_temp._rr3_plan_nonhouse rs
     WHERE NOT EXISTS(SELECT 1 FROM pg_temp._routed_player_items i WHERE i.club_id=rs.club_id AND i.user_id=rs.player_id))
  WHEN v4_ok THEN EXISTS(SELECT 1 FROM pg_temp._rr3_week_v4 rs
    WHERE COALESCE((rs.house_text)::boolean,false) IS FALSE
     AND NOT EXISTS(SELECT 1 FROM pg_temp._routed_player_items i WHERE i.club_id=rs.club_id AND i.user_id=rs.player_id))
  ELSE EXISTS(SELECT 1 FROM public.accounting_payable_earning_sources rs WHERE (rs.coordinator_union_id=p_union_id OR (standalone_club IS NOT NULL AND rs.coordinator_union_id IS NULL AND rs.club_id=standalone_club))
   AND rs.earned_at>=p_period_start AND rs.earned_at<p_period_end
   AND COALESCE((rs.contract->>'is_union_house')::boolean,false) IS FALSE
   AND NOT EXISTS(SELECT 1 FROM pg_temp._routed_player_items i WHERE i.club_id=rs.club_id AND i.user_id=rs.player_id)) END)
 THEN RAISE EXCEPTION 'routed_rakeback_player_period_missing' USING ERRCODE='55000'; END IF;
 SELECT md5(COALESCE(jsonb_agg(jsonb_build_array(i.period_id,i.certificate_id,i.club_id,i.user_id,i.payer_kind,i.payer_user,i.owed,i.rake,i.rate,i.fingerprint) ORDER BY i.period_id),'[]'::jsonb)::text)
  INTO fingerprint FROM pg_temp._routed_player_items i;
 SELECT * INTO previous FROM public.accounting_routed_settlement_runs
  WHERE scope_kind=p_scope_kind AND scope_id=p_scope_id AND period_start=p_period_start AND period_end=p_period_end AND round_no=3;
 IF FOUND THEN
  IF EXISTS(SELECT FROM smarter_private.existing_rakeback_transfer_allocations a JOIN pg_temp._routed_player_items i ON i.period_id=a.obligation_id WHERE a.obligation_role='player'AND NOT smarter_private.existing_rakeback_transfer_complete('player',i.period_id)) OR previous.source_fingerprint<>fingerprint OR EXISTS(SELECT 1 FROM pg_temp._routed_player_items i WHERE i.status<>'paid' OR NOT EXISTS(
   SELECT 1 FROM public.rakeback_period_payouts pp WHERE pp.rakeback_period_id=i.period_id AND pp.user_id=i.user_id AND pp.club_id=i.club_id AND pp.status='paid' AND pp.payout_amount=i.owed AND(CASE WHEN EXISTS(SELECT FROM public.accounting_rakeback_wallet_contracts wc WHERE wc.calculation_id=i.certificate_id) THEN smarter_private.rakeback_wallet_payout_complete(pp.id,i.certificate_id) WHEN i.payer_kind='split' THEN smarter_private.split_rakeback_payout_complete(pp.id,i.certificate_id) ELSE true END)))
  THEN RAISE EXCEPTION 'routed_rakeback_changed_after_payment' USING ERRCODE='55000'; END IF;
  RETURN previous.result||jsonb_build_object('duplicate',true);
 END IF;
 -- CHUNKED CLOSE (20261003, round 3 in batches): inside a chunked close attempt
 -- a period an earlier batch of THIS round paid is recognised by its own
 -- evidence and not paid again; outside one nothing is.
  PERFORM smarter_private.weekly_payout_require_round(p_scope_kind,p_scope_id,p_period_start,p_period_end,3);
 v_batched:=COALESCE(current_setting('app.weekly_accounting_chunked',true),'')='on'
  AND NULLIF(current_setting('app.weekly_accounting_scope_deadline',true),'') IS NOT NULL;
 CREATE TEMP TABLE IF NOT EXISTS _routed_player_done(period_id uuid PRIMARY KEY) ON COMMIT DROP;
 TRUNCATE pg_temp._routed_player_done;
 IF EXISTS(SELECT FROM pg_temp._routed_player_items i JOIN smarter_private.existing_rakeback_transfer_allocations a ON a.obligation_role='player'AND a.obligation_id=i.period_id WHERE NOT smarter_private.existing_rakeback_transfer_complete('player',i.period_id)) THEN RAISE EXCEPTION 'existing_transfer_discharge_receipt_incomplete' USING ERRCODE='23514';END IF;
 INSERT INTO pg_temp._routed_player_done SELECT i.period_id FROM pg_temp._routed_player_items i JOIN smarter_private.existing_rakeback_transfer_allocations a ON a.obligation_role='player'AND a.obligation_id=i.period_id WHERE smarter_private.existing_rakeback_transfer_complete('player',i.period_id);
 IF v_batched THEN
  INSERT INTO pg_temp._routed_player_done SELECT i.period_id FROM pg_temp._routed_player_items i
   WHERE i.status='paid' AND (SELECT count(*) FROM public.rakeback_period_payouts pp WHERE pp.rakeback_period_id=i.period_id)=1
    AND EXISTS(SELECT 1 FROM public.rakeback_period_payouts pp WHERE pp.rakeback_period_id=i.period_id AND pp.club_id=i.club_id AND pp.user_id=i.user_id
     AND pp.status='paid' AND pp.payout_amount=i.owed
     AND CASE WHEN EXISTS(SELECT FROM public.accounting_rakeback_wallet_contracts wc WHERE wc.calculation_id=i.certificate_id) THEN smarter_private.rakeback_wallet_payout_complete(pp.id,i.certificate_id) WHEN i.payer_kind='split' THEN smarter_private.split_rakeback_payout_complete(pp.id,i.certificate_id) WHEN i.owed>0 THEN EXISTS(SELECT 1 FROM public.chip_ledger l WHERE l.idempotency_key='round3-period:v3:'||i.period_id::text
       AND l.amount=i.owed AND l.club_id=i.club_id AND l.to_type='player_wallet' AND l.to_entity_id=i.user_id AND l.category='rakeback'
       AND l.metadata->>'accounting_scope_kind'=p_scope_kind AND l.metadata->>'accounting_scope_id'=p_scope_id::text
       AND l.metadata->>'certificate_id'=i.certificate_id::text AND l.metadata->>'payout_id'=pp.id::text
       AND l.metadata->>'source_fingerprint' IS NOT DISTINCT FROM i.fingerprint) ELSE true END) ON CONFLICT DO NOTHING;
 END IF;
 CREATE TEMP TABLE IF NOT EXISTS _routed_player_todo(LIKE pg_temp._routed_player_items) ON COMMIT DROP;
 TRUNCATE pg_temp._routed_player_todo;
 INSERT INTO pg_temp._routed_player_todo SELECT i.* FROM pg_temp._routed_player_items i
  WHERE NOT EXISTS(SELECT 1 FROM pg_temp._routed_player_done d WHERE d.period_id=i.period_id);
 CREATE TEMP TABLE IF NOT EXISTS _routed_player_now(period_id uuid PRIMARY KEY) ON COMMIT DROP;
 TRUNCATE pg_temp._routed_player_now;
 IF EXISTS(SELECT 1 FROM pg_temp._routed_player_todo i WHERE i.status IS DISTINCT FROM 'pending'
   OR EXISTS(SELECT 1 FROM public.rakeback_period_payouts pp WHERE pp.rakeback_period_id=i.period_id))
  OR EXISTS(SELECT 1 FROM public.union_settlement_rounds sr WHERE sr.union_id=p_union_id AND sr.round_no=3
   AND sr.period_start<p_period_end AND sr.period_end>p_period_start AND (sr.amount>0 OR sr.payees>0 OR sr.shortfalls>0))
 THEN RAISE EXCEPTION 'legacy_rakeback_payment_requires_reconciliation' USING ERRCODE='55000'; END IF;
 -- Discharge only owner-confirmed actual transfers AFTER the original whole
 -- source/certificate/refusal checks and BEFORE new wallet funding is planned.
 prior_saved_context:=current_setting('app.accounting_routing_context',true);
 PERFORM set_config('app.accounting_routing_context',scope.routing_context,true);
 FOR prior_item IN SELECT i.* FROM pg_temp._routed_player_todo i JOIN smarter_private.existing_rakeback_transfer_instructions q
  ON q.club_id=i.club_id AND q.beneficiary_id=i.user_id AND q.period_start=p_period_start AND q.period_end=p_period_end WHERE 'player'=ANY(q.roles)
  ORDER BY i.club_id,i.user_id,i.period_id LOOP
  prior_plan:=smarter_private.apply_existing_rakeback_transfer(p_scope_kind,p_scope_id,p_period_start,p_period_end,'player',prior_item.club_id,prior_item.user_id,prior_item.period_id,prior_item.certificate_id);
  IF prior_plan IS NULL THEN RAISE EXCEPTION 'existing_transfer_expected_player_instruction_required';END IF;
  INSERT INTO pg_temp._routed_player_done VALUES(prior_item.period_id)ON CONFLICT DO NOTHING;
  DELETE FROM pg_temp._routed_player_todo WHERE period_id=prior_item.period_id;
  UPDATE pg_temp._routed_player_items SET status='paid'WHERE period_id=prior_item.period_id;
 END LOOP;
 PERFORM set_config('app.accounting_routing_context',COALESCE(prior_saved_context,''),true);
 -- RAKEBACK IS PAID FROM WHERE COMMISSION LANDS (20261022, Dan). A real agent
 -- pays its players from its agent wallet (agents.agent_wallet_balance), where
 -- its weekly commission is credited. A share the certificate records for the
 -- club owner, or for no agent, is paid from the club bank, never from the
 -- owner's wallet. The certificate's payer identity is unchanged.
 CREATE TEMP TABLE IF NOT EXISTS _routed_player_funding(period_id uuid,payer_kind text,payer_user uuid,payer_entity uuid,owed numeric,club_id uuid,funded_from text,destination_kind text,typed_wallet boolean,PRIMARY KEY(period_id,payer_kind,payer_entity,destination_kind)) ON COMMIT DROP;
 TRUNCATE pg_temp._routed_player_funding;
 INSERT INTO pg_temp._routed_player_funding SELECT i.period_id,fp.payer_kind,fp.payer_user,fp.payer_entity,fp.owed,i.club_id,
  CASE WHEN fp.payer_kind='club' OR fp.payer_user IS NULL OR fp.payer_user=owner_club.owner_id THEN 'club_treasury' ELSE 'agent_wallet' END,fp.destination_kind,EXISTS(SELECT FROM public.accounting_rakeback_wallet_contracts wc WHERE wc.calculation_id=i.certificate_id)
 FROM pg_temp._routed_player_todo i JOIN public.clubs owner_club ON owner_club.id=i.club_id
 CROSS JOIN LATERAL smarter_private.rakeback_certificate_wallets(i.certificate_id)fp;
 IF EXISTS(SELECT 1 FROM pg_temp._routed_player_todo i WHERE i.owed IS DISTINCT FROM(SELECT sum(fp.owed)FROM pg_temp._routed_player_funding fp WHERE fp.period_id=i.period_id))
 THEN RAISE EXCEPTION 'routed_rakeback_payer_funding_not_conserved' USING ERRCODE='23514'; END IF;
 CREATE TEMP TABLE IF NOT EXISTS _routed_player_wallets(club_id uuid,user_id uuid,opening numeric,delta numeric,PRIMARY KEY(club_id,user_id)) ON COMMIT DROP;
 TRUNCATE pg_temp._routed_player_wallets;
 INSERT INTO pg_temp._routed_player_wallets(club_id,user_id,delta)
 SELECT f.club_id,i.user_id,sum(f.owed) FROM pg_temp._routed_player_funding f JOIN pg_temp._routed_player_todo i ON i.period_id=f.period_id WHERE f.owed>0 AND f.destination_kind='player_wallet' GROUP BY f.club_id,i.user_id;
 CREATE TEMP TABLE IF NOT EXISTS _routed_agent_wallets(club_id uuid,user_id uuid,opening numeric,delta numeric,PRIMARY KEY(club_id,user_id)) ON COMMIT DROP;
 TRUNCATE pg_temp._routed_agent_wallets;
 INSERT INTO pg_temp._routed_agent_wallets(club_id,user_id,delta)
 SELECT x.club_id,x.user_id,sum(x.delta) FROM(SELECT club_id,payer_user user_id,-owed delta FROM pg_temp._routed_player_funding WHERE funded_from='agent_wallet' UNION ALL SELECT f.club_id,i.user_id,f.owed FROM pg_temp._routed_player_funding f JOIN pg_temp._routed_player_todo i ON i.period_id=f.period_id WHERE f.destination_kind='agent_wallet')x GROUP BY x.club_id,x.user_id;
 PERFORM id FROM public.clubs WHERE id IN(SELECT club_id FROM pg_temp._routed_player_todo) ORDER BY id FOR NO KEY UPDATE;
 FOR r IN SELECT i.* FROM pg_temp._routed_player_todo i WHERE EXISTS(SELECT FROM pg_temp._routed_player_funding f WHERE f.period_id=i.period_id AND f.owed>0 AND f.destination_kind='player_wallet')
  AND NOT EXISTS(SELECT FROM public.club_members cm WHERE cm.club_id=i.club_id AND cm.user_id=i.user_id)
  ORDER BY i.club_id,i.user_id,i.period_id LOOP
  PERFORM smarter_private.preserve_historical_rakeback_wallet(r.period_id,r.certificate_id,p_period_start,p_period_end);
 END LOOP;
 PERFORM cm.user_id FROM public.club_members cm JOIN pg_temp._routed_player_wallets w ON w.club_id=cm.club_id AND w.user_id=cm.user_id
  ORDER BY cm.club_id,cm.user_id FOR NO KEY UPDATE OF cm;
 UPDATE pg_temp._routed_player_wallets w SET opening=cm.chip_balance FROM public.club_members cm WHERE cm.club_id=w.club_id AND cm.user_id=w.user_id;
 IF EXISTS(SELECT 1 FROM pg_temp._routed_player_wallets WHERE opening IS NULL OR opening<0 OR opening<>round(opening,2) OR opening::text IN('NaN','Infinity','-Infinity'))
 THEN RAISE EXCEPTION 'routed_rakeback_account_missing_or_invalid' USING ERRCODE='23514'; END IF;
 PERFORM a.id FROM public.agents a JOIN pg_temp._routed_agent_wallets w ON w.club_id=a.club_id AND w.user_id=a.user_id
  ORDER BY a.club_id,a.user_id FOR NO KEY UPDATE OF a;
 UPDATE pg_temp._routed_agent_wallets w SET opening=a.agent_wallet_balance FROM public.agents a WHERE a.club_id=w.club_id AND a.user_id=w.user_id;
 IF EXISTS(SELECT 1 FROM pg_temp._routed_agent_wallets WHERE opening IS NULL OR opening<0 OR opening<>round(opening,2) OR opening::text IN('NaN','Infinity','-Infinity'))
 THEN RAISE EXCEPTION 'routed_rakeback_agent_wallet_missing_or_invalid' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM(SELECT club_id,payer_user,sum(owed) owed FROM pg_temp._routed_player_funding WHERE funded_from='agent_wallet' GROUP BY club_id,payer_user) x
  JOIN pg_temp._routed_agent_wallets w ON w.club_id=x.club_id AND w.user_id=x.payer_user WHERE w.opening<x.owed)
 THEN RAISE EXCEPTION 'routed_rakeback_agent_funding_shortfall' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM(SELECT club_id,sum(owed) owed FROM pg_temp._routed_player_funding WHERE funded_from='club_treasury' GROUP BY club_id) x
  LEFT JOIN public.clubs bank ON bank.id=x.club_id WHERE bank.chip_treasury IS NULL OR bank.chip_treasury<x.owed
   OR bank.chip_treasury<>round(bank.chip_treasury,2) OR bank.chip_treasury::text IN('NaN','Infinity','-Infinity'))
 THEN RAISE EXCEPTION 'routed_rakeback_club_funding_shortfall' USING ERRCODE='23514'; END IF;
 deleted_deferral:=current_setting('app.deleted_wallet_routing_stage',true);
 club_skip:=current_setting('app.ledger_autoskip_clubs',true);member_skip:=current_setting('app.ledger_autoskip_club_members',true);agent_skip:=current_setting('app.ledger_autoskip_agents',true);
 maintenance:=current_setting('app.ledger_maintenance',true);
 routing_context:=current_setting('app.accounting_routing_context',true);
 PERFORM set_config('app.accounting_routing_context',scope.routing_context,true);
 PERFORM set_config('app.deleted_wallet_routing_stage','rakeback',true);
 PERFORM set_config('app.ledger_autoskip_clubs','1',true);PERFORM set_config('app.ledger_autoskip_club_members','1',true);PERFORM set_config('app.ledger_autoskip_agents','1',true);
 v_stop:=CASE WHEN v_batched THEN LEAST(clock_timestamp()+interval '90 seconds',NULLIF(current_setting('app.weekly_accounting_scope_deadline',true),'')::timestamptz) ELSE clock_timestamp()+interval '90 seconds' END;
 FOR r IN SELECT * FROM pg_temp._routed_player_todo ORDER BY club_id,payer_user NULLS FIRST,user_id,period_id LOOP
   PERFORM smarter_private.weekly_payout_require_round(p_scope_kind,p_scope_id,p_period_start,p_period_end,3);
   amount:=r.owed;
   INSERT INTO public.rakeback_period_payouts(rakeback_period_id,club_id,user_id,user_rake_contribution,rakeback_pct,payout_amount,status,paid_at)
   VALUES(r.period_id,r.club_id,r.user_id,r.rake,round(r.rate*100,2),amount,'paid',now()) RETURNING id INTO payout_id;
  IF amount>0 THEN
   FOR g IN SELECT * FROM pg_temp._routed_player_funding WHERE period_id=r.period_id ORDER BY payer_kind,payer_entity,destination_kind LOOP
    amount:=g.owed;
    IF amount=0 THEN CONTINUE; END IF;
   IF g.destination_kind='agent_wallet' THEN
    SELECT agent_wallet_balance INTO player_before FROM public.agents WHERE club_id=r.club_id AND user_id=r.user_id;
   ELSE
    SELECT chip_balance INTO player_before FROM public.club_members WHERE club_id=r.club_id AND user_id=r.user_id;
   END IF;
   IF g.funded_from='club_treasury' THEN
    SELECT chip_treasury INTO payer_before FROM public.clubs WHERE id=r.club_id;
    UPDATE public.clubs SET chip_treasury=chip_treasury-amount WHERE id=r.club_id AND chip_treasury>=amount RETURNING chip_treasury INTO payer_after;
   ELSE
    SELECT agent_wallet_balance INTO payer_before FROM public.agents WHERE club_id=r.club_id AND user_id=g.payer_user;
    UPDATE public.agents SET agent_wallet_balance=agent_wallet_balance-amount,updated_at=now() WHERE club_id=r.club_id AND user_id=g.payer_user AND agent_wallet_balance>=amount RETURNING agent_wallet_balance INTO payer_after;
   END IF;
   IF g.destination_kind='agent_wallet' THEN
    UPDATE public.agents SET agent_wallet_balance=agent_wallet_balance+amount,updated_at=now() WHERE club_id=r.club_id AND user_id=r.user_id RETURNING agent_wallet_balance INTO player_after;
   ELSE
    UPDATE public.club_members SET chip_balance=chip_balance+amount,updated_at=now() WHERE club_id=r.club_id AND user_id=r.user_id RETURNING chip_balance INTO player_after;
   END IF;
   IF payer_after IS NULL OR player_after IS NULL OR payer_before-payer_after<>amount OR player_after-player_before<>amount
   THEN RAISE EXCEPTION 'routed_rakeback_transfer_not_conserved' USING ERRCODE='23514'; END IF;
   -- A debit of an agent wallet or the club bank is journalled by its leg below.
   INSERT INTO public.wallet_transactions(user_id,wallet_type,type,amount,category,description,balance_after,related_entity_id)
    VALUES(r.user_id,CASE WHEN g.destination_kind='agent_wallet' THEN 'BUSINESS' ELSE 'PLAYER' END,'credit',amount,'rakeback','Weekly rakeback received under recorded agreement',player_after,payout_id) RETURNING id INTO wallet_id;
   IF NOT g.typed_wallet AND r.payer_kind<>'split' THEN
   PERFORM set_config('app.ledger_maintenance','rakeback payout evidence pointer',true);
   UPDATE public.rakeback_period_payouts SET wallet_transaction_id=wallet_id WHERE id=payout_id;
   PERFORM set_config('app.ledger_maintenance',COALESCE(maintenance,''),true);
   END IF;
   INSERT INTO public.chip_ledger(performed_by,from_type,from_entity_id,to_type,to_entity_id,amount,category,club_id,union_id,description,idempotency_key,metadata,
    pre_from_balance,post_from_balance,pre_to_balance,post_to_balance)
    VALUES(COALESCE(auth.uid(),'2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid),CASE WHEN g.funded_from='club_treasury' THEN 'club_treasury' ELSE 'agent_wallet' END,
     CASE WHEN g.funded_from='club_treasury' THEN r.club_id ELSE g.payer_user END,g.destination_kind,r.user_id,amount,'rakeback',r.club_id,p_union_id,'Weekly rakeback from certified historical payer',
     CASE WHEN g.typed_wallet THEN 'round3-period:own-agent-v1:'||r.period_id::text||':payer:'||g.payer_kind||':'||g.payer_entity::text||':destination:'||g.destination_kind ELSE 'round3-period:v3:'||r.period_id::text||CASE WHEN r.payer_kind='split' THEN ':payer:'||g.payer_kind||':'||g.payer_entity::text ELSE '' END END,jsonb_build_object('routing_version',3,'accounting_scope_kind',p_scope_kind,'accounting_scope_id',p_scope_id,'period_id',r.period_id,'period_start',p_period_start,'period_end',p_period_end,
       'certificate_id',r.certificate_id,'source_fingerprint',r.fingerprint,'payout_id',payout_id,'wallet_transaction_id',wallet_id,'payee_role_at_transfer',CASE WHEN g.destination_kind='agent_wallet' THEN 'agent' ELSE 'player' END,
       'paid_from',g.funded_from,'owner_share_payer',CASE WHEN g.payer_kind='agent' AND g.funded_from='club_treasury' THEN g.payer_user END)||CASE WHEN g.typed_wallet THEN jsonb_build_object('wallet_destination_version','own-agent-v1','destination_kind',g.destination_kind) ELSE '{}'::jsonb END,
      payer_before,payer_after,player_before,player_after) RETURNING id INTO ledger_id;
   IF g.typed_wallet THEN
    INSERT INTO public.accounting_rakeback_wallet_transfers(payout_id,calculation_id,period_id,payer_kind,payer_entity_id,destination_kind,amount,ledger_id,wallet_transaction_id)
    VALUES(payout_id,r.certificate_id,r.period_id,g.payer_kind,g.payer_entity,g.destination_kind,amount,ledger_id,wallet_id);
   ELSIF r.payer_kind='split' THEN
    INSERT INTO public.accounting_rakeback_payer_transfers(payout_id,calculation_id,period_id,payer_kind,payer_entity_id,amount,ledger_id,wallet_transaction_id)
    VALUES(payout_id,r.certificate_id,r.period_id,g.payer_kind,g.payer_entity,amount,ledger_id,wallet_id);
   END IF;
   SELECT count(*) INTO receipt_count FROM public.settlement_invoices i WHERE i.source_ledger_id=ledger_id AND i.status='paid'
    AND i.chips_transferred AND i.message_sent AND i.net_amount=amount AND i.gross_amount=amount AND i.deductions=0;
   IF receipt_count<>1 THEN RAISE EXCEPTION 'routed_rakeback_invoice_delivery_incomplete' USING ERRCODE='23514'; END IF;
   END LOOP;
   paid:=paid+r.owed;payees:=payees+1;
  END IF;
  UPDATE public.rakeback_periods SET status='paid',paid_at=now() WHERE id=r.period_id;
  INSERT INTO pg_temp._routed_player_now VALUES(r.period_id);
  IF v_batched AND clock_timestamp()>v_stop
    AND NOT smarter_private.weekly_payout_owns_round(p_scope_kind,p_scope_id,p_period_start,p_period_end,3) THEN EXIT; END IF;
 END LOOP;
 SELECT count(*) INTO v_remaining FROM pg_temp._routed_player_todo t WHERE NOT EXISTS(SELECT 1 FROM pg_temp._routed_player_now n WHERE n.period_id=t.period_id);
 IF v_remaining>0 THEN
  -- A batch: every locked wallet must hold exactly what this batch paid it.
  UPDATE pg_temp._routed_player_wallets w SET delta=COALESCE((SELECT sum(x.delta) FROM(
   SELECT t.club_id,t.user_id,f.owed AS delta FROM pg_temp._routed_player_todo t JOIN pg_temp._routed_player_now n ON n.period_id=t.period_id JOIN pg_temp._routed_player_funding f ON f.period_id=t.period_id WHERE f.destination_kind='player_wallet'
   ) x
   WHERE x.club_id=w.club_id AND x.user_id=w.user_id),0);
  UPDATE pg_temp._routed_agent_wallets w SET delta=COALESCE((SELECT sum(x.delta)FROM(SELECT f.club_id,f.payer_user user_id,-f.owed delta FROM pg_temp._routed_player_funding f JOIN pg_temp._routed_player_now n ON n.period_id=f.period_id WHERE f.funded_from='agent_wallet' UNION ALL SELECT f.club_id,t.user_id,f.owed FROM pg_temp._routed_player_funding f JOIN pg_temp._routed_player_now n ON n.period_id=f.period_id JOIN pg_temp._routed_player_todo t ON t.period_id=f.period_id WHERE f.destination_kind='agent_wallet')x WHERE x.club_id=w.club_id AND x.user_id=w.user_id),0);
 END IF;
 PERFORM set_config('app.ledger_autoskip_clubs',COALESCE(club_skip,''),true);PERFORM set_config('app.ledger_autoskip_club_members',COALESCE(member_skip,''),true);PERFORM set_config('app.ledger_autoskip_agents',COALESCE(agent_skip,''),true);
 PERFORM set_config('app.deleted_wallet_routing_stage',COALESCE(deleted_deferral,''),true);
 IF EXISTS(SELECT 1 FROM pg_temp._routed_player_wallets w JOIN public.club_members cm ON cm.club_id=w.club_id AND cm.user_id=w.user_id
   WHERE cm.chip_balance IS DISTINCT FROM w.opening+w.delta)
 THEN RAISE EXCEPTION 'routed_rakeback_final_balance_incorrect' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM pg_temp._routed_agent_wallets w LEFT JOIN public.agents a ON a.club_id=w.club_id AND a.user_id=w.user_id
   WHERE a.agent_wallet_balance IS DISTINCT FROM w.opening+w.delta)
 THEN RAISE EXCEPTION 'routed_rakeback_final_agent_wallet_incorrect' USING ERRCODE='23514'; END IF;
 -- All original transfer, invoice and net-wallet checks above still decide
 -- whether this stage may finish. Return only free net chips afterward,
 -- retaining published unpaid player obligations across bounded chunks.
 FOR v_deleted IN
  SELECT cm.club_id,cm.user_id FROM public.club_members cm
  JOIN public.profiles dp ON dp.id=cm.user_id AND dp.status='deleted'
  WHERE EXISTS(SELECT FROM pg_temp._routed_player_wallets w WHERE w.club_id=cm.club_id AND w.user_id=cm.user_id) AND EXISTS(SELECT FROM pg_temp._routed_player_todo t JOIN pg_temp._routed_player_now done ON done.period_id=t.period_id WHERE t.club_id=cm.club_id AND t.user_id=cm.user_id) ORDER BY cm.club_id,cm.user_id
 LOOP
  SELECT cm.chip_balance,coalesce(cm.held_chips,0),coalesce(cm.locked_chips,0)
   INTO STRICT v_deleted_before,v_deleted_held,v_deleted_locked FROM public.club_members cm
   WHERE cm.club_id=v_deleted.club_id AND cm.user_id=v_deleted.user_id;
  SELECT dwr_bank.chip_treasury INTO STRICT v_deleted_bank FROM public.clubs dwr_bank WHERE dwr_bank.id=v_deleted.club_id;
  v_deleted_return:=public.fn_ca_deleted_wallet_bank_return(v_deleted.club_id,v_deleted.user_id,'player_wallet');
  IF v_deleted_return->'success' IS DISTINCT FROM 'true'::jsonb
   OR v_deleted_return->>'reserved_rakeback' IS NULL OR (v_deleted_return->>'reserved_rakeback')::numeric<0
   OR (v_deleted_return->>'reserved_rakeback')::numeric::text IN('NaN','Infinity','-Infinity')
   OR (v_deleted_return->>'amount')::numeric IS DISTINCT FROM greatest(v_deleted_before-v_deleted_held-v_deleted_locked-(v_deleted_return->>'reserved_rakeback')::numeric,0)
   OR (v_deleted_return->>'player_chips')::numeric IS DISTINCT FROM (v_deleted_return->>'amount')::numeric
   OR (v_deleted_return->>'agent_chips')::numeric IS DISTINCT FROM 0::numeric
   OR NOT EXISTS(SELECT FROM public.club_members cm WHERE cm.club_id=v_deleted.club_id AND cm.user_id=v_deleted.user_id
     AND cm.chip_balance=v_deleted_before-(v_deleted_return->>'amount')::numeric
     AND coalesce(cm.held_chips,0)=v_deleted_held AND coalesce(cm.locked_chips,0)=v_deleted_locked)
   OR NOT EXISTS(SELECT FROM public.clubs dwr_bank WHERE dwr_bank.id=v_deleted.club_id AND dwr_bank.chip_treasury=v_deleted_bank+(v_deleted_return->>'amount')::numeric)
  THEN RAISE EXCEPTION 'deleted_weekly_net_bank_return_not_conserved' USING ERRCODE='23514'; END IF;
 END LOOP;
 FOR v_deleted IN
  SELECT a.club_id,a.user_id FROM public.agents a
  JOIN public.profiles dp ON dp.id=a.user_id AND dp.status='deleted'
  WHERE EXISTS(SELECT FROM pg_temp._routed_agent_wallets w WHERE w.club_id=a.club_id AND w.user_id=a.user_id)
   AND EXISTS(SELECT FROM pg_temp._routed_player_funding f JOIN pg_temp._routed_player_now done ON done.period_id=f.period_id
    WHERE f.club_id=a.club_id AND ((f.funded_from='agent_wallet' AND f.payer_user=a.user_id) OR(f.destination_kind='agent_wallet' AND EXISTS(SELECT FROM pg_temp._routed_player_todo t WHERE t.period_id=f.period_id AND t.user_id=a.user_id)))) ORDER BY a.club_id,a.user_id
 LOOP
  SELECT a.agent_wallet_balance INTO STRICT v_deleted_before FROM public.agents a
   WHERE a.club_id=v_deleted.club_id AND a.user_id=v_deleted.user_id;
  SELECT dwr_bank.chip_treasury INTO STRICT v_deleted_bank FROM public.clubs dwr_bank WHERE dwr_bank.id=v_deleted.club_id;
  v_deleted_return:=public.fn_ca_deleted_wallet_bank_return(v_deleted.club_id,v_deleted.user_id,'agent_wallet');
  IF v_deleted_return->'success' IS DISTINCT FROM 'true'::jsonb
   OR v_deleted_return->>'reserved_rakeback' IS NULL OR (v_deleted_return->>'reserved_rakeback')::numeric<0
   OR (v_deleted_return->>'reserved_rakeback')::numeric::text IN('NaN','Infinity','-Infinity')
   OR (v_deleted_return->>'amount')::numeric IS DISTINCT FROM greatest(v_deleted_before-(v_deleted_return->>'reserved_rakeback')::numeric,0)
   OR (v_deleted_return->>'agent_chips')::numeric IS DISTINCT FROM (v_deleted_return->>'amount')::numeric
   OR (v_deleted_return->>'player_chips')::numeric IS DISTINCT FROM 0::numeric
   OR NOT EXISTS(SELECT FROM public.agents a WHERE a.club_id=v_deleted.club_id AND a.user_id=v_deleted.user_id
     AND a.agent_wallet_balance=v_deleted_before-(v_deleted_return->>'amount')::numeric)
   OR NOT EXISTS(SELECT FROM public.clubs dwr_bank WHERE dwr_bank.id=v_deleted.club_id AND dwr_bank.chip_treasury=v_deleted_bank+(v_deleted_return->>'amount')::numeric)
  THEN RAISE EXCEPTION 'deleted_weekly_net_bank_return_not_conserved' USING ERRCODE='23514'; END IF;
 END LOOP;
 PERFORM set_config('app.accounting_routing_context',COALESCE(routing_context,''),true);

 IF v_remaining>0 THEN
  RETURN jsonb_build_object('success',false,'batch_committed',true,'round',3,'routing_version',3,'source_version',2,'scope_kind',p_scope_kind,'scope_id',p_scope_id,
   'periods',(SELECT count(*) FROM pg_temp._routed_player_items),'paid_periods',(SELECT count(*) FROM pg_temp._routed_player_done)+(SELECT count(*) FROM pg_temp._routed_player_now),
   'remaining',v_remaining,'source_fingerprint',fingerprint,'plan_used',v_plan_used);
 END IF;
 -- The round's totals include what earlier batches of it paid.
 SELECT COALESCE(sum(i.owed),0),count(*) INTO v_paid_before,v_payees_before FROM pg_temp._routed_player_items i
  JOIN pg_temp._routed_player_done d ON d.period_id=i.period_id WHERE i.owed>0;
 paid:=paid+v_paid_before;payees:=payees+v_payees_before;
 result:=jsonb_build_object('success',true,'round',3,'name','certified_payer_to_players','routing_version',3,'source_version',2,'source_contract_version',3,'scope_kind',p_scope_kind,'scope_id',p_scope_id,
  'amount',paid,'payees',payees,'shortfalls',0,'periods',(SELECT count(*) FROM pg_temp._routed_player_items),'detail','[]'::jsonb);
 result:=result||jsonb_build_object('existing_transfer_economic_plan',smarter_private.existing_rakeback_transfer_scope_economic_plan(p_scope_kind,p_scope_id,p_period_start,p_period_end,'player'),
  'existing_transfer_receipts',smarter_private.existing_rakeback_transfer_scope_receipts(p_scope_kind,p_scope_id,p_period_start,p_period_end,'player'));
 INSERT INTO public.accounting_routed_settlement_runs(union_id,standalone_club_id,period_start,period_end,round_no,source_fingerprint,result)
  VALUES(p_union_id,standalone_club,p_period_start,p_period_end,3,fingerprint,result);
 RETURN result;
END $function$
