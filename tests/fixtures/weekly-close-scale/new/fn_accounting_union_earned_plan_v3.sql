CREATE OR REPLACE FUNCTION public.fn_accounting_union_earned_plan_v3(p_union_id uuid, p_start timestamp with time zone, p_end timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
END $function$
