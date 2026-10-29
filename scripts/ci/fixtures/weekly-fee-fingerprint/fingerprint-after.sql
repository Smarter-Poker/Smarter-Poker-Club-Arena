CREATE OR REPLACE FUNCTION public.fn_accounting_tournament_fee_fingerprint(p_row rake_records)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
 -- Versioned economic fields are stable across unrelated schema additions.
 -- Tuple terminal markers are not economic source edits.
 SELECT md5(jsonb_build_object('id',p_row.id,'hand_id',p_row.hand_id,'table_id',p_row.table_id,'club_id',p_row.club_id,'rake_amount',p_row.rake_amount,'bbj_contribution',p_row.bbj_contribution,'pot_size',p_row.pot_size,'num_players',p_row.num_players,'created_at',p_row.created_at,'player_contributions',p_row.player_contributions,'global_hand_id',p_row.global_hand_id,'is_tournament',p_row.is_tournament,'tournament_id',p_row.tournament_id,'source',p_row.source,'metadata',p_row.metadata,'rake_method',p_row.rake_method,'returned_uncalled',p_row.returned_uncalled)::text)
$function$
