CREATE OR REPLACE FUNCTION public.fn_prune_ca_hand_facts(p_limit integer DEFAULT 200000)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE ids uuid[]; n integer; lim integer:=LEAST(GREATEST(COALESCE(p_limit,250),1),250); days integer;
BEGIN
 SELECT horse_retention_days INTO days FROM public.hand_history_retention_policy LIMIT 1;
 IF public.fn_platform_frozen() THEN RETURN jsonb_build_object('deleted',0,'compacted',0,'more',false,'retention_days',days,'status','frozen'); END IF;
 SELECT array_agg(q.hand_id ORDER BY q.qualified_at,q.hand_id) INTO ids FROM (
  SELECT c.hand_id,c.qualified_at FROM smarter_private.horse_adaptive_disposal_certificates c
  WHERE NOT EXISTS(SELECT 1 FROM smarter_private.horse_fact_card_disposals f WHERE f.hand_id=c.hand_id)
  ORDER BY c.qualified_at,c.hand_id LIMIT lim) q;
 n:=smarter_private.compact_horse_fact_cards(ids);
 RETURN jsonb_build_object('deleted',0,'compacted',n,'cutoff',now()-make_interval(days=>COALESCE(days,8)),
  'retention_days',days,'more',COALESCE(cardinality(ids),0)>=lim);
END $function$;
