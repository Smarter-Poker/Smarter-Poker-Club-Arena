-- Round 1, statements, cash, and recognized tournament fees share one
-- immutable earning basis. Every source must match an actual bank deposit.
-- Historical final statements retain their original frozen paid basis.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='60s';
DO $guard$ BEGIN
 IF md5(pg_get_functiondef('public.fn_union_club_rake_basis(uuid,timestamptz,timestamptz,boolean)'::regprocedure))<>'73e6a90482ad9a5e0bcac494e371651e'
 OR md5(pg_get_functiondef('public.fn_union_weekly_rakeback_close(uuid,timestamptz,timestamptz)'::regprocedure))<>'315af918ff53073c0d1f08f4189e49d3'
 THEN RAISE EXCEPTION 'union source close preimage changed';END IF;
END $guard$;
CREATE FUNCTION public.fn_accounting_union_earned_plan(p_union_id uuid,p_start timestamptz,p_end timestamptz)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $function$
DECLARE issue_count bigint;bank_total numeric;source_total numeric;house_total numeric;detail jsonb;fingerprint text;
BEGIN
 IF p_union_id IS NULL OR p_start IS NULL OR p_end IS NULL OR NOT isfinite(p_start) OR NOT isfinite(p_end) OR p_start>=p_end
 THEN RAISE EXCEPTION 'invalid_union_earning_source_period' USING ERRCODE='22023'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.accounting_cash_accrual_cutover WHERE singleton AND starts_at<=p_start)
 THEN RAISE EXCEPTION 'union_earning_source_historical_week_uncertified' USING ERRCODE='55000'; END IF;
 -- Each real rake-bank credit must have exactly one typed source authority.
 -- A banked tournament with missing agreements is a debt exception, never
 -- silently reclassified as retained union revenue.
 SELECT count(*) INTO issue_count FROM public.union_wallet_transactions t
  LEFT JOIN public.accounting_cash_bank_receipts c ON c.union_transaction_id=t.id
  LEFT JOIN public.accounting_tournament_fee_recognitions f ON f.union_wallet_transaction_id=t.id
  WHERE t.union_id=p_union_id AND t.wallet='rake_wallet' AND t.direction='credit' AND t.tx_type='rake'
   AND t.created_at>=p_start AND t.created_at<p_end
   AND (((c.rake_record_id IS NOT NULL)::int+(f.tournament_id IS NOT NULL)::int)<>1
    OR (c.rake_record_id IS NOT NULL AND (c.union_id IS DISTINCT FROM p_union_id OR c.amount IS DISTINCT FROM t.amount
     OR c.banked_at IS DISTINCT FROM t.created_at OR c.club_ledger_id IS NOT NULL))
    OR (f.tournament_id IS NOT NULL AND (f.union_id IS DISTINCT FROM p_union_id OR f.net_rake IS DISTINCT FROM t.amount
     OR f.recognized_at IS DISTINCT FROM t.created_at OR f.status IS DISTINCT FROM 'recognized' OR f.bank_journal_id IS NOT NULL))
    OR t.amount IS NULL OR t.amount<=0 OR t.amount<>round(t.amount,2) OR t.amount::text IN('NaN','Infinity','-Infinity'));
 IF issue_count>0 THEN RAISE EXCEPTION 'union_rake_bank_source_unverified:%',issue_count USING ERRCODE='55000'; END IF;
 -- Check the reverse direction too, including sources whose bank row was
 -- changed to another week, union, wallet, or category.
 SELECT count(*) INTO issue_count FROM (
  SELECT c.union_transaction_id AS bank_id,c.banked_at AS earned_at,c.amount AS amount,c.union_id
   FROM public.accounting_cash_bank_receipts c WHERE c.union_id=p_union_id AND c.banked_at>=p_start AND c.banked_at<p_end
  UNION ALL
  SELECT f.union_wallet_transaction_id,f.recognized_at,f.net_rake,f.union_id
   FROM public.accounting_tournament_fee_recognitions f WHERE f.union_id=p_union_id AND f.net_rake>0
    AND f.recognized_at>=p_start AND f.recognized_at<p_end
 ) s LEFT JOIN public.union_wallet_transactions t ON t.id=s.bank_id
 WHERE t.id IS NULL OR t.union_id IS DISTINCT FROM s.union_id OR t.created_at IS DISTINCT FROM s.earned_at
  OR t.amount IS DISTINCT FROM s.amount OR t.wallet IS DISTINCT FROM 'rake_wallet'
  OR t.direction IS DISTINCT FROM 'credit' OR t.tx_type IS DISTINCT FROM 'rake';
 IF issue_count>0 THEN RAISE EXCEPTION 'union_rake_bank_receipt_drifted:%',issue_count USING ERRCODE='55000'; END IF;
 SELECT count(*) INTO issue_count FROM public.accounting_cash_bank_receipts c
  LEFT JOIN public.rake_records r ON r.id=c.rake_record_id
  LEFT JOIN public.accounting_cash_accrual_batches b ON b.rake_record_id=c.rake_record_id
  LEFT JOIN LATERAL (SELECT count(*) AS n,sum(s.rake_credit) AS total,
    count(*) FILTER(WHERE s.union_id IS DISTINCT FROM c.union_id OR s.earned_at IS DISTINCT FROM c.banked_at) AS invalid
    FROM public.accounting_payable_earning_sources s WHERE s.source_type='cash_rake_accrual' AND s.rake_record_id=c.rake_record_id) x ON true
  WHERE c.union_id=p_union_id AND c.banked_at>=p_start AND c.banked_at<p_end
   AND (r.id IS NULL OR r.rake_amount IS DISTINCT FROM c.amount OR r.created_at IS DISTINCT FROM c.banked_at
    OR r.is_tournament IS TRUE OR r.tournament_id IS NOT NULL OR b.status IS DISTINCT FROM 'accrued'
    OR b.earned_at IS DISTINCT FROM r.created_at OR x.n=0 OR x.total IS DISTINCT FROM c.amount OR x.invalid>0);
 IF issue_count>0 THEN RAISE EXCEPTION 'union_cash_sources_do_not_match_bank:%',issue_count USING ERRCODE='55000'; END IF;
 SELECT count(*) INTO issue_count FROM public.accounting_tournament_fee_recognitions f
  LEFT JOIN LATERAL (SELECT count(*) AS n,sum(s.rake_credit) AS total
   FROM public.accounting_payable_earning_sources s WHERE s.source_type='tournament_fee_accrual'
    AND s.tournament_id=f.tournament_id AND s.union_id=p_union_id AND s.earned_at=f.recognized_at) x ON true
  WHERE f.union_id=p_union_id AND f.recognized_at>=p_start AND f.recognized_at<p_end AND f.net_rake>0
   AND (f.status IS DISTINCT FROM 'recognized' OR x.n=0 OR x.total IS DISTINCT FROM f.net_rake);
 IF issue_count>0 THEN RAISE EXCEPTION 'union_tournament_sources_do_not_match_bank:%',issue_count USING ERRCODE='55000'; END IF;
 SELECT count(*) INTO issue_count FROM public.accounting_payable_earning_sources s
  LEFT JOIN public.accounting_cash_bank_receipts c ON s.source_type='cash_rake_accrual' AND c.rake_record_id=s.rake_record_id
  LEFT JOIN public.accounting_tournament_fee_recognitions f ON s.source_type='tournament_fee_accrual' AND f.tournament_id=s.tournament_id
  WHERE s.union_id=p_union_id AND s.earned_at>=p_start AND s.earned_at<p_end
   AND ((s.source_type='cash_rake_accrual' AND (c.rake_record_id IS NULL OR c.union_id IS DISTINCT FROM s.union_id OR c.banked_at IS DISTINCT FROM s.earned_at))
    OR (s.source_type='tournament_fee_accrual' AND (f.tournament_id IS NULL OR f.union_id IS DISTINCT FROM s.union_id
      OR f.recognized_at IS DISTINCT FROM s.earned_at OR f.status IS DISTINCT FROM 'recognized'))
    OR s.source_type NOT IN('cash_rake_accrual','tournament_fee_accrual'));
 IF issue_count>0 THEN RAISE EXCEPTION 'union_earning_source_without_bank:%',issue_count USING ERRCODE='55000'; END IF;
 -- The recorded union agreement must be the latest observation at earning
 -- (cash) or charge (tournament) time. Current membership/rates do not alter it.
 WITH sources AS (
  SELECT s.*,COALESCE(f.game_type,'cash') AS game_type,
   s.contract->'union_agreement' AS agreement,(s.contract->>'terms_at')::timestamptz AS terms_at,
   COALESCE((s.contract->>'is_union_house')::boolean,false) AS is_house
   FROM public.accounting_payable_earning_sources s LEFT JOIN public.accounting_tournament_fee_sources f
    ON s.source_type='tournament_fee_accrual' AND f.id=s.source_id
   WHERE s.union_id=p_union_id AND s.earned_at>=p_start AND s.earned_at<p_end
 ), checked AS (
  SELECT s.*,h.id AS history_id,h.observed_at,h.after_terms,
   COALESCE(CASE s.game_type WHEN 'cash' THEN s.agreement->'terms'->>'rate_cash'
    WHEN 'mtt' THEN s.agreement->'terms'->>'rate_mtt' WHEN 'sng' THEN s.agreement->'terms'->>'rate_sng'
    WHEN 'spin' THEN s.agreement->'terms'->>'rate_spin' WHEN 'satellite' THEN s.agreement->'terms'->>'rate_satellite' END,
    s.agreement->'terms'->>'club_commission_rate')::numeric AS rate
   FROM sources s LEFT JOIN public.accounting_agreement_history h ON h.id=(s.agreement->>'history_id')::bigint
 )
 SELECT count(*) INTO issue_count FROM checked s
 WHERE s.contract->>'club_id' IS DISTINCT FROM s.club_id::text OR s.contract->>'player_id' IS DISTINCT FROM s.player_id::text
  OR s.contract->>'union_id' IS DISTINCT FROM p_union_id::text OR s.coordinator_union_id IS DISTINCT FROM p_union_id
  OR (s.contract->>'rake_credit')::numeric IS DISTINCT FROM s.rake_credit OR s.terms_at IS NULL OR s.terms_at>s.earned_at
  OR (s.source_type='cash_rake_accrual' AND s.terms_at IS DISTINCT FROM s.earned_at)
  OR (s.source_type='tournament_fee_accrual' AND NOT EXISTS(SELECT 1 FROM public.accounting_tournament_fee_sources f
    WHERE f.id=s.source_id AND f.charged_at=s.terms_at))
  OR (s.is_house AND (s.agreement IS DISTINCT FROM 'null'::jsonb OR NOT EXISTS(SELECT 1 FROM public.clubs c
    WHERE c.id=s.club_id AND c.is_union IS TRUE AND (c.id=p_union_id OR c.union_id=p_union_id))))
  OR (NOT s.is_house AND (s.history_id IS NULL OR s.after_terms IS DISTINCT FROM s.agreement->'terms'
    OR s.agreement->'terms'->>'club_id' IS DISTINCT FROM s.club_id::text OR s.agreement->'terms'->>'union_id' IS DISTINCT FROM p_union_id::text
    OR s.observed_at>s.terms_at OR s.observed_at IS DISTINCT FROM (s.agreement->>'observed_at')::timestamptz
    OR NOT EXISTS(SELECT 1 FROM public.accounting_agreement_history h WHERE h.id=s.history_id AND h.entity_type='union_clubs'
     AND h.club_id=s.club_id AND h.entity_key=s.agreement->'terms'->>'id')
    OR EXISTS(SELECT 1 FROM public.accounting_agreement_history h JOIN public.accounting_agreement_history old ON old.id=s.history_id
      WHERE h.entity_type='union_clubs' AND h.entity_key=old.entity_key AND h.observed_at<=s.terms_at AND (h.observed_at,h.id)>(old.observed_at,old.id))
    OR s.rate IS NULL OR s.rate<0 OR s.rate>1 OR s.rate::text IN('NaN','Infinity','-Infinity')));
 IF issue_count>0 THEN RAISE EXCEPTION 'union_earning_agreement_unverified:%',issue_count USING ERRCODE='55000'; END IF;
 SELECT COALESCE(sum(amount),0) INTO bank_total FROM public.union_wallet_transactions
  WHERE union_id=p_union_id AND wallet='rake_wallet' AND direction='credit' AND tx_type='rake' AND created_at>=p_start AND created_at<p_end;
 SELECT COALESCE(sum(s.rake_credit),0),COALESCE(sum(s.rake_credit) FILTER(WHERE (s.contract->>'is_union_house')::boolean),0),
  md5(COALESCE(string_agg(md5(jsonb_build_array(s.source_type,s.source_id,s.rake_record_id,s.tournament_id,s.earned_at,s.rake_credit,s.contract)::text),
    '' ORDER BY s.source_type,s.source_id),'')) INTO source_total,house_total,fingerprint
  FROM public.accounting_payable_earning_sources s WHERE s.union_id=p_union_id AND s.earned_at>=p_start AND s.earned_at<p_end;
 IF source_total IS DISTINCT FROM bank_total THEN RAISE EXCEPTION 'union_earned_rake_does_not_conserve_bank' USING ERRCODE='55000'; END IF;
 WITH source_rates AS (
  SELECT s.club_id,COALESCE(f.game_type,'cash') AS game_type,s.rake_credit,
   COALESCE(CASE COALESCE(f.game_type,'cash') WHEN 'cash' THEN s.contract->'union_agreement'->'terms'->>'rate_cash'
    WHEN 'mtt' THEN s.contract->'union_agreement'->'terms'->>'rate_mtt' WHEN 'sng' THEN s.contract->'union_agreement'->'terms'->>'rate_sng'
    WHEN 'spin' THEN s.contract->'union_agreement'->'terms'->>'rate_spin' WHEN 'satellite' THEN s.contract->'union_agreement'->'terms'->>'rate_satellite' END,
    s.contract->'union_agreement'->'terms'->>'club_commission_rate')::numeric AS rate
  FROM public.accounting_payable_earning_sources s LEFT JOIN public.accounting_tournament_fee_sources f
   ON s.source_type='tournament_fee_accrual' AND f.id=s.source_id
  WHERE s.union_id=p_union_id AND s.earned_at>=p_start AND s.earned_at<p_end AND COALESCE((s.contract->>'is_union_house')::boolean,false) IS FALSE
 ), basis AS (
  SELECT club_id,game_type,sum(rake_credit) AS rake_in,
   CASE WHEN sum(rake_credit)>0 THEN sum(rake_credit*rate)/sum(rake_credit) ELSE 0 END AS rate,
   trunc(sum(rake_credit*rate),2) AS payout FROM source_rates GROUP BY club_id,game_type
 ) SELECT COALESCE(jsonb_agg(to_jsonb(b) ORDER BY club_id,game_type),'[]') INTO detail FROM basis b;
 RETURN jsonb_build_object('accounting_version',3,'union_id',p_union_id,'period_start',p_start,'period_end',p_end,
  'period_rake',bank_total,'earned_rake',source_total,'house_rake',house_total,'source_fingerprint',fingerprint,'basis_detail',detail);
