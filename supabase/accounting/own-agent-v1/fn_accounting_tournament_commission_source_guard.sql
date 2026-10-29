CREATE OR REPLACE FUNCTION public.fn_accounting_tournament_commission_source_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$DECLARE s record;matches int;BEGIN
 IF NEW.source_type='tournament_fee_accrual' THEN
  SELECT f.*,r.recognized_at,r.disposition,b.status accounting_status INTO s FROM public.accounting_effective_tournament_fee_sources f
   JOIN public.accounting_tournament_recognized_sources r ON r.source_id=f.id
   JOIN public.accounting_tournament_fee_recognitions b ON b.tournament_id=r.tournament_id WHERE f.id=NEW.source_id;
  IF NOT FOUND OR s.disposition IS DISTINCT FROM 'earned' OR s.accounting_status IS DISTINCT FROM 'recognized'
   OR NEW.club_id IS DISTINCT FROM s.club_id OR NEW.created_at IS DISTINCT FROM s.recognized_at THEN
   RAISE EXCEPTION 'tournament_commission_recognized_source_required' USING ERRCODE='23514'; END IF;
  SELECT count(*) INTO matches FROM jsonb_array_elements(s.contract->'tiers')t
   WHERE t->>'user_id'=NEW.user_id::text AND (t->>'amount')::numeric=NEW.amount AND (t->>'rate')::numeric=NEW.commission_rate AND NEW.amount>0;
  IF matches<>1 THEN RAISE EXCEPTION 'tournament_commission_disagrees_with_recorded_entitlement' USING ERRCODE='23514'; END IF;
 ELSIF NEW.source_type IN('tournament_fee','tournament_rake_settlement') THEN
  RAISE EXCEPTION 'tournament_commission_requires_canonical_source_writer' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END$function$
