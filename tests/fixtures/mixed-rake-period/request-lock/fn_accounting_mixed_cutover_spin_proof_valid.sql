CREATE OR REPLACE FUNCTION public.fn_accounting_mixed_cutover_spin_proof_valid(p_rake_record_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET "TimeZone" TO 'UTC'
AS $function$
 SELECT EXISTS(
  SELECT 1 FROM public.accounting_mixed_cutover_spin_fee_proofs p
   JOIN public.accounting_tournament_fee_batches b USING(rake_record_id)
   JOIN public.rake_records r ON r.id=b.rake_record_id
   JOIN public.accounting_tournament_fee_cutover c ON c.singleton
  WHERE p.rake_record_id=p_rake_record_id AND p.tournament_id=r.tournament_id
   AND b.status='legacy_unverified' AND b.source_manifest IS NULL
   AND p.original_batch=to_jsonb(b) AND p.cutover_at=c.starts_at
   AND r.created_at>=c.starts_at AND b.source_fingerprint=public.fn_accounting_tournament_fee_fingerprint(r)
   AND r.source='fn_spin_book_entry' AND r.metadata->>'kind'='spin_rake'
   AND p.canonical_sources=(SELECT jsonb_agg(to_jsonb(s) ORDER BY s.player_id)
    FROM public.accounting_tournament_fee_sources s WHERE s.rake_record_id=p_rake_record_id)
 );
$function$
;
