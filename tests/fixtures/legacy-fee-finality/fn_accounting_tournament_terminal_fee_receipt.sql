CREATE OR REPLACE FUNCTION public.fn_accounting_tournament_terminal_fee_receipt(p_tournament_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$DECLARE r record;proof jsonb;fp text;credits numeric;n int;BEGIN
 SELECT * INTO r FROM public.accounting_tournament_fee_recognitions WHERE tournament_id=p_tournament_id;
 IF NOT FOUND THEN RETURN NULL; END IF;
 SELECT md5(COALESCE(string_agg(public.fn_accounting_tournament_fee_fingerprint(q),':' ORDER BY q.id),'')) INTO fp
  FROM public.rake_records q WHERE q.tournament_id=p_tournament_id AND q.is_tournament;
 IF r.source_fingerprint IS DISTINCT FROM fp THEN RAISE EXCEPTION 'recognized_tournament_fee_sources_changed' USING ERRCODE='23514'; END IF;
 proof:=public.fn_accounting_tournament_bank_proof(r.tournament_id,r.recognized_at,r.bank_club_id,r.union_id,r.net_rake,r.union_wallet_transaction_id,r.bank_journal_id);
 SELECT COALESCE(sum(x.rake_credit),0),count(*) INTO credits,n FROM public.accounting_tournament_recognized_sources x WHERE x.tournament_id=p_tournament_id;
 IF (r.status='banked_accrual_deferred' AND (n<>0 OR r.plan->>'payable' IS DISTINCT FROM 'false' OR NULLIF(r.plan->>'reason','') IS NULL))
  OR (r.status<>'banked_accrual_deferred' AND (credits IS DISTINCT FROM r.net_rake
    OR n<>(SELECT count(*) FROM public.accounting_tournament_fee_sources f WHERE f.tournament_id=p_tournament_id)
    OR EXISTS(SELECT 1 FROM public.accounting_tournament_fee_sources f LEFT JOIN public.accounting_tournament_recognized_sources x ON x.source_id=f.id
      WHERE f.tournament_id=p_tournament_id AND (x.source_id IS NULL OR x.tournament_id IS DISTINCT FROM p_tournament_id
        OR x.recognized_at IS DISTINCT FROM r.recognized_at OR x.rake_credit IS DISTINCT FROM CASE WHEN x.disposition='earned' THEN f.rake_credit ELSE 0 END))
    OR EXISTS(SELECT 1 FROM public.accounting_tournament_fee_sources f
      JOIN public.accounting_tournament_recognized_sources x ON x.source_id=f.id AND x.disposition='earned'
      CROSS JOIN LATERAL jsonb_array_elements(f.contract->'tiers')tier
      WHERE f.tournament_id=p_tournament_id AND (tier->>'amount')::numeric>0 AND NOT EXISTS(
       SELECT 1 FROM public.agent_commissions c WHERE c.source_type='tournament_fee_accrual' AND c.source_id=f.id
        AND c.user_id::text=tier->>'user_id' AND c.club_id=f.club_id AND c.created_at=r.recognized_at
        AND c.amount=(tier->>'amount')::numeric AND c.commission_rate=(tier->>'rate')::numeric)))) THEN
  RAISE EXCEPTION 'tournament_fee_recognition_source_receipt_incomplete' USING ERRCODE='23514'; END IF;
 RETURN proof||jsonb_build_object('accounting_version',2,'tournament_id',p_tournament_id,'status',r.status,
  'source_fingerprint',fp,'reason',r.plan->>'reason','payable',r.status='recognized','recognized_source_count',n);
END$function$
