CREATE OR REPLACE FUNCTION public.fn_accounting_tournament_fee_fingerprint(p_row rake_records)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
 -- Versioned economic fields are stable across unrelated schema additions.
 -- Tuple terminal markers are not economic source edits.
 SELECT md5(jsonb_object_agg(field,to_jsonb(p_row)->field ORDER BY field)::text)
 FROM unnest(ARRAY['id','hand_id','table_id','club_id','rake_amount','bbj_contribution','pot_size','num_players',
  'created_at','player_contributions','global_hand_id','is_tournament','tournament_id','source','metadata',
  'rake_method','returned_uncalled']::text[])field
$function$