END $function$;
REVOKE ALL ON FUNCTION public.fn_accounting_union_earned_plan(uuid,timestamptz,timestamptz) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.fn_union_club_rake_basis(p_union_id uuid, p_start timestamp with time zone, p_end timestamp with time zone, p_live boolean DEFAULT false)
 RETURNS TABLE(club_id uuid, game_type text, rake_in numeric, rate numeric, payout numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_sref text;
BEGIN
  IF p_union_id IS NULL OR p_start IS NULL OR p_end IS NULL OR p_end <= p_start THEN
    RETURN;
  END IF;

  /* THE WITNESS FIRST. A period that has been closed stored the rows it was
     paid from; a statement for that period describes THAT, never a
     recomputation over attribution tables that may since have moved. */
  v_sref := p_union_id::text || ':'
    || to_char(p_start at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') || '..'
    || to_char(p_end   at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"');

  IF EXISTS (SELECT 1 FROM public.ca_settlements s
              WHERE s.settlement_type = 'union_rakeback_close' AND s.union_id = p_union_id
                AND s.state = 'final' AND s.external_ref = v_sref
                AND s.totals ? 'basis_detail') THEN
    RETURN QUERY
      SELECT (d->>'club_id')::uuid, d->>'game_type',
             (d->>'rake_in')::numeric, (d->>'rate')::numeric, (d->>'payout')::numeric
        FROM public.ca_settlements s
        CROSS JOIN LATERAL jsonb_array_elements(s.totals->'basis_detail') d
       WHERE s.settlement_type = 'union_rakeback_close' AND s.union_id = p_union_id
         AND s.state = 'final' AND s.external_ref = v_sref;
    RETURN;
  END IF;

  -- Open/current statements and the close read exactly the same certified
  -- source plan. An old hourly projection cannot replace earning contracts.
  RETURN QUERY SELECT (d->>'club_id')::uuid,d->>'game_type',(d->>'rake_in')::numeric,
    (d->>'rate')::numeric,(d->>'payout')::numeric
   FROM jsonb_array_elements(public.fn_accounting_union_earned_plan(p_union_id,p_start,p_end)->'basis_detail')d;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_union_weekly_rakeback_close(p_union_id uuid, p_period_start timestamp with time zone, p_period_end timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_source_plan jsonb; v_ledger_id uuid; v_prior_context jsonb; context_key text;
  v_wallet       public.union_wallets%ROWTYPE;
  v_period_total numeric := 0;
  v_payout_total numeric := 0;
  v_retained     numeric := 0;
  v_clubs_paid   integer := 0;
  v_club         record;
  v_new_rw       numeric;
  v_new_cb       numeric;
  v_rw_before    numeric;
  v_cb_before    numeric;
  v_clubs_before numeric := 0;
  v_clubs_after  numeric := 0;
  v_credit       jsonb;
  v_sref         text;
  v_sid          uuid;
  v_sstate       text;
  v_actor        uuid;
BEGIN
  IF NOT public.fn_caller_is_engine() THEN RAISE EXCEPTION 'service_role_required' USING ERRCODE='42501'; END IF;
  -- EMERGENCY SETTLEMENT LOCK CHECK
  IF EXISTS (SELECT 1 FROM settlement_locks WHERE lock_type = 'GLOBAL_SETTLEMENT_FREEZE' AND is_active = true) THEN
    RAISE EXCEPTION 'EMERGENCY_PROFIT_DRIFT_LOCK';
  END IF;

  IF p_union_id IS NULL OR p_period_start IS NULL OR p_period_end IS NULL
     OR p_period_end <= p_period_start OR NOT isfinite(p_period_start) OR NOT isfinite(p_period_end) THEN
    RETURN jsonb_build_object('success', false, 'error', 'bad_params');
  END IF;

  IF EXISTS (SELECT 1 FROM public.union_settlement_floor f
              WHERE f.union_id = p_union_id
                AND p_period_start < f.earliest_period_start) THEN
    RETURN jsonb_build_object('success', false, 'error', 'before_settlement_floor');
  END IF;

  -- Every entry point uses the union's calendar, including DST boundaries.
  IF p_period_start <> public.fn_union_week_start(p_period_start)
     OR p_period_end <> public.fn_union_week_start(p_period_end)
     OR p_period_end <> public.fn_union_week_start(p_period_start+interval '8 days')
     OR p_period_end > public.fn_union_week_start(now()) THEN
    RETURN jsonb_build_object('success', false, 'error', 'period_not_closed_union_weeks');
  END IF;

  -- Accrual and bank producers acquire this exact scope before writing.
  PERFORM pg_advisory_xact_lock(hashtextextended('union-accounting:'||p_union_id::text||':'
    ||extract(epoch FROM p_period_start)::text||':'||extract(epoch FROM p_period_end)::text,0));

  IF EXISTS (
    SELECT 1 FROM union_rakeback_log
     WHERE union_id = p_union_id
       AND period_start = p_period_start AND period_end = p_period_end
  ) THEN
    RETURN jsonb_build_object('success', false, 'error', 'already_executed');
  END IF;

  -- settlement walk: one row per (union, period), resumable after 'failed'
  v_sref := p_union_id::text || ':'
    || to_char(p_period_start at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') || '..'
    || to_char(p_period_end   at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"');

  SELECT id, state INTO v_sid, v_sstate
    FROM ca_settlements
   WHERE settlement_type = 'union_rakeback_close' AND external_ref = v_sref
   FOR UPDATE;
  IF v_sid IS NULL THEN
    INSERT INTO ca_settlements (id, settlement_type, external_ref, state, union_id, totals)
    VALUES (gen_random_uuid(), 'union_rakeback_close', v_sref, 'open', p_union_id, '{}'::jsonb)
    RETURNING id INTO v_sid;
  ELSIF v_sstate = 'final' THEN
    RETURN jsonb_build_object('success', false, 'error', 'already_executed', 'settlement_id', v_sid);
  ELSIF v_sstate = 'failed' THEN
    UPDATE ca_settlements SET state = 'open', error_detail = NULL WHERE id = v_sid;  -- resume
  ELSE
    -- intermediate states never persist (single transaction), so anything
    -- else here is a concurrent close of the same period. Refuse loudly.
    RETURN jsonb_build_object('success', false, 'error', 'close_already_in_state_' || v_sstate,
                              'settlement_id', v_sid);
  END IF;

  UPDATE ca_settlements SET state = 'locked_for_calculation' WHERE id = v_sid;

  SELECT * INTO v_wallet FROM union_wallets WHERE union_id = p_union_id FOR UPDATE;
  IF v_wallet.union_id IS NULL THEN
    UPDATE ca_settlements SET state = 'failed', error_detail = 'no_wallet' WHERE id = v_sid;
    RETURN jsonb_build_object('success', false, 'error', 'no_wallet', 'settlement_id', v_sid);
  END IF;

  -- Recheck after the union wallet lock: concurrent overlapping closes cannot
  -- both consume the same rake credits under different period identities.
  IF EXISTS (SELECT 1 FROM public.union_rakeback_log l
              WHERE l.union_id = p_union_id
                AND l.period_start < p_period_end AND l.period_end > p_period_start) THEN
    UPDATE public.ca_settlements SET state = 'failed', error_detail = 'overlapping_closed_period' WHERE id = v_sid;
    RETURN jsonb_build_object('success', false, 'error', 'overlapping_closed_period', 'settlement_id', v_sid);
  END IF;

  BEGIN
    PERFORM 1 FROM public.union_wallet_transactions t WHERE t.union_id=p_union_id
      AND t.wallet='rake_wallet' AND t.direction='credit' AND t.tx_type='rake'
      AND t.created_at>=p_period_start AND t.created_at<p_period_end ORDER BY t.id FOR SHARE;
    v_source_plan:=public.fn_accounting_union_earned_plan(p_union_id,p_period_start,p_period_end);
  EXCEPTION WHEN OTHERS THEN
    UPDATE public.ca_settlements SET state='failed',error_detail=left(SQLERRM,2000) WHERE id=v_sid;
    RETURN jsonb_build_object('success',false,'error','union_earning_source_not_certified','detail',SQLERRM,'settlement_id',v_sid);
  END;

  /* THE PERIOD (unchanged): everything the rake treasury received. Each credit
     now also carries the GAME TYPE it came from: the named tournament's
     tournament_type, or cash when it names none. */
  DROP TABLE IF EXISTS _uwrb_credits;
  CREATE TEMP TABLE _uwrb_credits ON COMMIT DROP AS
  WITH raw AS (
    SELECT t.id, t.amount, t.notes, t.created_at,
           substring(t.notes from '\[tournament ([0-9a-f-]+)\]')::uuid AS tournament_id
      FROM union_wallet_transactions t
     WHERE t.union_id = p_union_id
       AND t.wallet = 'rake_wallet' AND t.direction = 'credit' AND t.tx_type = 'rake'
       AND t.created_at >= p_period_start AND t.created_at < p_period_end
  )
  SELECT r.id, r.amount, r.notes, r.created_at, r.tournament_id,
         CASE WHEN r.tournament_id IS NULL THEN 'cash'
              ELSE COALESCE(lower(tr.tournament_type), 'other') END AS game_type
    FROM raw r
    LEFT JOIN tournaments tr ON tr.id = r.tournament_id;

  DROP TABLE IF EXISTS _uwrb_by_type;
  /* THE BASIS (Dan, 2026-09-03) lives in fn_union_club_rake_basis since
     Phase 6 (20260907): the statement and the reconciliation report read
     the same function, so what is paid and what is described cannot
     diverge. The block that used to be here is that function, verbatim. */
  CREATE TEMP TABLE _uwrb_by_type ON COMMIT DROP AS
  SELECT b.club_id, b.game_type, b.rake_in, b.rate, b.payout
    FROM public.fn_union_club_rake_basis(p_union_id, p_period_start, p_period_end, true) b;

  /* The per-club roll-up the money section pays from. */
  DROP TABLE IF EXISTS _uwrb;
  CREATE TEMP TABLE _uwrb ON COMMIT DROP AS
  SELECT club_id,
         round(sum(rake_in), 2) AS rake_in,
         round(sum(payout), 2)  AS payout
    FROM _uwrb_by_type
   GROUP BY club_id;

  SELECT round(COALESCE(SUM(amount), 0), 2) INTO v_period_total FROM _uwrb_credits;
  SELECT round(COALESCE(SUM(payout), 0), 2) INTO v_payout_total
    FROM _uwrb WHERE club_id IS NOT NULL AND club_id <> p_union_id;
  IF v_period_total IS DISTINCT FROM (v_source_plan->>'period_rake')::numeric THEN
    RAISE EXCEPTION 'union_rake_bank_changed_during_close' USING ERRCODE='55000';
  END IF;
  v_retained := round(v_period_total - v_payout_total, 2);

  /* a share can never exceed what the treasury received: the attribution is
     a view of the same credits, so this only trips on a data fault */
  IF v_payout_total > v_period_total THEN
    UPDATE ca_settlements SET state = 'failed', error_detail = 'attribution_exceeds_treasury' WHERE id = v_sid;
    RETURN jsonb_build_object('success', false, 'error', 'attribution_exceeds_treasury',
      'period_rake', v_period_total, 'payout', v_payout_total, 'settlement_id', v_sid);
  END IF;

  UPDATE ca_settlements
     SET state = 'calculated',
         totals = jsonb_build_object('period_rake', v_period_total, 'payout_total', v_payout_total,
                                     'retained', v_retained,
                                     'basis', 'immutable_earned_sources_matched_to_bank',
                                     'accounting_version',3,
                                     'source_fingerprint',v_source_plan->'source_fingerprint',
                                     'house_rake',v_source_plan->'house_rake',
                                     'rate_model', 'observed_per_source_truncated_per_club_game',
                                     'basis_by_club', (SELECT COALESCE(jsonb_object_agg(club_id::text, rake_in), '{}'::jsonb) FROM _uwrb),
                                     'payout_by_club', (SELECT COALESCE(jsonb_object_agg(club_id::text, payout), '{}'::jsonb) FROM _uwrb),
                                     'basis_detail', (SELECT COALESCE(jsonb_agg(jsonb_build_object('club_id', club_id, 'game_type', game_type, 'rake_in', rake_in, 'rate', rate, 'payout', payout) ORDER BY club_id, game_type), '[]'::jsonb) FROM _uwrb_by_type),
                                     'basis_by_game_type', (SELECT COALESCE(jsonb_object_agg(game_type, x), '{}'::jsonb)
                                                              FROM (SELECT game_type,
                                                                           jsonb_build_object('basis', round(sum(rake_in), 2),
                                                                                              'payout', round(sum(payout), 2)) AS x
                                                                      FROM _uwrb_by_type GROUP BY game_type) g),
                                     'rates', (SELECT COALESCE(jsonb_object_agg(club_id::text || ':' || game_type, rate), '{}'::jsonb)
                                                 FROM _uwrb_by_type))
   WHERE id = v_sid;

  IF v_period_total <= 0 THEN
    INSERT INTO union_rakeback_log (union_id, period_start, period_end, total_rakeback, executed_at)
    VALUES (p_union_id, p_period_start, p_period_end, 0, now());
    UPDATE ca_settlements SET state = 'validated' WHERE id = v_sid;
    UPDATE ca_settlements SET state = 'ledger_posted' WHERE id = v_sid;
    UPDATE ca_settlements SET state = 'post_commit_verified' WHERE id = v_sid;
    UPDATE ca_settlements SET state = 'final' WHERE id = v_sid;
    RETURN jsonb_build_object('success', true, 'clubs_paid', 0,
      'period_rake', 0, 'total_rakeback', 0, 'union_retained', 0, 'note', 'no_rake',
      'settlement_id', v_sid);
  END IF;

  /* SEPARATE POTS (Phase 2.1). The rake treasury owes the whole period: the
     clubs' share leaves it as rakeback, the union's share leaves it for the
     general bank. The general bank is never a source. A treasury that cannot
     cover the period refuses the close whole - never partial, never from the
     bank - and says so. Who eats a short treasury is Dan's ruling
     (roadmap decision 4). */
  IF v_period_total > COALESCE(v_wallet.rake_wallet, 0) THEN
    UPDATE ca_settlements SET state = 'failed', error_detail = 'insufficient_rake_treasury' WHERE id = v_sid;
    PERFORM public.fn_ca_raise_drift_incident(
      'rakeback_close', 'incorrect_rakeback', 'critical',
      'rakeback-insufficient:' || p_union_id::text || ':' || to_char(p_period_start, 'YYYY-MM-DD'),
      v_period_total - COALESCE(v_wallet.rake_wallet, 0),
      v_period_total,
      COALESCE(v_wallet.rake_wallet, 0),
      'settlement', 'union', p_union_id, NULL, p_union_id,
      NULL, NULL, NULL, v_sid::text, NULL, NULL,
      'union rake treasury cannot cover the period it owes; close refused before any movement (the general bank is never a source)',
      true,
      jsonb_build_object('rake_wallet', v_wallet.rake_wallet,
                         'chip_balance', v_wallet.chip_balance,
                         'period_total', v_period_total,
                         'payout', v_payout_total, 'retained', v_retained,
                         'period_start', p_period_start, 'period_end', p_period_end));
    RETURN jsonb_build_object('success', false, 'error', 'insufficient_rake_treasury', 'retryable', true,
      'period_rake', v_period_total, 'payout', v_payout_total,
      'rake_wallet', v_wallet.rake_wallet, 'chip_balance', v_wallet.chip_balance,
      'settlement_id', v_sid);
  END IF;

  UPDATE ca_settlements SET state = 'validated' WHERE id = v_sid;

  SELECT jsonb_object_agg(k,current_setting(k,true)) INTO v_prior_context FROM unnest(ARRAY[
    'app.ledger_autoskip_clubs','app.ledger_autoskip_union_wallets','app.ledger_category',
    'app.ledger_counterparty','app.ledger_counterparty_entity','app.ledger_settlement'])k;
  -- guarded money section: all of it lands, or none of it does
  BEGIN
    /* One declaration for every balance write below. The union_wallets
       auto-ledger is skipped: the union side of each club credit is the
       from-leg of the club's own row, and the retained share is written
       explicitly. */
    PERFORM public.fn_ca_declare_ledger('rakeback', 'union_wallet', p_union_id, v_sid, NULL,
                                        ARRAY['union_wallets','clubs']);
    v_actor := COALESCE(auth.uid(), '2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid);

    v_rw_before := round(COALESCE(v_wallet.rake_wallet, 0), 2);
    v_cb_before := round(COALESCE(v_wallet.chip_balance, 0), 2);
    SELECT round(COALESCE(SUM(c.chip_treasury), 0), 2) INTO v_clubs_before
      FROM clubs c
     WHERE c.id IN (SELECT club_id FROM _uwrb
                     WHERE club_id IS NOT NULL AND club_id <> p_union_id AND payout > 0);

    FOR v_club IN
      SELECT club_id, rake_in, payout FROM _uwrb
       WHERE club_id IS NOT NULL AND club_id <> p_union_id AND payout > 0 ORDER BY club_id
    LOOP
      v_credit := fn_credit_treasury(
        v_club.club_id, v_club.payout,
        'Union weekly rakeback ' || to_char(p_period_start, 'YYYY-MM-DD')
          || '..' || to_char(p_period_end, 'YYYY-MM-DD'),
        jsonb_build_object('union_id', p_union_id,
                           'period_start', p_period_start, 'period_end', p_period_end,
                           'rake_basis', v_club.rake_in, 'rate', 'per_game_type',
                           'by_game_type', (SELECT COALESCE(jsonb_object_agg(game_type,
                                                     jsonb_build_object('basis', rake_in, 'rate', rate, 'payout', payout)), '{}'::jsonb)
                                              FROM _uwrb_by_type g WHERE g.club_id = v_club.club_id),
                           'settlement_id', v_sid),
        'union_close:' || v_sid::text || ':' || v_club.club_id::text
      );
      IF COALESCE((v_credit->>'success')::boolean, false) IS NOT TRUE THEN
        RAISE EXCEPTION 'treasury credit failed for club %: %', v_club.club_id, v_credit;
      END IF;
      -- The earning union is explicit even if the club has since left or
      -- joined another union. Do not derive this journal scope from the club's
      -- current union_id via its generic balance trigger.
      INSERT INTO public.chip_ledger(performed_by,from_type,from_entity_id,to_type,to_entity_id,amount,category,
        club_id,union_id,description,idempotency_key,metadata,pre_to_balance,post_to_balance)
      VALUES(v_actor,'union_wallet',p_union_id,'club_treasury',v_club.club_id,v_club.payout,'rakeback',
        v_club.club_id,p_union_id,'Union weekly rakeback from recorded earnings',
        'union_close:'||v_sid::text||':'||v_club.club_id::text,
        jsonb_build_object('settlement_id',v_sid,'period_start',p_period_start,'period_end',p_period_end,
          'rake_basis',v_club.rake_in,'accounting_version',3,'source_fingerprint',v_source_plan->'source_fingerprint'),
        (v_credit->>'balance_before')::numeric,(v_credit->>'balance_after')::numeric) RETURNING id INTO v_ledger_id;
      IF NOT EXISTS(SELECT 1 FROM public.settlement_invoices i WHERE i.source_ledger_id=v_ledger_id AND i.status='paid'
        AND i.net_amount=v_club.payout AND i.chips_transferred AND i.message_sent
        AND EXISTS(SELECT 1 FROM public.accounting_invoice_deliveries d WHERE d.invoice_id=i.id)) THEN
        RAISE EXCEPTION 'union_close_invoice_receipt_missing' USING ERRCODE='23514';
      END IF;
      v_clubs_paid := v_clubs_paid + 1;
    END LOOP;

    -- one debit per pot: the treasury pays the whole period; the retained
    -- share moves to the general bank
    UPDATE union_wallets
       SET rake_wallet       = rake_wallet - v_period_total,
           chip_balance      = chip_balance + v_retained,
           total_settlements = COALESCE(total_settlements, 0) + v_payout_total,
           updated_at        = now()
     WHERE union_id = p_union_id
     RETURNING round(rake_wallet, 2), round(chip_balance, 2) INTO v_new_rw, v_new_cb;

    INSERT INTO union_wallet_transactions
      (union_id, club_id, amount, tx_type, wallet, direction, balance_after, notes)
    SELECT p_union_id, club_id, payout, 'rakeback', 'rake_wallet', 'debit', v_new_rw,
           'Weekly rakeback to club at the per-game-type rate (period '
             || to_char(p_period_start, 'YYYY-MM-DD') || '..'
             || to_char(p_period_end, 'YYYY-MM-DD') || ')'
      FROM _uwrb
     WHERE club_id IS NOT NULL AND club_id <> p_union_id AND payout > 0;

    IF v_retained > 0 THEN
      INSERT INTO union_wallet_transactions
        (union_id, amount, tx_type, wallet, direction, balance_after, notes)
      VALUES
        (p_union_id, v_retained, 'rake_hold', 'rake_wallet', 'debit', v_new_rw,
         'Union retained share + self-club rake, out of the rake treasury (period '
           || to_char(p_period_start, 'YYYY-MM-DD') || '..'
           || to_char(p_period_end, 'YYYY-MM-DD') || ')'),
        (p_union_id, v_retained, 'rake_hold', 'chip_balance', 'credit', v_new_cb,
         'Union retained share + self-club rake, into the general bank (period '
           || to_char(p_period_start, 'YYYY-MM-DD') || '..'
           || to_char(p_period_end, 'YYYY-MM-DD') || ')');

      INSERT INTO public.chip_ledger
        (performed_by, from_type, from_entity_id, to_type, to_entity_id,
         amount, category, union_id, description, idempotency_key, metadata)
      VALUES
        (v_actor, 'union_wallet', p_union_id, 'union_bank', p_union_id,
         v_retained, 'treasury_transfer', p_union_id,
         'Weekly union close ' || to_char(p_period_start, 'YYYY-MM-DD') || '..'
           || to_char(p_period_end, 'YYYY-MM-DD')
           || ': retained share ' || v_retained || ' of period rake ' || v_period_total
           || ' moves from the rake treasury to the general bank (clubs paid '
           || v_payout_total || ')',
         'union_close:' || v_sid::text || ':retained',
         jsonb_build_object('settlement_id', v_sid, 'period_start', p_period_start,
                            'period_end', p_period_end, 'period_rake', v_period_total,
                            'payout_total', v_payout_total, 'clubs_paid', v_clubs_paid)) RETURNING id INTO v_ledger_id;
      IF NOT EXISTS(SELECT 1 FROM public.settlement_invoices i WHERE i.source_ledger_id=v_ledger_id AND i.status='paid'
        AND i.net_amount=v_retained AND i.chips_transferred AND i.message_sent
        AND EXISTS(SELECT 1 FROM public.accounting_invoice_deliveries d WHERE d.invoice_id=i.id)) THEN
        RAISE EXCEPTION 'union_retained_invoice_receipt_missing' USING ERRCODE='23514';
      END IF;
    END IF;

    /* CONSERVATION, ASSERTED ON THE BALANCES THEMSELVES (not on the plan).
       What left the treasury must equal what the clubs and the bank received,
       to the cent, or none of it lands. */
    SELECT round(COALESCE(SUM(c.chip_treasury), 0), 2) INTO v_clubs_after
      FROM clubs c
     WHERE c.id IN (SELECT club_id FROM _uwrb
                     WHERE club_id IS NOT NULL AND club_id <> p_union_id AND payout > 0);

    IF round((v_new_rw - v_rw_before) + (v_new_cb - v_cb_before) + (v_clubs_after - v_clubs_before), 2) <> 0
       OR round(v_new_rw - v_rw_before, 2) <> round(-v_period_total, 2)
       OR round(v_clubs_after - v_clubs_before, 2) <> round(v_payout_total, 2)
       OR round(v_new_cb - v_cb_before, 2) <> round(v_retained, 2) THEN
      RAISE EXCEPTION 'conservation violation in the weekly union close: treasury % -> %, bank % -> %, clubs % -> %, period % payout % retained %',
        v_rw_before, v_new_rw, v_cb_before, v_new_cb, v_clubs_before, v_clubs_after,
        v_period_total, v_payout_total, v_retained;
    END IF;

    UPDATE ca_settlements
       SET state = 'ledger_posted',
           totals = totals || jsonb_build_object('clubs_paid', v_clubs_paid,
                                                 'retained', v_retained,
                                                 'rw_debit', v_period_total,
                                                 'conservation', 'asserted')
     WHERE id = v_sid;

    INSERT INTO union_rakeback_log (union_id, period_start, period_end, total_rakeback, executed_at)
    VALUES (p_union_id, p_period_start, p_period_end, v_payout_total, now());

  EXCEPTION WHEN OTHERS THEN
    -- every money movement above just rolled back to the section start
    UPDATE ca_settlements
       SET state = 'failed', error_detail = left(SQLERRM, 2000)
     WHERE id = v_sid;
    PERFORM public.fn_ca_raise_drift_incident(
      'rakeback_close', 'incorrect_rakeback', 'critical',
      'rakeback-close-failed:' || p_union_id::text || ':' || to_char(p_period_start, 'YYYY-MM-DD'),
      0, NULL, NULL,
      'settlement', 'union', p_union_id, NULL, p_union_id,
      NULL, NULL, NULL, v_sid::text, NULL, NULL,
      left('weekly rakeback close aborted mid-flight and rolled back cleanly: ' || SQLERRM, 500),
      true,
      jsonb_build_object('sqlstate', SQLSTATE,
                         'period_start', p_period_start, 'period_end', p_period_end,
                         'clubs_paid_before_abort', v_clubs_paid));
    RETURN jsonb_build_object('success', false, 'error', 'close_failed', 'retryable', true,
      'detail', SQLERRM, 'settlement_id', v_sid);
  END;

  FOR context_key IN SELECT jsonb_object_keys(v_prior_context) LOOP
    PERFORM set_config(context_key,COALESCE(v_prior_context->>context_key,''),true);
  END LOOP;
  UPDATE ca_settlements SET state = 'post_commit_verified' WHERE id = v_sid;
  UPDATE ca_settlements SET state = 'final' WHERE id = v_sid;

  RETURN jsonb_build_object('success', true,
    'clubs_paid', v_clubs_paid,
    'period_rake', v_period_total,
    'total_rakeback', v_payout_total,
    'union_retained', v_retained,
    'retained_to_bank', v_retained,
    'rake_wallet_after', v_new_rw,
    'chip_balance_after', v_new_cb,
    'conservation', 'asserted',
    'settlement_id', v_sid);
END
$function$;
REVOKE ALL ON FUNCTION public.fn_union_weekly_rakeback_close(uuid,timestamptz,timestamptz) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_union_club_rake_basis(uuid,timestamptz,timestamptz,boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_union_club_rake_basis(uuid,timestamptz,timestamptz,boolean) TO service_role;
COMMENT ON FUNCTION public.fn_union_weekly_rakeback_close(uuid,timestamptz,timestamptz) IS 'Private Round 1, invoked by the single weekly coordinator; complete observed source contracts, exact bank-receipt conservation, original frozen final basis, full funding and rollback.';
COMMIT;
