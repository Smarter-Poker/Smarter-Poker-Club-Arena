CREATE OR REPLACE FUNCTION smarter_private.rakeback_certificate_payers(p_calculation bigint)
 RETURNS TABLE(payer_kind text, payer_user uuid, payer_entity uuid, owed numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE c public.accounting_rakeback_period_calculations%ROWTYPE;plan jsonb;
BEGIN
 SELECT * INTO STRICT c FROM public.accounting_rakeback_period_calculations WHERE id=p_calculation;
 IF c.payer_kind<>'split' THEN
  IF c.payer_kind NOT IN('agent','club') OR(c.payer_kind='agent')IS DISTINCT FROM(c.payer_user_id IS NOT NULL)
  THEN RAISE EXCEPTION 'rakeback_certificate_payer_invalid' USING ERRCODE='23514'; END IF;
  RETURN QUERY SELECT c.payer_kind,c.payer_user_id,COALESCE(c.payer_user_id,c.club_id),c.rakeback_amount;RETURN;
 END IF;
 plan:=smarter_private.rakeback_payer_plan(c.source_allocations,c.rakeback_amount);
 IF jsonb_array_length(plan)<2 OR c.payer_user_id IS NOT NULL
  OR(SELECT count(*)FROM public.accounting_rakeback_payer_contracts g WHERE g.calculation_id=c.id)<>jsonb_array_length(plan)
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(plan)p LEFT JOIN public.accounting_rakeback_payer_contracts g
   ON g.calculation_id=c.id AND g.payer_kind=p->>'payer_kind' AND g.payer_entity_id=COALESCE(NULLIF(p->>'payer_user_id','')::uuid,c.club_id)
   WHERE g.calculation_id IS NULL OR g.payer_user_id IS DISTINCT FROM NULLIF(p->>'payer_user_id','')::uuid
    OR g.amount IS DISTINCT FROM(p->>'amount')::numeric OR g.unrounded IS DISTINCT FROM(p->>'unrounded')::numeric
    OR g.rake IS DISTINCT FROM(p->>'rake')::numeric OR g.source_count IS DISTINCT FROM(p->>'source_count')::bigint
    OR g.source_fingerprint IS DISTINCT FROM c.source_fingerprint OR g.payer_user_id=c.player_id)
 THEN RAISE EXCEPTION 'split_rakeback_payer_contracts_disagree' USING ERRCODE='23514'; END IF;
 RETURN QUERY SELECT g.payer_kind,g.payer_user_id,g.payer_entity_id,g.amount FROM public.accounting_rakeback_payer_contracts g
  WHERE g.calculation_id=c.id ORDER BY g.payer_kind,g.payer_entity_id;
END $function$
;
