CREATE OR REPLACE FUNCTION smarter_private.horse_cash_compact_request(p_request jsonb)
 RETURNS jsonb
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'pg_catalog'
AS $function$
 SELECT jsonb_set(p_request,'{hand_row}',coalesce((SELECT jsonb_object_agg(key,value)
 FROM jsonb_each(p_request->'hand_row') WHERE key=ANY(ARRAY['has_human','tournament_id','pot_size','big_blind','rake_amount','bbj_amount','_accepted_post_commit_facts'])),'{}'::jsonb))
 #- '{hand_row,_accepted_post_commit_facts,stats_facts}'
$function$
;
CREATE OR REPLACE FUNCTION smarter_private.horse_cash_compact_atomic(p_atomic jsonb)
 RETURNS jsonb
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'pg_catalog'
AS $function$
 SELECT p_atomic #- '{post_commit_payload,accepted_hand_facts,stats_facts}'
$function$
;
